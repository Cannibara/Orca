"""Per-quarter price summary of one stock's split-adjusted daily bars.

The trade price of a quarter is its volume-weighted average of the daily typical price
(high + low + close) / 3. The same VWAP per calendar month backs the cost basis of a position
opened part-way through a quarter.
"""

from dataclasses import dataclass
from datetime import date

import polars as pl

from orca.quarters import BASE_YEAR


@dataclass(frozen=True)
class QuarterPx:
    """One quarter of a stock's prices on today's share basis. The price fields are None only
    when the quarter has rows but none with a close."""

    vwap: float | None
    low: float | None
    high: float | None
    close: float | None  # close of the last trading day in the quarter
    div_ps: float  # dividends per share paid in the quarter
    monthly_vwap: tuple[float | None, float | None, float | None]  # None: no priced day that month


def quarter_px(daily: pl.DataFrame) -> dict[int, QuarterPx]:
    """The quarters in which `daily` has rows. `daily` holds one stock's split-adjusted bars
    (date, high, low, close, volume, dividend; other columns are ignored), in any order.

    A day without a close is not priced: it adds nothing to the VWAP, low, high or close, but its
    dividend still counts. A missing high or low is taken to be the close. A missing volume is
    zero, and a quarter or month with no volume at all is priced at the plain mean of its typical
    prices. Quarters without rows are absent."""
    if daily.is_empty():
        return {}
    close = pl.col("close")
    priced = close.is_not_null()
    typical = (pl.col("high").fill_null(close) + pl.col("low").fill_null(close) + close) / 3
    bars = (
        daily.sort("date")
        .select(
            q=(pl.col("date").dt.year() - BASE_YEAR) * 4 + (pl.col("date").dt.month() - 1) // 3,
            month=(pl.col("date").dt.month() - 1) % 3,
            typical=typical,
            volume=pl.when(priced).then(pl.col("volume").fill_null(0.0)).otherwise(0.0),
            low=pl.when(priced).then(pl.col("low").fill_null(close)),
            high=pl.when(priced).then(pl.col("high").fill_null(close)),
            close=close,
            dividend=pl.col("dividend").fill_null(0.0),
        )
        .with_columns(weighted=pl.col("typical") * pl.col("volume"))
    )
    quarters = bars.group_by("q").agg(
        _vwap().alias("vwap"),
        pl.col("low").min(),
        pl.col("high").max(),
        pl.col("close").drop_nulls().last(),  # rows are sorted by date
        pl.col("dividend").sum().alias("div_ps"),
    )
    months = {
        (q, month): vwap
        for q, month, vwap in bars.group_by("q", "month")
        .agg(_vwap().alias("vwap"))
        .iter_rows()
    }
    return {
        row["q"]: QuarterPx(
            vwap=row["vwap"],
            low=row["low"],
            high=row["high"],
            close=row["close"],
            div_ps=row["div_ps"],
            monthly_vwap=tuple(months.get((row["q"], month)) for month in range(3)),
        )
        for row in quarters.iter_rows(named=True)
    }


def _vwap() -> pl.Expr:
    """Aggregate of a group of `quarter_px` bars: volume-weighted mean of the typical price, or
    its plain mean when the group has no volume."""
    volume = pl.col("volume").sum()
    weighted_mean = pl.col("weighted").sum() / volume
    return pl.when(volume > 0).then(weighted_mean).otherwise(pl.col("typical").mean())


def close_on(daily: pl.DataFrame, d: date) -> float | None:
    """The close of the latest day on or before `d` that has one, or None when there is none.
    `daily` holds one stock's bars (date, close), in any order."""
    closes = daily.filter((pl.col("date") <= d) & pl.col("close").is_not_null())
    if closes.is_empty():
        return None
    return closes.sort("date").get_column("close")[-1]


def last_close_before(px: dict[int, QuarterPx], q: int) -> float | None:
    """The close of the latest quarter before `q` that has one: the price a position is exited
    at when the stock stopped trading (delisted, acquired). None when there is no such quarter."""
    for earlier in sorted((k for k in px if k < q), reverse=True):
        if px[earlier].close is not None:
            return px[earlier].close
    return None
