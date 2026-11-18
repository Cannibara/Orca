"""Classifying the ETFs funds held (`orca/hierarchy/tools/etf_batches.py`)."""

import importlib.util
from pathlib import Path

from orca.hierarchy import Node

_PATH = Path(__file__).parents[1] / "orca" / "hierarchy" / "tools" / "etf_batches.py"
_spec = importlib.util.spec_from_file_location("etf_batches", _PATH)
etf_batches = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(etf_batches)

MEMORY = Node("Technology", "Semiconductors", "Memory")
OIL = Node("Energy", "Oil", "Production")
NODES = {1: MEMORY, 2: OIL}


def etf_row(sid, kind="etf"):
    return {"stock_id": sid, "ticker": f"E{sid}", "name": f"ETF {sid}", "kind": kind, "invested": 1_000_000}


def fold(answers, rows=None):
    return etf_batches.fold_etfs(rows or [etf_row(1)], {a["id"]: a for a in answers}, NODES)


def test_a_sector_etf_is_labelled_at_the_level_the_model_names():
    for level, path in (("sector", "Technology"), ("industry", "Technology > Semiconductors"), ("vertical", MEMORY.path)):
        rows, problems = fold([{"id": 1, "k": "sector", "lv": level, "v": 1, "c": 3}])
        assert not problems and rows[0]["etf"]["path"] == path and rows[0]["etf"]["lv"] == level


def test_other_classes_carry_no_path_and_leverage_is_kept():
    rows, problems = fold([{"id": 1, "k": "bond", "c": 3, "v": 2, "lv": "sector"}])
    assert not problems and rows[0]["etf"] == {"k": "bond", "label": "bonds", "c": 3, "note": ""}  # a stray node on a bond fund is ignored
    rows, _ = fold([{"id": 1, "k": "sector", "lv": "industry", "v": 1, "c": 3, "lev": "3x", "n": "3x semis"}])
    assert (rows[0]["etf"]["lev"], rows[0]["etf"]["note"]) == ("3x", "3x semis")


def test_bad_answers_are_reported_and_leave_the_row_alone():
    rows, problems = fold([{"id": 1, "k": "banana", "c": 3}])
    assert "etf" not in rows[0] and "class 'banana'" in problems[0]
    rows, problems = fold([{"id": 1, "k": "sector", "c": 3}])
    assert "etf" not in rows[0] and "without a level" in problems[0]
    rows, problems = fold([{"id": 1, "k": "sector", "lv": "vertical", "v": 99, "c": 3}])
    assert "etf" not in rows[0] and problems


def test_only_etf_rows_with_an_answer_change():
    rows = [etf_row(1), etf_row(2), etf_row(3, kind="stock")]
    out, problems = etf_batches.fold_etfs(rows, {1: {"id": 1, "k": "broad", "c": 3}, 3: {"id": 3, "k": "broad", "c": 3}}, NODES)
    assert not problems and "etf" in out[0] and "etf" not in out[1] and "etf" not in out[2]


def test_read_answers_checks_ids_and_order(tmp_path):
    (tmp_path / "etf_in_01.txt").write_text("1|SPY|SPDR|5\n2|GLD|GOLD|4\n")
    (tmp_path / "etf_out_01.jsonl").write_text('{"id":1,"k":"broad","c":3}\n{"id":2,"k":"commodity","c":3}\n')
    answers, problems = etf_batches.read_answers(tmp_path)
    assert sorted(answers) == [1, 2] and not problems
    (tmp_path / "etf_out_01.jsonl").write_text('{"id":2,"k":"commodity","c":3}\n')
    _, problems = etf_batches.read_answers(tmp_path)
    assert problems and "1 answers for 2" in problems[0]
