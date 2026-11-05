"""Home page lists: top funds, conviction moves, wins and losses, latest filings, crowded buys and
calls. Every list is a plain function of the per-fund snapshots and returns JSON-ready rows
(dicts of int, float, str and None; dates as ISO strings), identified by stock_id and fund_id."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from orca.config import (
    CALLS_MIN_MCAP,
    CALLS_MIN_PRICE,
    CALLS_MIN_WEIGHT,
    CONC_MAX_POS,
    CONC_MIN_BOOK,
    CONC_MIN_POS,
    CONC_MIN_TOP10,
    CONVICTION_LOOKBACK,
    CONVICTION_MAX_BOOK_CHANGE,
    CONVICTION_MAX_ROWS,
    CONVICTION_MAX_TOP,
    CONVICTION_MIN_MOVE,
    CONVICTION_QUIET,
    CONVICTION_USUAL_X,
    CONVICTION_VS_TOP,
    CONVICTION_WINDOW,
    CROWDED_MIN_FUNDS,
    EXCLUDE_NAME_WORDS,
    GIANT_MIN_POSITIONS,
    PERIODS,
    TOP_MIN_BOOK,
    TOP_MIN_POSITIONS,
    TOP_MIN_PRICED,
    TOP_MIN_QUARTERS,
)
from orca.engine.metrics import Performance
from orca.engine.position import Trade

_BUYS = ("new", "add")
CALLS_EACH_END = 50  # the calls lists keep this many best and this many worst rows
# A listed word must start a word of the name: "FIRST BANK" and "BANKSHARES" are banks, while
# "DRIFTBANK" is not.
_EXCLUDED = re.compile(r"(?<![A-Z0-9])(?:" + "|".join(map(re.escape, EXCLUDE_NAME_WORDS)) + ")")


@dataclass(frozen=True, slots=True)
class FundSnapshot:
    """One fund's latest figures, as the home lists need them. Weights are shares of the book
    keyed by stock_id (`weights_prev` is the quarter before `weights_now`). `trades_latest` pairs
    each stock_id with its trade in the latest quarter; `pnl_latest` is the latest quarter's P&L
    per stock; `buys_recent` holds (stock_id, q, est. price, weight after, filed) for recent new
    and add trades. Both leave out entry trades (`Trade.entry`: a first report is no move). `perf`
    is keyed by period (the keys of `config.PERIODS`), None when too short.

    `conviction_quarters` holds what the conviction lists need of each of the fund's last
    CONVICTION_LOOKBACK + CONVICTION_WINDOW quarters (`ConvictionQuarter`), so their rules apply at
    publish time and changing one needs no recompute. A snapshot stored before it existed has none,
    which keeps the fund off those lists until it is recomputed."""

    fund_id: int
    name: str
    book: float
    n_priced: int
    priced_pct: float
    quarters_filed: int
    excluded: bool
    weights_now: dict[int, float]
    weights_prev: dict[int, float]
    trades_latest: list[tuple[int, Trade]]
    pnl_latest: dict[int, float]
    buys_recent: list[tuple[int, int, float, float, date]]
    perf: dict[str, Performance | None]
    filed: date
    period_q: int
    conviction_quarters: tuple["ConvictionQuarter", ...] = ()


@dataclass(frozen=True, slots=True)
class ConvictionQuarter:
    """One quarter of a fund as the conviction lists see it: its AUM (priced book) at the start
    and end, its largest holding at the start (a share of the book), how many positions it held at
    the end, whether it filed both this quarter and the one before (a quarter it skipped is a copy
    of the one before, with no trades), its net flow (`flow`: the dollars of every trade of the
    quarter, sales negative; money coming in or going out), and its moves of CONVICTION_KEEP or
    more of the smaller of its start and end AUM: (stock_id, type, usd, w_prev, w_after, px),
    `usd` the dollars traded (negative: sold), `w_prev` and `w_after` the stock's weight at the
    start and end, `px` the estimated trade price. Entry trades (a first report, a holding priced
    for the first time) are no move and are left out. A record stored before `flow` existed reads
    back with no flow: its moves count as traded until the fund is recomputed."""

    q: int
    start: float
    end: float
    top_prev: float
    n_held: int
    filed_pair: bool
    moves: tuple[tuple[int, str, float, float, float, float], ...]
    flow: float = 0.0


def is_excluded_name(name: str) -> bool:
    """Whether a fund name marks a bank, insurer or broker: one of EXCLUDE_NAME_WORDS
    at the start of a word (case-insensitive)."""
    return _EXCLUDED.search(name.upper()) is not None


def top_funds(snaps: list[FundSnapshot], period: str) -> dict[str, list[dict]]:
    """The funds worth ranking over `period` (a key of `config.PERIODS`), by return per year.

    A fund needs the top-fund basics (book, quarters filed, priced positions, priced share of
    the book, not a bank or similar) and a performance for the period. Funds holding
    GIANT_MIN_POSITIONS or more priced positions are index giants and are listed apart, in
    "giants", never in "eligible"."""
    if period not in PERIODS:
        raise ValueError(f"unknown period {period!r}")
    ranked = []
    for s in snaps:
        p = s.perf.get(period)
        if p is None or not _top_base(s):
            continue
        ranked.append((s, p))
    ranked.sort(key=lambda sp: _return_order(sp[1].ann_return) + (sp[0].fund_id,))
    out: dict[str, list[dict]] = {"eligible": [], "giants": []}
    for s, p in ranked:
        row = {
            "fund_id": s.fund_id,
            "name": s.name,
            "book": float(s.book),
            "n_positions": int(s.n_priced),
            "ann_return": _num(p.ann_return),
            "max_dd": _num(p.max_dd),
            "sharpe": _num(p.sharpe),
        }
        out["giants" if s.n_priced >= GIANT_MIN_POSITIONS else "eligible"].append(row)
    return out


def conviction_moves(
    snaps: list[FundSnapshot],
    window: str,
    *,
    latest_q: int | None = None,
    not_stocks: frozenset[int] = frozenset(),
) -> list[dict]:
    """Moves large for the fund that made them, in the latest quarter (`window` "q") or in each of
    the latest CONVICTION_WINDOW quarters ("y"), the most unusual first, at most
    CONVICTION_MAX_ROWS. `not_stocks` (the ETFs) are neither listed nor set a usual move.

    `latest_q` is the quarter the lists are about; when None it is the newest `period_q` among
    the snapshots not excluded by name or flag, so one early or bad filer cannot make the rest
    stale. Quarters after it are never listed.

    A move's size is `_move_size`: a buy over the fund's AUM at the end of the quarter, a sale
    over its AUM at the start, with the fund's money in or out taken out of adds and trims. The
    fund's usual move is its biggest single move of the CONVICTION_LOOKBACK quarters before,
    measured the same way (only quarters it started with a book count; with none, there is
    nothing to compare with and the quarter is skipped). A move is listed when it is
    CONVICTION_MIN_MOVE or more of the AUM, CONVICTION_USUAL_X times the usual move or more (a
    usual move under CONVICTION_QUIET counts as CONVICTION_QUIET) and CONVICTION_VS_TOP or more of
    the largest holding at the quarter's start, in a quarter `_conviction_quarter` accepts, by a
    fund not excluded. `score` (the move over the usual one) orders the rows; trims and exits
    count like buys."""
    anchor = _anchor(snaps, latest_q)
    if anchor is None:
        return []
    span = 1 if window == "q" else CONVICTION_WINDOW
    wanted = range(anchor - span + 1, anchor + 1)
    rows = []
    for s in snaps:
        if _excluded(s):
            continue
        records = {r.q: r for r in s.conviction_quarters}
        for q in wanted:
            r = records.get(q)
            if r is None or not _conviction_quarter(r):
                continue
            usual = _usual_move(records, q, not_stocks)
            if usual is None:
                continue
            floor = max(usual, CONVICTION_QUIET)
            for stock_id, kind, usd, w_prev, w_after, px in r.moves:
                if stock_id in not_stocks:
                    continue
                size = _move_size(r, kind, usd, w_prev)
                # Rounded so a move of exactly a threshold is not lost to float error.
                if not (
                    round(size - CONVICTION_MIN_MOVE, 12) >= 0
                    and round(size - CONVICTION_USUAL_X * floor, 12) >= 0
                    and round(size - CONVICTION_VS_TOP * r.top_prev, 12) >= 0
                ):
                    continue
                rows.append(
                    {
                        "fund_id": s.fund_id,
                        "name": s.name,
                        "stock_id": stock_id,
                        "q": q,
                        "move": kind,
                        "usd": float(usd),
                        "weight_after": float(w_after),
                        "change_pts": float((w_after - w_prev) * 100),
                        "est_price": float(px),
                        "score": float(size / floor),
                    }
                )
    rows.sort(key=lambda r: (-r["score"], r["fund_id"], r["stock_id"], r["q"]))
    return rows[:CONVICTION_MAX_ROWS]


def _conviction_quarter(r: ConvictionQuarter) -> bool:
    """A quarter whose moves can count: filed with the one before, an AUM of CONC_MIN_BOOK or
    more that neither grew nor shrank more than CONVICTION_MAX_BOOK_CHANGE times (a jump comes
    from holdings priced for the first time, restructurings or reporting errors, not trading),
    no index giant, and a largest holding at the start of CONVICTION_MAX_TOP or less (holding
    companies and single-stock vehicles are left out)."""
    return (
        r.filed_pair
        and r.start > 0
        and r.end >= CONC_MIN_BOOK
        and 1 / CONVICTION_MAX_BOOK_CHANGE <= r.end / r.start <= CONVICTION_MAX_BOOK_CHANGE
        and r.n_held < GIANT_MIN_POSITIONS
        and 0 < r.top_prev <= CONVICTION_MAX_TOP
    )


def _usual_move(
    records: dict[int, ConvictionQuarter], q: int, not_stocks: frozenset[int]
) -> float | None:
    """The biggest single move of the CONVICTION_LOOKBACK quarters before `q` that the fund
    started with a book, each over its own quarter's AUM; None when there is no such quarter."""
    before = [
        records[p]
        for p in range(q - CONVICTION_LOOKBACK, q)
        if p in records and records[p].start > 0
    ]
    if not before:
        return None
    return max(
        (
            _move_size(r, kind, usd, w_prev)
            for r in before
            for stock_id, kind, usd, w_prev, *_ in r.moves
            if stock_id not in not_stocks
        ),
        default=0.0,
    )


