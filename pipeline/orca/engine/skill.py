"""Stock picking vs sector allocation as an opportunity cost (owner 2026-11-28: "not IRR, but the stock pick vs
sector vs market given the same bet size and timing"; plan `docs/superpowers/plans/2026-11-17-sector-indices.md` §7).

A fund's real trades are replayed through each stock's own total-return series (dividends reinvested): a buy puts
the same dollars in at the quarter's average level, a sell takes out the same fraction of the units as of the
fund's shares. That gives the dollars the fund had in each stock at every point. A quarter is split at its average
level, where the trades happen: the first half holds the units from before the trade, the second half those after.

Each half, the same money is put three ways: the stock (what the fund earned), the index of the stock's hierarchy
label, and Orca's index of the whole market (SPY too, for reference). Per fund and tier (1 sector, 2 industry,
3 vertical), summing over every position and half:
  picking    = Σ money × (stock return − label return) ÷ dollar-years at work
  allocation = Σ money × (label return − market return) ÷ dollar-years at work
Both are fractions a year with nothing compounded or annualised beyond that one division: a stock held one quarter
counts that quarter's gap on that quarter's money. A dollar-year is a dollar at work for a year (a half is 1/8).

A half counts only where the stock, its label at every tier, the market and SPY all have a return for it, so the
money behind every figure is the same. A single-sector ETF is a pick at its own tier (finer tiers use that tier);
a neutral ETF or an unlabelled stock counts only in coverage; a conglomerate (@nosector) is compared with SPY.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Mapping

import polars as pl

from orca.engine.sectors import MARKET, SEP

TRADES_SCHEMA = pl.Schema(
    {"cik": pl.Int64, "stock_id": pl.Int32, "q": pl.Int32, "delta": pl.Float64, "px": pl.Float64, "shares_after": pl.Float64}
)
SERIES_SCHEMA = pl.Schema({"key": pl.String, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64})
TIERS = (1, 2, 3)
HALF = 0.125  # years in half a quarter
POS = ["cik", "stock_id"]


@dataclass(frozen=True)
class EtfPick:
    path: str  # the hierarchy label the ETF tracks
    tier: int  # 1 sector, 2 industry, 3 vertical


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


def half_returns(series: pl.DataFrame) -> pl.DataFrame:
    """Per key and quarter: `r1` from the last quarter's end to this quarter's average level (null when the key has
    no level for the quarter before), `r2` from the average level to the quarter end, and the two levels a
    position's money is counted at: `e0` (the last quarter end) and `level_avg`."""
    s = series.sort("key", "q").with_columns(e0=pl.col("level_end").shift(1).over("key"), q0=pl.col("q").shift(1).over("key"))
    adjacent = (pl.col("q0") == pl.col("q") - 1) & (pl.col("e0") > 0)
    return s.select(
        "key", "q",
        pl.when(adjacent).then(pl.col("level_avg") / pl.col("e0") - 1).alias("r1"),
        pl.when(pl.col("level_avg") > 0).then(pl.col("level_end") / pl.col("level_avg") - 1).alias("r2"),
        pl.when(adjacent).then(pl.col("e0")).alias("e0"), "level_avg",
    )  # fmt: skip


