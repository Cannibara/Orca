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

from orca.engine.sectors import QUARTER_SCHEMA, index_returns, market_caps, stock_quarters
from orca.hierarchy import assign, load
from orca.hierarchy.assign import SicTable
from orca.hierarchy.matching import kind
from orca.http import FetchError
from orca.run.budget import Budget
from orca.run.market import load_daily
from orca.run.state import SECURITIES_TABLE_SCHEMA, read_table
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
    paths, how = {}, {}
    for sid, code in stocks.select("stock_id", "sic").iter_rows():
        node, found = assign.label_of(sid, code, labels, sic)
        if node is not None and (sid not in labels or labels[sid].kind == "stock"):
            paths[sid], how[sid] = node.path, found
    ids = stocks["stock_id"].to_list()
    parts = []
    for i in range(0, len(ids), SECTOR_CHUNK):
        daily = load_daily(lake, ids[i : i + SECTOR_CHUNK])
        if not daily.is_empty():
            parts.append(stock_quarters(daily))
    if not parts:
        return {"stocks": 0}
    sq = pl.concat(parts)
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
