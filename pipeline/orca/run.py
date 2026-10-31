"""Weekly orchestrator: ingest new filings and prices, recompute the funds they touch, publish.

A run (`run_weekly`) goes: unseen bulk ZIPs -> live filings since the last run -> per-quarter
holdings -> new CUSIPs mapped -> prices of held stocks -> affected funds -> those funds
recomputed (bridge and share invariants checked) -> home lists and health -> files staged, only
the changed ones kept -> CUSIP scan -> manifest. Anything that fails before the manifest leaves the
published site on the last good version, and what the run still owes (funds and stocks to
recompute) is kept in the lake's state, so the next run picks it up.

Lake layout (all under `lake.root`):
- `filings/qNNN`, `raw_holdings/qNNN`: every filing of report period NNN and its raw rows, one
  copy per (accession, source); a re-read filing replaces its earlier copy.
- `reports/qNNN`, `holdings/qNNN`: the chosen reports and the collapsed holdings of the quarter,
  rebuilt whenever the quarter gets a filing.
- `securities`, `cusip_map`, `prices_daily/...`, `rf`, `fund_state` (each fund's header and home
  snapshot as JSON, for the funds a run does not recompute).
- `ingested.json` (bulk ZIPs ingested, name -> sha256), `state.json` (live watermark, last
  quarter, pending recomputes), `published.json` (the last manifest's files).

A fund is identified by its CIK (`fund_id` = CIK), so ids never depend on ingestion order.
"""

import argparse
import json
import logging
import os
import random
import re
import shutil
import statistics
import sys
import tempfile
import zipfile
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import date, datetime, timedelta
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, urlunsplit

import brotli
import polars as pl

from orca import config
from orca.config import PERIODS, PRICE_MISMATCH
from orca.engine.fund import FundQuarter, aggregate_fund, check_bridge, contributions, fund_years
from orca.engine.metrics import Performance, hold_lengths, performance, priced_pct, turnover
from orca.engine.position import PositionResult, Trade, compute_position
from orca.engine.whatif import beat_spy_pct, buys_vs_sells, exit_rows
from orca.holdings import HOLDINGS_SCHEMA, build_holdings, fill_gaps, select_reports
from orca.home import (
    FundSnapshot,
    calls,
    conviction_moves,
    crowded_buys,
    just_filed,
    top_funds,
    wins_losses,
)
from orca.http import FetchError, FigiClient
from orca.prices import (
    TABLE as PRICES_TABLE,
)
from orca.prices import (
    PriceSource,
    compact_prices,
    split_adjust_prices,
    split_adjust_shares,
    update_prices,
)
from orca.publish import (
    ExitsSummary,
    FundMeta,
    FundOutput,
    HomeLists,
    build_metrics,
    changed_files,
    new_version,
    publish_fund,
    publish_shared,
    read_manifest,
    weekly_closes,
    write_health,
    write_manifest,
)
from orca.quarter_px import QuarterPx, close_on, quarter_px
from orca.quarters import q_end, q_of_date
from orca.sec.bulk import parse_bulk_zip
from orca.sec.live import FILINGS_SCHEMA
from orca.securities import (
    SECURITIES_SCHEMA,
    assign_stock_ids,
    map_cusips,
    normalise_ticker,
    sector_for_sic,
)
from orca.storage import Lake, Manifest, sha256_file

log = logging.getLogger(__name__)

DEADLINE_DAYS = 45  # a 13F is due 45 days after the quarter ends
LIVE_RECENT_BUSINESS_DAYS = 3  # a missing daily index this recent may only be late
LIVE_FIRST_LOOKBACK_DAYS = 7  # first live read when there is no bulk data to start after
BENCHMARK_CUSIP = "78462F103"  # SPY, the benchmark of the what-if figures
SPLIT_RATIOS = (2.0, 3.0, 4.0, 5.0, 10.0, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10)
KEEP_STAGING = 2  # staging folders kept (this run's and the one before)
MAX_FLAGS_PER_KIND = 100  # health lists at most this many findings of one kind
EMPTY_FETCH_WARN = 0.25  # share of tickers answering with no rows that is worth a flag
COMPACT_AT_RUN_PARTS = 4  # price run parts that trigger a compaction into yearly parts
FUND_BATCH = 250  # funds computed per batch (bounds memory on a full recompute)
_BUYS = ("new", "add")

RAW_SCHEMA = pl.Schema(
    {
        "accession": pl.String,
        "cusip": pl.String,
        "issuer": pl.String,
        "title": pl.String,
        "shares": pl.Float64,
        "sh_type": pl.String,
        "put_call": pl.String,
        "value_usd": pl.Float64,
        "source": pl.String,
    }
)
TABLE_SCHEMA = pl.Schema(
    {
        **SECURITIES_SCHEMA,
        "cik": pl.Int64,
        "sic": pl.Int32,
        "sector": pl.String,
        "shares_out": pl.Float64,
    }
)
CUSIP_MAP_SCHEMA = pl.Schema({"cusip": pl.String, "stock_id": pl.Int32, "method": pl.String})
REPORTS_SCHEMA = FILINGS_SCHEMA
FUND_STATE_SCHEMA = pl.Schema({"cik": pl.Int64, "meta": pl.String, "snap": pl.String})
RF_SCHEMA = pl.Schema({"year": pl.Int32, "rate": pl.Float64})
SPLITS_SCHEMA = pl.Schema({"stock_id": pl.Int32, "date": pl.Date, "split_factor": pl.Float64})


class InvariantError(RuntimeError):
    """A recomputed fund broke an invariant (the AUM bridge, or negative shares)."""


class CusipLeakError(RuntimeError):
    """A staged file contains a CUSIP of the security master."""


# --- inputs -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Sources:
    """Everything a run fetches, injectable so tests and the demo never touch the network.

    `download_bulk_zip(url, dest)` writes the ZIP to `dest`; `live_filings(since, until, stats)`
    is `sec.live.fetch_new_filings` on the shared SEC client (it fills stats, including
    `no_index_days`); `figi` is a FigiClient for `securities.map_cusips`; `sic` and
    `shares_outstanding` take a company CIK; `tbill()` is `rf.fetch_tbill`."""

    list_bulk_zips: Callable[[], list[str]]
    download_bulk_zip: Callable[[str, Path], None]
    live_filings: Callable[[date, date, dict], tuple[pl.DataFrame, pl.DataFrame]]
    figi: FigiClient
    sec_tickers: Callable[[], pl.DataFrame]
    sic: Callable[[int], int | None]
    shares_outstanding: Callable[[int], float | None]
    prices: PriceSource
    tbill: Callable[[], dict[int, float]]


def production_sources() -> Sources:
    """Sources on the real services: one shared SEC client (www.sec.gov and data.sec.gov share
    one rate limit), OpenFIGI, Tiingo and FRED. Needs ORCA_CONTACT, TIINGO_KEY and FRED_KEY."""
    from orca.http import figi_client, fred_client, sec_client, tiingo_client
    from orca.prices import TiingoSource
    from orca.rf import fetch_tbill
    from orca.sec.bulk import list_bulk_zips
    from orca.sec.live import fetch_new_filings
    from orca.securities import fetch_shares_outstanding, fetch_sic, load_sec_tickers

    sec, fred = sec_client(), fred_client()

    def download(url: str, dest: Path) -> None:
        Path(dest).write_bytes(sec.get(url).content)

    return Sources(
        list_bulk_zips=lambda: list_bulk_zips(sec),
        download_bulk_zip=download,
        live_filings=lambda since, until, stats: fetch_new_filings(sec, since, until, stats),
        figi=figi_client(),
        sec_tickers=lambda: load_sec_tickers(sec),
        sic=lambda cik: fetch_sic(sec, cik),
        shares_outstanding=lambda cik: fetch_shares_outstanding(sec, cik),
        prices=TiingoSource(tiingo_client()),
        tbill=lambda: fetch_tbill(fred),
    )


@dataclass(frozen=True)
class RunStats:
    """What a run did. `files` maps every file the run wrote to its checksum; `changed` lists the
    published paths whose bytes changed (the files left in `staging`), plus manifest.json."""

    run_id: str
    staging: Path
    last_q: int
    files: dict[str, str]
    changed: list[str]
    filings_parsed: int
    funds_recomputed: int
    flags: list