def replay(trades: pl.DataFrame, series: pl.DataFrame, last_q: int) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(units: cik, stock_id, key, q, u_prev, u per trade, the units held before and after it, 0 once sold out;
    dropped: the positions with a trade the series has no level for). `trades` has TRADES_SCHEMA plus `key`.

    A buy adds dollars ÷ the quarter's average level; a sell takes out the same fraction of the units as of the
    fund's shares (matching dollars could drive a replay negative)."""
    group = ["cik", "stock_id", "key"]
    t = trades.filter(pl.col("q") <= last_q).join(series.select("key", "q", "level_avg"), on=["key", "q"], how="left")
    dropped = t.group_by(group).agg(pl.col("level_avg").is_null().any().alias("bad")).filter("bad").drop("bad")
    t = t.join(dropped, on=group, how="anti").sort(*group, "q")
    eps = 1e-9
    gone = pl.col("shares_after").abs() <= eps * pl.max_horizontal(pl.col("delta").abs(), pl.lit(1.0))
    buy = pl.col("delta") > 0
    t = t.with_columns(
        ep=gone.shift(1, fill_value=False).cast(pl.Int32).cum_sum().over(group),
        f=pl.when(buy).then(0.0).otherwise(-pl.col("delta") / (pl.col("shares_after") - pl.col("delta"))),
        gone=gone,
    )
    t = t.with_columns(K=(1 - pl.col("f")).cum_prod().over(*group, "ep"))
    add = pl.when(buy).then(pl.col("delta") * pl.col("px") / pl.col("level_avg") / pl.col("K")).otherwise(0.0)
    t = t.with_columns(u=pl.col("K") * add.cum_sum().over(*group, "ep"))
    t = t.with_columns(u_prev=pl.col("u").shift(1, fill_value=0.0).over(*group, "ep"))
    units = t.select(*group, "q", "u_prev", pl.when(pl.col("gone")).then(0.0).otherwise(pl.col("u")).alias("u"))
    return units, dropped.select(group)


def _held(units: pl.DataFrame, last_q: int) -> pl.DataFrame:
    """Per position and quarter held: `u0` the units in the first half (before the quarter's trade), `u1` after."""
    d = units.sort(*POS, "q").with_columns(q_next=pl.col("q").shift(-1).over(POS).fill_null(last_q + 1))
    trade_rows = d.select(*POS, "key", "q", pl.col("u_prev").alias("u0"), pl.col("u").alias("u1"))
    hold = (
        d.filter((pl.col("u") > 0) & (pl.col("q_next") > pl.col("q") + 1))
        .with_columns(qq=pl.int_ranges(pl.col("q") + 1, pl.col("q_next"), dtype=pl.Int32))
        .explode("qq")
        .select(*POS, "key", pl.col("qq").alias("q"), pl.col("u").alias("u0"), pl.col("u").alias("u1"))
    )  # fmt: skip
    return pl.concat([trade_rows, hold])


def attribute(
    trades: pl.DataFrame,
    series: pl.DataFrame,
    halves: pl.DataFrame,
    benches: Mapping[str, Mapping[int, str] | str],
    last_q: int,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(rows, dropped). The positions are the stocks of `benches`' first per-stock mapping (all of them when every
    bench is one key).

    rows, per position and quarter: `w1` / `w2` the dollars in the stock in each half (0 where the half does not
    count), `b` = (w1 + w2) / 2 the dollars at work over the quarter, `g_fund` the dollars the stock made, and
    `g_<name>` what the same money made in each bench, a series key per stock (a label) or one for all (the market).
    A half counts only where the stock and every bench have a return for it."""
    per_stock = [m for m in benches.values() if not isinstance(m, str)]
    if per_stock:
        trades = trades.filter(pl.col("stock_id").is_in(list(per_stock[0])))
    units, dropped = replay(trades.with_columns(key="s" + pl.col("stock_id").cast(pl.String)), series, last_q)
    h = halves.select("key", "q", "r1", "r2", "e0", "level_avg")
    d = _held(units, last_q).join(h, on=["key", "q"])  # a quarter without a price for the stock does not count
    d = d.with_columns(
        c1=pl.when(pl.col("u0") > 0).then(pl.col("u0") * pl.col("e0")).otherwise(0.0),
        c2=pl.col("u1") * pl.col("level_avg"),
        ok1=pl.col("r1").is_not_null(),
        ok2=pl.col("r2").is_not_null(),
    ).rename({"r1": "s1", "r2": "s2"})
    hr = halves.select("key", "q", "r1", "r2")
    for name, m in benches.items():
        if isinstance(m, str):
            d = d.with_columns(pl.lit(m).alias("_k"))
        else:
            keys = pl.DataFrame({"stock_id": list(m), "_k": list(m.values())}, schema={"stock_id": pl.Int32, "_k": pl.String})
            d = d.join(keys, on="stock_id", how="left")
        d = d.join(hr.rename({"key": "_k", "r1": f"{name}_1", "r2": f"{name}_2"}), on=["_k", "q"], how="left").drop("_k")
        d = d.with_columns(ok1=pl.col("ok1") & pl.col(f"{name}_1").is_not_null(), ok2=pl.col("ok2") & pl.col(f"{name}_2").is_not_null())
    w1 = pl.when(pl.col("ok1") & (pl.col("c1") > 0)).then(pl.col("c1")).otherwise(0.0)
    w2 = pl.when(pl.col("ok2") & (pl.col("c2") > 0)).then(pl.col("c2")).otherwise(0.0)
    d = d.with_columns(w1=w1, w2=w2)

    def gain(a: str, b: str) -> pl.Expr:
        return pl.when(pl.col("w1") > 0).then(pl.col("w1") * pl.col(a)).otherwise(0.0) + pl.when(pl.col("w2") > 0).then(pl.col("w2") * pl.col(b)).otherwise(0.0)

    d = d.with_columns(b=(pl.col("w1") + pl.col("w2")) / 2, g_fund=gain("s1", "s2"), **{f"g_{n}": gain(f"{n}_1", f"{n}_2") for n in benches})
    return d.select(*POS, "q", "w1", "w2", "b", "g_fund", *[f"g_{n}" for n in benches]), dropped


def _label_at(path: str, tier: int) -> str:
    return SEP.join(path.split(SEP)[:tier])


def tier_labels(stock_paths: dict[int, str], etfs: dict[int, EtfPick | None], nosector: set[str], spy_key: str, tier: int) -> dict[int, str]:
    """stock_id -> the series key it is compared with at `tier`: its label's index, a conglomerate's SPY,
    a single-sector ETF's own label at its tier (finer tiers use that tier). Neutral ETFs are not picks."""
    label = {sid: spy_key if path in nosector else _label_at(path, tier) for sid, path in stock_paths.items()}
    for sid, pick in etfs.items():
        if pick is not None:
            label[sid] = _label_at(pick.path, min(tier, pick.tier))
    return label


