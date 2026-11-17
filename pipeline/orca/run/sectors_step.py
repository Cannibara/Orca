"""Run steps for the sector indices: keep the share-count history (`shares_hist`) up to date, and build
`sector_returns`, every hierarchy label's index (lake only; nothing is published yet).

One SEC call per company (share classes share a CIK). Companies with no history come first, then the stalest;
a company whose newest row was filed within `FRESH_DAYS` is skipped. `max_calls` caps one run (about 40 min at
the SEC's 8 calls a second), so the first backfill spreads over a run or two. A company that reports no count
gets a null row, so it is asked again only once that row is stale.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable
from datetime import date, timedelta

import polars as pl

from orca.engine import skill
from orca.engine.sectors import QUARTER_SCHEMA, index_returns, market_caps, stock_quarters
from orca.hierarchy import assign, load
from orca.hierarchy.assign import SicTable
from orca.hierarchy.matching import kind
from orca.http import FetchError
from orca.run.budget import Budget
from orca.run.market import BENCHMARK_CUSIP, load_daily, stock_of
from orca.run.state import CUSIP_MAP_SCHEMA, FUND_FLOWS_SCHEMA, SECURITIES_TABLE_SCHEMA, read_table
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


SECTOR_CHUNK = 2000  # stocks per price read: bounds memory


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
    adr = load_overrides() if adr is None else adr
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    stocks = securities.filter(
        pl.struct("ticker", "sector").map_elements(lambda r: kind(r["ticker"] or "", r["sector"] or "") == "stock", return_dtype=pl.Boolean)
    )
    paths, how, moved = stock_paths(stocks, labels, sic)
    if moved:
        flags.append({"type": "label_ticker_changed", "count": moved})
    etf_ids = securities.filter(pl.col("sector") == "ETF/Fund")["stock_id"].to_list()  # their own series, for ETF picks
    ids = stocks["stock_id"].to_list() + etf_ids
    parts = []
    for i in range(0, len(ids), SECTOR_CHUNK):
        daily = load_daily(lake, ids[i : i + SECTOR_CHUNK])
        if not daily.is_empty():
            parts.append(stock_quarters(daily))
    if not parts:
        return {"stocks": 0}
    sq = pl.concat(parts)
    lake.write("stock_quarters", sq.select("stock_id", "q", "close", "div", "vwap"))
    sq = sq.filter(pl.col("stock_id").is_in(stocks["stock_id"].to_list()))
    caps, fallback = market_caps(sq, read_table(lake, "shares_hist", SHARES_SCHEMA), securities, adr)
    sq = sq.join(caps, on=["stock_id", "q"], how="left").select(*QUARTER_SCHEMA.names()).cast(QUARTER_SCHEMA)
    out = index_returns(sq, paths, last_q)
    lake.write("sector_returns", out)
    latest = caps.filter(pl.col("q") == last_q)
    total = latest["cap"].sum() or 1.0
    unlabelled = latest.filter(~pl.col("stock_id").is_in(list(paths)))["cap"].sum()
    used = set(sq.filter(pl.col("q") <= last_q)["stock_id"].to_list()) & set(paths)
    stats = {
        "stocks": len(used),
        "by_how": dict(sorted(Counter(how[s] for s in used).items())),
        "labels": out["label"].n_unique(),
        "unlabelled_cap_share": round(unlabelled / total, 4),
        "fallback_caps": len(fallback & used),
        "fallback_cap_share": round(latest.filter(pl.col("stock_id").is_in(list(fallback)))["cap"].sum() / total, 4),
    }
    flags.append({"type": "sector_returns", **{k: v for k, v in stats.items() if k != "by_how"}})
    log.info("sector_returns: %s", stats)
    return stats


SKILL_CHUNK = 500  # funds per replay: bounds memory


def score_funds(lake: Lake, last_q: int, flags: list) -> dict:
    """Score every fund in `fund_flows` against `sector_returns` (`engine/skill.py`) and write `fund_skill`
    (per fund and tier) and `etf_ranks` (per single-sector ETF position). Labels are read fresh."""
    h = load()
    sector = read_table(lake, "sector_returns", pl.Schema({"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64}))
    flows = read_table(lake, "fund_flows", FUND_FLOWS_SCHEMA)
    if sector.is_empty() or flows.is_empty():
        return {"funds": 0}
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
    ciks = flows["cik"].unique().sort().to_list()
    scores, ranks, dropped = [], [], 0
    for i in range(0, len(ciks), SKILL_CHUNK):
        part = flows.filter(pl.col("cik").is_in(ciks[i : i + SKILL_CHUNK]))
        got, bad = skill.fund_scores(part, sq, sector, paths, etfs, nosector, spy, last_q)
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


def recompute(lake: Lake) -> dict:
    """`orca.run sectors`: rebuild the indices and the scores from the lake, for a relabel. No fetch, no fund
    compute, nothing published; it uses the quarter of the last run."""
    from orca.run.state import State

    last_q = State.load(lake).last_q
    if last_q is None:
        raise SystemExit("no run has completed on this lake yet")
    flags: list = []
    return {"sectors": build_sector_returns(lake, last_q, flags), "skill": score_funds(lake, last_q, flags), "flags": flags}
