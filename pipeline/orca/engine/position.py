"""Average-cost P&L of one stock held by one fund over one tracking segment.

Every quarter's share change is assumed to trade at one price (see `_trade_price`). Buys add to
the cost basis; a sell realises the difference to the average cost per share and takes that
average cost out of the basis. A quarter's value change then splits exactly into the market move
on shares already held, net buying, and the gain or loss on the quarter's own trades.
"""

from dataclasses import dataclass

from orca.quarter_px import QuarterPx, last_close_before


@dataclass(frozen=True, slots=True)
class Trade:
    """One quarter's share change. `delta` is signed; `low` and `high` are the quarter's price
    range, None when the stock has no prices in the quarter. `entry` marks a position entering
    the book without a buy decision of that quarter: the first report of a tracking segment, or a
    holding valued for the first time (bought at the close, like a first report)."""

    q: int
    type: str  # "new" | "add" | "trim" | "exit"
    delta: float
    px: float
    low: float | None
    high: float | None
    shares_after: float
    entry: bool = False


@dataclass(frozen=True, slots=True)
class PositionQuarter:
    """One quarter of a held position. `shares` and `cost` are the end-of-quarter figures;
    `realised`, `market_move`, `trade_gain`, `dividends` and `net_buying` belong to the quarter.
    `trade_px` is None when nothing traded. value = shares x valuation close."""

    q: int
    shares: float
    delta: float
    trade_px: float | None
    cost: float
    realised: float
    market_move: float
    trade_gain: float
    dividends: float
    value: float
    net_buying: float


@dataclass(frozen=True, slots=True)
class PositionResult:
    """A position's quarters and totals. `quarters` runs from the first held quarter to the last
    exit (or `last_q` while held), leaving out quarters in which the position was not held.
    `to_q` is the exit quarter, None while the position is still held at `last_q`; `shares_now`
    and `cost_now` are the end-of-segment holding. avg_cost = invested / shares bought;
    avg_exit = sold_usd / sold_shares."""

    stock_id: int
    from_q: int
    to_q: int | None
    quarters: list[PositionQuarter]
    trades: list[Trade]
    invested: float
    realised: float
    dividends: float
    shares_now: float
    cost_now: float
    avg_cost: float
    avg_exit: float | None
    sold_shares: float
    sold_usd: float


def compute_position(
    stock_id: int,
    shares_by_q: dict[int, float],
    px: dict[int, QuarterPx],
    segment_start_q: int,
    last_q: int,
    implied_px: dict[int, float],
) -> PositionResult | None:
    """The position of one stock over the quarters `segment_start_q`..`last_q`.

    `shares_by_q` holds the split-adjusted shares per quarter; a missing quarter is zero shares,
    and quarters before `segment_start_q` are ignored. `implied_px` is the fund's reported
    value per share, the fallback price. None when the stock is never held at a quarter where it
    has a price.

    A quarter without any price keeps the position at its previous valuation. A position that
    cannot be valued yet stays out of the book and enters it when a price appears, taken as
    bought at that quarter's close, like a first report."""
    quarters: list[PositionQuarter] = []
    trades: list[Trade] = []
    shares = cost = close = 0.0  # the holding after the last quarter, and its valuation close
    invested = realised = dividends = bought_shares = sold_shares = sold_usd = 0.0
    exit_q = None
    for q in range(segment_start_q, last_q + 1):
        reported = float(shares_by_q.get(q, 0.0))
        if shares == 0 and reported == 0:
            continue  # flat: no valuation needed
        prev_shares, prev_close = shares, close
        close = _valuation_close(px, q, implied_px)
        if close is None and prev_shares > 0:
            close = prev_close
        shares = reported if close is not None else 0.0
        if prev_shares == 0 and shares == 0:
            continue  # held but not yet priced: still outside the book
        delta = shares - prev_shares
        market_move = prev_shares * (close - prev_close) if prev_shares > 0 else 0.0
        quarter_px = px.get(q)
        dividend = prev_shares * quarter_px.div_ps if quarter_px is not None else 0.0
        trade_px = None
        net_buying = trade_gain = realised_q = 0.0
        if delta != 0:
            first_report = prev_shares == 0 and (
                q == segment_start_q or shares_by_q.get(q - 1, 0.0) > 0
            )
            trade_px = _trade_price(px, q, first_report, implied_px, close)
            net_buying = delta * trade_px
            trade_gain = delta * (close - trade_px)
            if delta > 0:
                kind = "new" if prev_shares == 0 else "add"
                cost += net_buying
                invested += net_buying
                bought_shares += delta
            else:
                kind = "exit" if shares == 0 else "trim"
                average_cost = cost / prev_shares
                realised_q = -delta * (trade_px - average_cost)
                cost = 0.0 if shares == 0 else cost + delta * average_cost
                sold_shares -= delta
                sold_usd -= net_buying
                if shares == 0:
                    exit_q = q
            trades.append(
                Trade(
                    q=q,
                    type=kind,
                    delta=delta,
                    px=trade_px,
                    low=quarter_px.low if quarter_px else None,
                    high=quarter_px.high if quarter_px else None,
                    shares_after=shares,
                    entry=first_report,
                )
            )
        realised += realised_q
        dividends += dividend
        quarters.append(
            PositionQuarter(
                q=q,
                shares=shares,
                delta=delta,
                trade_px=trade_px,
                cost=cost,
                realised=realised_q,
                market_move=market_move,
                trade_gain=trade_gain,
                dividends=dividend,
                value=shares * close,
                net_buying=net_buying,
            )
        )
    if not quarters:
        return None
    return PositionResult(
        stock_id=stock_id,
        from_q=quarters[0].q,
        to_q=None if shares > 0 else exit_q,
        quarters=quarters,
        trades=trades,
        invested=invested,
        realised=realised,
        dividends=dividends,
        shares_now=shares,
        cost_now=cost,
        avg_cost=invested / bought_shares,
        avg_exit=sold_usd / sold_shares if sold_shares > 0 else None,
        sold_shares=sold_shares,
        sold_usd=sold_usd,
    )


def _valuation_close(
    px: dict[int, QuarterPx], q: int, implied_px: dict[int, float]
) -> float | None:
    """The price a position is valued at in quarter `q`: the quarter's close, else the last close
    before it (a stock that stopped trading), else the reported value per share. None: unpriced."""
    quarter_px = px.get(q)
    if quarter_px is not None and quarter_px.close is not None:
        return quarter_px.close
    earlier = last_close_before(px, q)
    return earlier if earlier is not None else implied_px.get(q)


def _trade_price(
    px: dict[int, QuarterPx],
    q: int,
    first_report: bool,
    implied_px: dict[int, float],
    valuation_close: float,
) -> float:
    """The price at which quarter `q`'s share change trades: the close for a first report, else
    the quarter's VWAP, else the last close before it, else the reported value per share. The
    valuation close is the last resort, so a valued quarter always has a trade price: it is
    reached by a stock with no market data whose fund reported no value that quarter (a gap in
    `implied_px`), which trades at the position's previous valuation."""
    quarter_px = px.get(q)
    if first_report and quarter_px is not None and quarter_px.close is not None:
        return quarter_px.close
    if quarter_px is not None and quarter_px.vwap is not None:
        return quarter_px.vwap
    earlier = last_close_before(px, q)
    if earlier is not None:
        return earlier
    implied = implied_px.get(q)
    return implied if implied is not None else valuation_close
