"""`python -m orca.run workbook`: demo funds, unknown ids, funds nobody can price, and the guard
that refuses inputs which do not validate or serialise."""

import dataclasses

import pytest
from workbook_fixtures import FUND, TODAY, held, multi_stock_fixtures

from orca import config
from orca.demo import fixture_sources
from orca.run import run_weekly
from orca.run import workbook as wb
from orca.run.cli import main
from orca.storage import Lake
from orca.workbook.inputs import from_json


@pytest.fixture
def demo_lake(demo_run, monkeypatch):
    monkeypatch.setattr(config, "LAKE_DIR", demo_run.lake.root)
    return demo_run.lake


def test_cli_builds_two_demo_funds(demo_lake, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["workbook", "--fund", "9100001", "--fund", "9100005", "--out", str(out)]) == 0
    books = sorted(p.name for p in out.glob("*.xlsx"))
    assert len(books) == 2
    assert books[0].startswith("orca-9100001-") and books[0].endswith("-2026-10-30.xlsx")
    assert books[1].startswith("orca-9100005-")
    files = sorted((out / "inputs").glob("*.json"))
    assert [f.name for f in files] == ["9100001.json", "9100005.json"]
    for f in files:
        assert from_json(f.read_bytes()).fund_id == int(f.stem)
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("fund ")]
    assert len(lines) == 2 and all(" rows, " in ln and " MB, " in ln for ln in lines)


def test_cli_unknown_fund_exits_1(demo_lake, tmp_path, capsys):
    assert main(["workbook", "--fund", "123", "--out", str(tmp_path)]) == 1
    assert "fund 123: not found" in capsys.readouterr().out
    assert not list(tmp_path.glob("*.xlsx"))


def test_cli_skips_fund_without_priced_positions(tmp_path, monkeypatch, capsys, no_health_gates):
    # CHAR is filed with shares but no value and has no prices: the engine has no position.
    rows = {q: [held("CHAR", 500, 0)] for q in (43, 44, 45)}
    fx = multi_stock_fixtures({"CHAR": None}, rows)
    lake = Lake(tmp_path / "lake")
    run_weekly(lake, tmp_path / "pub", fixture_sources(fx), TODAY)
    monkeypatch.setattr(config, "LAKE_DIR", lake.root)
    out = tmp_path / "out"
    assert main(["workbook", "--fund", str(FUND), "--out", str(out)]) == 0
    assert f"fund {FUND}: skipped: no priced positions" in capsys.readouterr().out
    assert not list(out.glob("*.xlsx"))


def test_cli_refuses_inputs_that_do_not_validate(demo_lake, tmp_path, monkeypatch, capsys):
    real = wb.build_inputs

    def poisoned(*args, **kwargs):
        fi = real(*args, **kwargs)
        return dataclasses.replace(fi, tbill=[float("nan"), *fi.tbill[1:]])

    monkeypatch.setattr(wb, "build_inputs", poisoned)
    assert main(["workbook", "--fund", "9100001", "--out", str(tmp_path)]) == 1
    assert "fund 9100001: tbill" in capsys.readouterr().out
    assert not list(tmp_path.rglob("*.xlsx")) and not list(tmp_path.rglob("*.json"))


def test_cli_refuses_inputs_that_do_not_read_back(demo_lake, tmp_path, monkeypatch, capsys):
    real = wb.from_json
    monkeypatch.setattr(
        wb, "from_json", lambda data: dataclasses.replace(real(data), name="changed")
    )
    assert main(["workbook", "--fund", "9100001", "--out", str(tmp_path)]) == 1
    assert "fund 9100001: its inputs file does not read back equal" in capsys.readouterr().out
    assert not list(tmp_path.rglob("*.xlsx")) and not list(tmp_path.rglob("*.json"))


def test_cli_mixed_known_and_unknown_funds(demo_lake, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["workbook", "--fund", "9100001", "--fund", "123", "--out", str(out)]) == 1
    printed = capsys.readouterr().out
    assert "fund 123: not found" in printed
    assert [p.name for p in out.glob("orca-9100001-*.xlsx")] != []
    assert [p.name for p in (out / "inputs").glob("*.json")] == ["9100001.json"]
    assert not list(out.glob("orca-123-*"))


def test_cli_other_exception_leaves_no_partial_files(demo_lake, tmp_path, monkeypatch, capsys):
    real = wb.build_workbook

    def boom(fi, path):
        if fi.fund_id == 9100001:
            path.write_bytes(b"half a workbook")  # what a build killed half way leaves
            raise RuntimeError("secret detail 037833100")
        return real(fi, path)

    monkeypatch.setattr(wb, "build_workbook", boom)
    out = tmp_path / "out"
    assert main(["workbook", "--fund", "9100001", "--fund", "9100005", "--out", str(out)]) == 1
    printed = capsys.readouterr().out
    assert "fund 9100001: failed: RuntimeError" in printed
    assert "secret detail" not in printed and "037833100" not in printed
    assert sorted(p.name for p in out.rglob("*") if p.is_file() and "9100001" in p.name) == []
    assert [p.name for p in out.glob("orca-9100005-*.xlsx")] != []
    assert [p.name for p in (out / "inputs").glob("*.json")] == ["9100005.json"]
    assert not list(out.glob("*.part"))
