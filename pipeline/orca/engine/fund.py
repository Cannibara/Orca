"""A fund's quarters: the sum of its positions, with the return and the AUM bridge."""

import math
from dataclasses import dataclass

from orca.engine.position import PositionResult
from orca.quarters import BASE_YEAR

_QUARTERS_PER_YEAR = 4


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


@dataclass(frozen=True, slots=True)
class FundYear:
    """A calendar year of a fund's quarters, or the part of it the segment covers. `qs` are the
    quarters, start/end the book at the first quarter's start and the last quarter's end,
    gains = market move + trade gains, inflows = net buying. `ret` chains the quarterly returns
    (None when no quarter has one); `approx_ret` = (gains + dividends) / (start + inflows / 2),
    None when that denominator is not positive."""

    label: str
    qs: list[int]
    ret: float | None
    start: float
    end: float
    gains: float
    inflows: float
    dividends: float
    approx_ret: float | None


def fund_years(quarters: list[FundQuarter]) -> list[FundYear]:
    """The calendar years `quarters` fall in, in order. A year with fewer than four quarters is
    labelled by the quarters it covers (see `_year_label`)."""
    by_year: dict[int, list[FundQuarter]] = {}
    for fq in sorted(quarters, key=lambda fq: fq.q):
        by_year.setdefault(_year_of(fq.q), []).append(fq)
    years = []
    for year, qs in by_year.items():
        start, inflows = qs[0].start, sum(fq.net_buying for fq in qs)
        gains = sum(fq.market_move + fq.trade_gains for fq in qs)
        dividends = sum(fq.dividends for fq in qs)
        denominator = start + inflows / 2
        rets = [fq.ret for fq in qs if fq.ret is not None]
        years.append(
            FundYear(
                label=_year_label(year, [fq.q % 4 + 1 for fq in qs]),
                qs=[fq.q for fq in qs],
                ret=math.prod(1 + r for r in rets) - 1 if rets else None,
                start=start,
                end=qs[-1].end,
                gains=gains,
                inflows=inflows,
                dividends=dividends,
                approx_ret=(gains + dividends) / denominator if denominator > 0 else None,
            )
        )
    return years


def full_years(years: list[FundYear], quarters: list[FundQuarter]) -> list[FundYear]:
    """The years that can be judged as whole years, oldest first: four quarters, each with a
    return, and none of them the first quarter of `quarters`. That quarter has no return to
    measure (the book was empty at its start), so the year holding it covers fewer than four
    quarters of return. The year figures of the summary (best and worst year, years with a gain)
    and the turnover all use this one set of years."""
    if not quarters:
        return []
    first_q = min(fq.q for fq in quarters)
    returns = {fq.q: fq.ret for fq in quarters}
    return [
        year
        for year in sorted(years, key=lambda y: y.qs[0])
        if len(year.qs) == _QUARTERS_PER_YEAR
        and first_q not in year.qs
        and year.ret is not None
        and all(returns.get(q) is not None for q in year.qs)
    ]


def contributions(
    positions: list[PositionResult], years: list[FundYear]
) -> dict[str, list[tuple[int, float, float]]]:
    """Per year label, each position's (stock_id, points, pnl), largest points first.

    pnl = the position's market move + trade gain + dividends over the year's quarters; points =
    pnl / (year start + inflows / 2) x 100. A year whose denominator is not positive maps to an
    empty list, and a position with no quarters in a year is left out of it."""
    result: dict[str, list[tuple[int, float, float]]] = {}
    for year in years:
        denominator = year.start + year.inflows / 2
        rows = []
        if denominator > 0:
            quarters = set(year.qs)
            for position in positions:
                held = [pq for pq in position.quarters if pq.q in quarters]
                if not held:
                    continue
                pnl = sum(pq.market_move + pq.trade_gain + pq.dividends for pq in held)
                rows.append((position.stock_id, pnl / denominator * 100, pnl))
            rows.sort(key=lambda row: row[1], reverse=True)
        result[year.label] = rows
    return result


def _year_of(q: int) -> int:
    return BASE_YEAR + q // 4


def _year_label(year: int, quarters: list[int]) -> str:
    """The label of `year` by the quarters (1-4) it covers: "2025" for all four, else "2026 Q1",
    "2026 H1", "2014 H2", "2026 9M" or "2014 Q2–Q4"."""
    covered = set(quarters)
    if covered == {1, 2, 3, 4}:
        return str(year)
    if len(covered) == 1:
        return f"{year} Q{quarters[0]}"
    if covered == {1, 2}:
        return f"{year} H1"
    if covered == {3, 4}:
        return f"{year} H2"
    if covered == {1, 2, 3}:
        return f"{year} 9M"
    return f"{year} Q{min(covered)}–Q{max(covered)}"
