"""Our own index for every hierarchy label: sector, industry and industry vertical, plus the whole market.

Market-cap weighted with no cap on any stock, rebalanced each quarter, total return with dividends
(DECISIONS 2026-11-17). A hierarchy label's index holds every stock whose main label sits under it, so each tier
partitions the market and industries, sectors and the market are cap-weighted sums of their stocks.

Per label and quarter q, with weights wᵢ fixed by market caps at the end of q−1:
  ret       = Σ wᵢ (closeᵢ,q + divᵢ,q) / closeᵢ,q−1 − 1
  level_end = level_end(q−1) × (1 + ret)        (1 at the quarter before the first return)
  level_avg = level_end(q−1) × Σ wᵢ vwapᵢ,q / closeᵢ,q−1   (fund trades are priced at the quarter VWAP)
A stale close (more than STALE_DAYS before the quarter end) sits out of the quarter it ends and the next one,
unless the stock never trades again: then it is a delisting and earns its return up to that last close.
"""

from __future__ import annotations

from datetime import timedelta

import polars as pl

from orca.quarters import BASE_YEAR, q_end
from orca.shares_hist import SCHEMA as SHARES_SCHEMA
from orca.shares_hist import shares_asof

MARKET = "Market"
SEP = " > "
STALE_DAYS = 7  # about five trading days
QUARTER_SCHEMA = pl.Schema(
    {"stock_id": pl.Int32, "q": pl.Int32, "close": pl.Float64, "div": pl.Float64, "vwap": pl.Float64, "cap": pl.Float64, "stale": pl.Boolean}
)
OUT_SCHEMA = pl.Schema(
    {"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "ret": pl.Float64, "level_end": pl.Float64, "level_avg": pl.Float64,
     "n": pl.Int32, "cap": pl.Float64, "top_weight": pl.Float64}
)  # fmt: skip
__all__ = ["MARKET", "QUARTER_SCHEMA", "SHARES_SCHEMA", "index_returns", "market_caps", "stock_quarters"]


