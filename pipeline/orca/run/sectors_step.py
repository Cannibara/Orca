"""Run steps for the sector indices: keep the share-count history (`shares_hist`) up to date, and build
`sector_returns`, every hierarchy label's index (lake only; nothing is published yet).

One SEC call per company (share classes share a CIK). Companies with no history come first, then the stalest;
a company whose newest row was filed within `FRESH_DAYS` is skipped. `max_calls` caps one run (about 40 min at
the SEC's 8 calls a second), so the first backfill spreads over a run or two. A company that reports no count
gets a null row, so it is asked again only once that row is stale.
"""

from __future__ import annotations

import json
import logging
import shutil
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import polars as pl

from orca.engine import skill, skill_detail
from orca.engine.sectors import (
    HEAVY_WEIGHT,
    MAX_PRICE_GAP,
    OUT_SCHEMA,
    QUARTER_SCHEMA,
    REPORTED_SCHEMA,
    cap_report,
    index_returns,
    market_caps,
    mispriced,
    stock_quarters,
)
from orca.hierarchy import assign, load
from orca.hierarchy.assign import SicTable
from orca.hierarchy.matching import kind
from orca.http import FetchError
from orca.publish import read_manifest, write_json, write_manifest
from orca.run.budget import Budget
from orca.run.market import BENCHMARK_CUSIP, load_daily, stock_of
from orca.run.publish_step import CusipLeakError, cusip_leaks, is_cusip, is_sector_path
from orca.run.state import (
    CUSIP_MAP_SCHEMA,
    FUND_FLOWS_SCHEMA,
    SECURITIES_TABLE_SCHEMA,
    read_table,
)
from orca.sec.adr import SCHEMA as ADR_SCHEMA
from orca.sec.adr import TABLE as ADR_TABLE
from orca.sec.adr import Adr
from orca.shares_hist import SCHEMA, frame, load_overrides
from orca.shares_hist import SCHEMA as SHARES_SCHEMA
from orca.storage import Lake

log = logging.getLogger(__name__)
FRESH_DAYS = 100  # a 10-Q comes every quarter
MAX_CALLS = 19_000


def update_share_history(
    lake: Lake,
    fetch: Callable[[int], list],
    securities: pl.DataFrame,
    flags: list,
    budget: Budget,
    today: date,
    max_calls: int = MAX_CALLS,
) -> dict:
    table = read_table(lake, "shares_hist", SCHEMA)
    companies = (
        securities.filter(pl.col("cik").is_not_null() & (pl.col("sector") != "ETF/Fund"))
        .group_by("cik")
        .agg(pl.col("stock_id").sort())
    )
    last = table.group_by("stock_id").agg(pl.col("filed").max().alias("last"))
    companies = (
        companies.explode("stock_id").join(last, on="stock_id", how="left")
        .group_by("cik").agg(pl.col("stock_id"), pl.col("last").min())
        .filter(pl.col("last").is_null() | (pl.col("last") < today - timedelta(days=FRESH_DAYS)))
        .sort("last", "cik", nulls_last=False)
    )  # fmt: skip
    fresh, failed, asked = [], 0, 0
    for cik, stock_ids, _ in companies.iter_rows():
        if asked >= max_calls or budget.spent():
            break
        asked += 1
        try:
            rows = fetch(cik)
        except FetchError:
            failed += 1
            continue
        rows = rows or [(today, today, None)]
        fresh += [frame(sid, rows) for sid in stock_ids]
    if fresh:
        done = pl.concat(fresh)
        table = pl.concat([table.filter(~pl.col("stock_id").is_in(done["stock_id"].unique().to_list())), done])
        lake.write("shares_hist", table.cast(SCHEMA).sort("stock_id", "end"))
    if failed:
        flags.append({"type": "shares_lookup_failed", "count": failed})
    stats = {"companies": asked - failed, "owed": companies.height - asked}
    log.info("shares_hist: %s", stats)
    return stats


ADR_FRESH_DAYS = 365  # a 20-F comes once a year
ADR_MAX_CALLS = 2_500  # ~5 minutes at 8 calls a second; the rest wait for later runs, biggest first


