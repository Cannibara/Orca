"""What the fund page draws from the sector-choice / stock-choice replays (spec
`docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md` §6).

`skill.fund_scores` keeps one IRR per fund, tier and replay. The fund page also needs each replay's value at every
quarter end (the Lines chart), its quarterly and yearly returns (the stacked bars), the IRRs of the biggest
positions (stocks vs their label) and of each label the fund bought (labels vs the market), and the fund's mix of
labels over time. Same replays (`skill.replay`), same dropped positions, so the figures agree with the scores.

Quarterly returns are time-weighted with the trade at the quarter's average level, the level `replay` trades at:
r = (value just before the trades ÷ value at the last quarter end) × (value at the quarter end ÷ value just after
the trades) − 1. Money going in or out then never moves the return, even a sell-out, and the three replays share the
same quarters, so each year market + (label − market) + (fund − label) = fund exactly.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from orca.engine import skill
from orca.engine.fund import _year_label
from orca.engine.sectors import MARKET, SEP

PICKS = 30  # positions listed one by one; the rest are one row
OTHERS = -1  # stock_id of that row until publish (irr_by's join would drop a null key)
IRR_STEPS = 64  # bisection steps: a double's precision (the web's 200 change nothing past ~60)
MIX_MIN = 0.002  # a vertical that never reaches 0.2% of the book joins its sector's "(Smaller holdings)"
NOT_CLASSIFIED = SEP.join(["(Not classified)"] * 3)
ETFS = "(ETFs)"
SMALLER = "(Smaller holdings)"
KEYS = ["cik", "tier", "variant"]


@dataclass(frozen=True)
class Detail:
    quarters: pl.DataFrame  # cik, tier, variant, q, v, r  (tier 1: fund, label, mkt, spy; tiers 2–3: label)
    years: pl.DataFrame  # cik, tier, variant, year, name, ret
    bought: pl.DataFrame  # cik, q, bought
    first_q: pl.DataFrame  # cik, first_q
    scores: pl.DataFrame  # cik, tier, irr_fund, irr_label, irr_mkt, irr_spy, picking, allocation, coverage, n
    picks: pl.DataFrame  # cik, tier, rank, stock_id (OTHERS for the rest), label, bought, irr_own, irr_label
    bets: pl.DataFrame  # cik, tier, label, bought, irr, irr_mkt, mkt_share


def quarter_values(units: pl.DataFrame, series: pl.DataFrame, last_q: int) -> pl.DataFrame:
    """Per (cik, tier, variant, q): `v` the replay's value at the quarter end, `pre` / `post` its value at the
    quarter's average level just before / after the quarter's trades.

    `units` is `replay(..., units=True)`'s third frame. A position holds u after a trade until its next trade (0
    once sold out). A key with no level in a quarter (a halted or delisted stock) keeps its last level end, at
    which it also trades: so it neither gains nor loses while it has no price."""
    g = [c for c in units.columns if c not in ("q", "u_prev", "u")]
    d = units.sort(*g, "q").with_columns(q_next=pl.col("q").shift(-1).over(g).fill_null(last_q + 1))
    trade_rows = d.select(*g, "q", pl.col("u_prev").alias("u0"), pl.col("u").alias("u1"))
    hold = (
        d.filter((pl.col("u") > 0) & (pl.col("q_next") > pl.col("q") + 1))
        .with_columns(qq=pl.int_ranges(pl.col("q") + 1, pl.col("q_next"), dtype=pl.Int32))
        .explode("qq")
        .select(*g, pl.col("qq").alias("q"), pl.col("u").alias("u0"), pl.col("u").alias("u1"))
    )
    rows = pl.concat([trade_rows, hold]).group_by("cik", "tier", "variant", "key", "q").agg(pl.col("u0").sum(), pl.col("u1").sum())
    lev = series.filter(pl.col("q") <= last_q).select("key", "q", pl.col("q").alias("q_at"), "level_avg", "level_end").sort("q")
    rows = rows.sort("q").join_asof(lev, on="q", by="key", strategy="backward", check_sortedness=False)  # both sorted by q
    avg = pl.when(pl.col("q_at") == pl.col("q")).then(pl.col("level_avg")).otherwise(pl.col("level_end"))
    return (
        rows.filter(pl.col("level_end").is_not_null())
        .group_by("cik", "tier", "variant", "q")
        .agg((pl.col("u1") * pl.col("level_end")).sum().alias("v"), (pl.col("u0") * avg).sum().alias("pre"), (pl.col("u1") * avg).sum().alias("post"))
    )


def quarter_returns(values: pl.DataFrame, first_q: pl.DataFrame, last_q: int) -> pl.DataFrame:
    """Every quarter from the fund's `first_q` to `last_q` with the value `v` and the time-weighted return `r`
    (module docstring); null where the replay held nothing in the quarter."""
    grid = (
        values.select(KEYS).unique().join(first_q, on="cik")
        .with_columns(q=pl.int_ranges(pl.col("first_q"), last_q + 1, dtype=pl.Int32)).explode("q").drop("first_q")
    )  # fmt: skip
    d = grid.join(values, on=[*KEYS, "q"], how="left").with_columns(pl.col("v", "pre", "post").fill_null(0.0)).sort(*KEYS, "q")
    d = d.with_columns(v_prev=pl.col("v").shift(1, fill_value=0.0).over(KEYS))
    before, after = pl.col("pre") / pl.col("v_prev"), pl.col("v") / pl.col("post")
    has_prev, has_post = pl.col("v_prev") > 0, pl.col("post") > 0
    r = (
        pl.when(has_prev & has_post).then(before * after - 1)
        .when(has_prev).then(before - 1)
        .when(has_post).then(after - 1)
    )  # fmt: skip
    return d.select(*KEYS, "q", "v", r.alias("r"))


def year_returns(quarters: pl.DataFrame) -> pl.DataFrame:
    """Calendar years of `quarter_returns` rows: the label `summary.json` gives the quarters, and the chained
    return of the quarters with one (null when none)."""
    y = quarters.with_columns(year=(pl.col("q") // 4 + 2013).cast(pl.Int32), qn=(pl.col("q") % 4 + 1).cast(pl.Int32))
    out = y.group_by(*KEYS, "year").agg(
        pl.col("qn").sort().alias("qns"),
        pl.when(pl.col("r").is_not_null().any()).then((1 + pl.col("r")).product() - 1).alias("ret"),
    )
    names = {(yr, tuple(qns)): _year_label(yr, list(qns)) for yr, qns in out.select("year", "qns").unique().iter_rows()}
    return out.with_columns(
        name=pl.struct("year", "qns").map_elements(lambda s: names[(s["year"], tuple(s["qns"]))], return_dtype=pl.String)
    ).select(*KEYS, "year", "name", "ret").sort(*KEYS, "year")


def fund_detail(
    trades: pl.DataFrame,
    sector_returns: pl.DataFrame,
    stock_paths: dict[int, str],
    etfs: dict[int, skill.EtfPick | None],
    nosector: set[str],
    spy_id: int | None,
    last_q: int,
    series: pl.DataFrame,
) -> Detail:
    """The fund-page detail of every fund in `trades` (one chunk of `fund_flows`). `sector_returns` needs its
    `cap` column (the label's market value at the quarter's start); `series` is own + label series."""
    trades = trades.filter(pl.col("q") <= last_q)
    spy_key = f"s{spy_id}" if spy_id is not None else MARKET
    buys = trades.filter(pl.col("delta") > 0).with_columns(dollars=pl.col("delta") * pl.col("px"))
    caps = sector_returns.select("label", "q", "cap")
    w = caps.join(caps.filter(pl.col("label") == MARKET).select("q", pl.col("cap").alias("cap_m")), on="q").select(
        "label", "q", (pl.col("cap") / pl.col("cap_m")).alias("w")
    )
    parts: dict[str, list[pl.DataFrame]] = {k: [] for k in ("values", "scores", "picks", "bets", "kept")}
    for tier in skill.TIERS:
        key = skill.tier_labels(stock_paths, etfs, nosector, spy_key, tier)
        group = skill.tier_labels(stock_paths, etfs, set(), spy_key, tier)  # a conglomerate's bet is its own label
        lab = pl.DataFrame(
            {"stock_id": list(key), "_key": list(key.values()), "_label": [group[s] for s in key]},
            schema={"stock_id": pl.Int32, "_key": pl.String, "_label": pl.String},
        )
        picks = trades.join(lab, on="stock_id").with_columns(tier=pl.lit(tier, pl.Int8))
        variants = [("fund", "s" + pl.col("stock_id").cast(pl.String)), ("label", pl.col("_key")), ("mkt", pl.lit(MARKET))]
        if tier == 1 and spy_id is not None:
            variants.append(("spy", pl.lit(spy_key)))
        keyed = pl.concat([picks.with_columns(key=k, variant=pl.lit(v)) for v, k in variants]).drop("_key")
        flows, dropped, units = skill.replay(keyed, series, last_q, by=("tier", "variant", "_label"), units=True)
        # as fund_scores: a position any scored replay cannot trade leaves every replay; SPY's own gaps only its own
        bad = dropped.filter(pl.col("variant") != "spy").select("cik", "stock_id", "tier").unique()
        flows = flows.join(bad, on=["cik", "stock_id", "tier"], how="anti")
        units = units.join(bad, on=["cik", "stock_id", "tier"], how="anti")
        kept = flows.filter(pl.col("variant") == "fund").select("cik", "stock_id").unique()
        parts["kept"].append(kept.with_columns(tier=pl.lit(tier, pl.Int8)))
        wanted = units if tier == 1 else units.filter(pl.col("variant") == "label")
        parts["values"].append(quarter_values(wanted, series, last_q))

        irr = skill.irr_by(flows.select(*KEYS, "t", "cf"), KEYS, steps=IRR_STEPS)
        irr = irr.pivot("variant", index=["cik", "tier"], values="irr")
        for v in ("fund", "label", "mkt", "spy"):
            if v not in irr.columns:
                irr = irr.with_columns(pl.lit(None, pl.Float64).alias(v))
        kept_buys = buys.join(kept, on=["cik", "stock_id"]).join(lab.select("stock_id", "_label"), on="stock_id")
        covered = kept_buys.group_by("cik").agg(pl.col("dollars").sum().alias("covered"), pl.col("stock_id").n_unique().cast(pl.Int32).alias("n"))
        total = buys.group_by("cik").agg(pl.col("dollars").sum().alias("all"))
        parts["scores"].append(
            irr.join(covered, on="cik", how="left").join(total, on="cik", how="left").select(
                "cik", "tier", pl.col("fund").alias("irr_fund"), pl.col("label").alias("irr_label"), pl.col("mkt").alias("irr_mkt"),
                pl.col("spy").alias("irr_spy"), (pl.col("fund") - pl.col("label")).alias("picking"),
                (pl.col("label") - pl.col("mkt")).alias("allocation"), (pl.col("covered") / pl.col("all")).alias("coverage"), "n",
            )
        )  # fmt: skip

        # stocks vs their label: the biggest positions by dollars bought, one by one
        pos = (
            kept_buys.group_by("cik", "stock_id").agg(pl.col("dollars").sum().alias("bought"), pl.col("_label").first())
            .sort("cik", "bought", "stock_id", descending=[False, True, False])
            .with_columns(rank=pl.int_range(pl.len(), dtype=pl.Int32).over("cik"))
            .with_columns(pid=pl.when(pl.col("rank") < PICKS).then(pl.col("stock_id")).otherwise(pl.lit(OTHERS, pl.Int32)))
        )  # fmt: skip
        pf = flows.filter(pl.col("variant").is_in(["fund", "label"])).join(pos.select("cik", "stock_id", "pid"), on=["cik", "stock_id"])
        pirr = skill.irr_by(pf.select(*KEYS, "pid", "t", "cf"), [*KEYS, "pid"], steps=IRR_STEPS)
        pirr = pirr.pivot("variant", index=["cik", "tier", "pid"], values="irr")
        for v in ("fund", "label"):
            if v not in pirr.columns:
                pirr = pirr.with_columns(pl.lit(None, pl.Float64).alias(v))
        prow = pos.group_by("cik", "pid").agg(pl.col("bought").sum(), pl.col("_label").first(), pl.col("rank").min())
        parts["picks"].append(
            prow.join(pirr, on=["cik", "pid"], how="left").select(
                "cik", pl.lit(tier, pl.Int8).alias("tier"), "rank", pl.col("pid").alias("stock_id"),
                pl.when(pl.col("pid") == OTHERS).then(None).otherwise(pl.col("_label")).alias("label"),
                "bought", pl.col("fund").alias("irr_own"), pl.col("label").alias("irr_label"),
            )
        )  # fmt: skip

        # labels vs the market: every label bought, its trades replayed in its index and in the market
        bf = flows.filter(pl.col("variant").is_in(["label", "mkt"]))
        birr = skill.irr_by(bf.select(*KEYS, "_label", "t", "cf"), [*KEYS, "_label"], steps=IRR_STEPS)
        birr = birr.pivot("variant", index=["cik", "tier", "_label"], values="irr")
        for v in ("label", "mkt"):
            if v not in birr.columns:
                birr = birr.with_columns(pl.lit(None, pl.Float64).alias(v))
        bq = kept_buys.group_by("cik", "_label", "q").agg(pl.col("dollars").sum())
        share = (
            bq.join(w, left_on=["_label", "q"], right_on=["label", "q"], how="left")
            .group_by("cik", "_label").agg(
                pl.col("dollars").sum().alias("bought"),
                ((pl.col("dollars") * pl.col("w")).sum() / pl.col("dollars").filter(pl.col("w").is_not_null()).sum()).alias("mkt_share"),
            )
        )  # fmt: skip
        bets = share.join(birr, on=["cik", "_label"], how="left").select(
            "cik", pl.lit(tier, pl.Int8).alias("tier"), pl.col("_label").alias("label"), "bought",
            pl.col("label").alias("irr"), pl.col("mkt").alias("irr_mkt"), "mkt_share",
        )  # fmt: skip
        if tier == 1:  # every sector, so a reader sees what they left out
            sectors = sector_returns.filter(pl.col("tier") == 1).select("label").unique()
            fq = kept_buys.group_by("cik", "q").agg(pl.col("dollars").sum())
            unbought = (
                fq.join(sectors, how="cross").join(w, on=["label", "q"], how="left")
                .group_by("cik", "label").agg(
                    ((pl.col("dollars") * pl.col("w").fill_null(0.0)).sum() / pl.col("dollars").sum()).alias("mkt_share")
                )
                .join(bets.select("cik", "label"), on=["cik", "label"], how="anti")
                .select("cik", pl.lit(1, pl.Int8).alias("tier"), "label", pl.lit(0.0).alias("bought"),
                        pl.lit(None, pl.Float64).alias("irr"), pl.lit(None, pl.Float64).alias("irr_mkt"), "mkt_share")
            )  # fmt: skip
            bets = pl.concat([bets, unbought])
        parts["bets"].append(bets)

    kept1 = parts["kept"][0].drop("tier")
    first_q = trades.join(kept1, on=["cik", "stock_id"]).group_by("cik").agg(pl.col("q").min().alias("first_q"))
    values = pl.concat(parts["values"])
    quarters = quarter_returns(values, first_q, last_q)
    bought = (
        buys.join(kept1, on=["cik", "stock_id"]).group_by("cik", "q").agg(pl.col("dollars").sum().alias("bought"))
    )  # fmt: skip
    return Detail(
        quarters=quarters,
        years=year_returns(quarters),
        bought=bought,
        first_q=first_q,
        scores=pl.concat(parts["scores"]).sort("cik", "tier").with_columns(  # SPY is replayed once, at tier 1
            irr_spy=pl.col("irr_spy").filter(pl.col("tier") == 1).first().over("cik")
        ),
        picks=pl.concat(parts["picks"]).sort("cik", "tier", "rank"),
        bets=pl.concat(parts["bets"]).sort(["cik", "tier", "bought", "label"], descending=[False, False, True, False]),
    )


def mix_paths(stock_paths: dict[int, str], etfs: dict[int, skill.EtfPick | None]) -> dict[int, str]:
    """stock_id -> the three-part path its holdings count under in the mix: its vertical, a single-sector ETF's
    label padded with "(ETFs)". Neutral ETFs and unlabelled stocks are left out (they count as not classified)."""
    out = {}
    for sid, path in stock_paths.items():
        parts = path.split(SEP)
        out[sid] = SEP.join((parts + [parts[-1]] * 3)[:3])  # a path is a vertical's; pad defensively
    for sid, pick in etfs.items():
        if pick is not None:
            parts = pick.path.split(SEP)
            out[sid] = SEP.join((parts + [ETFS] * 3)[:3])
    return out


def fund_mix(trades: pl.DataFrame, sq: pl.DataFrame, paths: dict[int, str], last_q: int) -> pl.DataFrame:
    """(cik, q, label, share): each fund's priced long book (shares × quarter-end close, as the fund files value
    it; a stock without a close that quarter keeps its last one) split by `mix_paths`, from its first trade to
    `last_q`. Verticals that never reach MIX_MIN of the book in any quarter join their sector's smaller holdings."""
    t = trades.filter(pl.col("q") <= last_q).sort("cik", "stock_id", "q")
    t = t.with_columns(q_next=pl.col("q").shift(-1).over("cik", "stock_id").fill_null(last_q + 1))
    eps = 1e-9 * pl.max_horizontal(pl.col("delta").abs(), pl.lit(1.0))
    held = (
        t.filter(pl.col("shares_after") > eps)
        .with_columns(qq=pl.int_ranges("q", "q_next", dtype=pl.Int32)).explode("qq")
        .select("cik", "stock_id", pl.col("qq").alias("q"), pl.col("shares_after").alias("shares"))
    )  # fmt: skip
    close = sq.filter((pl.col("q") <= last_q) & pl.col("close").is_not_null()).select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "close").sort("q")
    held = held.sort("q").join_asof(close, on="q", by="stock_id", strategy="backward", check_sortedness=False).filter(pl.col("close") > 0)
    lab = pl.DataFrame({"stock_id": list(paths), "label": list(paths.values())}, schema={"stock_id": pl.Int32, "label": pl.String})
    held = held.join(lab, on="stock_id", how="left").with_columns(pl.col("label").fill_null(NOT_CLASSIFIED))
    val = held.group_by("cik", "q", "label").agg((pl.col("shares") * pl.col("close")).sum().alias("v"))
    val = val.with_columns(share=pl.col("v") / pl.col("v").sum().over("cik", "q"))
    small = pl.col("share").max().over("cik", "label") < MIX_MIN
    sector = pl.col("label").str.split(SEP).list.first()
    rolled = pl.when(small & (pl.col("label") != NOT_CLASSIFIED)).then(sector + SEP + SMALLER + SEP + SMALLER).otherwise(pl.col("label"))
    return (
        val.with_columns(label=rolled).group_by("cik", "q", "label").agg(pl.col("share").sum().round(4))
        .sort("cik", "label", "q")
    )  # fmt: skip


def label_list(sector_returns: pl.DataFrame, last_q: int) -> pl.DataFrame:
    """Every label of tiers 1–3 with an index at `last_q`: label, tier, parent, name, n, top_weight."""
    s = sector_returns.filter((pl.col("q") == last_q) & (pl.col("tier") > 0))
    parts = pl.col("label").str.split(SEP)
    return s.select(
        "label", pl.col("tier").cast(pl.Int8),
        pl.when(pl.col("tier") > 1).then(parts.list.slice(0, pl.col("tier") - 1).list.join(SEP)).alias("parent"),
        parts.list.last().alias("name"), "n", pl.col("top_weight").round(4),
    ).sort("label")  # fmt: skip