def stock_quarters(daily: pl.DataFrame) -> pl.DataFrame:
    """Per stock and quarter: last close, its date, stale flag, raw (as traded) close, dividends and VWAP.

    `daily` is `split_adjust_prices` output (split-adjusted bars that keep the raw split_factor)."""
    close = pl.col("close")
    later = pl.col("split_factor").fill_null(1.0).reverse().cum_prod().reverse().shift(-1, fill_value=1.0).over("stock_id")
    typical = (pl.col("high").fill_null(close) + pl.col("low").fill_null(close) + close) / 3
    vol = pl.col("volume").fill_null(0.0)
    bars = (
        daily.sort("stock_id", "date")
        .with_columns(factor=later, q=((pl.col("date").dt.year() - BASE_YEAR) * 4 + (pl.col("date").dt.month() - 1) // 3).cast(pl.Int32))
        .filter(close.is_not_null() | (pl.col("dividend").fill_null(0.0) != 0))
    )  # fmt: skip
    priced = bars.filter(close.is_not_null())
    out = priced.group_by("stock_id", "q").agg(
        close.last(),
        pl.col("date").last().alias("last"),
        (close * pl.col("factor")).last().alias("raw_close"),
        pl.when(vol.sum() > 0).then((typical * vol).sum() / vol.sum()).otherwise(typical.mean()).alias("vwap"),
    )
    divs = bars.group_by("stock_id", "q").agg(pl.col("dividend").fill_null(0.0).sum().alias("div"))
    out = out.join(divs, on=["stock_id", "q"], how="left").with_columns(pl.col("div").fill_null(0.0))
    ends = pl.DataFrame({"q": sorted(set(out["q"].to_list()))}, schema={"q": pl.Int32})
    ends = ends.with_columns(pl.col("q").map_elements(lambda q: q_end(q) - timedelta(days=STALE_DAYS), return_dtype=pl.Date).alias("_cut"))
    return out.join(ends, on="q").with_columns(stale=pl.col("last") < pl.col("_cut")).drop("_cut").sort("stock_id", "q")


def market_caps(sq: pl.DataFrame, hist: pl.DataFrame, securities: pl.DataFrame, adr: dict[str, float]) -> tuple[pl.DataFrame, set[int]]:
    """(stock_id, q, cap) at each quarter end, and the stock ids that fell back to today's count.

    cap = raw close × the latest count filed by the quarter end; without a history, split-adjusted close ×
    today's `shares_out`. Both are per ADR for an ADR. A company with several share classes reports one
    total, so it is counted once, on its lowest stock id."""
    securities = securities.filter(pl.col("stock_id").is_in(sq["stock_id"].unique().to_list()))  # a bond sharing the CIK never wins
    first = securities.filter(pl.col("cik").is_null() | (pl.col("stock_id") == pl.col("stock_id").min().over("cik")))
    sq = sq.join(first.select("stock_id", "ticker", "shares_out"), on="stock_id")
    dates = {q: q_end(q) for q in sorted(set(sq["q"].to_list()))}
    asof = shares_asof(hist, list(dates.values()))
    asof = asof.join(pl.DataFrame({"q": list(dates), "asof": list(dates.values())}, schema={"q": pl.Int32, "asof": pl.Date}), on="asof")
    ratio = pl.col("ticker").replace_strict(adr, default=1.0, return_dtype=pl.Float64)
    out = sq.join(asof.select("stock_id", "q", "shares"), on=["stock_id", "q"], how="left").with_columns(
        cap=pl.when(pl.col("shares").is_not_null()).then(pl.col("raw_close") * pl.col("shares")).otherwise(pl.col("close") * pl.col("shares_out")) / ratio,
        fallback=pl.col("shares").is_null() & pl.col("shares_out").is_not_null(),
    )  # fmt: skip
    out = out.filter(pl.col("cap").is_not_null() & (pl.col("cap") > 0))
    return out.select("stock_id", pl.col("q").cast(pl.Int32), "cap"), set(out.filter("fallback")["stock_id"].to_list())


def index_returns(sq: pl.DataFrame, labels: dict[int, str], last_q: int) -> pl.DataFrame:
    """One row per hierarchy label (every tier, and MARKET) and quarter with a return, up to `last_q`.

    `sq` has QUARTER_SCHEMA columns (cap = market cap at that quarter's end); `labels` maps stock_id to its
    vertical path. Stocks without a label are left out."""
    lab = pl.DataFrame({"stock_id": list(labels), "path": list(labels.values())}, schema={"stock_id": pl.Int32, "path": pl.String})
    s = sq.filter(pl.col("q") <= last_q).join(lab, on="stock_id").sort("stock_id", "q")
    prev = s.select("stock_id", (pl.col("q") + 1).alias("q"), pl.col("close").alias("close_p"), pl.col("cap").alias("cap_p"), pl.col("stale").alias("stale_p"))
    last = s.group_by("stock_id").agg(pl.col("q").max().alias("q_last"))
    r = (
        s.join(prev, on=["stock_id", "q"]).join(last, on="stock_id")
        .filter(pl.col("close").is_not_null() & (pl.col("close_p") > 0) & (pl.col("cap_p") > 0) & ~pl.col("stale_p")
                & (~pl.col("stale") | (pl.col("q") == pl.col("q_last"))))
        .with_columns(
            r=(pl.col("close") + pl.col("div")) / pl.col("close_p") - 1,
            a=pl.col("vwap").fill_null(pl.col("close")) / pl.col("close_p"),
            vertical=pl.col("path"),
            industry=pl.col("path").str.split(SEP).list.slice(0, 2).list.join(SEP),
            sector=pl.col("path").str.split(SEP).list.first(),
            market=pl.lit(MARKET),
        )
    )  # fmt: skip
    parts = []
    for tier, key in enumerate(("market", "sector", "industry", "vertical")):
        g = r.group_by(key, "q").agg(
            ((pl.col("cap_p") * pl.col("r")).sum() / pl.col("cap_p").sum()).alias("ret"),
            ((pl.col("cap_p") * pl.col("a")).sum() / pl.col("cap_p").sum()).alias("avg"),
            pl.len().cast(pl.Int32).alias("n"),
            pl.col("cap_p").sum().alias("cap"),
            (pl.col("cap_p").max() / pl.col("cap_p").sum()).alias("top_weight"),
        )
        parts.append(g.rename({key: "label"}).with_columns(tier=pl.lit(tier, pl.Int8)))
    out = pl.concat(parts).sort("label", "q")
    growth = (1 + pl.col("ret")).cum_prod().over("label")
    out = out.with_columns(level_end=growth).with_columns(
        level_avg=pl.col("level_end").shift(1, fill_value=1.0).over("label") * pl.col("avg")
    )
    return out.select(*OUT_SCHEMA.names()).cast(OUT_SCHEMA)
