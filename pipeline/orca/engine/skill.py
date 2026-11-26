"""Stock picking vs sector allocation, by IRR (plan `docs/superpowers/plans/2026-11-17-sector-indices.md` §7).

Every score is one replay: a fund's real trades pushed through a return series. A buy puts the same dollars
into the series at the quarter's average level; a sell takes out the same fraction of the replay's units as of
the fund's shares (matching dollars could drive a replay negative); what is left is valued at the last quarter
end. The fund side replays each position through the stock's own total-return series (dividends reinvested), so
fund and index stand on the same footing. Per fund and tier (1 sector, 2 industry, 3 vertical):
  picking    = IRR(fund) − IRR(same flows in each pick's own hierarchy label's index)
  allocation = IRR(those label indices) − IRR(same flows in the market index)
A single-sector ETF is a pick at its own tier (finer tiers use that tier); a neutral ETF or an unlabelled stock
counts only in coverage; a conglomerate (@nosector) is compared with SPY. Times follow the web (`live.ts`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import polars as pl

from orca.engine.sectors import MARKET, SEP
from orca.quarters import q_end, q_start

TRADES_SCHEMA = pl.Schema(
    {"cik": pl.Int64, "stock_id": pl.Int32, "q": pl.Int32, "delta": pl.Float64, "px": pl.Float64, "shares_after": pl.Float64}
)
SERIES_SCHEMA = pl.Schema({"key": pl.String, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64})
EPOCH = date(2013, 1, 1)
TIERS = (1, 2, 3)


@dataclass(frozen=True)
class EtfPick:
    path: str  # the hierarchy label the ETF tracks
    tier: int  # 1 sector, 2 industry, 3 vertical


def trade_years(q: int) -> float:
    """Years of 365 days from 2013-01-01 to the quarter's mid day (`live.ts` midQuarterMs)."""
    start = q_start(q)
    return ((start + timedelta(days=(q_end(q) - start).days // 2)) - EPOCH).days / 365


def end_years(q: int) -> float:
    return (q_end(q) - EPOCH).days / 365


# The 13F data starts in 1998 Q4 (FIRST_DATA_Q), prices in 1999 Q1 and the indices' returns in 1999 Q2, so a
# position held from the start had a first trade no series had a level for and dropped out whole: Berkshire's
# Coca-Cola, American Express, Wells Fargo and Walmart, 23% of its buying (owner 2026-11-26: "assume it's the same").
# A series that begins with the data (its first quarter FLAT_UNTIL_Q or before) is flat before it: level 1.0 from
# FIRST_DATA_Q, where both a stock's own series and every index start. Fund and index side start alike, so neither
# gains; a series that begins later (a listing in 2005) is left as it is.
FIRST_DATA_Q = -57
FLAT_UNTIL_Q = -55


def _flat_start(series: pl.DataFrame) -> pl.DataFrame:
    """`series` (SERIES_SCHEMA) with level 1.0 in the quarters from FIRST_DATA_Q to the one before each key's first,
    for the keys whose first quarter is FLAT_UNTIL_Q or before."""
    first = series.group_by("key").agg(pl.col("q").min().alias("_q0")).filter(pl.col("_q0") <= FLAT_UNTIL_Q)
    rows = [(key, q, 1.0, 1.0) for key, q0 in first.iter_rows() for q in range(FIRST_DATA_Q, q0)]
    if not rows:
        return series
    return pl.concat([pl.DataFrame(rows, schema=SERIES_SCHEMA, orient="row"), series]).sort("key", "q")


def own_series(sq: pl.DataFrame) -> pl.DataFrame:
    """Each stock's total-return series (key "s<stock_id>"): level_end chains (close + div) / previous close,
    level_avg = previous level × VWAP / previous close; 1.0 at its first quarter (and flat before it, `_flat_start`)."""
    s = sq.sort("stock_id", "q").with_columns(
        close_p=pl.col("close").shift(1).over("stock_id"),
    )
    growth = pl.when(pl.col("close_p") > 0).then((pl.col("close") + pl.col("div")) / pl.col("close_p")).otherwise(1.0)
    s = s.with_columns(level_end=growth.cum_prod().over("stock_id"))
    s = s.with_columns(level_p=pl.col("level_end").shift(1).over("stock_id"))
    avg = pl.when(pl.col("close_p") > 0).then(pl.col("level_p") * pl.col("vwap").fill_null(pl.col("close")) / pl.col("close_p"))
    avg = avg.otherwise(pl.col("vwap").fill_null(pl.col("close")) / pl.col("close"))
    return _flat_start(s.select(("s" + pl.col("stock_id").cast(pl.String)).alias("key"), "q", avg.alias("level_avg"), "level_end").cast(SERIES_SCHEMA))


def label_series(sector_returns: pl.DataFrame) -> pl.DataFrame:
    """Each hierarchy label's index series (key = the label), flat before it starts (`_flat_start`)."""
    return _flat_start(sector_returns.select(pl.col("label").alias("key"), "q", "level_avg", "level_end").cast(SERIES_SCHEMA))


def replay(trades: pl.DataFrame, series: pl.DataFrame, last_q: int, by: tuple[str, ...] = (), units: bool = False):
    """(flows: group columns, t, cf; dropped: the positions with a trade the series has no level for), and with
    `units` a third frame: per trade, the group columns, q, u_prev and u (the replay's units before and after it;
    0 once sold out), which `skill_detail` values quarter by quarter.

    `trades` has TRADES_SCHEMA plus `key` (the series to replay through) and the `by` columns."""
    group = ["cik", "stock_id", "key", *by]
    t = trades.filter(pl.col("q") <= last_q).join(series.select("key", "q", "level_avg"), on=["key", "q"], how="left")
    dropped = t.group_by(group).agg(pl.col("level_avg").is_null().any().alias("bad")).filter("bad").drop("bad")
    t = t.join(dropped, on=group, how="anti").sort(*group, "q")
    eps = 1e-9
    gone = pl.col("shares_after").abs() <= eps * pl.max_horizontal(pl.col("delta").abs(), pl.lit(1.0))
    buy = pl.col("delta") > 0
    t = t.with_columns(
        ep=gone.shift(1, fill_value=False).cast(pl.Int32).cum_sum().over(group),
        f=pl.when(buy).then(0.0).otherwise(-pl.col("delta") / (pl.col("shares_after") - pl.col("delta"))),
        dollars=pl.col("delta") * pl.col("px"),
        gone=gone,
    )
    t = t.with_columns(K=(1 - pl.col("f")).cum_prod().over(*group, "ep"))
    t = t.with_columns(u=pl.col("K") * pl.when(buy).then(pl.col("dollars") / pl.col("level_avg") / pl.col("K")).otherwise(0.0).cum_sum().over(*group, "ep"))
    t = t.with_columns(u_prev=pl.col("u").shift(1, fill_value=0.0).over(*group, "ep"))
    times = {q: trade_years(q) for q in t["q"].unique().to_list()}
    trade_cf = t.select(
        *group,
        pl.col("q").replace_strict(times, return_dtype=pl.Float64).alias("t"),
        pl.when(buy).then(-pl.col("dollars")).otherwise(pl.col("f") * pl.col("u_prev") * pl.col("level_avg")).alias("cf"),
    )
    end_level = series.filter(pl.col("q") <= last_q).sort("key", "q").group_by("key").agg(pl.col("level_end").last().alias("le"))
    last = t.group_by(group).agg(pl.col("u").last(), pl.col("gone").last()).filter(~pl.col("gone"))
    end_cf = last.join(end_level, on="key", how="left").select(*group, pl.lit(end_years(last_q)).alias("t"), (pl.col("u") * pl.col("le")).alias("cf"))
    if not units:
        return pl.concat([trade_cf, end_cf]), dropped.select(group)
    held = t.select(*group, "q", "u_prev", pl.when(pl.col("gone")).then(0.0).otherwise(pl.col("u")).alias("u"))
    return pl.concat([trade_cf, end_cf]), dropped.select(group), held


def irr_by(flows: pl.DataFrame, by: list[str], steps: int = 200) -> pl.DataFrame:
    """IRR of each group's (t, cf) flows: bisection on [−0.99, 10], `steps` steps (200 as the web's `irr`; 64
    already reach a double's precision), null without a sign change. Every group is solved at once."""
    f = flows.group_by(*by, "t").agg(pl.col("cf").sum())
    keys = f.select(by).unique().sort(by).with_row_index("_g")
    f = f.join(keys, on=by).select(pl.col("_g").cast(pl.Int64), "t", "cf")
    n = keys.height
    g = f["_g"]

    def npv(r: pl.Series) -> pl.Series:
        v = f.with_columns(r=r.gather(g)).group_by("_g").agg((pl.col("cf") * (1 + pl.col("r")).pow(-pl.col("t"))).sum().alias("v"))
        return v.sort("_g")["v"]

    signs = f.group_by("_g").agg((pl.col("cf") < 0).any().alias("neg"), (pl.col("cf") > 0).any().alias("pos")).sort("_g")
    lo, hi = pl.Series([-0.99] * n), pl.Series([10.0] * n)
    f_lo, f_hi = npv(lo), npv(hi)
    lo_sign = f_lo.sign()
    for _ in range(steps):
        mid = (lo + hi) / 2
        up = npv(mid).sign() == lo_sign
        lo = pl.select(pl.when(up).then(mid).otherwise(lo)).to_series()
        hi = pl.select(pl.when(up).then(hi).otherwise(mid)).to_series()
    out = pl.DataFrame({"f_lo": f_lo, "f_hi": f_hi, "r": (lo + hi) / 2, "neg": signs["neg"], "pos": signs["pos"]})
    ok = pl.col("neg") & pl.col("pos") & pl.col("f_lo").is_finite() & pl.col("f_hi").is_finite()
    ok &= (pl.col("f_lo").sign() != pl.col("f_hi").sign()) | (pl.col("f_lo") == 0) | (pl.col("f_hi") == 0)
    r = pl.when(pl.col("f_lo") == 0).then(-0.99).when(pl.col("f_hi") == 0).then(10.0).otherwise(pl.col("r"))
    irr = out.select(pl.when(ok).then(r).alias("irr"))["irr"]
    return keys.drop("_g").with_columns(irr=irr)


def _label_at(path: str, tier: int) -> str:
    return SEP.join(path.split(SEP)[:tier])


def tier_labels(stock_paths: dict[int, str], etfs: dict[int, EtfPick | None], nosector: set[str], spy_key: str, tier: int) -> dict[int, str]:
    """stock_id -> the series key its label replay uses at `tier`: its label's index, a conglomerate's SPY,
    a single-sector ETF's own label at its tier (finer tiers use that tier). Neutral ETFs are not picks."""
    label = {sid: spy_key if path in nosector else _label_at(path, tier) for sid, path in stock_paths.items()}
    for sid, pick in etfs.items():
        if pick is not None:
            label[sid] = _label_at(pick.path, min(tier, pick.tier))
    return label


def fund_scores(
    trades: pl.DataFrame,
    sq: pl.DataFrame,
    sector_returns: pl.DataFrame,
    stock_paths: dict[int, str],
    etfs: dict[int, EtfPick | None],
    nosector: set[str],
    spy_id: int | None,
    last_q: int,
    series: pl.DataFrame | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(scores: cik, tier, irr_fund, irr_label, irr_mkt, picking, allocation, coverage, n; dropped positions).

    `series` (own and label series) can be passed in when scoring many chunks; one tier is replayed at a time."""
    trades = trades.filter(pl.col("q") <= last_q)
    bought = trades.filter(pl.col("delta") > 0).group_by("cik").agg((pl.col("delta") * pl.col("px")).sum().alias("bought"))
    spy_key = f"s{spy_id}" if spy_id is not None else MARKET
    if series is None:
        series = pl.concat([own_series(sq), label_series(sector_returns)])
    all_flows, all_bad = [], []
    for tier in TIERS:
        keyed = []
        label = tier_labels(stock_paths, etfs, nosector, spy_key, tier)
        picks = trades.filter(pl.col("stock_id").is_in(list(label)))
        lab = pl.DataFrame({"stock_id": list(label), "_label": list(label.values())}, schema={"stock_id": pl.Int32, "_label": pl.String})
        picks = picks.join(lab, on="stock_id").with_columns(tier=pl.lit(tier, pl.Int8))
        for variant, key in (("fund", "s" + pl.col("stock_id").cast(pl.String)), ("label", pl.col("_label")), ("mkt", pl.lit(MARKET))):
            keyed.append(picks.with_columns(key=key, variant=pl.lit(variant)).drop("_label"))
        tier_flows, dropped = replay(pl.concat(keyed), series, last_q, by=("tier", "variant"))
        bad = dropped.select("cik", "stock_id", "tier").unique()
        # collapse to one row per (fund, tier, variant, time) at once: the IRR needs no more
        all_flows.append(
            tier_flows.join(bad, on=["cik", "stock_id", "tier"], how="anti").group_by("cik", "stock_id", "tier", "variant", "t").agg(pl.col("cf").sum())
        )
        all_bad.append(bad)
    flows, bad = pl.concat(all_flows), pl.concat(all_bad)
    irr = irr_by(flows, ["cik", "tier", "variant"]).pivot("variant", index=["cik", "tier"], values="irr")
    for v in ("fund", "label", "mkt"):
        if v not in irr.columns:
            irr = irr.with_columns(pl.lit(None, pl.Float64).alias(v))
    kept = flows.filter(pl.col("variant") == "fund").select("cik", "tier", "stock_id").unique()
    covered = (
        trades.filter(pl.col("delta") > 0).join(kept, on=["cik", "stock_id"])
        .group_by("cik", "tier").agg((pl.col("delta") * pl.col("px")).sum().alias("covered"), pl.col("stock_id").n_unique().alias("n"))
    )  # fmt: skip
    scores = (
        irr.rename({"fund": "irr_fund", "label": "irr_label", "mkt": "irr_mkt"})
        .with_columns(picking=pl.col("irr_fund") - pl.col("irr_label"), allocation=pl.col("irr_label") - pl.col("irr_mkt"))
        .join(covered, on=["cik", "tier"], how="left").join(bought, on="cik", how="left")
        .with_columns(coverage=pl.col("covered") / pl.col("bought"), n=pl.col("n").cast(pl.Int32))
        .select("cik", "tier", "irr_fund", "irr_label", "irr_mkt", "picking", "allocation", "coverage", "n")
        .sort("cik", "tier")
    )  # fmt: skip
    return scores, bad.sort("cik", "tier", "stock_id")


def etf_ranks(trades: pl.DataFrame, sector_returns: pl.DataFrame, etfs: dict[int, EtfPick | None], last_q: int) -> pl.DataFrame:
    """Per single-sector ETF position: its own label's IRR rank among every label at the ETF's tier, and the best."""
    picks = {sid: p for sid, p in etfs.items() if p is not None}
    t = trades.filter(pl.col("stock_id").is_in(list(picks)))
    if t.is_empty():
        return pl.DataFrame(schema={"cik": pl.Int64, "stock_id": pl.Int32, "label": pl.String, "irr": pl.Float64, "rank": pl.Int32, "of": pl.Int32, "best": pl.String, "best_irr": pl.Float64})
    meta = pl.DataFrame({"stock_id": list(picks), "own": [p.path for p in picks.values()], "tier": [p.tier for p in picks.values()]},
                        schema={"stock_id": pl.Int32, "own": pl.String, "tier": pl.Int8})  # fmt: skip
    labels = sector_returns.filter(pl.col("tier") > 0).select(pl.col("label").alias("key"), "tier").unique()
    t = t.join(meta, on="stock_id").join(labels, on="tier")
    flows, _ = replay(t.drop("own", "tier"), label_series(sector_returns), last_q)
    irr = irr_by(flows, ["cik", "stock_id", "key"]).drop_nulls("irr")
    ranked = irr.with_columns(
        rank=pl.col("irr").rank("ordinal", descending=True).over("cik", "stock_id").cast(pl.Int32),
        of=pl.len().over("cik", "stock_id").cast(pl.Int32),
    )
    best = ranked.filter(pl.col("rank") == 1).select("cik", "stock_id", pl.col("key").alias("best"), pl.col("irr").alias("best_irr"))
    own = ranked.join(meta.select("stock_id", "own"), on="stock_id").filter(pl.col("key") == pl.col("own"))
    return own.join(best, on=["cik", "stock_id"]).select("cik", "stock_id", pl.col("key").alias("label"), "irr", "rank", "of", "best", "best_irr").sort("cik", "stock_id")