def update_adr_ratios(
    lake: Lake,
    fetch: Callable[[int], Adr],
    securities: pl.DataFrame,
    flags: list,
    budget: Budget,
    today: date,
    max_calls: int = ADR_MAX_CALLS,
) -> dict:
    """Keep `adr_ratios` (`sec/adr.py`) up to date: one row per company, asked again after ADR_FRESH_DAYS.
    Companies never asked come first, biggest first by today's count times the last close. That count is in
    ordinary shares for an ADR, so a missing ratio makes it look bigger and it is asked sooner. A lookup costs
    one SEC call, or up to three for a 20-F filer."""
    table = read_table(lake, ADR_TABLE, ADR_SCHEMA)
    stocks = securities.filter(pl.col("cik").is_not_null() & (pl.col("sector") != "ETF/Fund"))
    sq = lake.read("stock_quarters")  # the last indices run's closes; empty on a new lake
    if sq.is_empty():
        last = pl.DataFrame(schema={"stock_id": pl.Int32, "close": pl.Float64})
    else:
        last = sq.sort("q").group_by("stock_id").last().select(pl.col("stock_id").cast(pl.Int32), pl.col("close").cast(pl.Float64))
    size = (
        stocks.join(last, on="stock_id", how="left").group_by("cik")
        .agg((pl.col("shares_out") * pl.col("close")).max().fill_null(0.0).alias("size"))
    )  # fmt: skip
    todo = (
        size.join(table.select("cik", "checked"), on="cik", how="left")
        .filter(pl.col("checked").is_null() | (pl.col("checked") < today - timedelta(days=ADR_FRESH_DAYS)))
        .sort(pl.col("checked").is_not_null(), pl.col("size"), descending=[False, True])
    )  # fmt: skip
    rows, failed, asked = [], 0, 0
    for cik in todo["cik"].to_list():
        if asked >= max_calls or budget.spent():
            break
        asked += 1
        try:
            a = fetch(cik)
        except FetchError:
            failed += 1
            continue
        rows.append({"cik": cik, "form": a.form, "filed": a.filed, "ratio": a.ratio, "source": a.source, "checked": today})
    if rows:
        done = pl.DataFrame(rows, schema=ADR_SCHEMA)
        table = pl.concat([table.filter(~pl.col("cik").is_in(done["cik"].to_list())), done])
        lake.write(ADR_TABLE, table.sort("cik"))
    if failed:
        flags.append({"type": "adr_lookup_failed", "count": failed})
    filers = table.filter(pl.col("form") == "20-F")
    stats = {"companies": asked - failed, "owed": todo.height - asked, "filers": filers.height,
             "ratios": filers.filter(pl.col("ratio").is_not_null()).height}  # fmt: skip
    log.info("adr_ratios: %s", stats)
    return stats


def adr_ratios(lake: Lake, securities: pl.DataFrame, overrides: dict[str, float]) -> dict[str, float]:
    """ticker -> ordinary shares per ADS: the 20-F lookups (`adr_ratios`), then `share_overrides.csv` on top
    (a hand correction wins). Each lookup the CSV contradicts is logged, to fix one or the other."""
    table = read_table(lake, ADR_TABLE, ADR_SCHEMA).filter(pl.col("ratio").is_not_null() & (pl.col("ratio") > 0))
    found = securities.filter(pl.col("ticker").is_not_null()).join(table.select("cik", "ratio"), on="cik").select("ticker", "ratio")
    out = dict(found.iter_rows())
    for ticker, r in overrides.items():
        if ticker in out and abs(out[ticker] - r) > 0.01 * r:
            log.warning("adr ratio: %s is %s in share_overrides.csv but %s in its 20-F", ticker, r, out[ticker])
    out.update(overrides)
    return out


def reported_prices(lake: Lake, cusip_map: pl.DataFrame) -> pl.DataFrame:
    """REPORTED_SCHEMA: per stock and quarter, from its 13F holdings of the one CUSIP the funds hold the most dollars
    of: the median price per share reported (value over shares, share rows only), and the funds and shares of the rows
    priced within MAX_PRICE_GAP of that median (a share count misread from a text filing has a price far off, and would
    swamp the sum). Other CUSIPs mapped to the stock are left out: run 47 read BlackRock at $10 a share, the median of
    the dozens of BlackRock funds the CUSIP map also gives its id. One quarter's holdings at a time, five columns of it."""
    mapped = cusip_map.filter(pl.col("stock_id").is_not_null()).select("cusip", pl.col("stock_id").cast(pl.Int32)).lazy()
    parts = []
    for part in lake.parts("holdings"):
        rows = (
            pl.scan_parquet(lake.root / "holdings" / f"{part}.parquet")
            .filter((pl.col("kind") == "SH") & (pl.col("shares") > 0) & (pl.col("value_usd") > 0))
            .select("cik", "q", "cusip", "shares", "value_usd", (pl.col("value_usd") / pl.col("shares")).alias("_p"))
            .join(mapped, on="cusip")
            .with_columns(price=pl.col("_p").median().over("stock_id", "q", "cusip"))
        )  # fmt: skip
        near = (pl.col("_p") <= pl.col("price") * MAX_PRICE_GAP) & (pl.col("_p") >= pl.col("price") / MAX_PRICE_GAP)
        parts.append(
            rows.filter(near)
            .group_by("stock_id", "q", "cusip")
            .agg(pl.col("price").first(), pl.col("cik").n_unique().alias("holders"), pl.col("shares").sum().alias("held"),
                 pl.col("value_usd").sum().alias("_v"))
            .sort("stock_id", "q", "_v", "cusip", descending=[False, False, True, False])
            .group_by("stock_id", "q", maintain_order=True)
            .first()
            .collect()
        )  # fmt: skip
    if not parts:
        return pl.DataFrame(schema=REPORTED_SCHEMA)
    return pl.concat(parts).select(*REPORTED_SCHEMA.names()).cast(REPORTED_SCHEMA)


