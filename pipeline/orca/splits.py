"""Stock splits read from the 13F filings themselves, for stocks the price vendor has no history for.

A split leaves a holder's position unchanged but multiplies its share count: in one quarter every
holder that did not trade reports k times the shares, at a reported price (value / shares) k times
lower. Without the split, the engine reads that as k - 1 times the position bought at a price 1/k
of the last one, which books a false loss of most of the position. The vendor's split factors
correct this for every stock it has prices for; a stock it has none for at the time (a company
gone since, before 2013 half of all split value) gets the splits its holders' filings show.
"""

from datetime import date

import polars as pl

from orca.quarters import q_start
from orca.storage import Lake

# Split ratios looked for, reverse splits included.
FACTORS = (2.0, 3.0, 1.5, 4.0, 5.0, 10.0, 1.25, 4 / 3, 0.5, 0.25, 0.2, 0.1)
SHARE_TOLERANCE = 0.01  # a holder's share count is within 1% of k times the quarter before
PRICE_TOLERANCE = 0.25  # and its reported price within 25% of 1/k times (prices move)
MIN_AGREEING = 0.5  # of the holders reporting the stock in both quarters


def _part_quarter(part: str) -> int:
    return int(part[1:])  # "q-56" -> -56, "q053" -> 53


def infer_splits(lake: Lake, cusips: set[str]) -> dict[str, list[tuple[date, float]]]:
    """For each CUSIP of `cusips`, the splits its holders' filings show: (first day of the quarter
    in which the share counts changed, factor). A split is read in quarter q when at least
    MIN_AGREEING of the funds holding the stock in q - 1 and q report exactly k times the
    shares (SHARE_TOLERANCE) at about 1/k of the reported price (PRICE_TOLERANCE), the same k
    for all of them. Reads two quarters' holdings at a time, only the rows of `cusips`."""
    if not cusips:
        return {}
    wanted = sorted(cusips)
    parts = sorted(lake.parts("holdings"), key=_part_quarter)
    found: dict[str, list[tuple[date, float]]] = {}
    before, before_q = None, None
    for part in parts:
        q = _part_quarter(part)
        rows = (
            pl.scan_parquet(lake.root / "holdings" / f"{part}.parquet")
            .filter(
                (pl.col("kind") == "SH")
                & pl.col("cusip").is_in(wanted)
                & (pl.col("shares") > 0)
                & (pl.col("value_usd") > 0)
            )
            .select("cik", "cusip", "shares", "value_usd")
            .collect()
        )
        if before is not None and before_q == q - 1:
            for cusip, factor in _splits_between(before, rows):
                found.setdefault(cusip, []).append((q_start(q), factor))
        before, before_q = rows, q
    return found


def _splits_between(before: pl.DataFrame, after: pl.DataFrame) -> list[tuple[str, float]]:
    """(cusip, factor) of the splits between two consecutive quarters' holdings."""
    pairs = before.join(after, on=["cik", "cusip"], suffix="_after")
    if pairs.is_empty():
        return []
    k = pl.col("shares_after") / pl.col("shares")
    price_ratio = (pl.col("value_usd") / pl.col("shares")) / (
        pl.col("value_usd_after") / pl.col("shares_after")
    )
    matched = pl.lit(None, dtype=pl.Float64)
    for factor in reversed(FACTORS):  # the first factor that fits wins
        fits = ((k / factor - 1).abs() <= SHARE_TOLERANCE) & (
            (price_ratio / factor - 1).abs() <= PRICE_TOLERANCE
        )
        matched = pl.when(fits).then(pl.lit(factor)).otherwise(matched)
    pairs = pairs.with_columns(factor=matched)
    holders = pairs.group_by("cusip").agg(holders=pl.len())
    agreeing = (
        pairs.filter(pl.col("factor").is_not_null())
        .group_by("cusip", "factor")
        .agg(agreeing=pl.len())
        .join(holders, on="cusip")
        .filter(pl.col("agreeing") >= MIN_AGREEING * pl.col("holders"))
        .sort("cusip", "agreeing", descending=[False, True])
        .unique("cusip", keep="first", maintain_order=True)
    )
    return list(agreeing.select("cusip", "factor").iter_rows())
