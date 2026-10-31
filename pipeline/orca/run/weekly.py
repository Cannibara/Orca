"""The weekly run (`run_weekly`) and the monthly check (`verify`)."""

import logging
import random
import statistics
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import polars as pl

from orca.holdings import HOLDINGS_SCHEMA, build_holdings, select_reports
from orca.home import FundSnapshot
from orca.publish import (
    FundMeta,
    changed_files,
    new_version,
    publish_fund,
    write_health,
    write_manifest,
)
from orca.quarters import q_end, q_of_date
from orca.run.compute import Context, affected_funds, compute_batch
from orca.run.ingest import Counts, ingest_bulk, ingest_live
from orca.run.market import map_new_cusips, refresh_prices, update_rf
from orca.run.publish_step import (
    CusipLeakError,
    capped,
    cusip_leaks,
    is_cusip,
    is_fund_path,
    keep_only,
    prune_staging,
    publish_shared_files,
)
from orca.run.sources import Sources
from orca.run.state import (
    CUSIP_MAP_SCHEMA,
    FUND_STATE_RUN,
    FUND_STATE_SCHEMA,
    RAW_SCHEMA,
    REPORTS_SCHEMA,
    State,
    chunks,
    drop_parts,
    dump,
    load_published,
    published_path,
    read_table,
    scan,
    undump,
    write_json_atomic,
)
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake

log = logging.getLogger(__name__)

DEADLINE_DAYS = 45  # a 13F is due 45 days after the quarter ends
FUND_BATCH = 250  # funds computed and published per batch: only one fund's output is held at once


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


def deadline_quarter(today: date) -> int:
    """The latest quarter whose 45-day filing deadline has passed: q_end(q) + 45 days <= today."""
    q = q_of_date(today)
    while q_end(q) + timedelta(days=DEADLINE_DAYS) > today:
        q -= 1
    return q


def _all_ciks(lake: Lake) -> set[int]:
    reports = scan(lake, "reports", REPORTS_SCHEMA)
    return {int(c) for c in reports["cik"].unique().to_list()}


def _recompute_set(lake: Lake, ctx: Context, state: State, last_q: int) -> set[int]:
    # A rebuild, the deadline quarter, the T-bill rate and the benchmark (every fund's what-if
    # figures) concern every fund.
    if state.pending_all or state.last_q != last_q or ctx.spy_id in state.pending_stocks:
        return _all_ciks(lake)
    cusips = [c for c, sid in ctx.stock_of.items() if sid in state.pending_stocks]
    holders = (
        scan(lake, "holdings", HOLDINGS_SCHEMA, pl.col("cusip").is_in(cusips))
        if cusips
        else pl.DataFrame(schema=HOLDINGS_SCHEMA)
    )
    holders = holders.select(
        "cik",
        stock_id=pl.col("cusip").replace_strict(ctx.stock_of, default=None, return_dtype=pl.Int32),
    )
    return affected_funds(
        pl.DataFrame({"cik": sorted(state.pending_funds)}, schema={"cik": pl.Int64}),
        sorted(state.pending_stocks),
        holders,
    )


@dataclass
class _Funds:
    """What computing and publishing the funds left: the files written, each computed fund's
    header and home snapshot (by CIK), and its data-quality flags. The full outputs are gone."""

    files: dict[str, str]
    metas: dict[int, FundMeta]
    snaps: dict[int, FundSnapshot]
    flags: list


def _publish_funds(ctx: Context, ciks: set[int], staging: Path, compress: bool) -> _Funds:
    """Compute the funds of `ciks` FUND_BATCH at a time, writing each fund's files into `staging`
    and each batch's fund state into the lake's FUND_STATE_RUN parts as soon as they exist; only
    the headers, snapshots, flags and checksums are kept. A part left by a run that died is
    dropped first: it was never published."""
    lake = ctx.lake
    drop_parts(lake, FUND_STATE_RUN)
    done = _Funds({}, {}, {}, [])
    for number, batch in enumerate(chunks(sorted(ciks), FUND_BATCH)):
        where = pl.col("cik").is_in(batch)
        holdings = scan(lake, "holdings", HOLDINGS_SCHEMA, where)
        reports = scan(lake, "reports", REPORTS_SCHEMA, where)
        if reports.height:
            rows = _publish_batch(ctx, holdings, reports, staging, compress, done)
            lake.write(FUND_STATE_RUN, rows, part=f"b{number:05d}")
    return done


def _publish_batch(
    ctx: Context,
    holdings: pl.DataFrame,
    reports: pl.DataFrame,
    staging: Path,
    compress: bool,
    done: _Funds,
) -> pl.DataFrame:
    """One batch of `_publish_funds`; its fund state rows."""
    rows = []
    for result in compute_batch(ctx, holdings, reports):
        meta = result.output.meta
        done.files.update(publish_fund(staging, result.output, compress))
        done.flags += result.flags
        done.metas[meta.fund_id], done.snaps[meta.fund_id] = meta, result.snapshot
        rows.append((meta.fund_id, dump(meta), dump(result.snapshot)))
    return pl.DataFrame(rows, schema=FUND_STATE_SCHEMA, orient="row")