# --- small pure helpers -----------------------------------------------------------------------


def deadline_quarter(today: date) -> int:
    """The latest quarter whose 45-day filing deadline has passed: q_end(q) + 45 days <= today."""
    q = q_of_date(today)
    while q_end(q) + timedelta(days=DEADLINE_DAYS) > today:
        q -= 1
    return q


def live_watermark(since: date, until: date, no_index_days: Iterable[date]) -> date:
    """The last day of since..until that counts as read: `until`, unless one of its last three
    business days had no index (EDGAR may publish it late); then the day before the earliest such
    day, so the next run reads it again. Older days without an index are weekends and holidays."""
    recent: set[date] = set()
    day = until
    while len(recent) < LIVE_RECENT_BUSINESS_DAYS and day >= since:
        if day.weekday() < 5:
            recent.add(day)
        day -= timedelta(days=1)
    missing = [d for d in no_index_days if d in recent]
    return min(missing) - timedelta(days=1) if missing else until


def strip_query(url: str) -> str:
    """`url` without its query string or fragment (a FRED url carries the API key)."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def affected_funds(
    new_filings: pl.DataFrame, changed_stocks: list[int], holdings: pl.DataFrame
) -> set[int]:
    """The funds (CIKs) to recompute: those with new or amended filings (`new_filings` has a
    `cik` column) and those holding a stock whose price history changed (`holdings` has `cik`
    and `stock_id` columns, any quarter)."""
    funds = (
        {int(c) for c in new_filings.get_column("cik").to_list()} if new_filings.height else set()
    )
    if changed_stocks and holdings.height:
        holders = holdings.filter(pl.col("stock_id").is_in(list(changed_stocks)))
        funds |= {int(c) for c in holders.get_column("cik").unique().to_list()}
    return funds


def price_flags(holdings: pl.DataFrame, px: dict[int, dict[int, QuarterPx]], q: int) -> list[dict]:
    """Rows of quarter `q` whose reported value per share is more than PRICE_MISMATCH times away
    from our close (either way). `holdings` has cik, q, stock_id, shares (split-adjusted, on the
    same basis as `px`) and value_usd; `px` is stock_id -> quarter -> QuarterPx. The engine values
    positions at our close whatever the filing says; this only reports the disagreement."""
    flags = []
    rows = holdings.filter(pl.col("q") == q).sort("cik", "stock_id")
    for cik, stock_id, shares, value in rows.select(
        "cik", "stock_id", "shares", "value_usd"
    ).iter_rows():
        quarter = px.get(stock_id, {}).get(q)
        ours = quarter.close if quarter is not None else None
        if not ours or ours <= 0 or not shares or shares <= 0 or value is None or value <= 0:
            continue
        reported = value / shares
        ratio = reported / ours
        if ratio > PRICE_MISMATCH or ratio < 1 / PRICE_MISMATCH:
            flags.append(
                {
                    "type": "price_mismatch",
                    "fund_id": int(cik),
                    "stock_id": int(stock_id),
                    "q": int(q),
                    "reported": float(reported),
                    "ours": float(ours),
                }
            )
    return flags


def split_suspects(holdings: pl.DataFrame, splits: pl.DataFrame) -> list[dict]:
    """Share counts that change by exactly 2, 3, 4, 5 or 10 times (or a half ... a tenth) from one
    quarter to the next with no vendor split of the stock in between: perhaps a split the vendor
    has not recorded. `holdings` has cik, q, stock_id and shares as reported (not adjusted);
    `splits` has stock_id, date and split_factor (rows with factor 1 are ignored)."""
    split_days: dict[int, list[date]] = defaultdict(list)
    for stock_id, day, factor in splits.select("stock_id", "date", "split_factor").iter_rows():
        if factor is not None and factor != 1.0:
            split_days[int(stock_id)].append(day)
    by_key: dict[tuple[int, int], dict[int, float]] = defaultdict(dict)
    for cik, q, stock_id, shares in holdings.select("cik", "q", "stock_id", "shares").iter_rows():
        by_key[(int(cik), int(stock_id))][int(q)] = float(shares)
    flags = []
    for (cik, stock_id), series in sorted(by_key.items()):
        for q in sorted(series):
            before, after = series.get(q - 1), series[q]
            if not before or before <= 0 or after <= 0:
                continue
            ratio = after / before
            if not any(abs(ratio / r - 1) < 1e-9 for r in SPLIT_RATIOS):
                continue
            start, end = q_end(q - 1), q_end(q)
            if any(start < day <= end for day in split_days.get(stock_id, [])):
                continue
            flags.append(
                {
                    "type": "split_suspect",
                    "fund_id": cik,
                    "stock_id": stock_id,
                    "q": q,
                    "ratio": ratio,
                }
            )
    return flags


# --- lake helpers ---------------------------------------------------------------------------


def _part(q: int) -> str:
    return f"q{q:03d}"


def _part_paths(lake: Lake, table: str) -> list[Path]:
    return [lake.root / table / f"{part}.parquet" for part in lake.parts(table)]


def _scan(lake: Lake, table: str, schema: pl.Schema, where: pl.Expr | None = None) -> pl.DataFrame:
    """The rows of every part of `table` that match `where`, read part by part (lazily, so only
    the matching rows are held), in part order."""
    frames = []
    for path in _part_paths(lake, table):
        frame = pl.scan_parquet(path)
        if where is not None:
            frame = frame.filter(where)
        frames.append(frame.collect())
    if not frames:
        return pl.DataFrame(schema=schema)
    return pl.concat(frames, how="vertical_relaxed").cast(schema)


def _read_table(lake: Lake, table: str, schema: pl.Schema) -> pl.DataFrame:
    frame = lake.read(table)
    return pl.DataFrame(schema=schema) if frame.is_empty() else frame.cast(schema)


def _write_json_atomic(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


@dataclass
class _State:
    """What runs hand on to each other (lake/state.json). The pending sets (and `pending_all`, a
    recompute of every fund owed by a rebuild or a new T-bill table) are added to before the work
    that needs them is attempted and cleared only after a successful publish. `prices_in_flight`
    names a price run that has not finished: its part may hold changes nobody has recorded."""

    live_watermark: date | None = None
    last_q: int | None = None
    pending_funds: set[int] = field(default_factory=set)
    pending_stocks: set[int] = field(default_factory=set)
    pending_weekly: set[int] = field(default_factory=set)
    price_tried: set[int] = field(default_factory=set)
    rf_stale: bool = False
    pending_all: bool = False
    prices_in_flight: str | None = None

    @staticmethod
    def path(lake: Lake) -> Path:
        return lake.root / "state.json"

    @classmethod
    def load(cls, lake: Lake) -> "_State":
        path = cls.path(lake)
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text())
        watermark = raw.get("live_watermark")
        return cls(
            live_watermark=date.fromisoformat(watermark) if watermark else None,
            last_q=raw.get("last_q"),
            pending_funds=set(raw.get("pending_funds", [])),
            pending_stocks=set(raw.get("pending_stocks", [])),
            pending_weekly=set(raw.get("pending_weekly", [])),
            price_tried=set(raw.get("price_tried", [])),
            rf_stale=bool(raw.get("rf_stale", False)),
            pending_all=bool(raw.get("pending_all", False)),
            prices_in_flight=raw.get("prices_in_flight"),
        )

    def save(self, lake: Lake) -> None:
        _write_json_atomic(
            self.path(lake),
            {
                "live_watermark": self.live_watermark.isoformat() if self.live_watermark else None,
                "last_q": self.last_q,
                "pending_funds": sorted(self.pending_funds),
                "pending_stocks": sorted(self.pending_stocks),
                "pending_weekly": sorted(self.pending_weekly),
                "price_tried": sorted(self.price_tried),
                "rf_stale": self.rf_stale,
                "pending_all": self.pending_all,
                "prices_in_flight": self.prices_in_flight,
            },
        )


def _published_path(lake: Lake) -> Path:
    return lake.root / "published.json"


def _load_published(lake: Lake, out_root: Path, compressed: bool = True) -> dict[str, str]:
    """The files of the last successful publish: the lake's copy (it travels with the lake), else
    the manifest in `out_root`."""
    path = _published_path(lake)
    if path.exists():
        return json.loads(path.read_text())
    return (
        read_manifest(out_root, compressed) if (Path(out_root) / "manifest.json").exists() else {}
    )


# --- ingest -------------------------------------------------------------------------------


@dataclass
class _Counts:
    filings_parsed: int = 0
    drops: dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))

    def add(self, source: str, stats: dict) -> None:
        for key, value in stats.items():
            if isinstance(value, int) and not isinstance(value, bool) and value:
                self.drops[source][key] += value


def _ingest(
    lake: Lake, filings: pl.DataFrame, raw: pl.DataFrame, source: str, counts: _Counts
) -> set[int]:
    """Merge `filings` and their raw rows (from `source`) into the per-quarter tables, replacing
    any earlier copy of the same (accession, source), and rebuild the chosen reports and holdings
    of every quarter touched. Returns the CIKs whose holdings may have changed."""
    if filings.is_empty():
        return set()
    filings = filings.select(FILINGS_SCHEMA.names()).cast(FILINGS_SCHEMA)
    raw = raw.with_columns(source=pl.lit(source)).select(RAW_SCHEMA.names()).cast(RAW_SCHEMA)
    raw = raw.join(filings.select("accession", "period").unique("accession"), on="accession")
    affected = {int(c) for c in filings["cik"].unique().to_list()}
    for period in sorted(filings["period"].unique().to_list()):
        part = _part(period)
        new_f = filings.filter(pl.col("period") == period)
        new_r = raw.filter(pl.col("period") == period).drop("period")
        keys = new_f.select("accession", "source").unique()
        old_f = lake.read("filings", part=part)
        old_r = lake.read("raw_holdings", part=part)
        if not old_f.is_empty():
            # The same accession may be on file under another CIK (a multi-filer filing read live
            # first): whoever had it is affected too.
            same = old_f.filter(pl.col("accession").is_in(new_f["accession"].to_list()))
            affected |= {int(c) for c in same["cik"].to_list()}
            new_f = pl.concat(
                [
                    old_f.cast(FILINGS_SCHEMA).join(keys, on=["accession", "source"], how="anti"),
                    new_f,
                ]
            )
        if not old_r.is_empty():
            new_r = pl.concat(
                [old_r.cast(RAW_SCHEMA).join(keys, on=["accession", "source"], how="anti"), new_r]
            )
        # A canonical row order, so a quarter's parts (and what is computed from them) do not
        # depend on the order in which its filings arrived.
        new_f = new_f.sort("cik", "filed", "accession", "source")
        new_r = new_r.sort(RAW_SCHEMA.names(), nulls_last=True)
        lake.write("filings", new_f, part=part)
        lake.write("raw_holdings", new_r, part=part)
        lake.write("reports", select_reports(new_f).cast(REPORTS_SCHEMA), part=part)
        stats: dict = {}
        lake.write("holdings", build_holdings(new_f, new_r, stats), part=part)
        counts.add("holdings", stats)
    return affected


def _ingest_bulk(lake: Lake, sources: Sources, state: _State, flags: list, counts: _Counts) -> None:
    ingested = Manifest(lake.root / "ingested.json")
    try:
        urls = sources.list_bulk_zips()
    except FetchError as err:
        flags.append(
            {"type": "bulk_list_failed", "url": strip_query(err.url), "status": err.status}
        )
        return
    if not urls:
        # The data-sets page lists dozens of ZIPs; none means the page changed shape.
        flags.append({"type": "no_bulk_zips"})
        return
    with tempfile.TemporaryDirectory() as tmp:
        for url in urls:
            name = PurePosixPath(urlsplit(url).path).name
            if name in ingested:
                continue
            dest = Path(tmp) / name
            try:
                sources.download_bulk_zip(url, dest)
            except FetchError as err:
                log.warning("bulk ZIP %s skipped: %s", strip_query(url), err.status)
                flags.append(
                    {"type": "fetch_failed", "url": strip_query(url), "status": err.status}
                )
                continue
            stats: dict = {}
            try:
                checksum = sha256_file(dest)
                filings, raw = parse_bulk_zip(dest, stats)
            except (ValueError, zipfile.BadZipFile) as err:
                detail = str(err).replace(str(dest), name)[:200]  # not the runner's temp path
                flags.append({"type": "bulk_unreadable", "url": strip_query(url), "detail": detail})
                continue
            finally:
                dest.unlink(missing_ok=True)
            state.pending_funds |= _ingest(lake, filings, raw, "bulk", counts)
            state.save(lake)
            # Only now is the ZIP recorded: a crash before this line re-reads it next run.
            ingested.mark(name, checksum)
            ingested.save()
            counts.filings_parsed += filings.height
            counts.add("bulk", stats)


def _ingest_live(
    lake: Lake, sources: Sources, state: _State, today: date, flags: list, counts: _Counts
) -> None:
    if state.live_watermark is not None:
        since = state.live_watermark + timedelta(days=1)
    else:
        bulk = _scan(lake, "filings", FILINGS_SCHEMA, pl.col("source") == "bulk")
        latest = bulk["filed"].max() if bulk.height else None
        since = (
            latest + timedelta(days=1)
            if latest
            else today - timedelta(days=LIVE_FIRST_LOOKBACK_DAYS)
        )
    until = today
    if since > until:
        return
    stats: dict = {}
    try:
        filings, raw = sources.live_filings(since, until, stats)
    except FetchError as err:
        flags.append({"type": "live_failed", "url": strip_query(err.url), "status": err.status})
        return
    state.pending_funds |= _ingest(lake, filings, raw, "live", counts)
    state.live_watermark = live_watermark(since, until, stats.get("no_index_days", []))
    state.save(lake)
    counts.filings_parsed += filings.height
    counts.add("live", stats)


# --- securities -------------------------------------------------------------------------------


def _stock_of(cusip_map: pl.DataFrame) -> dict[str, int]:
    mapped = cusip_map.filter(pl.col("stock_id").is_not_null())
    return dict(zip(mapped["cusip"].to_list(), mapped["stock_id"].to_list()))


def _map_new_cusips(lake: Lake, sources: Sources, state: _State, flags: list) -> None:
    """Map the share CUSIPs not yet in cusip_map (and the benchmark's), oldest first, give new
    securities ids, sectors and shares outstanding, and mark every fund holding a newly mapped
    CUSIP for recompute. A failed mapping leaves the CUSIPs for the next run."""
    cusip_map = _read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    known = set(cusip_map["cusip"].to_list())
    firsts = []
    for path in _part_paths(lake, "holdings"):
        firsts.append(
            pl.scan_parquet(path)
            .filter(pl.col("kind") == "SH")
            .group_by("cusip")
            .agg(pl.col("q").min())
            .collect()
        )
    held = (
        pl.concat(firsts).group_by("cusip").agg(pl.col("q").min()).sort("q", "cusip")
        if firsts
        else pl.DataFrame(schema={"cusip": pl.String, "q": pl.Int16})
    )
    new = [c for c in held["cusip"].to_list() if c not in known]
    if BENCHMARK_CUSIP not in known and BENCHMARK_CUSIP not in new:
        new.append(BENCHMARK_CUSIP)
    if not new:
        return
    try:
        tickers = sources.sec_tickers()
        issuers = _issuer_names(lake, new)
        mapped = map_cusips(new, issuers, sources.figi, tickers)
    except FetchError as err:
        flags.append(
            {
                "type": "cusip_mapping_failed",
                "count": len(new),
                "url": strip_query(err.url),
                "status": err.status,
            }
        )
        return
    except ValueError as err:  # an OpenFIGI answer that does not line up with the jobs
        flags.append({"type": "cusip_mapping_failed", "count": len(new), "detail": str(err)[:200]})
        return

    existing = _read_table(lake, "securities", TABLE_SCHEMA)
    old_max = existing["stock_id"].max() or 0
    securities = assign_stock_ids(mapped, existing).cast(TABLE_SCHEMA)
    added = securities.filter(pl.col("stock_id") > old_max)
    securities = pl.concat(
        [securities.filter(pl.col("stock_id") <= old_max), _enrich(added, sources, tickers, flags)]
    )

    new_map = _cusip_rows(mapped, securities)
    newly = new_map.filter(pl.col("stock_id").is_not_null())["cusip"].to_list()
    if newly:
        holders = _scan(lake, "holdings", HOLDINGS_SCHEMA, pl.col("cusip").is_in(newly))
        state.pending_funds |= {int(c) for c in holders["cik"].unique().to_list()}
        state.save(lake)  # before the map is written, so a crash cannot lose these funds
    lake.write("securities", securities.sort("stock_id"))
    lake.write("cusip_map", pl.concat([cusip_map, new_map]).sort("cusip"))


def _issuer_names(lake: Lake, cusips: list[str]) -> dict[str, str]:
    """An issuer name per CUSIP as the 13Fs spell it (the alphabetically first, for a stable
    choice), for the name fallback of the mapping."""
    clean = pl.col("cusip").str.strip_chars().str.to_uppercase()
    frames = [
        pl.scan_parquet(path)
        .select(clean.alias("cusip"), "issuer")
        .filter(pl.col("cusip").is_in(cusips) & pl.col("issuer").is_not_null())
        .group_by("cusip")
        .agg(pl.col("issuer").min())
        .collect()
        for path in _part_paths(lake, "raw_holdings")
    ]
    if not frames:
        return {}
    names = pl.concat(frames).group_by("cusip").agg(pl.col("issuer").min())
    return dict(names.iter_rows())


def _enrich(
    added: pl.DataFrame, sources: Sources, tickers: pl.DataFrame, flags: list
) -> pl.DataFrame:
    """Company CIK (from the SEC ticker list), SIC code, sector and shares outstanding of new
    securities. A failed lookup is flagged and left empty."""
    cik_of = {t: c for t, c in tickers.select("ticker", "cik").iter_rows()}
    rows = []
    for row in added.iter_rows(named=True):
        cik = cik_of.get(normalise_ticker(row["ticker"])) if row["ticker"] else None
        sic = shares = None
        if cik is not None:
            try:
                sic = None if row["is_etf"] else sources.sic(cik)
                shares = sources.shares_outstanding(cik)
            except FetchError as err:
                flags.append(
                    {
                        "type": "security_lookup_failed",
                        "stock_id": row["stock_id"],
                        "status": err.status,
                    }
                )
        rows.append(
            {
                **row,
                "cik": cik,
                "sic": sic,
                "sector": sector_for_sic(sic, bool(row["is_etf"])),
                "shares_out": shares,
            }
        )
    return pl.DataFrame(rows, schema=TABLE_SCHEMA)


def _cusip_rows(mapped: pl.DataFrame, securities: pl.DataFrame) -> pl.DataFrame:
    """cusip_map rows of `mapped`: each CUSIP's stock id found by the security's key, its FIGI,
    or (without one) the FIGI of a security with its ticker, else its ticker, as
    assign_stock_ids identifies securities."""
    by_figi, by_ticker, figi_of_ticker = {}, {}, {}
    for stock_id, figi, ticker in securities.select("stock_id", "figi", "ticker").iter_rows():
        if figi:
            by_figi[figi] = stock_id
            if ticker:
                figi_of_ticker.setdefault(ticker, figi)
        elif ticker:
            by_ticker.setdefault(ticker, stock_id)
    rows = []
    for cusip, figi, ticker, method in mapped.select(
        "cusip", "figi", "ticker", "method"
    ).iter_rows():
        figi = figi or figi_of_ticker.get(ticker)
        stock_id = by_figi.get(figi) if figi else by_ticker.get(ticker)
        rows.append((cusip, stock_id, method))
    return pl.DataFrame(rows, schema=CUSIP_MAP_SCHEMA, orient="row")


# --- prices -------------------------------------------------------------------------------


def _held_stocks(lake: Lake, stock_of: dict[str, int], last_q: int) -> set[int]:
    rows = _scan(
        lake, "holdings", HOLDINGS_SCHEMA, (pl.col("q") >= last_q) & (pl.col("kind") == "SH")
    )
    return {stock_of[c] for c in rows["cusip"].unique().to_list() if c in stock_of}


def _update_prices(
    lake: Lake, sources: Sources, state: _State, today: date, last_q: int, run_id: str, flags: list
) -> list[int]:
    """Fetch the prices of the stocks held in the latest quarter, the benchmark and any stock
    never fetched; record the stocks whose history changed (and those with new rows, for their
    weekly file) in the state before anything is recomputed from them. Returns the changed ids.

    A price run writes its part as it goes but reports the changed stocks only at the end, so the
    run is marked in flight while it works. If it dies, the next run takes every stock of its part
    as changed: more recomputing than needed, but no change is lost."""
    _recover_prices_in_flight(lake, state)
    securities = _read_table(lake, "securities", TABLE_SCHEMA)
    stock_of = _stock_of(_read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
    wanted = _held_stocks(lake, stock_of, last_q) | (
        set(securities["stock_id"].to_list()) - state.price_tried
    )
    if BENCHMARK_CUSIP in stock_of:
        wanted.add(stock_of[BENCHMARK_CUSIP])
    ticker_of = dict(securities.select("stock_id", "ticker").iter_rows())
    tickers = {sid: ticker_of[sid] for sid in sorted(wanted) if ticker_of.get(sid)}
    if sum(p.startswith("z") for p in lake.parts(PRICES_TABLE)) >= COMPACT_AT_RUN_PARTS:
        compact_prices(lake)
    stats: dict = {}
    state.prices_in_flight = run_id
    state.save(lake)
    changed = update_prices(lake, sources.prices, tickers, today, run_id=run_id, stats=stats)
    part = f"z{run_id}"
    touched = set()
    if part in lake.parts(PRICES_TABLE):
        touched = set(lake.read(PRICES_TABLE, part=part)["stock_id"].unique().to_list())
    failed = {sid for sid, _, _ in stats["failed"]}
    state.pending_stocks |= set(changed)
    state.pending_weekly |= touched | set(changed)
    if stats["stopped"] is None:
        state.price_tried |= set(tickers) - failed
    else:  # the run broke off: only stocks that have rows are known to have been fetched
        state.price_tried |= touched
    state.prices_in_flight = None
    state.save(lake)

    asked = stats["fetched"] + stats["empty"]
    empty_ratio = stats["empty"] / asked if asked else 0.0
    if failed or stats["stopped"] or empty_ratio > EMPTY_FETCH_WARN:
        flags.append(
            {
                "type": "prices",
                "fetched": stats["fetched"],
                "empty": stats["empty"],
                "empty_ratio": empty_ratio,
                "failed": sorted(failed)[:MAX_FLAGS_PER_KIND],
                "failed_count": len(failed),
                "stopped": stats["stopped"],
            }
        )
    if changed:
        _refresh_shares_outstanding(lake, sources, securities, changed, flags)
    return changed


def _recover_prices_in_flight(lake: Lake, state: _State) -> None:
    if state.prices_in_flight is None:
        return
    part = f"z{state.prices_in_flight}"
    if part in lake.parts(PRICES_TABLE):
        stocks = set(lake.read(PRICES_TABLE, part=part)["stock_id"].unique().to_list())
        state.pending_stocks |= stocks
        state.pending_weekly |= stocks
    state.prices_in_flight = None
    state.save(lake)


def _refresh_shares_outstanding(
    lake: Lake, sources: Sources, securities: pl.DataFrame, stock_ids: list[int], flags: list
) -> None:
    """A split changes the share count: refetch it for the stocks whose history changed."""
    fresh = {}
    for stock_id, cik in (
        securities.filter(pl.col("stock_id").is_in(stock_ids)).select("stock_id", "cik").iter_rows()
    ):
        if cik is None:
            continue
        try:
            shares = sources.shares_outstanding(cik)
        except FetchError as err:
            flags.append(
                {"type": "security_lookup_failed", "stock_id": stock_id, "status": err.status}
            )
            continue
        if shares is not None:
            fresh[stock_id] = shares
    if fresh:
        update = pl.DataFrame(
            {"stock_id": list(fresh), "_fresh": list(fresh.values())},
            schema={"stock_id": pl.Int32, "_fresh": pl.Float64},
        )
        securities = (
            securities.join(update, on="stock_id", how="left")
            .with_columns(shares_out=pl.coalesce("_fresh", "shares_out"))
            .drop("_fresh")
        )
        lake.write("securities", securities.cast(TABLE_SCHEMA).sort("stock_id"))


def _load_daily(lake: Lake, stock_ids: Iterable[int] | None = None) -> pl.DataFrame:
    """Stored bars of `stock_ids` (all stocks when None), split-adjusted to today's share basis;
    of a day stored more than once the last copy in part order wins."""
    where = None if stock_ids is None else pl.col("stock_id").is_in(sorted(stock_ids))
    frames = []
    for path in _part_paths(lake, PRICES_TABLE):
        frame = pl.scan_parquet(path)
        frames.append((frame.filter(where) if where is not None else frame).collect())
    if not frames:
        return pl.DataFrame()
    raw = pl.concat(frames, how="vertical_relaxed").unique(
        subset=["stock_id", "date"], keep="last", maintain_order=True
    )
    return split_adjust_prices(raw)


def _latest_closes(lake: Lake) -> dict[int, tuple[date, float]]:
    """Each stock's latest stored close and its date (raw = today's basis: no split after it)."""
    frames = [
        pl.scan_parquet(path).select("stock_id", "date", "close").collect()
        for path in _part_paths(lake, PRICES_TABLE)
    ]
    if not frames:
        return {}
    rows = (
        pl.concat(frames)
        .unique(subset=["stock_id", "date"], keep="last", maintain_order=True)
        .filter(pl.col("close").is_not_null() & pl.col("close").is_finite())
        .sort("stock_id", "date")
        .group_by("stock_id", maintain_order=True)
        .agg(pl.col("date").last(), pl.col("close").last())
    )
    return {sid: (day, float(close)) for sid, day, close in rows.iter_rows()}


def _update_rf(
    lake: Lake, sources: Sources, state: _State, last_q: int, full: bool, flags: list
) -> None:
    """The T-bill table, refetched when the latest quarter moves on (or on a full run, or after a
    failure): Sharpe and Sortino of every fund depend on it, so a new table is written only
    after a recompute of every fund is recorded as owed (`pending_all`)."""
    stored = _rf(lake)
    if stored and not (full or state.rf_stale or state.last_q != last_q):
        return
    try:
        fetched = sources.tbill()
    except FetchError as err:
        flags.append({"type": "tbill_failed", "url": strip_query(err.url), "status": err.status})
        state.rf_stale = True
        return
    state.rf_stale = False
    fetched = {int(y): float(r) for y, r in fetched.items()}
    if fetched == stored:
        return
    state.pending_all = True
    state.save(lake)
    years = sorted(fetched)
    lake.write("rf", pl.DataFrame({"year": years, "rate": [fetched[y] for y in years]}, RF_SCHEMA))


def _rf(lake: Lake) -> dict[int, float]:
    return {int(y): float(r) for y, r in _read_table(lake, "rf", RF_SCHEMA).iter_rows()}


# --- computing funds ------------------------------------------------------------------------


@dataclass
class _Context:
    """What computing a fund needs beyond its own rows: the security master, the risk-free rate
    and a cache of each stock's quarter prices, splits and daily closes (today's share basis)."""

    lake: Lake
    last_q: int
    stock_of: dict[str, int]
    rf: dict[int, float]
    spy_id: int | None
    px: dict[int, dict[int, QuarterPx]] = field(default_factory=dict)
    splits: dict[int, pl.DataFrame] = field(default_factory=dict)
    closes: dict[int, pl.DataFrame] = field(default_factory=dict)

    @classmethod
    def build(cls, lake: Lake, last_q: int) -> "_Context":
        stock_of = _stock_of(_read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
        return cls(lake, last_q, stock_of, _rf(lake), stock_of.get(BENCHMARK_CUSIP))

    def load(self, stock_ids: Iterable[int]) -> None:
        missing = sorted(set(stock_ids) - self.px.keys())
        if not missing:
            return
        daily = _load_daily(self.lake, missing)
        by_stock = daily.partition_by("stock_id", as_dict=True) if daily.height else {}
        no_splits = pl.DataFrame(schema={"date": pl.Date, "split_factor": pl.Float64})
        no_closes = pl.DataFrame(schema={"date": pl.Date, "close": pl.Float64})
        for stock_id in missing:
            rows = by_stock.get((stock_id,))
            if rows is None:
                self.px[stock_id], self.splits[stock_id] = {}, no_splits
                self.closes[stock_id] = no_closes
                continue
            self.px[stock_id] = quarter_px(rows)
            self.splits[stock_id] = rows.filter(pl.col("split_factor") != 1.0).select(
                "date", "split_factor"
            )
            self.closes[stock_id] = rows.select("date", "close")


@dataclass(frozen=True)
class _FundResult:
    output: FundOutput
    snapshot: FundSnapshot
    flags: list


def _bounded(px: dict[int, QuarterPx], bound: int) -> dict[int, QuarterPx]:
    return {q: v for q, v in px.items() if q <= bound}


def _compute_batch(
    ctx: _Context, holdings: pl.DataFrame, reports: pl.DataFrame
) -> list[_FundResult]:
    """Compute every fund of `holdings` / `reports` (the rows of a set of CIKs)."""
    filed_quarters = reports.select("cik", q="period").unique()
    filled, status = fill_gaps(holdings, ctx.last_q, filed_quarters)
    rows_of = filled.partition_by("cik", as_dict=True) if filled.height else {}
    reports_of = reports.partition_by("cik", as_dict=True) if reports.height else {}
    empty = filled.clear()
    return [
        _compute_fund(ctx, row, rows_of.get((row["cik"],), empty), reports_of[(row["cik"],)])
        for row in status.sort("cik").iter_rows(named=True)
    ]


def _compute_fund(
    ctx: _Context, status: dict, rows: pl.DataFrame, reports: pl.DataFrame
) -> _FundResult:
    """One fund over its latest tracking segment, through its last held quarter: the carried
    deadline quarter after a late filing, or the last filed quarter (an early filer's next
    quarter; a fund gone inactive stays frozen there). Prices count up to that quarter or the
    deadline quarter, whichever is later, so a fund's files do not move with the week's prices."""
    cik, last_q = int(status["cik"]), ctx.last_q
    segment = status["segments"][-1]
    start, end = int(segment["start"]), int(segment["end"])
    end_q = last_q if end == last_q - 1 else end
    bound = max(last_q, end_q)
    rows = rows.filter(pl.col("q").is_between(start, end_q))

    shares_rows = (
        rows.filter(pl.col("kind") == "SH")
        .with_columns(
            stock_id=pl.col("cusip").replace_strict(
                ctx.stock_of, default=None, return_dtype=pl.Int32
            )
        )
        .filter(pl.col("stock_id").is_not_null())
    )
    ctx.load(
        shares_rows["stock_id"].unique().to_list()
        + ([ctx.spy_id] if ctx.spy_id is not None else [])
    )
    adjusted, reported = _share_series(ctx, shares_rows)

    positions = []
    for stock_id in sorted(adjusted):
        implied = {
            q: value / shares
            for q, (shares, value) in adjusted[stock_id].items()
            if shares > 0 and value > 0
        }
        shares_by_q = {q: shares for q, (shares, _) in adjusted[stock_id].items()}
        result = compute_position(
            stock_id, shares_by_q, _bounded(ctx.px[stock_id], bound), start, end_q, implied
        )
        if result is not None:
            positions.append(result)
    quarters = aggregate_fund(positions, start, end_q)
    _check_invariants(cik, positions, quarters)

    px_by_stock = {p.stock_id: _bounded(ctx.px[p.stock_id], bound) for p in positions}
    spy_px = _bounded(ctx.px.get(ctx.spy_id, {}), bound) if ctx.spy_id is not None else {}
    years = fund_years(quarters)
    rets = [(fq.q, fq.ret) for fq in quarters if fq.ret is not None]
    hold_all, hold_sold = hold_lengths(positions, end_q)
    metrics = build_metrics(
        performance(rets, ctx.rf),
        years,
        quarters,
        turnover=turnover(years, quarters),
        hold_all=hold_all,
        hold_sold=hold_sold,
    )
    exits = exit_rows(positions, px_by_stock, spy_px)
    exits_summary = ExitsSummary(*buys_vs_sells(positions, px_by_stock), beat_spy_pct(exits))

    period_q = int(status["last_filed_q"])
    latest_reports = reports.filter(pl.col("period") == period_q)
    filed = latest_reports["filed"].max()
    named = reports.filter(pl.col("manager_name").is_not_null()).sort(
        "period", "filed", "accession"
    )
    name = named["manager_name"][-1].strip() if named.height else f"CIK {cik}"
    latest_rows = rows.filter(pl.col("q") == end_q)
    priced = priced_pct(
        latest_rows.select("cusip", "kind", "value_usd"),
        {c for c in latest_rows["cusip"].to_list() if c in ctx.stock_of},
    )
    held = [p for p in positions if p.shares_now > 0]
    meta = FundMeta(
        fund_id=cik,
        name=name,
        cik=cik,
        period_q=period_q,
        filed=filed,
        book=quarters[-1].end if quarters else 0.0,
        n_holdings=len(held),
        priced_pct=priced,
        tracked_since_q=start,
        inactive=bool(status["inactive"]),
    )
    output = FundOutput(
        meta=meta,
        years=years,
        quarters=quarters,
        positions=positions,
        contributions=contributions(positions, years),
        exits=exits,
        exits_summary=exits_summary,
        metrics=metrics,
    )
    filed_quarters = set(reports["period"].to_list())
    snapshot = _snapshot(
        ctx,
        meta,
        positions,
        quarters,
        rows,
        rets,
        end_q,
        sum(start <= q <= end for q in filed_quarters),
    )

    engine_rows = pl.DataFrame(
        [
            (cik, q, sid, shares, value)
            for sid, series in adjusted.items()
            for q, (shares, value) in series.items()
        ],
        schema={
            "cik": pl.Int64,
            "q": pl.Int64,
            "stock_id": pl.Int64,
            "shares": pl.Float64,
            "value_usd": pl.Float64,
        },
        orient="row",
    )
    latest_two = reported.filter(pl.col("q").is_in([period_q - 1, period_q]))
    splits = pl.DataFrame(
        [
            (sid, day, factor)
            for sid in sorted(set(latest_two["stock_id"].to_list()))
            for day, factor in ctx.splits[sid].iter_rows()
        ],
        schema=SPLITS_SCHEMA,
        orient="row",
    )
    flags = price_flags(engine_rows, ctx.px, period_q) + split_suspects(latest_two, splits)
    return _FundResult(output, snapshot, flags)


def _share_series(
    ctx: _Context, shares_rows: pl.DataFrame
) -> tuple[dict[int, dict[int, tuple[float, float]]], pl.DataFrame]:
    """Per stock and quarter the split-adjusted shares and reported value (share classes of one
    stock summed), and the same as reported (cik, q, stock_id, shares) for the split check."""
    summed = (
        shares_rows.group_by("cik", "q", "stock_id")
        .agg(pl.col("shares").sum(), pl.col("value_usd").sum())
        .sort("stock_id", "q")
    )
    adjusted: dict[int, dict[int, tuple[float, float]]] = defaultdict(dict)
    for q, stock_id, shares, value in summed.select(
        "q", "stock_id", "shares", "value_usd"
    ).iter_rows():
        adjusted[stock_id][q] = (split_adjust_shares(shares, q, ctx.splits[stock_id]), value)
    return dict(adjusted), summed.select("cik", "q", "stock_id", "shares")


def _check_invariants(
    cik: int, positions: list[PositionResult], quarters: list[FundQuarter]
) -> None:
    for fq in quarters:
        if not check_bridge(fq):
            raise InvariantError(
                f"fund {cik}, quarter {fq.q}: the AUM bridge does not add up: end {fq.end} != "
                f"start {fq.start} + market move "
                f"{fq.market_move} + net buying {fq.net_buying} + trade gains {fq.trade_gains}"
            )
    for position in positions:
        for pq in position.quarters:
            if pq.shares < 0:
                raise InvariantError(
                    f"fund {cik}, stock {position.stock_id}, quarter {pq.q}: negative shares"
                )


def _snapshot(
    ctx: _Context,
    meta: FundMeta,
    positions: list[PositionResult],
    quarters: list[FundQuarter],
    rows: pl.DataFrame,
    rets: list[tuple[int, float]],
    end_q: int,
    quarters_filed: int,
) -> FundSnapshot:
    last_q = ctx.last_q
    value_at: dict[int, dict[int, float]] = defaultdict(dict)
    for p in positions:
        for pq in p.quarters:
            value_at[pq.q][p.stock_id] = pq.value
    end_of = {fq.q: fq.end for fq in quarters}

    def weights(q: int) -> dict[int, float]:
        book = end_of.get(q, 0.0)
        if book <= 0:
            return {}
        return {sid: v / book for sid, v in sorted(value_at.get(q, {}).items()) if v > 0}

    filed_at = (
        dict(rows.group_by("q").agg(pl.col("filed").max()).iter_rows()) if rows.height else {}
    )
    buys_recent = [
        (
            p.stock_id,
            t.q,
            t.px,
            value_at[t.q].get(p.stock_id, 0.0) / end_of[t.q] if end_of.get(t.q, 0.0) > 0 else 0.0,
            filed_at.get(t.q, meta.filed),
        )
        for p in positions
        for t in p.trades
        if t.type in _BUYS and last_q - 3 <= t.q <= last_q
    ]
    until_last = [(q, r) for q, r in rets if q <= last_q]
    perf: dict[str, Performance | None] = {}
    for period, n in PERIODS.items():
        window = until_last if n is None else [(q, r) for q, r in until_last if q > last_q - n]
        perf[period] = performance(window, ctx.rf) if n is None or len(window) == n else None
    return FundSnapshot(
        fund_id=meta.fund_id,
        name=meta.name,
        book=meta.book,
        n_priced=meta.n_holdings,
        priced_pct=meta.priced_pct,
        quarters_filed=quarters_filed,
        excluded=meta.inactive,
        weights_now=weights(end_q),
        weights_prev=weights(end_q - 1),
        trades_latest=[(p.stock_id, t) for p in positions for t in p.trades if t.q == last_q],
        pnl_latest={
            p.stock_id: pq.market_move + pq.trade_gain + pq.dividends
            for p in positions
            for pq in p.quarters
            if pq.q == last_q
        },
        buys_recent=buys_recent,
        perf=perf,
        filed=meta.filed,
        period_q=meta.period_q,
    )


# --- fund state (what unchanged funds contribute to the shared files) --------------------------


# The stored fund state is JSON written field by field from the dataclasses, so a field added to
# FundMeta or FundSnapshot (or Trade, Performance) is kept, and a removed one fails loudly.
_STORED_TYPES = {cls.__name__: cls for cls in (FundMeta, FundSnapshot, Trade, Performance)}


def _encode(value: object) -> object:
    """`value` as JSON-ready data that `_decode` turns back into an equal value: dataclasses,
    dates, tuples and dicts (with any keys) are tagged; floats round-trip exactly."""
    if isinstance(value, date):
        return {"__date__": value.isoformat()}
    if is_dataclass(value) and not isinstance(value, type):
        return {
            "__type__": type(value).__name__,
            **{f.name: _encode(getattr(value, f.name)) for f in fields(value)},
        }
    if isinstance(value, dict):
        return {"__dict__": [[_encode(k), _encode(v)] for k, v in value.items()]}
    if isinstance(value, tuple):
        return {"__tuple__": [_encode(v) for v in value]}
    if isinstance(value, list):
        return [_encode(v) for v in value]
    return value


def _decode(value: object) -> object:
    if isinstance(value, list):
        return [_decode(v) for v in value]
    if not isinstance(value, dict):
        return value
    if "__date__" in value:
        return date.fromisoformat(value["__date__"])
    if "__tuple__" in value:
        return tuple(_decode(v) for v in value["__tuple__"])
    if "__dict__" in value:
        return {_decode(k): _decode(v) for k, v in value["__dict__"]}
    cls = _STORED_TYPES[value["__type__"]]
    return cls(**{k: _decode(v) for k, v in value.items() if k != "__type__"})


def _dump(value: object) -> str:
    return json.dumps(_encode(value), sort_keys=True)


def _load(text: str) -> object:
    return _decode(json.loads(text))


# --- publishing -----------------------------------------------------------------------------

_TOKEN = re.compile(r"(?<![0-9A-Za-z])(?<![0-9]\.)[0-9A-Za-z]{9}(?![0-9A-Za-z])(?!\.[0-9])")
_CUSIP_SPECIALS = {"*": 36, "@": 37, "#": 38}


def cusip_check_digit(base: str) -> str:
    """The check digit of a CUSIP's first eight characters (the standard modulus-10 rule: the
    characters at even positions doubled, letters worth 10 to 35, digits of products summed)."""
    total = 0
    for position, char in enumerate(base.upper()):
        if char.isdigit():
            value = int(char)
        elif "A" <= char <= "Z":
            value = ord(char) - ord("A") + 10
        else:
            value = _CUSIP_SPECIALS[char]
        if position % 2:
            value *= 2
        total += value // 10 + value % 10
    return str((10 - total % 10) % 10)


def _is_cusip(text: str) -> bool:
    """Whether `text` is a well-formed CUSIP: nine characters ending in their check digit."""
    if len(text) != 9 or not all(c.isalnum() or c in _CUSIP_SPECIALS for c in text[:8]):
        return False
    return cusip_check_digit(text[:8]) == text[8]


def _cusip_leaks(staging: Path, cusips: set[str], compressed: bool) -> list[str]:
    """Where staged files contain a CUSIP of `cusips` as a whole token (not inside a longer word
    or number): "path (offset n)" of the first one in each file. The CUSIP itself is not named,
    as the error ends up in a log."""
    leaks = []
    for path in sorted(staging.rglob("*.json")):
        data = path.read_bytes()
        text = (brotli.decompress(data) if compressed else data).decode("ascii", "replace")
        hit = next((m for m in _TOKEN.finditer(text) if m.group().upper() in cusips), None)
        if hit is not None:
            leaks.append(f"{path.relative_to(staging).as_posix()} (offset {hit.start()})")
    return leaks


def _capped(flags: list[dict]) -> list:
    """At most MAX_FLAGS_PER_KIND findings of each type, with a count of the rest."""
    kept, extra = [], defaultdict(int)
    seen: dict[str, int] = defaultdict(int)
    for flag in flags:
        kind = flag.get("type", "") if isinstance(flag, dict) else ""
        seen[kind] += 1
        if seen[kind] <= MAX_FLAGS_PER_KIND:
            kept.append(flag)
        else:
            extra[kind] += 1
    kept += [{"type": f"{kind}_more", "count": n} for kind, n in sorted(extra.items())]
    return kept


def _publish_shared(
    ctx: _Context,
    staging: Path,
    metas: list[FundMeta],
    snaps: list[FundSnapshot],
    weekly_ids: set[int] | None,
    today: date,
    compress: bool,
) -> dict[str, str]:
    """funds.json, securities.json, latest_prices.json, the home lists and the weekly files of
    `weekly_ids` (every stock when None)."""
    lake, last_q = ctx.lake, ctx.last_q
    securities = _read_table(lake, "securities", TABLE_SCHEMA).sort("stock_id")
    latest = _latest_closes(lake)
    asof = max((day for day, _ in latest.values()), default=today)
    latest_prices = {
        sid: (latest[sid][1] if sid in latest else None) for sid in securities["stock_id"].to_list()
    }

    # The calls lists are ranked on prices as of the deadline quarter's end, not this week's, so
    # the home files change with filings only (the browser shows moves to the latest price).
    candidates = sorted({sid for s in snaps for sid, *_ in s.buys_recent})
    ctx.load(candidates)
    q_close = {
        sid: ctx.px[sid][last_q].close
        for sid in candidates
        if last_q in ctx.px[sid] and ctx.px[sid][last_q].close
    }
    shares_out = dict(securities.select("stock_id", "shares_out").iter_rows())
    mcap = {sid: shares_out[sid] * px for sid, px in q_close.items() if shares_out.get(sid)}

    def px_on_filed(stock_id: int, filed: date) -> float | None:
        return close_on(ctx.closes[stock_id], filed)

    home = HomeLists(
        latest_q=last_q,
        top={period: top_funds(snaps, period) for period in PERIODS},
        conviction=conviction_moves(snaps, latest_q=last_q),
        wins_losses=wins_losses(snaps, latest_q=last_q),
        just_filed=just_filed(snaps),
        crowded=crowded_buys(snaps, latest_q=last_q),
        calls_q=calls(snaps, mcap, q_close, px_on_filed, "q", latest_q=last_q),
        calls_y=calls(snaps, mcap, q_close, px_on_filed, "y", latest_q=last_q),
    )

    weekly_ids = set(securities["stock_id"].to_list()) if weekly_ids is None else weekly_ids
    ctx.load(weekly_ids)
    weekly = {sid: weekly_closes(ctx.closes[sid]) for sid in sorted(weekly_ids)}

    table = securities.with_columns(
        name=pl.coalesce("name", "ticker"), sector=pl.col("sector").fill_null("Other")
    )
    return publish_shared(
        staging,
        funds=metas,
        securities=table,
        asof=asof,
        latest_prices=latest_prices,
        home=home,
        weekly=weekly,
        compress=compress,
    )


def _prune_staging(out_root: Path) -> None:
    runs = sorted(p for p in (Path(out_root) / "staging").iterdir() if p.is_dir())
    for old in runs[:-KEEP_STAGING]:
        shutil.rmtree(old, ignore_errors=True)


def _keep_only(staging: Path, keep: set[str]) -> None:
    """Delete the staged files not in `keep` (unchanged since the last publish), then empty
    folders, so the staging folder holds exactly what is to be uploaded."""
    for path in sorted(staging.rglob("*"), reverse=True):
        rel = path.relative_to(staging).as_posix()
        if path.is_file() and rel not in keep:
            path.unlink()
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()


# --- the run ------------------------------------------------------------------------------


def _all_ciks(lake: Lake) -> set[int]:
    reports = _scan(lake, "reports", REPORTS_SCHEMA)
    return {int(c) for c in reports["cik"].unique().to_list()}


def _compute(ctx: _Context, ciks: set[int]) -> list[_FundResult]:
    results = []
    ordered = sorted(ciks)
    for i in range(0, len(ordered), FUND_BATCH):
        batch = ordered[i : i + FUND_BATCH]
        where = pl.col("cik").is_in(batch)
        holdings = _scan(ctx.lake, "holdings", HOLDINGS_SCHEMA, where)
        reports = _scan(ctx.lake, "reports", REPORTS_SCHEMA, where)
        if reports.height:
            results += _compute_batch(ctx, holdings, reports)
    return results


def run_weekly(
    lake: Lake,
    out_root: Path,
    sources: Sources,
    today: date,
    full: bool = False,
    *,
    compress: bool = True,
    built: datetime | None = None,
) -> RunStats:
    """One pipeline run as of `today`; `full` recomputes and republishes everything (after a
    formula change). Returns what it did. Raises InvariantError or CusipLeakError, before the
    manifest is written, when a recomputed fund breaks an invariant or a staged file would publish
    a CUSIP; the site then stays on the last good version and the next run retries."""
    out_root = Path(out_root)
    lake.root.mkdir(parents=True, exist_ok=True)
    state = _State.load(lake)
    last_q = deadline_quarter(today)
    run_id = today.strftime("%Y%m%d")
    flags: list = []
    counts = _Counts()
    if full:  # owed until a publish succeeds, even if this run dies
        state.pending_all = True
        state.save(lake)

    _ingest_bulk(lake, sources, state, flags, counts)
    _ingest_live(lake, sources, state, today, flags, counts)
    _map_new_cusips(lake, sources, state, flags)
    _update_prices(lake, sources, state, today, last_q, run_id, flags)
    _update_rf(lake, sources, state, last_q, full, flags)
    state.save(lake)
    for source, drops in sorted(counts.drops.items()):
        flags.append({"type": "dropped_rows", "source": source, **dict(sorted(drops.items()))})

    ctx = _Context.build(lake, last_q)
    # A rebuild, the deadline quarter, the T-bill rate and the benchmark (every fund's what-if
    # figures) concern every fund.
    everything = state.pending_all or state.last_q != last_q or ctx.spy_id in state.pending_stocks
    if everything:
        recompute = _all_ciks(lake)
    else:
        cusips = [c for c, sid in ctx.stock_of.items() if sid in state.pending_stocks]
        holders = (
            _scan(lake, "holdings", HOLDINGS_SCHEMA, pl.col("cusip").is_in(cusips))
            if cusips
            else pl.DataFrame(schema=HOLDINGS_SCHEMA)
        )
        holders = holders.select(
            "cik",
            stock_id=pl.col("cusip").replace_strict(
                ctx.stock_of, default=None, return_dtype=pl.Int32
            ),
        )
        recompute = affected_funds(
            pl.DataFrame({"cik": sorted(state.pending_funds)}, schema={"cik": pl.Int64}),
            sorted(state.pending_stocks),
            holders,
        )
    results = _compute(ctx, recompute)
    computed = {r.output.meta.fund_id for r in results}
    for result in results:
        flags += result.flags

    staging = new_version(out_root, run_id)
    files: dict[str, str] = {}
    for result in results:
        files.update(publish_fund(staging, result.output, compress))

    stored = _read_table(lake, "fund_state", FUND_STATE_SCHEMA)
    stored = stored.clear() if full else stored.filter(~pl.col("cik").is_in(sorted(recompute)))
    fresh = pl.DataFrame(
        [(r.output.meta.fund_id, _dump(r.output.meta), _dump(r.snapshot)) for r in results],
        schema=FUND_STATE_SCHEMA,
        orient="row",
    )
    fund_state = pl.concat([stored, fresh]).sort("cik")
    metas = [_load(m) for m in fund_state["meta"].to_list()]
    snaps = [_load(s) for s in fund_state["snap"].to_list()]
    weekly_ids = None if full else state.pending_weekly
    files.update(_publish_shared(ctx, staging, metas, snaps, weekly_ids, today, compress))

    cusip_map = _read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    priced = [m.priced_pct for m in metas]
    files.update(
        write_health(
            staging,
            {
                "filings_parsed": counts.filings_parsed,
                "unmapped_cusips": int(cusip_map["stock_id"].is_null().sum()),
                "coverage_median": statistics.median(priced) if priced else None,
                "funds_recomputed": len(results),
                "flags": _capped(flags),
            },
            compress,
        )
    )

    previous = _load_published(lake, out_root, compress)
    changed = changed_files(files, previous)
    _keep_only(staging, set(changed))
    # Only well-formed CUSIPs are guarded: a junk 13F value ("0", "N/A") is nobody's identifier
    # and must not stop the run when free text happens to contain it.
    guarded = {c for c in cusip_map["cusip"].to_list() if _is_cusip(c)}
    leaks = _cusip_leaks(staging, guarded, compress)
    if leaks:
        raise CusipLeakError(f"staged files would publish a CUSIP: {', '.join(leaks)}")

    dropped = {cik for cik in recompute if cik not in computed}
    merged = dict(files) if full else {**previous, **files}
    merged = {path: sha for path, sha in merged.items() if not _is_fund_path(path, dropped)}
    write_manifest(out_root, run_id, merged, compress, built=built)

    lake.write("fund_state", fund_state)  # recomputed funds replaced, dropped ones gone
    _write_json_atomic(_published_path(lake), merged)
    state.pending_funds.clear()
    state.pending_stocks.clear()
    state.pending_weekly.clear()
    state.pending_all = False
    state.last_q = last_q
    state.save(lake)
    _prune_staging(out_root)
    log.info("run %s: %d funds recomputed, %d files changed", run_id, len(results), len(changed))
    return RunStats(
        run_id=run_id,
        staging=staging,
        last_q=last_q,
        files=files,
        changed=sorted([*changed, "manifest.json"]),
        filings_parsed=counts.filings_parsed,
        funds_recomputed=len(results),
        flags=flags,
    )


def _is_fund_path(path: str, ciks: set[int]) -> bool:
    parts = path.split("/")
    return len(parts) == 3 and parts[0] == "fund" and parts[1].isdigit() and int(parts[1]) in ciks


def copy_published(staging: Path, out_root: Path, dest: Path) -> None:
    """Do what the upload does, into a local folder: copy the staged *.json files to `dest`
    under their paths, then the manifest last."""
    dest = Path(dest)
    for path in sorted(Path(staging).rglob("*.json")):
        target = dest / path.relative_to(staging)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(out_root) / "manifest.json", dest / "manifest.json")


# --- verify ---------------------------------------------------------------------------------


def verify(
    lake: Lake, out_root: Path, sample: int, seed: int | None = None, compress: bool = True
) -> list[str]:
    """Rebuild `sample` random published funds from the lake's raw filings (holdings rebuilt from
    scratch, not read from the incremental tables) into a temporary folder and return the paths
    whose bytes differ from the published ones (or are missing either side)."""
    state = _State.load(lake)
    published = _load_published(lake, out_root, compress)
    if state.last_q is None or not published:
        return []
    ids = sorted({int(p.split("/")[1]) for p in published if p.startswith("fund/")})
    chosen = sorted(random.Random(seed).sample(ids, min(sample, len(ids))))
    holdings, reports = [], []
    for part in lake.parts("filings"):
        filings = lake.read("filings", part=part).cast(FILINGS_SCHEMA)
        raw = lake.read("raw_holdings", part=part)
        if raw.is_empty():
            raw = pl.DataFrame(schema=RAW_SCHEMA)
        holdings.append(
            build_holdings(filings, raw.cast(RAW_SCHEMA)).filter(pl.col("cik").is_in(chosen))
        )
        reports.append(
            select_reports(filings).cast(REPORTS_SCHEMA).filter(pl.col("cik").is_in(chosen))
        )
    ctx = _Context.build(lake, state.last_q)
    results = _compute_batch(ctx, pl.concat(holdings), pl.concat(reports)) if reports else []
    rebuilt: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for result in results:
            rebuilt.update(publish_fund(Path(tmp), result.output, compress))
    expected = {p: sha for p, sha in published.items() if _is_fund_path(p, set(chosen))}
    return sorted(p for p in expected.keys() | rebuilt.keys() if expected.get(p) != rebuilt.get(p))


# --- command line -----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m orca.run", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("weekly", help="ingest new data, recompute affected funds, publish changes")
    commands.add_parser("rebuild", help="recompute and republish every fund")
    check = commands.add_parser(
        "verify", help="rebuild a sample of funds and compare with the published files"
    )
    check.add_argument("--sample", type=int, default=50)
    check.add_argument("--seed", type=int, default=None)
    demo_cmd = commands.add_parser("demo", help="build the synthetic demo dataset (no network)")
    demo_cmd.add_argument("--out", type=Path, default=Path("data/demo"))
    demo_cmd.add_argument(
        "--plain", action="store_true", help="uncompressed JSON (for the Vite dev server)"
    )
    demo_cmd.add_argument("--seed", type=int, default=7)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO lines print the FRED key

    if args.command in ("weekly", "rebuild"):
        stats = run_weekly(
            Lake(config.LAKE_DIR),
            config.OUT_DIR,
            production_sources(),
            date.today(),
            full=args.command == "rebuild",
        )
        print(f"staging: {stats.staging}")
        print(f"changed: {len(stats.changed)} files, funds recomputed: {stats.funds_recomputed}")
        return 0
    if args.command == "verify":
        diffs = verify(Lake(config.LAKE_DIR), config.OUT_DIR, args.sample, args.seed)
        for path in diffs:
            print(f"differs: {path}")
        print(f"verify: {len(diffs)} file(s) differ")
        return 1 if diffs else 0
    from orca import demo

    files = demo.write_demo(args.out, seed=args.seed, compress=not args.plain)
    print(f"demo: {files} files written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
