"""A fund's quarters: the sum of its positions, with the return and the AUM bridge."""

from dataclasses import dataclass

from orca.engine.position import PositionResult


@dataclass(frozen=True, slots=True)
class FundQuarter:
    """One quarter of a fund's priced long book. start = the previous quarter's end (0 for the
    first quarter); net_buying = buys - sells; `ret` is None when the quarter has no return."""

    q: int
    start: float
    end: float
    net_buying: float
    buys: float
    sells: float
    market_move: float
    trade_gains: float
    dividends: float
    ret: float | None


def aggregate_fund(
    positions: list[PositionResult], segment_start_q: int, last_q: int
) -> list[FundQuarter]:
    """The fund's quarters `segment_start_q`..`last_q`, summed over `positions` (all computed
    over that same segment). A quarter without positions is all zeros.

    The return is (end - start - net buying + dividends) / (start + net buying / 2), None for
    the segment's first quarter and wherever the start value or the denominator is not positive
    (a book that was empty at the start of the quarter has no return to measure)."""
    quarters = range(segment_start_q, last_q + 1)
    end, buys, sells, market_move, trade_gains, dividends = (
        dict.fromkeys(quarters, 0.0) for _ in range(6)
    )
    for position in positions:
        for pq in position.quarters:
            end[pq.q] += pq.value
            if pq.net_buying > 0:
                buys[pq.q] += pq.net_buying
            else:
                sells[pq.q] -= pq.net_buying
            market_move[pq.q] += pq.market_move
            trade_gains[pq.q] += pq.trade_gain
            dividends[pq.q] += pq.dividends
    result = []
    start = 0.0
    for q in quarters:
        net_buying = buys[q] - sells[q]
        denominator = start + net_buying / 2
        ret = None
        if q != segment_start_q and start > 0 and denominator > 0:
            ret = (end[q] - start - net_buying + dividends[q]) / denominator
        result.append(
            FundQuarter(
                q=q,
                start=start,
                end=end[q],
                net_buying=net_buying,
                buys=buys[q],
                sells=sells[q],
                market_move=market_move[q],
                trade_gains=trade_gains[q],
                dividends=dividends[q],
                ret=ret,
            )
        )
        start = end[q]
    return result


def check_bridge(fq: FundQuarter) -> bool:
    """Whether end = start + market move + net buying + trade gains, to one part in a million of
    the largest amount in the quarter. The scale includes the start value and the traded amount,
    not just `end`: a book sold off completely ends at 0, yet its terms are billions of dollars
    and rounding alone exceeds a tolerance of 1e-6."""
    gap = fq.end - (fq.start + fq.market_move + fq.net_buying + fq.trade_gains)
    scale = max(1.0, abs(fq.end), abs(fq.start), fq.buys + fq.sells)
    return abs(gap) <= 1e-6 * scale
