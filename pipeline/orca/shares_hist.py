"""Share counts over time, for market-cap weights in the sector indices.

`securities.shares_out` holds only the latest cover-page count, so today's count times a past price misweights
the past (Apple's count fell about 40% since 2013). The SEC companyconcept JSON that lookup downloads holds the
whole history of `dei:EntityCommonStockSharesOutstanding`; this keeps it, one row per period end, in the lake
table `shares_hist`. Counts are as reported, on the share basis of their `end` date (the cover-page date); the
sector step turns them to today's basis with the splits after that date, to pair with split-adjusted closes.

ADRs: a 20-F filer reports ordinary shares, but the price is per ADR, so `data/share_overrides.csv` gives the
ordinary shares per ADR for the big ones (TSM: 5).
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path

import polars as pl

SCHEMA = pl.Schema({"stock_id": pl.Int32, "end": pl.Date, "filed": pl.Date, "shares": pl.Float64})
OVERRIDES_FILE = Path(__file__).parent / "hierarchy" / "data" / "share_overrides.csv"


def history(body: dict | None) -> list[tuple[date, date, float]]:
    """(period end, filed, shares) per period end, oldest first.

    Same rule as `securities.fetch_shares_outstanding` for each end: the facts of the newest filing (by filed,
    then accn), exact repeats dropped, share classes summed.
    """
    try:
        facts = body["units"]["shares"]
    except (KeyError, TypeError):
        return []
    by_end: dict[str, list[dict]] = defaultdict(list)
    for f in facts:
        if f.get("end") and f.get("filed") and f.get("val") is not None:
            by_end[f["end"]].append(f)
    out = []
    for end in sorted(by_end):
        newest = max((f["filed"], f.get("accn") or "") for f in by_end[end])
        distinct = {(f["val"], f.get("accn"), f.get("form"), f.get("fp")) for f in by_end[end] if (f["filed"], f.get("accn") or "") == newest}
        out.append((date.fromisoformat(end), date.fromisoformat(newest[0]), float(sum(v for v, *_ in distinct))))
    return out


def frame(stock_id: int, rows: list[tuple[date, date, float]]) -> pl.DataFrame:
    return pl.DataFrame({"stock_id": [stock_id] * len(rows), "end": [r[0] for r in rows], "filed": [r[1] for r in rows],
                         "shares": [r[2] for r in rows]}, schema=SCHEMA)  # fmt: skip


def shares_asof(table: pl.DataFrame, dates: list[date]) -> pl.DataFrame:
    """stock_id, asof, shares, end: on each date, the count of the latest period end filed by then, and that
    period end (the day the count is as of, which a split after it changes the basis of)."""
    parts = []
    for d in dates:
        known = table.filter((pl.col("filed") <= d) & pl.col("shares").is_not_null())
        if known.height:
            parts.append(known.sort("end", "filed").group_by("stock_id").last().select("stock_id", pl.lit(d).alias("asof"), "shares", "end"))
    if not parts:
        return pl.DataFrame(schema={"stock_id": pl.Int32, "asof": pl.Date, "shares": pl.Float64, "end": pl.Date})
    return pl.concat(parts)


def load_overrides(path: Path = OVERRIDES_FILE) -> dict[str, float]:
    with open(path, newline="", encoding="utf-8") as f:
        return {r["ticker"]: float(r["ordinary_per_adr"]) for r in csv.DictReader(f)}


def adr_shares(shares: float, ticker: str, ratios: dict[str, float]) -> float:
    """The count in the unit the price is quoted in (ADRs for an ADR)."""
    return shares / ratios.get(ticker, 1.0)
