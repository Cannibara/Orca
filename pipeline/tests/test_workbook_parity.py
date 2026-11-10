"""The site-parity fixture (web/tests/fixtures/workbook-cases.json) is fresh: built again from the
12 demo funds and the hand-built edge-case funds, recalculated by LibreOffice, it gives exactly
the committed bytes. Regenerate after a change to the workbook, the engine or the demo data:

    ORCA_WRITE_PARITY=1 uv run pytest tests/test_workbook_parity.py

The vitest test web/tests/workbook-parity.test.ts then runs the site's own functions on it."""

import json
import os
from pathlib import Path

import lo
import pytest
from conftest import demo_batch
from test_workbook_outputs import SHEETS, _edit_inputs
from workbook_fixtures import edge_case_inputs

from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.build import build_workbook, file_name, workbook_map
from orca.workbook.inputs import build_inputs
from orca.workbook.parity import dumps, parity_cases

FIXTURE = Path(__file__).resolve().parents[2] / "web" / "tests" / "fixtures" / "workbook-cases.json"
CIKS = list(range(9100001, 9100013))
# Two demo funds with a bracket typed into Summary's From/To years (a middle one, and one that
# runs into the part year), so the range tiles are compared away from the default bracket.
BRACKETS = {9100001: (2016, 2019), 9100004: (2018, 2026)}
REL = 1e-12  # float fields of a regenerated fixture against the committed one
REL_IRR = 1e-9  # IRR fields: LibreOffice's XIRR stops at its own tolerance
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
    base = dict(funds)
    funds.update({f"edge-{k}": fi for k, fi in edge_case_inputs(tmp_path / "edges").items()})

    paths = []
    for name, fi in funds.items():
        paths.append(tmp_path / "books" / f"{name}-{file_name(fi)}")
        paths[-1].parent.mkdir(exist_ok=True)
        build_workbook(fi, paths[-1])
    for cik, (first, last) in BRACKETS.items():
        fi = base[f"demo-{cik}"]
        funds[f"range-{cik}"] = fi
        paths.append(tmp_path / "books" / f"range-{cik}-{file_name(fi)}")
        build_workbook(fi, paths[-1])
        summary = workbook_map(fi).summary
        cells = {summary.cell("from_year"): first, summary.cell("to_year"): last}
        _edit_inputs(paths[-1], "Summary", cells)
    computed = lo.recalc_all(paths, tmp_path / "computed")
    cases = [(name, fi, lo.values(path)) for (name, fi), path in zip(funds.items(), computed)]
    fresh = dumps(parity_cases(cases))

    if os.environ.get("ORCA_WRITE_PARITY") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_bytes(fresh)
    assert FIXTURE.exists(), f"{FIXTURE} is missing: write it with {REGENERATE}"
    stale = differences(json.loads(FIXTURE.read_bytes()), json.loads(fresh))
    assert not stale, f"the parity fixture is stale ({stale[0]}): regenerate with {REGENERATE}"


def differences(old: object, new: object, path: str = "") -> list[str]:
    """Where `new` differs from `old`: keys, lengths, ints, strings and nulls exactly; floats
    within REL (REL_IRR in an IRR field). The first few differences, as paths."""
    if isinstance(old, dict) and isinstance(new, dict):
        if old.keys() != new.keys():
            return [f"{path}: keys {sorted(old.keys() ^ new.keys())[:3]}"]
        return [d for k in old for d in differences(old[k], new[k], f"{path}/{k}")][:5]
    if isinstance(old, list) and isinstance(new, list):
        if len(old) != len(new):
            return [f"{path}: length {len(old)} against {len(new)}"]
        pairs = enumerate(zip(old, new))
        return [d for i, (a, b) in pairs for d in differences(a, b, f"{path}/{i}")][:5]
    numbers = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (old, new))
    if numbers and (isinstance(old, float) or isinstance(new, float)):
        rel = REL_IRR if path.rsplit("/", 1)[-1].startswith("irr") else REL
        if abs(old - new) <= rel * abs(old):
            return []
    elif type(old) is type(new) and old == new:
        return []
    return [f"{path}: {old!r} against {new!r}"]