def _move_size(r: ConvictionQuarter, kind: str, usd: float, w_prev: float) -> float:
    """One move as a share of the fund: a buy over the AUM it ends the quarter with, a sale over
    the AUM it was sold out of (the start). An add or a trim first loses its pro-rata share of
    the quarter's money in or out (`flow` times the stock's weight at the start): new money spread
    over the book, or a redemption taken from every holding, is no decision about the stock. The
    flow only ever shrinks a move, never enlarges or flips it. A new position or an exit counts as
    traded."""
    counted = usd
    if kind in ("add", "trim"):
        counted = usd - r.flow * w_prev
        counted = min(max(counted, 0.0), usd) if usd > 0 else max(min(counted, 0.0), usd)
    base = r.end if usd > 0 else r.start
    return abs(counted) / base if base > 0 else 0.0


def wins_losses(
    snaps: list[FundSnapshot], n: int = 25, *, latest_q: int | None = None
) -> dict[str, list[dict]]:
    """The `n` biggest winning and losing positions of the latest quarter across the top-fund
    basics (any period, index giants included): {"wins": pnl > 0 largest first, "losses":
    pnl < 0 most negative first}. Funds whose `period_q` is not the latest quarter are left out.

    `latest_q` is the quarter the list is about; when None it is the newest `period_q` among the
    snapshots not excluded by name or flag, so one early or bad filer cannot make the rest stale."""
    wins, losses = [], []
    for s in _latest(snaps, latest_q):
        if not _top_base(s):
            continue
        for stock_id, pnl in s.pnl_latest.items():
            row = {"fund_id": s.fund_id, "name": s.name, "stock_id": stock_id, "pnl": float(pnl)}
            if pnl > 0:
                wins.append(row)
            elif pnl < 0:
                losses.append(row)
    wins.sort(key=lambda r: (-r["pnl"], r["fund_id"], r["stock_id"]))
    losses.sort(key=lambda r: (r["pnl"], r["fund_id"], r["stock_id"]))
    return {"wins": wins[:n], "losses": losses[:n]}


