"""What the fund page draws from the opportunity-cost attribution (`skill.attribute`; spec
`docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md` §6).

Every figure is money × return on the same money: each half quarter, the dollars the fund had in each stock, put
in the stock, its label's index, the market and SPY. Per fund and quarter, `cap` is the dollars at work over the
quarter and each way's quarterly return is what it made ÷ `cap`. A calendar year's return is what it made ÷ the
average `cap` of its quarters, so each year market + (label − market) + (fund − label) = fund exactly, and the
scores (dollars made ÷ dollar-years) are the years averaged by the money at work in them. The fund page also
lists the biggest positions (stock vs its label on its own money, and what that adds to the fund's score) and
each label bought (label vs the market), whose `adds` sum to the fund's picking and allocation exactly.
"""

from __future__ import annotations

from dataclasses import dataclass

import polars as pl

from orca.engine import skill
from orca.engine.fund import _year_label
from orca.engine.sectors import MARKET, SEP

PICKS = 30  # positions listed one by one; the rest are one row
OTHERS = -1  # stock_id of that row until publish
MIX_MIN = 0.002  # a vertical that never reaches 0.2% of the book joins its sector's "(Smaller holdings)"
NOT_CLASSIFIED = SEP.join(["(Not classified)"] * 3)
ETFS = "(ETFs)"
SMALLER = "(Smaller holdings)"
WAYS = ("fund", "mkt", "spy", "l1", "l2", "l3")  # the stock itself, the market, SPY, the label at tiers 1–3


@dataclass(frozen=True)
class Detail:
    quarters: pl.DataFrame  # cik, q, cap, fund, mkt, spy, l1, l2, l3 (quarterly returns on the same money)
    years: pl.DataFrame  # cik, year, name, fund, mkt, spy, l1, l2, l3
    bought: pl.DataFrame  # cik, q, bought
    first_q: pl.DataFrame  # cik, first_q
    scores: pl.DataFrame  # skill.score_table
    picks: pl.DataFrame  # cik, tier, rank, stock_id (OTHERS for the rest), label, bought, ret_own, ret_label, adds
    bets: pl.DataFrame  # cik, tier, label, bought, ret, ret_mkt, adds, mkt_share


def quarter_table(rows: pl.DataFrame, first_q: pl.DataFrame, last_q: int) -> pl.DataFrame:
    """Every quarter from each fund's `first_q` to `last_q`: `cap` (the dollars at work over it, 0 when none) and
    `g_<way>` what that money made each way."""
    q = rows.group_by("cik", "q").agg(pl.col("b").sum().alias("cap"), *[pl.col(f"g_{w}").sum() for w in WAYS])
    grid = first_q.with_columns(q=pl.int_ranges(pl.col("first_q"), last_q + 1, dtype=pl.Int32)).explode("q").drop("first_q")
    return grid.join(q, on=["cik", "q"], how="left").with_columns(pl.col("cap", *[f"g_{w}" for w in WAYS]).fill_null(0.0)).sort("cik", "q")


def quarter_returns(qt: pl.DataFrame) -> pl.DataFrame:
    """`quarter_table` as returns: what each way made ÷ `cap`; null where nothing was at work."""
    return qt.select("cik", "q", "cap", *[pl.when(pl.col("cap") > 0).then(pl.col(f"g_{w}") / pl.col("cap")).alias(w) for w in WAYS])