def _log_mispriced(off: pl.DataFrame, spared: pl.DataFrame, securities: pl.DataFrame, flags: list, top: int = 40) -> None:
    """Log the stocks whose closes `mispriced` set aside, most quarters first, with the worst quarter's two prices and
    the share of the company the funds hold then; and those it spared (the funds' CUSIP is not the company's stock)."""
    names = securities.select(pl.col("stock_id").cast(pl.Int32), "ticker", "name")
    for rows, what, limit in ((off, "prices set aside (13F price)", top), (spared, "prices kept (13F holdings not its stock)", 15)):
        if rows.is_empty():
            continue
        per = (
            rows.with_columns(_x=pl.col("gap").log().abs()).sort("_x", descending=True)
            .group_by("stock_id", maintain_order=True)
            .agg(pl.len().alias("quarters"), pl.col("q").min().alias("q0"), pl.col("q").max().alias("q1"), pl.col("q").first(),
                 pl.col("ours").first(), pl.col("theirs").first(), pl.col("held_share").first())
            .join(names, on="stock_id", how="left").sort("quarters", "stock_id", descending=[True, False])
        )  # fmt: skip
        for r in per.head(limit).iter_rows(named=True):
            held = "–" if r["held_share"] is None else f"{100 * r['held_share']:.0f}%"
            log.warning("%s: %s (%s, id %s) in %d quarters (q%s to q%s), worst q%s ours %.4g, theirs %.4g, funds hold %s",
                        what, r["ticker"], r["name"], r["stock_id"], r["quarters"], r["q0"], r["q1"], r["q"], r["ours"], r["theirs"], held)  # fmt: skip
    if not off.is_empty():
        flags.append({"type": "prices_set_aside", "stocks": off["stock_id"].n_unique(), "quarters": off.height})


def _log_scaled(scaled: pl.DataFrame, caps: pl.DataFrame, securities: pl.DataFrame, flags: list, top: int = 25) -> None:
    """Log the stocks whose stand-in count `held_scales` scaled down, biggest share of the market first (in the
    quarter it was biggest), with that quarter's scale."""
    if scaled.is_empty():
        return
    names = securities.select(pl.col("stock_id").cast(pl.Int32), "ticker", "name")
    total = caps.group_by("q").agg(pl.col("cap").sum().alias("_t"))
    s = scaled.join(total, on="q").with_columns(w=pl.col("cap") / pl.col("_t")).sort("w", descending=True)
    per = (
        s.group_by("stock_id", maintain_order=True)
        .agg(pl.len().alias("quarters"), pl.col("q").first(), pl.col("w").first(), pl.col("scale").first(), pl.col("scale").min().alias("low"))
        .join(names, on="stock_id", how="left")
    )  # fmt: skip
    for r in per.head(top).iter_rows(named=True):
        log.info("caps scaled by 13F holdings: %s (%s, id %s) in %d quarters, top %.2f%% of the market in q%s at x%.3f (lowest x%.3f)",
                 r["ticker"], r["name"], r["stock_id"], r["quarters"], 100 * r["w"], r["q"], r["scale"], r["low"])  # fmt: skip
    flags.append({"type": "caps_scaled", "stocks": per.height, "quarters": scaled.height})


def stock_paths(stocks: pl.DataFrame, labels: dict, sic: SicTable) -> tuple[dict[int, str], dict[int, str], int]:
    """(stock_id -> vertical path, stock_id -> how, ids skipped by the ticker guard) for `stocks` (stock_id,
    ticker, sic). A CSV row whose ticker no longer matches the lake's is not trusted (the lake's ids moved, or
    this is another lake), so that stock falls back to its SIC code."""
    paths, how, moved = {}, {}, 0
    for sid, ticker, code in stocks.select("stock_id", "ticker", "sic").iter_rows():
        lab = labels.get(sid)
        if lab is not None and lab.ticker != ticker:
            moved += 1
            lab = None
        if lab is not None and lab.kind != "stock":
            continue
        node, found = (lab.node, lab.how) if lab is not None else (sic.label(code), "sic")
        if node is not None:
            paths[sid], how[sid] = node.path, found
    return paths, how, moved


SECTOR_CHUNK = 1000  # stocks per price read: bounds memory