def just_filed(snaps: list[FundSnapshot], n: int = 50) -> list[dict]:
    """The `n` latest filings by funds that are not excluded by name, newest first (ties by
    name). The headline is the stock whose weight changed most, either way; its
    `headline_change_pts` is signed, in percentage points. Both are None for a fund without
    stocks."""
    listed = [s for s in snaps if not _excluded(s)]
    listed.sort(key=lambda s: (-s.filed.toordinal(), s.name, s.fund_id))
    rows = []
    for s in listed[:n]:
        stocks = sorted(s.weights_now.keys() | s.weights_prev.keys())
        change = {
            stock_id: s.weights_now.get(stock_id, 0.0) - s.weights_prev.get(stock_id, 0.0)
            for stock_id in stocks
        }
        headline = max(stocks, key=lambda stock_id: abs(change[stock_id])) if stocks else None
        rows.append(
            {
                "fund_id": s.fund_id,
                "name": s.name,
                "filed": s.filed.isoformat(),
                "period_q": int(s.period_q),
                "book": float(s.book),
                "headline_stock_id": headline,
                "headline_change_pts": None if headline is None else float(change[headline] * 100),
            }
        )
    return rows


def crowded_buys(snaps: list[FundSnapshot], *, latest_q: int | None = None) -> list[dict]:
    """Stocks that at least CROWDED_MIN_FUNDS distinct concentrated active funds bought (new or
    add) in the latest quarter: fund count, dollars bought and the funds' mean weight after.
    Funds whose `period_q` is not the latest quarter are left out.

    `latest_q` is the quarter the list is about; when None it is the newest `period_q` among the
    snapshots not excluded by name or flag, so one early or bad filer cannot make the rest stale."""
    buyers: dict[int, dict[int, tuple[float, float]]] = {}  # stock -> fund -> (dollars, weight)
    for s in _latest(snaps, latest_q):
        if not _concentrated(s):
            continue
        for stock_id, t in s.trades_latest:
            if t.type not in _BUYS:
                continue
            by_fund = buyers.setdefault(stock_id, {})
            dollars = by_fund.get(s.fund_id, (0.0, 0.0))[0] + t.delta * t.px
            by_fund[s.fund_id] = (dollars, s.weights_now.get(stock_id, 0.0))
    rows = [
        {
            "stock_id": stock_id,
            "funds_buying": len(by_fund),
            "total_bought": float(sum(d for d, _ in by_fund.values())),
            "avg_weight_after": float(sum(w for _, w in by_fund.values()) / len(by_fund)),
        }
        for stock_id, by_fund in buyers.items()
        if len(by_fund) >= CROWDED_MIN_FUNDS
    ]
    rows.sort(key=lambda r: (-r["funds_buying"], -r["total_bought"], r["stock_id"]))
    return rows


