"""Shared fixtures: one full demo run per session, and the engine's inputs and results for a set
of its funds."""

from dataclasses import dataclass
from pathlib import Path

import polars as pl
import pytest

from orca import demo
from orca.holdings import build_holdings, select_reports
from orca.run.compute import Context, FundResult, Prepared, prepare_batch
from orca.run.state import RAW_SCHEMA, REPORTS_SCHEMA, State
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake


@dataclass(frozen=True)
class DemoRun:
    root: Path  # root/lake, root/out (staged files and manifest.json)
    lake: Lake
    last_q: int


@pytest.fixture(scope="session")
def demo_run(tmp_path_factory) -> DemoRun:
    """One full run on the demo data as of DEMO_TODAY, as `demo.write_demo` does it."""
    from datetime import UTC, datetime

    from orca.run.weekly import run_weekly

    root = tmp_path_factory.mktemp("demo_run")
    lake = Lake(root / "lake")
    today = demo.DEMO_TODAY
    stats = run_weekly(
        lake,
        root / "out",
        demo.build_sources(7),
        today,
        full=True,
        built=datetime(today.year, today.month, today.day, tzinfo=UTC),
    )
    return DemoRun(root, lake, stats.last_q)


def demo_batch(
    demo_run: DemoRun, ciks: list[int]
) -> tuple[Context, list[tuple[Prepared, FundResult]]]:
    """The engine's inputs and results for `ciks`, read from the run's lake the way
    `run/weekly.verify` does (holdings rebuilt from the raw filings), with the Context used."""
    state = State.load(demo_run.lake)
    holdings, reports = [], []
    for part in demo_run.lake.parts("filings"):
        filings = demo_run.lake.read("filings", part=part).cast(FILINGS_SCHEMA)
        raw = demo_run.lake.read("raw_holdings", part=part)
        if raw.is_empty():
            raw = pl.DataFrame(schema=RAW_SCHEMA)
        holdings.append(
            build_holdings(filings, raw.cast(RAW_SCHEMA)).filter(
                pl.col("cik").is_in(ciks)
            )
        )
        reports.append(
            select_reports(filings)
            .cast(REPORTS_SCHEMA)
            .filter(pl.col("cik").is_in(ciks))
        )
    ctx = Context.build(demo_run.lake, state.last_q)
    return ctx, list(prepare_batch(ctx, pl.concat(holdings), pl.concat(reports)))