def build_sector_returns(
    lake: Lake,
    last_q: int,
    flags: list,
    labels: dict | None = None,
    sic: SicTable | None = None,
    adr: dict[str, float] | None = None,
) -> dict:
    """Build `sector_returns` (every hierarchy label's index, `engine/sectors.py`) from the lake and write it.

    Only stocks count: ETFs, funds and bonds are left out. A stock's label comes from `data/stock_nodes.csv`,
    then its SIC code; labels are read fresh each time, so a relabel needs only a re-run. Returns health counts:
    labelled stocks by how, and the share of market cap that is unlabelled or uses today's share count."""
    h = load()
    labels = assign.load_stock_labels(h=h) if labels is None else labels
    sic = SicTable.load(h=h) if sic is None else sic
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    adr = adr_ratios(lake, securities, load_overrides()) if adr is None else adr
    stocks = securities.filter(
        pl.struct("ticker", "sector").map_elements(lambda r: kind(r["ticker"] or "", r["sector"] or "") == "stock", return_dtype=pl.Boolean)
    )
    paths, how, moved = stock_paths(stocks, labels, sic)
    if moved:
        flags.append({"type": "label_ticker_changed", "count": moved})
    etf_ids = securities.filter(pl.col("sector") == "ETF/Fund")["stock_id"].to_list()  # their own series, for ETF picks
    ids = stocks["stock_id"].to_list() + etf_ids
    parts, split_parts = [], []
    for i in range(0, len(ids), SECTOR_CHUNK):
        daily = load_daily(lake, ids[i : i + SECTOR_CHUNK])
        if not daily.is_empty():
            parts.append(stock_quarters(daily))
            # the splits on record, to put each filed share count on the price's share basis
            split_parts.append(
                daily.filter(pl.col("split_factor").is_not_null() & (pl.col("split_factor") != 1.0))
                .select(pl.col("stock_id").cast(pl.Int32), "date", pl.col("split_factor").cast(pl.Float64))
            )
    if not parts:
        return {"stocks": 0}
    sq = pl.concat(parts)
    reported = reported_prices(lake, read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
    hist = read_table(lake, "shares_hist", SHARES_SCHEMA)
    splits = pl.concat(split_parts)
    stock_ids = stocks["stock_id"].to_list()
    scaled: list = []
    units: list = []
    caps, fallback = market_caps(sq.filter(pl.col("stock_id").is_in(stock_ids)), hist, securities, adr, splits, reported, scaled, units)
    # A close that is some other security's (`mispriced`) sits out: of the indices, and of the fund scores' stock
    # series, which read `stock_quarters`
    spared: list = []
    off = mispriced(sq, reported, pl.concat(units), spared)
    if not off.is_empty():
        bad = pl.col("_off").fill_null(False)
        gone = off.select(pl.col("stock_id").cast(sq.schema["stock_id"]), pl.col("q").cast(sq.schema["q"]), _off=pl.lit(True))
        sq = (
            sq.join(gone, on=["stock_id", "q"], how="left", maintain_order="left")
            .with_columns(close=pl.when(bad).then(None).otherwise(pl.col("close")), vwap=pl.when(bad).then(None).otherwise(pl.col("vwap")))
            .drop("_off")
        )  # fmt: skip
        caps = caps.join(gone.select(pl.col("stock_id").cast(caps.schema["stock_id"]), pl.col("q").cast(pl.Int32)), on=["stock_id", "q"], how="anti")
    _log_mispriced(off, pl.concat(spared), securities, flags)
    _log_scaled(pl.concat(scaled), caps, securities, flags)
    lake.write("stock_quarters", sq.select("stock_id", "q", "close", "div", "vwap"))
    sq = sq.filter(pl.col("stock_id").is_in(stock_ids))
    _, fallback_now = market_caps(sq.filter(pl.col("q") == last_q), hist, securities, adr, splits)  # the health figure: today only
    sq = sq.join(caps, on=["stock_id", "q"], how="left").select(*QUARTER_SCHEMA.names()).cast(QUARTER_SCHEMA)
    set_aside: list = []
    movers: list = []
    out = index_returns(sq, paths, last_q, set_aside, movers)
    lake.write("sector_returns", out)
    _log_caps(sq, paths, last_q, set_aside, movers, securities, flags)
    latest = caps.filter(pl.col("q") == last_q)
    total = latest["cap"].sum() or 1.0
    unlabelled = latest.filter(~pl.col("stock_id").is_in(list(paths)))["cap"].sum()
    used = set(sq.filter(pl.col("q") <= last_q)["stock_id"].to_list()) & set(paths)
    stats = {
        "stocks": len(used),
        "by_how": dict(sorted(Counter(how[s] for s in used).items())),
        "labels": out["label"].n_unique(),
        "unlabelled_cap_share": round(unlabelled / total, 4),
        "fallback_caps": len(fallback & used),  # used today's count in at least one quarter
        "fallback_cap_share": round(latest.filter(pl.col("stock_id").is_in(list(fallback_now)))["cap"].sum() / total, 4),  # in the last quarter
    }
    flags.append({"type": "sector_returns", **{k: v for k, v in stats.items() if k != "by_how"}})
    log.info("sector_returns: %s", stats)
    return stats


def _log_caps(
    sq: pl.DataFrame, paths: dict[int, str], last_q: int, set_aside: list, movers: list, securities: pl.DataFrame, flags: list
) -> None:
    """Log the caps worth a look (engine/sectors.cap_report) and the stock-quarters the indices set aside, with
    ticker and name, so a bad share count (an ADR without its ratio in share_overrides.csv) is named in the run's
    log. Tickers and caps only; the lake's CUSIPs never appear."""
    names = securities.select("stock_id", "ticker", "name")
    for kind, rows in cap_report(sq, paths, last_q).items():
        for r in rows.join(names, on="stock_id", how="left").iter_rows(named=True):
            log.info("caps %s: %s (%s, id %s) q%s %s cap $%sbn %s", kind, r["ticker"], r["name"], r["stock_id"], r["q"],
                     r["sector"], f"{r['cap'] / 1e9:,.1f}", r["weight"])  # fmt: skip
    if movers:
        moved = pl.concat(movers).join(names, on="stock_id", how="left")
        for r in moved.filter(pl.col("pts").abs() >= 0.03).iter_rows(named=True):
            log.info("caps movers: q%s %s (%s, id %s) weight %.1f%% return %+.0f%% moved the market %+.1f pts", r["q"], r["ticker"],
                     r["name"], r["stock_id"], 100 * r["weight"], 100 * r["r"], 100 * r["pts"])  # fmt: skip
        heavy = moved.filter(pl.col("weight") >= HEAVY_WEIGHT).sort("weight", descending=True).group_by("stock_id", "ticker", "name", maintain_order=True)
        for r in heavy.agg(pl.len().alias("n"), pl.col("weight").first().alias("top"), pl.col("q").first(), pl.col("q").min().alias("q0"),
                           pl.col("q").max().alias("q1")).iter_rows(named=True):  # fmt: skip
            log.info("caps heavy: %s (%s, id %s) %.0f%%+ of the market in %d quarters (q%s to q%s), top %.1f%% in q%s", r["ticker"],
                     r["name"], r["stock_id"], 100 * HEAVY_WEIGHT, r["n"], r["q0"], r["q1"], 100 * r["top"], r["q"])  # fmt: skip
    if set_aside:
        gone = pl.concat(set_aside).join(names, on="stock_id", how="left")
        per = gone.group_by("why", "stock_id", "ticker", "name").agg(pl.len().alias("quarters"), pl.col("weight").max().alias("worst"))
        for r in per.sort("why", "worst", descending=[False, True]).iter_rows(named=True):
            log.warning("caps set aside (%s): %s (%s, id %s) in %d quarters, worst %.3g", r["why"], r["ticker"], r["name"],
                        r["stock_id"], r["quarters"], r["worst"])  # fmt: skip
        counts = dict(per.group_by("why").len().iter_rows())
        flags.append({"type": "caps_set_aside", **counts})


SKILL_TRADES = 300_000  # trades per replay chunk: a few giant funds hold millions, so chunk by trades, not funds


def trade_chunks(counts: dict[int, int], max_trades: int = SKILL_TRADES) -> list[list[int]]:
    """CIKs (in order) grouped so each group holds at most `max_trades` trades; a bigger fund is a group alone.
    Run 28 lost its runner seconds into scoring with chunks of 200 funds each."""
    chunks: list[list[int]] = []
    size = 0
    for cik, n in counts.items():
        if not chunks or size + n > max_trades:
            chunks.append([])
            size = 0
        chunks[-1].append(cik)
        size += n
    return chunks


@dataclass(frozen=True)
class ScoreInputs:
    """What every replay needs, read from the lake once (labels read fresh)."""

    sector: pl.DataFrame
    sq: pl.DataFrame
    paths: dict[int, str]
    etfs: dict[int, skill.EtfPick | None]
    nosector: set[str]
    spy: int | None
    series: pl.DataFrame


SECTOR_SCHEMA = pl.Schema({"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64})


def score_inputs(lake: Lake, sector: pl.DataFrame) -> ScoreInputs:
    h = load()
    sq = lake.read("stock_quarters")
    labels = assign.load_stock_labels(h=h)
    sic = SicTable.load(h=h)
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    with open(assign.ETF_FILE, newline="", encoding="utf-8") as f:
        etf_rows, _ = assign.read_etf_labels(f, h)
    tickers = dict(securities.select("stock_id", "ticker").iter_rows())
    etfs = {sid: (skill.EtfPick(e.path, assign.TIERS.index(e.tier) + 1) if e.cls == "sector" else None)
            for sid, e in etf_rows.items() if tickers.get(sid) == e.ticker}  # fmt: skip
    stocks = securities.filter(
        ~pl.col("stock_id").is_in(list(etfs))
        & pl.struct("ticker", "sector").map_elements(lambda r: kind(r["ticker"] or "", r["sector"] or "") == "stock", return_dtype=pl.Boolean)
    )
    paths, _, _ = stock_paths(stocks, labels, sic)
    spy = stock_of(read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)).get(BENCHMARK_CUSIP)
    nosector = {n.path for n in h.nosector}
    series = pl.concat([skill.own_series(sq), skill.label_series(sector)])
    return ScoreInputs(sector, sq, paths, etfs, nosector, spy, series)


def score_funds(lake: Lake, last_q: int, flags: list) -> dict:
    """Score every fund in `fund_flows` against `sector_returns` (`engine/skill.py`) and write `fund_skill`
    (per fund and tier) and `etf_ranks` (per single-sector ETF position). Labels are read fresh."""
    sector = read_table(lake, "sector_returns", SECTOR_SCHEMA)
    flows = read_table(lake, "fund_flows", FUND_FLOWS_SCHEMA)
    if sector.is_empty() or flows.is_empty():
        return {"funds": 0}
    i = score_inputs(lake, sector)
    sq, paths, etfs, nosector, spy, series = i.sq, i.paths, i.etfs, i.nosector, i.spy, i.series
    counts = dict(flows.group_by("cik").len().sort("cik").iter_rows())
    scores, ranks, dropped = [], [], 0
    for n, chunk in enumerate(trade_chunks(counts)):
        part = flows.filter(pl.col("cik").is_in(chunk))
        got, bad = skill.fund_scores(part, sq, sector, paths, etfs, nosector, spy, last_q, series=series)
        if n % 10 == 0:
            log.info("skill: chunk %d, %d funds, %d trades, peak %d MB", n, len(chunk), part.height, peak_mb())
        scores.append(got)
        ranks.append(skill.etf_ranks(part, sector, etfs, last_q))
        dropped += bad.height
    scores, ranks = pl.concat(scores), pl.concat(ranks)
    lake.write("fund_skill", scores)
    lake.write("etf_ranks", ranks)
    industry = scores.filter(pl.col("tier") == 2)
    stats = {"funds": industry.height, "scored": industry["picking"].drop_nulls().len(), "etf_positions": ranks.height,
             "dropped_positions": dropped, "median_coverage": round(industry["coverage"].median() or 0.0, 3)}  # fmt: skip
    flags.append({"type": "fund_skill", **stats})
    log.info("fund_skill: %s", stats)
    return stats


SECTOR_STAGING = "sectors_staging"  # under the out folder: what the workflow's sector upload copies


def _r(x: float | None, digits: int = 6) -> float | None:
    return None if x is None else round(x, digits)


def _dollars(x: float | None) -> float | None:
    """Dollars to the cent, always a float: a whole number printed bare can be a 9-digit CUSIP
    (Microsoft's is 594918104) and trip the CUSIP guard; "594918104.0" is a decimal, which it skips."""
    return None if x is None else float(round(x, 2))


def skill_docs(d: skill_detail.Detail, mix: pl.DataFrame, last_q: int) -> dict[int, dict]:
    """fund id -> its `fund/{id}/skill.json` (contract.md, Sector files) from one chunk's detail and mix."""

    def by_cik(df: pl.DataFrame) -> dict[int, pl.DataFrame]:
        return {k[0]: v for k, v in df.partition_by("cik", as_dict=True).items()}

    quarters, years, bought, scores = by_cik(d.quarters), by_cik(d.years), by_cik(d.bought), by_cik(d.scores)
    picks, bets, mixes = by_cik(d.picks), by_cik(d.bets), by_cik(mix)
    first = dict(d.first_q.iter_rows())
    docs = {}
    for cik, sc in scores.items():
        if cik not in first:
            continue
        qs = list(range(first[cik], last_q + 1))
        qrows = quarters.get(cik, pl.DataFrame(schema=d.quarters.schema))
        series = {(t, v): {q: (val, r) for q, val, r in g.select("q", "v", "r").iter_rows()}
                  for (t, v), g in qrows.partition_by("tier", "variant", as_dict=True).items()}  # fmt: skip
        yrows = years.get(cik, pl.DataFrame(schema=d.years.schema))
        ys = {(t, v): {yr: ret for yr, ret in g.select("year", "ret").iter_rows()}
              for (t, v), g in yrows.partition_by("tier", "variant", as_dict=True).items()}  # fmt: skip
        names = yrows.filter(pl.col("tier") == 1).select("year", "name").unique().sort("year")
        year_ids, year_names = names["year"].to_list(), names["name"].to_list()
        buy = dict(bought[cik].select("q", "bought").iter_rows()) if cik in bought else {}

        def ret(t: int, v: str) -> list:
            s = series.get((t, v), {})
            return [_r(s.get(q, (None, None))[1]) for q in qs]

        def val(t: int, v: str) -> list:
            s = series.get((t, v), {})
            return [_dollars(s.get(q, (None, None))[0]) if (t, v) in series else None for q in qs]

        def yret(t: int, v: str) -> list:
            s = ys.get((t, v), {})
            return [_r(s.get(y)) for y in year_ids]

        tiers = {}
        for row in sc.iter_rows(named=True):
            t = row["tier"]
            pk = picks[cik].filter(pl.col("tier") == t) if cik in picks else pl.DataFrame(schema=d.picks.schema)
            bt = bets[cik].filter(pl.col("tier") == t) if cik in bets else pl.DataFrame(schema=d.bets.schema)
            tiers[str(t)] = {
                **{k: _r(row[k]) for k in ("irr_fund", "irr_label", "irr_mkt", "irr_spy", "picking", "allocation")},
                "coverage": _r(row["coverage"], 4), "n": row["n"],
                "quarters": {"label": ret(t, "label"), "v_label": val(t, "label"), "v_never": None},
                "years": {"label": yret(t, "label")},
                "picks": {
                    "stock_id": [None if s == skill_detail.OTHERS else s for s in pk["stock_id"].to_list()],
                    "label": pk["label"].to_list(), "bought": [_dollars(x) for x in pk["bought"].to_list()],
                    "irr_own": [_r(x) for x in pk["irr_own"].to_list()], "irr_label": [_r(x) for x in pk["irr_label"].to_list()],
                },
                "bets": {
                    "label": bt["label"].to_list(), "bought": [_dollars(x) for x in bt["bought"].to_list()],
                    "irr": [_r(x) for x in bt["irr"].to_list()], "irr_mkt": [_r(x) for x in bt["irr_mkt"].to_list()],
                    "mkt_share": [_r(x, 4) for x in bt["mkt_share"].to_list()],
                },
            }  # fmt: skip
        mq: dict = {"q": [], "label": [], "share": []}
        if cik in mixes:
            m = mixes[cik]
            mq["q"] = sorted(set(m["q"].to_list()))
            pos = {q: i for i, q in enumerate(mq["q"])}
            for label, g in m.partition_by("label", as_dict=True, maintain_order=True).items():
                row = [0.0] * len(mq["q"])
                for q, share in g.select("q", "share").iter_rows():
                    row[pos[q]] = share
                mq["label"].append(label[0])
                mq["share"].append(row)
            order = sorted(range(len(mq["label"])), key=lambda i: mq["label"][i])
            mq["label"], mq["share"] = [mq["label"][i] for i in order], [mq["share"][i] for i in order]
        docs[cik] = {
            "last_q": last_q, "first_q": first[cik],
            "quarters": {"q": qs, "bought": [_dollars(buy.get(q, 0.0)) for q in qs],
                         "fund": ret(1, "fund"), "mkt": ret(1, "mkt"), "spy": ret(1, "spy"),
                         "v_fund": val(1, "fund"), "v_mkt": val(1, "mkt"), "v_spy": val(1, "spy")},
            "years": {"name": year_names, "fund": yret(1, "fund"), "mkt": yret(1, "mkt"), "spy": yret(1, "spy")},
            "tiers": tiers, "mix": mq,
        }  # fmt: skip
    return docs


def publish_sectors(lake: Lake, out_root: Path, last_q: int, flags: list, compress: bool = True, built: datetime | None = None) -> dict:
    """Write `sectors/labels.json`, `sectors/scores.json` and every listed fund's `fund/{id}/skill.json` into
    `out_root/sectors_staging`, then add them to `out_root/manifest.json` (the site's, as the monthly run left it).

    Funds are those the manifest lists a summary for (all, without a manifest). The CUSIP guard runs over the
    staged files before the manifest changes; the workflow uploads the folder, then the manifest."""
    sector = read_table(lake, "sector_returns", OUT_SCHEMA)
    flows = read_table(lake, "fund_flows", FUND_FLOWS_SCHEMA)
    if sector.is_empty() or flows.is_empty():
        return {"funds": 0}
    i = score_inputs(lake, sector)
    out_root = Path(out_root)
    site = read_manifest(out_root, compress)
    listed = {int(p.split("/")[1]) for p in site if p.startswith("fund/") and p.endswith("/summary.json")}
    if listed:
        flows = flows.filter(pl.col("cik").is_in(list(listed)))
    staging = out_root / SECTOR_STAGING
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    paths = skill_detail.mix_paths(i.paths, i.etfs)
    files: dict[str, str] = {}
    scores = []
    counts = dict(flows.group_by("cik").len().sort("cik").iter_rows())
    for n, chunk in enumerate(trade_chunks(counts)):
        part = flows.filter(pl.col("cik").is_in(chunk))
        d = skill_detail.fund_detail(part, sector, i.paths, i.etfs, i.nosector, i.spy, last_q, i.series)
        mix = skill_detail.fund_mix(part, i.sq, paths, last_q)
        for cik, doc in skill_docs(d, mix, last_q).items():
            rel = f"fund/{cik}/skill.json"
            files[rel] = write_json(staging / rel, doc, compress)
        scores.append(d.scores.join(d.first_q, on="cik"))
        if n % 10 == 0:
            log.info("sector files: chunk %d, %d funds, %d trades, peak %d MB", n, len(chunk), part.height, peak_mb())
    sc = pl.concat(scores).sort("cik", "tier") if scores else pl.DataFrame()
    doc = {"last_q": last_q, "fund_id": [], "tier": [], "picking": [], "allocation": [], "n": [], "coverage": [], "span_q": []}
    for r in sc.iter_rows(named=True):
        doc["fund_id"].append(r["cik"])
        doc["tier"].append(r["tier"])
        doc["picking"].append(_r(r["picking"]))
        doc["allocation"].append(_r(r["allocation"]))
        doc["n"].append(r["n"])
        doc["coverage"].append(_r(r["coverage"], 4))
        doc["span_q"].append(last_q - r["first_q"] + 1)
    files["sectors/scores.json"] = write_json(staging / "sectors/scores.json", doc, compress)
    labels = skill_detail.label_list(sector, last_q)
    ldoc = {"last_q": last_q, **{c: labels[c].to_list() for c in ("label", "tier", "parent", "name", "n", "top_weight")}}
    files["sectors/labels.json"] = write_json(staging / "sectors/labels.json", ldoc, compress)
    cusips = {c for c in read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)["cusip"].to_list() if is_cusip(c)}
    leaks = cusip_leaks(staging, cusips, compress)
    if leaks:
        raise CusipLeakError(f"staged sector files would publish a CUSIP: {', '.join(leaks)}")
    version = "sectors"
    path = out_root / "manifest.json"
    if path.exists():
        version = read_json_any(path, compress).get("version", version)
    merged = {p: h for p, h in site.items() if not is_sector_path(p)} | files
    write_manifest(out_root, version, merged, compress, built=built)
    sizes = [f.stat().st_size for f in staging.rglob("skill.json")]
    stats = {"funds": len(sizes), "bytes": sum(sizes), "largest": max(sizes, default=0)}
    flags.append({"type": "sector_files", **stats})
    log.info("sector files: %s", stats)
    return stats


def read_json_any(path: Path, compressed: bool) -> dict:
    """A manifest restored from the site may be plain JSON (R2 decodes br for rclone): read either."""
    import brotli

    data = path.read_bytes()
    if compressed:
        try:
            data = brotli.decompress(data)
        except brotli.error:
            pass
    return json.loads(data)


def peak_mb() -> int:
    """The process's peak memory so far (MB): logged by each step, so a run that dies shows which step grew."""
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024


def recompute(
    lake: Lake,
    fetch_shares: Callable[[int], list] | None = None,
    minutes: float = 90,
    part: str = "all",
    out_root: Path | None = None,
    fetch_adr: Callable[[int], Adr] | None = None,
) -> dict:
    """`orca.run sectors`: share-count history (when `fetch_shares` is given), ADS ratios (`fetch_adr`), the indices and the scores, from
    the lake. Its own workflow step after the monthly run's lake is saved (so it can never cost that run), and
    the whole job after a relabel (`sectors_only`). `part` = "indices" (share counts and indices) or "scores"
    (fund scores) runs one half, so the workflow saves the indices before scoring starts. No fund compute,
    nothing published; it uses the quarter of the last run."""
    import gc

    from orca.run.state import State

    last_q = State.load(lake).last_q
    if last_q is None:
        raise SystemExit("no run has completed on this lake yet")
    flags: list = []
    budget = Budget(minutes)
    out: dict = {"flags": flags}
    if part == "publish":
        out["files"] = publish_sectors(lake, out_root if out_root is not None else Path("data/out"), last_q, flags)
        log.info("files: peak %d MB", peak_mb())
        return out
    if part == "scores":
        out["skill"] = score_funds(lake, last_q, flags)
        log.info("skill: peak %d MB", peak_mb())
        return out
    if fetch_shares is not None:
        securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
        out["shares"] = update_share_history(lake, fetch_shares, securities, flags, budget, date.today())
        if fetch_adr is not None:
            out["adr"] = update_adr_ratios(lake, fetch_adr, securities, flags, budget, date.today())
        del securities
        log.info("shares: peak %d MB", peak_mb())
    out["sectors"] = build_sector_returns(lake, last_q, flags)
    gc.collect()
    log.info("sectors: peak %d MB", peak_mb())
    if part == "indices":
        return out
    out["skill"] = score_funds(lake, last_q, flags)
    log.info("skill: peak %d MB", peak_mb())
    return out