def calls(
    snaps: list[FundSnapshot],
    mcap: dict[int, float],
    latest_px: dict[int, float],
    px_on_filed: Callable[[int, date], float | None],
    window: str,
    *,
    latest_q: int | None = None,
) -> list[dict]:
    """Recent buys by top funds (index giants excluded: their inflow-driven adds would flood the
    list) and concentrated funds, ordered by the stock's move since the fund's estimated buy
    price (latest price / est. price - 1), best first; the browser shows the top as the best
    calls and the bottom as the worst.

    A buy must be CALLS_MIN_WEIGHT or more of the book, in a stock with a known market cap of
    CALLS_MIN_MCAP or more and a known latest price of CALLS_MIN_PRICE or more. Window "q" keeps
    buys of the latest quarter, "y" those of the latest four (never a later quarter, such as an
    early filer's). A buy without a positive est. price has no move to rank and is left out.
    Only the CALLS_EACH_END best and CALLS_EACH_END worst rows are kept.

    `latest_q` is the quarter the list is about; when None it is the newest `period_q` among the
    snapshots not excluded by name or flag, so one early or bad filer cannot make the rest stale."""
    if window not in ("q", "y"):
        raise ValueError(f"unknown window {window!r}")
    latest_q = _anchor(snaps, latest_q)
    if latest_q is None:
        return []
    oldest_q = latest_q if window == "q" else latest_q - 3
    ranked = []
    for s in snaps:
        if not ((_top_base(s) and s.n_priced < GIANT_MIN_POSITIONS) or _concentrated(s)):
            continue
        for stock_id, q, est_price, weight_after, filed in s.buys_recent:
            if not oldest_q <= q <= latest_q or weight_after < CALLS_MIN_WEIGHT or est_price <= 0:
                continue
            cap, price = mcap.get(stock_id), latest_px.get(stock_id)
            if cap is None or cap < CALLS_MIN_MCAP or price is None or price < CALLS_MIN_PRICE:
                continue
            row = {
                "stock_id": stock_id,
                "fund_id": s.fund_id,
                "name": s.name,
                "q": int(q),
                "est_price": float(est_price),
                "price_on_filed": _num(px_on_filed(stock_id, filed)),
                "filed": filed.isoformat(),
            }
            ranked.append((price / est_price - 1, row))
    ranked.sort(key=lambda pr: (-pr[0], pr[1]["fund_id"], pr[1]["stock_id"], pr[1]["q"]))
    if len(ranked) > 2 * CALLS_EACH_END:
        ranked = ranked[:CALLS_EACH_END] + ranked[-CALLS_EACH_END:]
    return [row for _, row in ranked]


