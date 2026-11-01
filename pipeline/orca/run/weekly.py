"""The weekly run (`run_weekly`) and the monthly check (`verify`)."""

import json
import logging
import random
import statistics
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
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
    read_manifest,
    write_health,
    write_manifest,
)
from orca.quarters import q_end, q_of_date
from orca.run.budget import Budget
from orca.run.compute import Context, affected_funds, compute_batch
from orca.run.ingest import Counts, ingest_bulk, ingest_live
from orca.run.market import (
    map_new_cusips,
    refresh_prices,
    remap_held_cusips,
    retry_lookups,
    update_rf,
)
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
    published paths whose bytes changed (the files left in `staging`), plus manifest.json.
    `staging` is None when the time budget ran out before any fund was computed: nothing was
    published (and no staging folder made)."""

    run_id: str
    staging: Path | None
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


def _reconcile_published(lake: Lake, out_root: Path, state: State, compress: bool) -> None:
    """Make the lake's published.json what the site has: the manifest in `out_root` (the site's,
    which the workflow restores there; none means the site has nothing yet). They differ when a
    run wrote published.json but its upload failed or never ran, and the lake was saved all the
    same. The funds and weekly files whose published paths differ are then owed again, so this
    run rebuilds them and stages what the site lacks. Without a published.json in the lake there
    is nothing to reconcile (`load_published` reads the manifest)."""
    path = published_path(lake)
    if not path.exists():
        return
    recorded = json.loads(path.read_text())
    site = read_manifest(out_root, compress)
    differ = {p for p in recorded.keys() | site.keys() if recorded.get(p) != site.get(p)}
    if not differ:
        return
    funds = {i for p in differ if (i := _path_id(p, "fund")) is not None}
    stocks = {i for p in differ if (i := _path_id(p, "stock")) is not None}
    log.warning(
        "the site is behind the lake's last publish (%d files differ): republishing %d funds "
        "and %d weekly files",
        len(differ),
        len(funds),
        len(stocks),
    )
    state.pending_funds |= funds
    state.pending_weekly |= stocks
    state.save(lake)  # before published.json, so a crash in between reconciles again
    write_json_atomic(path, site)


def _path_id(path: str, kind: str) -> int | None:
    """The id in a published `{kind}/{id}/<file>` path (`fund` or `stock`), else None."""
    parts = path.split("/")
    if len(parts) == 3 and parts[0] == kind and parts[1].isdigit():
        return int(parts[1])
    return None


def _stage(name: str, budget: Budget, work: Callable[[], dict | None]) -> None:
    """Run one stage of the run, unless the time budget is already spent (then it is recorded as
    cut and skipped: what it would have done stays owed in the state), and log its time and the
    counts it returns."""
    if budget.spent():
        budget.cut(name)
        log.warning("%s: skipped, the time budget is spent", name)
        return
    log.info("%s: starting (%.0f minutes of the budget left)", name, budget.minutes_left())
    started = time.monotonic()
    _log_stage(name, started, work())


def _log_stage(name: str, started: float, counts: dict | None) -> None:
    """One INFO line per stage: its time and counts (numbers, never a URL)."""
    shown = "".join(f" {key}={value}" for key, value in (counts or {}).items())
    log.info("%s: %.1f s%s", name, time.monotonic() - started, shown)


@dataclass
class _Funds:
    """What computing and publishing the funds left: the files written, each computed fund's
    header and home snapshot (by CIK), its data-quality flags, and the CIKs whose batch was
    done (computed, or found to have no reports). The full outputs are gone."""

    files: dict[str, str] = field(default_factory=dict)
    metas: dict[int, FundMeta] = field(default_factory=dict)
    snaps: dict[int, FundSnapshot] = field(default_factory=dict)
    flags: list = field(default_factory=list)
    attempted: set[int] = field(default_factory=set)


def _publish_funds(
    ctx: Context, ciks: set[int], staging: Path, compress: bool, budget: Budget
) -> _Funds:
    """Compute the funds of `ciks` FUND_BATCH at a time, writing each fund's files into `staging`
    and each batch's fund state into the lake's FUND_STATE_RUN parts as soon as they exist; only
    the headers, snapshots, flags and checksums are kept. A part left by a run that died is
    dropped first: it was never published. The first batch always runs; no later one starts
    once the time budget is spent."""
    lake = ctx.lake
    drop_parts(lake, FUND_STATE_RUN)
    done = _Funds()
    for number, batch in enumerate(chunks(sorted(ciks), FUND_BATCH)):
        if number and budget.spent():
            budget.cut("compute")
            log.warning(
                "compute: stopped after %d funds, the time budget is spent", len(done.attempted)
            )
            break
        done.attempted |= set(batch)
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
    budget: Budget | None = None,
) -> RunStats:
    """One pipeline run as of `today`; `full` recomputes and republishes everything (after a
    formula change). Returns what it did. Raises InvariantError or CusipLeakError, before the
    manifest is written, when a recomputed fund breaks an invariant or a staged file would publish
    a CUSIP; the site then stays on the last good version and the next run retries.

    `budget` (default: ORCA_TIME_BUDGET_MIN, 270 minutes) bounds the run. When it is spent a long
    stage stops cleanly between two units of work (a ZIP, a ticker, a lookup, a batch of funds)
    and the later stages are skipped; the state keeps what is still owed, so the next run goes on
    from there. If funds were computed, they are published with the shared files and health.json
    names the stages cut short (`time_budget`); the funds not reached stay pending (a rebuild cut
    short is finished as an ordinary recompute of them). If the budget ran out before the first
    fund, nothing is published.

    The site's manifest in `out_root` (the workflow restores it there) is what was really
    uploaded: where the lake's published.json differs from it, an earlier run's upload did not
    complete, and the funds and weekly files concerned are rebuilt and staged again."""
    budget = Budget.from_env() if budget is None else budget
    out_root = Path(out_root)
    lake.root.mkdir(parents=True, exist_ok=True)
    state = State.load(lake)
    _reconcile_published(lake, out_root, state, compress)
    last_q = deadline_quarter(today)
    run_id = today.strftime("%Y%m%d")
    flags: list = []
    counts = Counts()
    if full:  # owed until a publish succeeds, even if this run dies
        state.pending_all = True
        state.save(lake)

    def securities() -> dict:
        return {
            **(map_new_cusips(lake, sources, state, today, flags, budget) or {}),
            **(retry_lookups(lake, sources, state, flags, budget) or {}),
            **(remap_held_cusips(lake, sources, state, today, last_q, flags, budget) or {}),
        }

    _stage("bulk", budget, lambda: ingest_bulk(lake, sources, state, flags, counts, budget))
    _stage("live", budget, lambda: ingest_live(lake, sources, state, today, flags, counts))
    _stage("securities", budget, securities)
    _stage(
        "prices",
        budget,
        lambda: refresh_prices(lake, sources, state, today, last_q, run_id, flags, budget),
    )
    _stage("rf", budget, lambda: update_rf(lake, sources, state, last_q, full, flags))
    state.save(lake)
    for source, drops in sorted(counts.drops.items()):
        flags.append({"type": "dropped_rows", "source": source, **dict(sorted(drops.items()))})

    if budget.spent():  # no fund computed: nothing new to publish, everything owed is in the state
        budget.cut("compute")
        flags.append(budget.flag())
        log.warning(
            "run %s: the time budget is spent before computing funds; not publishing", run_id
        )
        return RunStats(run_id, None, last_q, {}, [], counts.filings_parsed, 0, flags)

    started = time.monotonic()
    ctx = Context.build(lake, last_q)
    recompute = _recompute_set(lake, ctx, state, last_q)
    staging = new_version(out_root, run_id)
    funds = _publish_funds(ctx, recompute, staging, compress, budget)
    flags += funds.flags
    files, computed = funds.files, set(funds.metas)
    remaining = recompute - funds.attempted
    _log_stage("compute", started, {"funds": len(computed), "owed": len(remaining)})
    started = time.monotonic()
    rebuild = full and not remaining  # a whole rebuild replaces what was published before
    if budget.flag():
        flags.append(budget.flag())

    # The funds not recomputed contribute their stored header and snapshot to the shared files.
    metas, snaps = funds.metas, funds.snaps
    stored = read_table(lake, "fund_state", FUND_STATE_SCHEMA)
    if rebuild:
        stored = stored.clear()
    else:
        stored = stored.filter(~pl.col("cik").is_in(sorted(funds.attempted)))
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

    _log_stage("publish", started, {"files": len(files), "changed": len(changed)})
    dropped = funds.attempted - computed
    merged = dict(files) if rebuild else {**previous, **files}
    merged = {path: sha for path, sha in merged.items() if not is_fund_path(path, dropped)}
    write_manifest(out_root, run_id, merged, compress, built=built)

    # Recomputed funds replaced, dropped ones gone.
    _merge_fund_state(lake, funds.attempted, clear=rebuild)
    write_json_atomic(published_path(lake), merged)
    state.pending_funds = remaining  # what the price and filing changes still owe
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
