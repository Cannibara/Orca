"""The site-parity fixture (web/tests/fixtures/workbook-cases.json) is fresh: built again from the
12 demo funds and the hand-built edge-case funds, recalculated by LibreOffice, it gives exactly
the committed bytes. Regenerate after a change to the workbook, the engine or the demo data:

    ORCA_WRITE_PARITY=1 uv run pytest tests/test_workbook_parity.py

The vitest test web/tests/workbook-parity.test.ts then runs the site's own functions on it."""

import os
from pathlib import Path

import lo
import pytest
from conftest import demo_batch
from workbook_fixtures import edge_case_inputs

from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.build import build_workbook, file_name
from orca.workbook.inputs import build_inputs
from orca.workbook.parity import dumps, parity_cases

FIXTURE = Path(__file__).resolve().parents[2] / "web" / "tests" / "fixtures" / "workbook-cases.json"
CIKS = list(range(9100001, 9100013))
REGENERATE = "ORCA_WRITE_PARITY=1 uv run pytest tests/test_workbook_parity.py"


@pytest.mark.libreoffice
def test_parity_fixture_is_fresh(demo_run, tmp_path):
    lo.require_libreoffice()
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    funds = {
        f"demo-{p.cik}": build_inputs(ctx, p, r, latest, securities)
        for p, r in sorted(batch, key=lambda b: b[0].cik)
    }
    funds.update({f"edge-{k}": fi for k, fi in edge_case_inputs(tmp_path / "edges").items()})

    paths = []
    for name, fi in funds.items():
        paths.append(tmp_path / "books" / f"{name}-{file_name(fi)}")
        paths[-1].parent.mkdir(exist_ok=True)
        build_workbook(fi, paths[-1])
    computed = lo.recalc_all(paths, tmp_path / "computed")
    cases = [(name, fi, lo.values(path)) for (name, fi), path in zip(funds.items(), computed)]
    fresh = dumps(parity_cases(cases))

    if os.environ.get("ORCA_WRITE_PARITY") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(fresh)
    assert FIXTURE.exists(), f"{FIXTURE} is missing: write it with {REGENERATE}"
    assert FIXTURE.read_bytes() == fresh, f"the parity fixture is stale: regenerate with {REGENERATE}"
