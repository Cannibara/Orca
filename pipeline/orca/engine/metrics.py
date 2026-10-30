"""Fund-level figures from the quarterly returns and positions: risk-adjusted performance,
turnover, holding periods and price coverage."""

import math
import statistics
from dataclasses import dataclass

import polars as pl

from orca.engine.fund import FundQuarter, FundYear, full_years
from orca.engine.position import PositionResult
from orca.quarters import BASE_YEAR


@dataclass(frozen=True, slots=True)
class Performance:
    """Annualised figures from quarterly returns (four quarters a year). Sharpe, Sortino and
    Calmar are None when their denominator is zero; `max_dd` is <= 0."""

    ann_return: float | None
    sharpe: float | None
    sortino: float | None
    vol: float | None
    max_dd: float | None
    calmar: float | None
    quarters_pos_pct: float | None


def performance(rets: list[tuple[int, float]], rf_by_year: dict[int, float]) -> Performance | None:
    """Performance of `rets`, (quarter, return) pairs without missing returns. None below four.

    The quarter's risk-free rate is its year's rate / 4; a year without a rate takes the latest
    earlier year's, else 0. ann_return = growth ** (4 / n) - 1, vol = sample stdev x 2,
    Sharpe = mean excess x 4 / (sample stdev of excess x 2), Sortino divides by
    sqrt(mean(min(0, excess) ** 2)) x 2, max_dd is the worst fall of the chained index (starting
    at 1.0) from its peak, Calmar = ann_return / |max_dd|."""
    if len(rets) < 4:
        return None
    ordered = sorted(rets)
    returns = [r for _, r in ordered]
    n = len(returns)
    excess = [r - _quarterly_rf(q, rf_by_year) for q, r in ordered]
    growth = math.prod(1 + r for r in returns)
    # a return below -100% would make the growth negative; the fractional power must stay real
    ann_return = max(growth, 0.0) ** (4 / n) - 1
    vol = statistics.stdev(returns) * 2
    excess_stdev = statistics.stdev(excess) * 2
    downside = math.sqrt(sum(min(0.0, x) ** 2 for x in excess) / n) * 2
    mean_excess = statistics.fmean(excess) * 4
    max_dd = _max_drawdown(returns)
    return Performance(
        ann_return=ann_return,
        sharpe=mean_excess / excess_stdev if excess_stdev != 0 else None,
        sortino=mean_excess / downside if downside != 0 else None,
        vol=vol,
        max_dd=max_dd,
        calmar=ann_return / abs(max_dd) if max_dd != 0 else None,
        quarters_pos_pct=sum(r > 0 for r in returns) / n,
    )


def turnover(years: list[FundYear], quarters: list[FundQuarter]) -> float | None:
    """Mean over the full years (see `full_years`) of min(buys, sells) / mean book, from `quarters`.

    A year's buys and sells are summed over its quarters; its mean book is the mean of the year's
    start and its four quarter ends. The year holding the segment's first quarter is left out
    (its buys are the whole book), as is a year with a quarter without a return and a year whose
    mean book is not positive. None when no year is left."""
    by_q = {fq.q: fq for fq in quarters}
    turnovers = []
    for year in full_years(years, quarters):
        year_quarters = [by_q[q] for q in year.qs]
        mean_book = statistics.fmean([year.start, *(fq.end for fq in year_quarters)])
        if mean_book <= 0:
            continue
        buys = sum(fq.buys for fq in year_quarters)
        sells = sum(fq.sells for fq in year_quarters)
        turnovers.append(min(buys, sells) / mean_book)
    return statistics.fmean(turnovers) if turnovers else None


def hold_lengths(positions: list[PositionResult], last_q: int) -> tuple[float, float | None]:
    """Mean holding period in years (a quarter counts a quarter of a year, ends included) over
    all positions, and over those sold out (`to_q` set); a position still held runs to `last_q`.
    (0.0, None) for no positions; the second is None when none was sold out."""
    lengths = [((p.to_q if p.to_q is not None else last_q) - p.from_q + 1) / 4 for p in positions]
    sold = [length for length, p in zip(lengths, positions) if p.to_q is not None]
    return (
        statistics.fmean(lengths) if lengths else 0.0,
        statistics.fmean(sold) if sold else None,
    )


def priced_pct(latest_holdings: pl.DataFrame, priced_cusips: set[str]) -> float:
    """The reported value of the latest quarter's share rows (kind "SH") whose cusip is priced,
    as a share of the quarter's total reported value; 0.0 for an empty book. `latest_holdings`
    has the columns cusip, kind and value_usd."""
    total = float(latest_holdings.get_column("value_usd").sum())
    if total <= 0:
        return 0.0
    priced = latest_holdings.filter(
        (pl.col("kind") == "SH") & pl.col("cusip").is_in(list(priced_cusips))
    )
    return float(priced.get_column("value_usd").sum()) / total


def _quarterly_rf(q: int, rf_by_year: dict[int, float]) -> float:
    year = BASE_YEAR + q // 4
    if year not in rf_by_year:
        earlier = [y for y in rf_by_year if y < year]
        if not earlier:
            return 0.0
        year = max(earlier)
    return rf_by_year[year] / 4


def _max_drawdown(returns: list[float]) -> float:
    index = peak = 1.0
    worst = 0.0
    for r in returns:
        index *= 1 + r
        peak = max(peak, index)
        worst = min(worst, index / peak - 1)
    return worst