def _anchor(snaps: list[FundSnapshot], latest_q: int | None) -> int | None:
    """The latest quarter: `latest_q` when given, else the newest `period_q` among the snapshots
    not excluded; None when there is none."""
    if latest_q is not None:
        return latest_q
    periods = [s.period_q for s in snaps if not _excluded(s)]
    return max(periods) if periods else None


def _latest(snaps: list[FundSnapshot], latest_q: int | None) -> list[FundSnapshot]:
    """The snapshots of the latest quarter; stale and early filers are left out."""
    anchor = _anchor(snaps, latest_q)
    return [s for s in snaps if s.period_q == anchor]


def _excluded(s: FundSnapshot) -> bool:
    return s.excluded or is_excluded_name(s.name)


def _top_base(s: FundSnapshot) -> bool:
    """The top-fund basics, before any period's performance."""
    return (
        s.book >= TOP_MIN_BOOK
        and s.quarters_filed >= TOP_MIN_QUARTERS
        and s.n_priced >= TOP_MIN_POSITIONS
        and s.priced_pct >= TOP_MIN_PRICED
        and not _excluded(s)
    )


def _concentrated(s: FundSnapshot) -> bool:
    """A concentrated active fund: few enough positions, a heavy top ten, a big enough book."""
    top10 = sum(sorted(s.weights_now.values(), reverse=True)[:10])
    return (
        CONC_MIN_POS <= s.n_priced <= CONC_MAX_POS
        and top10 >= CONC_MIN_TOP10
        and s.book >= CONC_MIN_BOOK
        and not _excluded(s)
    )


def _return_order(ann_return: float | None) -> tuple[bool, float]:
    """Sort key putting the highest return first and a missing one last."""
    return (ann_return is None, -(ann_return or 0.0))


def _num(x: float | None) -> float | None:
    return None if x is None else float(x)
