"""Weekly orchestrator: ingest new filings and prices, recompute the funds they touch, publish.

A run (`run_weekly`) goes: unseen bulk ZIPs -> live filings since the last run -> per-quarter
holdings -> new CUSIPs mapped -> prices of held stocks -> affected funds -> those funds
recomputed (bridge and share invariants checked) and their files staged, a batch at a time -> home
lists and health -> only the changed files kept -> CUSIP scan -> manifest. Anything that fails
before the manifest leaves the published site on the last good version, and what the run still
owes (funds and stocks to recompute) is kept in the lake's state, so the next run picks it up.

Every run has a time budget (`budget`): when it is spent, the long stages stop cleanly and the
next run carries on from the state.

Modules: `state` (lake tables, state.json, stored fund state), `sources` (what a run fetches),
`budget` (the time budget), `ingest` (bulk and live filings), `market` (securities, prices,
T-bill), `compute` (one fund), `publish_step` (shared files, CUSIP guard, staging), `weekly` (the
run and `verify`), `cli`.

Lake layout (all under `lake.root`):
- `filings/qNNN`, `raw_holdings/qNNN`: every filing of report period NNN and its raw rows, one
  copy per (accession, source); a re-read filing replaces its earlier copy.
- `reports/qNNN`, `holdings/qNNN`: the chosen reports and the collapsed holdings of the quarter,
  rebuilt whenever the quarter gets a filing.
- `securities`, `cusip_map`, `prices_daily/...`, `rf`, `fund_state` (each fund's header and home
  snapshot as JSON, for the funds a run does not recompute) and `fund_state_run/bNNNNN` (the
  running publish's fund state, merged into `fund_state` after the manifest).
- `ingested.json` (bulk ZIPs ingested, name -> sha256), `state.json` (live watermark, last
  quarter, pending recomputes, lookups and price histories still owed), `published.json` (the
  last manifest's files).

A fund is identified by its CIK (`fund_id` = CIK), so ids never depend on ingestion order.
"""

from orca.run.cli import main
from orca.run.compute import InvariantError, affected_funds, price_flags, split_suspects
from orca.run.ingest import live_watermark
from orca.run.publish_step import CusipLeakError, copy_published, cusip_check_digit
from orca.run.sources import Sources, production_sources
from orca.run.state import strip_query
from orca.run.weekly import RunStats, deadline_quarter, run_weekly, verify

__all__ = [
    "CusipLeakError",
    "InvariantError",
    "RunStats",
    "Sources",
    "affected_funds",
    "copy_published",
    "cusip_check_digit",
    "deadline_quarter",
    "live_watermark",
    "main",
    "price_flags",
    "production_sources",
    "run_weekly",
    "split_suspects",
    "strip_query",
    "verify",
]