def _merge_fund_state(lake: Lake, replaced: set[int], clear: bool) -> None:
    """The stored fund state with this run's FUND_STATE_RUN parts merged in: the rows of
    `replaced` (every row when `clear`) give way to the run's (a fund without one is gone)."""
    stored = read_table(lake, "fund_state", FUND_STATE_SCHEMA)
    stored = stored.clear() if clear else stored.filter(~pl.col("cik").is_in(sorted(replaced)))
    fresh = scan(lake, FUND_STATE_RUN, FUND_STATE_SCHEMA)
    lake.write("fund_state", pl.concat([stored, fresh]).sort("cik"))
    drop_parts(lake, FUND_STATE_RUN)


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
    state = State.load(lake)
    last_q = deadline_quarter(today)
    run_id = today.strftime("%Y%m%d")
    flags: list = []
    counts = Counts()
    if full:  # owed until a publish succeeds, even if this run dies
        state.pending_all = True
        state.save(lake)

    ingest_bulk(lake, sources, state, flags, counts)
    ingest_live(lake, sources, state, today, flags, counts)
    map_new_cusips(lake, sources, state, flags)
    refresh_prices(lake, sources, state, today, last_q, run_id, flags)
    update_rf(lake, sources, state, last_q, full, flags)
    state.save(lake)
    for source, drops in sorted(counts.drops.items()):
        flags.append({"type": "dropped_rows", "source": source, **dict(sorted(drops.items()))})

    ctx = Context.build(lake, last_q)
    recompute = _recompute_set(lake, ctx, state, last_q)
    staging = new_version(out_root, run_id)
    funds = _publish_funds(ctx, recompute, staging, compress)
    flags += funds.flags
    files, computed = funds.files, set(funds.metas)

    # The funds not recomputed contribute their stored header and snapshot to the shared files.
    metas, snaps = funds.metas, funds.snaps
    stored = read_table(lake, "fund_state", FUND_STATE_SCHEMA)
    stored = stored.clear() if full else stored.filter(~pl.col("cik").is_in(sorted(recompute)))
    for cik, meta, snap in stored.iter_rows():
        metas[cik], snaps[cik] = undump(meta), undump(snap)
    del stored
    order = sorted(metas)
    weekly_ids = None if full else state.pending_weekly
    files.update(
        publish_shared_files(
            ctx,
            staging,
            [metas[c] for c in order],
            [snaps[c] for c in order],
            weekly_ids,
            today,
            compress,
        )
    )

    cusip_map = read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    priced = [metas[c].priced_pct for c in order]
    files.update(
        write_health(
            staging,
            {
                "filings_parsed": counts.filings_parsed,
                "unmapped_cusips": int(cusip_map["stock_id"].is_null().sum()),
                "coverage_median": statistics.median(priced) if priced else None,
                "funds_recomputed": len(computed),
                "flags": capped(flags),
            },
            compress,
        )
    )

    previous = load_published(lake, out_root, compress)
    changed = changed_files(files, previous)
    keep_only(staging, set(changed))
    # Only well-formed CUSIPs are guarded: a junk 13F value ("0", "N/A") is nobody's identifier
    # and must not stop the run when free text happens to contain it.
    guarded = {c for c in cusip_map["cusip"].to_list() if is_cusip(c)}
    leaks = cusip_leaks(staging, guarded, compress)
    if leaks:
        raise CusipLeakError(f"staged files would publish a CUSIP: {', '.join(leaks)}")

    dropped = recompute - computed
    merged = dict(files) if full else {**previous, **files}
    merged = {path: sha for path, sha in merged.items() if not is_fund_path(path, dropped)}
    write_manifest(out_root, run_id, merged, compress, built=built)

    _merge_fund_state(lake, recompute, clear=full)  # recomputed funds replaced, dropped ones gone
    write_json_atomic(published_path(lake), merged)
    state.pending_funds.clear()
    state.pending_stocks.clear()
    state.pending_weekly.clear()
    state.pending_all = False
    state.last_q = last_q
    state.save(lake)
    prune_staging(out_root)
    log.info("run %s: %d funds recomputed, %d files changed", run_id, len(computed), len(changed))
    return RunStats(
        run_id=run_id,
        staging=staging,
        last_q=last_q,
        files=files,
        changed=sorted([*changed, "manifest.json"]),
        filings_parsed=counts.filings_parsed,
        funds_recomputed=len(computed),
        flags=flags,
    )


# --- verify ---------------------------------------------------------------------------------


def verify(
    lake: Lake, out_root: Path, sample: int, seed: int | None = None, compress: bool = True
) -> list[str]:
    """Rebuild `sample` random published funds from the lake's raw filings (holdings rebuilt from
    scratch, not read from the incremental tables) into a temporary folder and return the paths
    whose bytes differ from the published ones (or are missing either side)."""
    state = State.load(lake)
    published = load_published(lake, out_root, compress)
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
    rebuilt: dict[str, str] = {}
    if reports:
        ctx = Context.build(lake, state.last_q)
        with tempfile.TemporaryDirectory() as tmp:
            for result in compute_batch(ctx, pl.concat(holdings), pl.concat(reports)):
                rebuilt.update(publish_fund(Path(tmp), result.output, compress))
    expected = {p: sha for p, sha in published.items() if is_fund_path(p, set(chosen))}
    return sorted(p for p in expected.keys() | rebuilt.keys() if expected.get(p) != rebuilt.get(p))