def benches(stock_paths: dict[int, str], etfs: dict[int, EtfPick | None], nosector: set[str], spy_id: int | None) -> dict[str, Mapping[int, str] | str]:
    """The benches every score needs: the label at each tier (`l1`–`l3`), the market and SPY."""
    spy_key = f"s{spy_id}" if spy_id is not None else MARKET
    out: dict[str, Mapping[int, str] | str] = {f"l{t}": tier_labels(stock_paths, etfs, nosector, spy_key, t) for t in TIERS}
    return out | {"mkt": MARKET, "spy": spy_key}


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
    halves: pl.DataFrame | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(scores: cik, tier, ret_fund, ret_label, ret_mkt, ret_spy, picking, allocation, coverage, n; dropped
    positions), as `score_table`."""
    trades = trades.filter(pl.col("q") <= last_q)
    if series is None:
        series = pl.concat([own_series(sq), label_series(sector_returns)])
    if halves is None:
        halves = half_returns(series)
    rows, dropped = attribute(trades, series, halves, benches(stock_paths, etfs, nosector, spy_id), last_q)
    return score_table(rows, trades), dropped.select(POS).unique().sort(POS)


def kept_positions(rows: pl.DataFrame) -> pl.DataFrame:
    """The positions with money at work in at least one half that counts (cik, stock_id)."""
    return rows.group_by(POS).agg(pl.col("b").sum()).filter(pl.col("b") > 0).select(POS)


def score_table(rows: pl.DataFrame, trades: pl.DataFrame) -> pl.DataFrame:
    """Per fund and tier from `attribute`'s rows (benches l1–l3, mkt, spy): ret_* the dollars each way made ÷ the
    dollar-years at work, picking = ret_fund − ret_label, allocation = ret_label − ret_mkt; `n` the positions
    scored and `coverage` their share of all the fund's buying (dollars)."""
    buys = trades.filter(pl.col("delta") > 0).with_columns(dollars=pl.col("delta") * pl.col("px"))
    bought = buys.group_by("cik").agg(pl.col("dollars").sum().alias("bought"))
    covered = buys.join(kept_positions(rows), on=POS).group_by("cik").agg(
        pl.col("dollars").sum().alias("covered"), pl.col("stock_id").n_unique().cast(pl.Int32).alias("n")
    )
    tot = rows.group_by("cik").agg((pl.col("b").sum() / 4).alias("dy"), pl.col("^g_.*$").sum()).filter(pl.col("dy") > 0)
    ret = {v: pl.col(f"g_{v}") / pl.col("dy") for v in ("fund", "mkt", "spy")}
    per = pl.concat([
        tot.select(
            "cik", pl.lit(t, pl.Int8).alias("tier"), ret["fund"].alias("ret_fund"), (pl.col(f"g_l{t}") / pl.col("dy")).alias("ret_label"),
            ret["mkt"].alias("ret_mkt"), ret["spy"].alias("ret_spy"),
        )
        for t in TIERS
    ])  # fmt: skip
    return (
        per.with_columns(picking=pl.col("ret_fund") - pl.col("ret_label"), allocation=pl.col("ret_label") - pl.col("ret_mkt"))
        .join(covered, on="cik", how="left").join(bought, on="cik", how="left")
        .with_columns(coverage=pl.col("covered") / pl.col("bought"))
        .select("cik", "tier", "ret_fund", "ret_label", "ret_mkt", "ret_spy", "picking", "allocation", "coverage", "n")
        .sort("cik", "tier")
    )  # fmt: skip


