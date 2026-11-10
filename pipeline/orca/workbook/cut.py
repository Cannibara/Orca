"""The 500-position cut: a big fund keeps its top positions as stock rows, and the rest become
one "All other positions" line made of Orca's own sums, so fund-level figures stay exact."""

from dataclasses import dataclass
from datetime import date

from orca.engine.position import PositionResult
from orca.engine.whatif import _BUYS, _return_after, exit_rows
from orca.run.compute import Prepared


@dataclass(frozen=True)
class OtherInputs:
    """Orca's sums over the positions beyond the cut. Per-quarter lists have one entry per
    quarter column `start..bound` (0.0 outside the positions' quarters, so after `end_q`).
    `buys`/`sells` are the quarter's positive/negative net buying summed per position (as
    `fund.aggregate_fund`). Counts and sums stand in for the Outputs formulas of section 3.4."""

    value_filed: list[float]
    value: list[float]
    buys: list[float]
    sells: list[float]
    market_move: list[float]
    trade_gain: list[float]
    dividends: list[float]
    count: int
    held_now: int
    in_book_count: int
    value_now: float
    before_value_now: float
    profitable: int
    computable: int
    hold_sum_all: float
    hold_n_all: int
    hold_sum_sold: float
    hold_n_sold: int
    buys_1y_sum: float
    buys_1y_n: int
    sells_1y_sum: float
    sells_1y_n: int
    beat_pairs: int
    beat_n: int
    missed_early: float
    missed_dodged: float


def split_top(
    positions: list[PositionResult], max_positions: int
) -> tuple[list[PositionResult], list[PositionResult]]:
    """(top, rest): the `max_positions` positions with the highest peak quarter-end value, ties
    by stock_id, and the others. Both keep that order; with no excess `rest` is empty."""
    ranked = sorted(
        positions,
        key=lambda pos: (-max((pq.value for pq in pos.quarters), default=0.0), pos.stock_id),
    )
    return ranked[:max_positions], ranked[max_positions:]


def other_inputs(
    rest: list[PositionResult],
    p: Prepared,
    latest: dict[int, tuple[date, float]],
    period_q: int,
) -> OtherInputs:
    """The sums of `rest` (the positions beyond the cut), at the latest prices in `latest`."""
    index = {q: i for i, q in enumerate(range(p.start, p.bound + 1))}
    n = len(index)
    value_filed, value, buys, sells, move, gain, divs = ([0.0] * n for _ in range(7))
    for pos in rest:
        for q, (_, filed_value) in p.filed.get(pos.stock_id, {}).items():
            if q in index:
                value_filed[index[q]] += filed_value
        for pq in pos.quarters:
            i = index[pq.q]
            value[i] += pq.value
            if pq.net_buying > 0:
                buys[i] += pq.net_buying
            else:
                sells[i] -= pq.net_buying
            move[i] += pq.market_move
            gain[i] += pq.trade_gain
            divs[i] += pq.dividends

    held_now = value_now = before_value_now = 0.0
    profitable = computable = 0
    hold_all = hold_sold = 0.0
    n_sold = 0
    buys_sum = sells_sum = 0.0
    buys_n = sells_n = 0
    early = dodged = 0.0
    for pos in rest:
        price = latest[pos.stock_id][1] if pos.stock_id in latest else None
        held = pos.shares_now > 0
        held_now += held
        before = next((pq.shares for pq in pos.quarters if pq.q == period_q - 1), 0.0)
        if price is not None:
            value_now += pos.shares_now * price
            before_value_now += before * price
        if held and price is not None:
            total = pos.realised + pos.shares_now * price - pos.cost_now + pos.dividends
        elif not held:
            total = pos.realised + pos.dividends
        else:
            total = None
        if total is not None:
            computable += 1
            profitable += total > 0
        length = ((pos.to_q if pos.to_q is not None else p.end_q) - pos.from_q + 1) / 4
        hold_all += length
        if pos.to_q is not None:
            hold_sold += length
            n_sold += 1
        px = p.px.get(pos.stock_id, {})
        for trade in pos.trades:
            result = _return_after(px, trade.q, trade.px)
            if result is None:
                continue
            if trade.type in _BUYS:
                buys_sum += result
                buys_n += 1
            else:
                sells_sum += result
                sells_n += 1
        if pos.sold_shares > 0 and price is not None:
            missed = pos.sold_shares * price - pos.sold_usd
            if missed > 0:
                early += missed
            else:
                dodged -= missed

    px_by_stock = {pos.stock_id: p.px.get(pos.stock_id, {}) for pos in rest}
    pairs = [
        (row.one_y, row.spy_one_y)
        for row in exit_rows(rest, px_by_stock, p.spy_px)
        if row.one_y is not None and row.spy_one_y is not None
    ]
    return OtherInputs(
        value_filed=value_filed,
        value=value,
        buys=buys,
        sells=sells,
        market_move=move,
        trade_gain=gain,
        dividends=divs,
        count=len(rest),
        held_now=int(held_now),
        in_book_count=sum(1 for pos in rest if pos.quarters),
        value_now=value_now,
        before_value_now=before_value_now,
        profitable=profitable,
        computable=computable,
        hold_sum_all=hold_all,
        hold_n_all=len(rest),
        hold_sum_sold=hold_sold,
        hold_n_sold=n_sold,
        buys_1y_sum=buys_sum,
        buys_1y_n=buys_n,
        sells_1y_sum=sells_sum,
        sells_1y_n=sells_n,
        beat_pairs=sum(one_y > spy for one_y, spy in pairs),
        beat_n=len(pairs),
        missed_early=early,
        missed_dodged=dodged,
    )