def year_returns(qt: pl.DataFrame) -> pl.DataFrame:
    """Calendar years of `quarter_table`: the label `summary.json` gives the quarters, and what each way made in the
    year ÷ the average `cap` of the year's quarters with money at work (null when none)."""
    y = qt.with_columns(year=(pl.col("q") // 4 + 2013).cast(pl.Int32), qn=(pl.col("q") % 4 + 1).cast(pl.Int32))
    out = y.group_by("cik", "year").agg(
        pl.col("qn").sort().alias("qns"), pl.col("cap").filter(pl.col("cap") > 0).mean().alias("avg"), *[pl.col(f"g_{w}").sum() for w in WAYS]
    )
    names = {(yr, tuple(qns)): _year_label(yr, list(qns)) for yr, qns in out.select("year", "qns").unique().iter_rows()}
    return out.select(
        "cik", "year",
        pl.struct("year", "qns").map_elements(lambda s: names[(s["year"], tuple(s["qns"]))], return_dtype=pl.String).alias("name"),
        *[pl.when(pl.col("avg") > 0).then(pl.col(f"g_{w}") / pl.col("avg")).alias(w) for w in WAYS],
    ).sort("cik", "year")  # fmt: skip


def fund_detail(
    trades: pl.DataFrame,
    sector_returns: pl.DataFrame,
    stock_paths: dict[int, str],
    etfs: dict[int, skill.EtfPick | None],
    nosector: set[str],
    spy_id: int | None,
    last_q: int,
    series: pl.DataFrame,
    halves: pl.DataFrame | None = None,
) -> Detail:
    """The fund-page detail of every fund in `trades` (one chunk of `fund_flows`). `sector_returns` needs its
    `cap` column (the label's market value at the quarter's start); `series` is own + label series."""
    trades = trades.filter(pl.col("q") <= last_q)
    if halves is None:
        halves = skill.half_returns(series)
    rows, _ = skill.attribute(trades, series, halves, skill.benches(stock_paths, etfs, nosector, spy_id), last_q)
    kept = skill.kept_positions(rows)
    buys = trades.filter(pl.col("delta") > 0).with_columns(dollars=pl.col("delta") * pl.col("px"))
    kept_buys = buys.join(kept, on=["cik", "stock_id"])
    first_q = trades.join(kept, on=["cik", "stock_id"]).group_by("cik").agg(pl.col("q").min().alias("first_q"))
    qt = quarter_table(rows, first_q, last_q)
    dy = rows.group_by("cik").agg((pl.col("b").sum() / 4).alias("dy"))
    pos = rows.group_by("cik", "stock_id").agg(pl.col("b").sum(), *[pl.col(f"g_{w}").sum() for w in WAYS])
    caps = sector_returns.select("label", "q", "cap")
    w = caps.join(caps.filter(pl.col("label") == MARKET).select("q", pl.col("cap").alias("cap_m")), on="q").select(
        "label", "q", (pl.col("cap") / pl.col("cap_m")).alias("w")
    )
    spy_key = f"s{spy_id}" if spy_id is not None else MARKET
    picks_out, bets_out = [], []
    for tier in skill.TIERS:
        group = skill.tier_labels(stock_paths, etfs, set(), spy_key, tier)  # a conglomerate's bet is its own label
        lab = pl.DataFrame({"stock_id": list(group), "_label": list(group.values())}, schema={"stock_id": pl.Int32, "_label": pl.String})
        g_l = f"g_l{tier}"

        # stocks vs their label, on each position's own money: the biggest by dollars bought, one by one
        p = (
            kept_buys.group_by("cik", "stock_id").agg(pl.col("dollars").sum().alias("bought")).join(lab, on="stock_id")
            .sort("cik", "bought", "stock_id", descending=[False, True, False])
            .with_columns(rank=pl.int_range(pl.len(), dtype=pl.Int32).over("cik"))
            .with_columns(pid=pl.when(pl.col("rank") < PICKS).then(pl.col("stock_id")).otherwise(pl.lit(OTHERS, pl.Int32)))
            .join(pos, on=["cik", "stock_id"])
            .group_by("cik", "pid").agg(
                pl.col("bought").sum(), pl.col("_label").first(), pl.col("rank").min(), pl.col("b").sum(), pl.col("g_fund").sum(), pl.col(g_l).sum()
            )
            .join(dy, on="cik")
        )  # fmt: skip
        picks_out.append(
            p.select(
                "cik", pl.lit(tier, pl.Int8).alias("tier"), "rank", pl.col("pid").alias("stock_id"),
                pl.when(pl.col("pid") == OTHERS).then(None).otherwise(pl.col("_label")).alias("label"), "bought",
                (pl.col("g_fund") / (pl.col("b") / 4)).alias("ret_own"), (pl.col(g_l) / (pl.col("b") / 4)).alias("ret_label"),
                ((pl.col("g_fund") - pl.col(g_l)) / pl.col("dy")).alias("adds"),
            )
        )  # fmt: skip

        # labels vs the market: every label bought, on the money the fund had in it
        bg = pos.join(lab, on="stock_id").group_by("cik", "_label").agg(pl.col("b").sum(), pl.col(g_l).sum(), pl.col("g_mkt").sum()).join(dy, on="cik")
        bq = kept_buys.join(lab, on="stock_id").group_by("cik", "_label", "q").agg(pl.col("dollars").sum())
        share = (
            bq.join(w, left_on=["_label", "q"], right_on=["label", "q"], how="left")
            .group_by("cik", "_label").agg(
                pl.col("dollars").sum().alias("bought"),
                ((pl.col("dollars") * pl.col("w")).sum() / pl.col("dollars").filter(pl.col("w").is_not_null()).sum()).alias("mkt_share"),
            )
        )  # fmt: skip
        bets = share.join(bg, on=["cik", "_label"], how="left").select(
            "cik", pl.lit(tier, pl.Int8).alias("tier"), pl.col("_label").alias("label"), "bought",
            (pl.col(g_l) / (pl.col("b") / 4)).alias("ret"), (pl.col("g_mkt") / (pl.col("b") / 4)).alias("ret_mkt"),
            ((pl.col(g_l) - pl.col("g_mkt")) / pl.col("dy")).alias("adds"), "mkt_share",
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
                .select("cik", pl.lit(1, pl.Int8).alias("tier"), "label", pl.lit(0.0).alias("bought"), pl.lit(None, pl.Float64).alias("ret"),
                        pl.lit(None, pl.Float64).alias("ret_mkt"), pl.lit(None, pl.Float64).alias("adds"), "mkt_share")
            )  # fmt: skip
            bets = pl.concat([bets, unbought])
        bets_out.append(bets)

    bought = kept_buys.group_by("cik", "q").agg(pl.col("dollars").sum().alias("bought"))
    return Detail(
        quarters=quarter_returns(qt),
        years=year_returns(qt),
        bought=bought,
        first_q=first_q,
        scores=skill.score_table(rows, trades),
        picks=pl.concat(picks_out).sort("cik", "tier", "rank"),
        bets=pl.concat(bets_out).sort(["cik", "tier", "bought", "label"], descending=[False, False, True, False]),
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