def etf_ranks(
    trades: pl.DataFrame, sector_returns: pl.DataFrame, etfs: dict[int, EtfPick | None], last_q: int, series: pl.DataFrame, halves: pl.DataFrame
) -> pl.DataFrame:
    """Per single-sector ETF position: what the same money made a year in its own label against every label at the
    ETF's tier (`ret`, its `rank` of `of`), and the best label."""
    picks = {sid: p for sid, p in etfs.items() if p is not None}
    empty = pl.DataFrame(schema={"cik": pl.Int64, "stock_id": pl.Int32, "label": pl.String, "ret": pl.Float64, "rank": pl.Int32, "of": pl.Int32, "best": pl.String, "best_ret": pl.Float64})
    t = trades.filter(pl.col("stock_id").is_in(list(picks)) & (pl.col("q") <= last_q))
    if t.is_empty():
        return empty
    rows, _ = attribute(t, series, halves, {}, last_q)
    rows = rows.filter(pl.col("b") > 0)
    meta = pl.DataFrame({"stock_id": list(picks), "own": [p.path for p in picks.values()], "tier": [p.tier for p in picks.values()]},
                        schema={"stock_id": pl.Int32, "own": pl.String, "tier": pl.Int8})  # fmt: skip
    labels = sector_returns.filter(pl.col("tier") > 0).select("label", "tier").unique()
    hr = halves.select(pl.col("key").alias("label"), "q", "r1", "r2")
    d = rows.join(meta, on="stock_id").join(labels, on="tier").join(hr, on=["label", "q"], how="left")
    miss = ((pl.col("w1") > 0) & pl.col("r1").is_null()) | ((pl.col("w2") > 0) & pl.col("r2").is_null())
    g = pl.when(pl.col("w1") > 0).then(pl.col("w1") * pl.col("r1")).otherwise(0.0) + pl.when(pl.col("w2") > 0).then(pl.col("w2") * pl.col("r2")).otherwise(0.0)
    per = (
        d.group_by("cik", "stock_id", "label").agg(miss.any().alias("miss"), g.sum().alias("g"), (pl.col("b").sum() / 4).alias("dy"), pl.col("own").first())
        .filter(~pl.col("miss")).with_columns(ret=pl.col("g") / pl.col("dy"))
    )  # fmt: skip
    if per.is_empty():
        return empty
    ranked = per.with_columns(
        rank=pl.col("ret").rank("ordinal", descending=True).over("cik", "stock_id").cast(pl.Int32),
        of=pl.len().over("cik", "stock_id").cast(pl.Int32),
    )
    best = ranked.filter(pl.col("rank") == 1).select("cik", "stock_id", pl.col("label").alias("best"), pl.col("ret").alias("best_ret"))
    own = ranked.filter(pl.col("label") == pl.col("own"))
    return own.join(best, on=["cik", "stock_id"]).select("cik", "stock_id", "label", "ret", "rank", "of", "best", "best_ret").sort("cik", "stock_id")
