"""Ingest: bulk ZIPs and live filings into the per-quarter filings, raw holdings, chosen reports and
holdings tables."""

import logging
import tempfile
import zipfile
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import polars as pl

from orca.holdings import build_holdings, select_reports
from orca.http import FetchError
from orca.run.budget import Budget
from orca.run.sources import Sources
from orca.run.state import RAW_SCHEMA, REPORTS_SCHEMA, State, part_name, scan, strip_query
from orca.sec.bulk import parse_bulk_zip
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake, Manifest, sha256_file

log = logging.getLogger(__name__)

LIVE_RECENT_BUSINESS_DAYS = 3  # a missing daily index this recent may only be late
LIVE_FIRST_LOOKBACK_DAYS = 7  # first live read when there is no bulk data to start after
LIVE_RETRY_DAYS = 28  # a day with a failed filing download is read again for four weeks


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


@dataclass
class Counts:
    filings_parsed: int = 0
    drops: dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))

    def add(self, source: str, stats: dict) -> None:
        for key, value in stats.items():
            if isinstance(value, int) and not isinstance(value, bool) and value:
                self.drops[source][key] += value


def ingest(
    lake: Lake, filings: pl.DataFrame, raw: pl.DataFrame, source: str, counts: Counts
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
        part = part_name(period)
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


def ingest_bulk(
    lake: Lake, sources: Sources, state: State, flags: list, counts: Counts, budget: Budget
) -> None:
    """Ingest the listed bulk ZIPs not ingested yet, in order, until the time budget is spent;
    the rest wait for the next run (a ZIP is recorded only once its rows are stored)."""
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
            if budget.spent():
                budget.cut("bulk")
                break
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
            state.pending_funds |= ingest(lake, filings, raw, "bulk", counts)
            state.save(lake)
            # Only now is the ZIP recorded: a crash before this line re-reads it next run.
            ingested.mark(name, checksum)
            ingested.save()
            counts.filings_parsed += filings.height
            counts.add("bulk", stats)


def ingest_live(
    lake: Lake, sources: Sources, state: State, today: date, flags: list, counts: Counts
) -> None:
    """Ingest the live filings since the watermark and move it on: to `live_watermark`'s day,
    or to the day before the earliest index day with a failed filing download, so the next run
    reads that day again (for LIVE_RETRY_DAYS; an older failure is given up and flagged). A
    failed read (SEC throttling included) moves nothing and is flagged."""
    if state.live_watermark is not None:
        since = state.live_watermark + timedelta(days=1)
    else:
        bulk = scan(lake, "filings", FILINGS_SCHEMA, pl.col("source") == "bulk")
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
    state.pending_funds |= ingest(lake, filings, raw, "live", counts)
    watermark = live_watermark(since, until, stats.get("no_index_days", []))
    failed = stats.get("failed_days", [])
    held = [day for day in failed if day > today - timedelta(days=LIVE_RETRY_DAYS)]
    if held:
        watermark = min(watermark, min(held) - timedelta(days=1))
    if abandoned := sorted(set(failed) - set(held)):
        flags.append(
            {"type": "live_downloads_abandoned", "days": [day.isoformat() for day in abandoned]}
        )
    state.live_watermark = watermark
    state.save(lake)
    counts.filings_parsed += filings.height
    counts.add("live", stats)
