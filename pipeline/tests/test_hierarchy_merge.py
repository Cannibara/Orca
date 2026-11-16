"""Folding a model's batch answers into the labelled stocks (`orca/hierarchy/tools/merge_batches.py`)."""

import importlib.util
from pathlib import Path

from orca.hierarchy import Node

_PATH = Path(__file__).parents[1] / "orca" / "hierarchy" / "tools" / "merge_batches.py"
_spec = importlib.util.spec_from_file_location("merge_batches", _PATH)
merge_batches = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(merge_batches)

MEMORY = Node("Technology", "Semiconductors", "Memory")
OTHER = Node("Technology", "Semiconductors", "Other Semiconductors")
OIL = Node("Energy", "Oil", "Production")
NODES = {1: MEMORY, 2: OTHER, 3: OIL}


def row(sid, tier, kind="stock", **extra):
    return {"stock_id": sid, "ticker": f"T{sid}", "name": f"NAME {sid}", "kind": kind, "tier": tier, **extra}


def labelled(main=MEMORY, how="default", extras=()):
    return {"main": main.path, "extras": [e.path for e in extras], "how": how}


def fold(rows, answers):
    return merge_batches.fold(rows, answers, NODES, {r["stock_id"]: 1_000_000 for r in rows})


def test_an_etf_keeps_no_label_and_needs_no_answer():
    final, _, problems = fold([row(1, "etf", kind="etf")], {})
    assert final[0]["main"] is None and final[0]["kind"] == "etf" and not problems


def test_an_auto_stock_keeps_its_label_and_the_blind_audit_only_measures_agreement():
    rows = [row(1, "auto", **labelled(MEMORY, "default")), row(2, "auto", **labelled(OIL, "placed"))]
    answers = {1: {"id": 1, "k": "stock", "v": 2, "c": 3}, 2: {"id": 2, "k": "stock", "v": 3, "c": 3}}
    final, agree, problems = fold(rows, answers)
    assert [r["main"] for r in final] == [MEMORY.path, OIL.path] and not problems  # never replaced
    assert all(r["src"] == "hierarchy" for r in final)
    assert dict(agree["default"]) == {"n": 1, "vertical": 0, "industry": 1, "sector": 1}  # same industry, other vertical
    assert dict(agree["placed"]) == {"n": 1, "vertical": 1, "industry": 1, "sector": 1}


def test_a_verified_match_keeps_the_hierarchy_label_and_a_rejected_one_takes_the_models():
    rows = [row(1, "verify", **labelled(MEMORY, "default")), row(2, "verify", **labelled(MEMORY, "default"))]
    answers = {1: {"id": 1, "k": "stock", "v": 3, "c": 3, "m": 1}, 2: {"id": 2, "k": "stock", "v": 3, "c": 3, "m": 0}}
    final, _, problems = fold(rows, answers)
    assert not problems
    assert (final[0]["main"], final[0]["src"], final[0]["checked"]) == (MEMORY.path, "hierarchy", True)
    assert (final[1]["main"], final[1]["src"], final[1]["how"]) == (OIL.path, "model", "model")


def test_a_stock_with_no_match_takes_the_models_label_and_extras():
    final, _, problems = fold([row(1, "none")], {1: {"id": 1, "k": "stock", "v": 3, "c": 2, "x": [1, 99], "n": "oil name"}})
    assert not problems
    assert final[0]["main"] == OIL.path and final[0]["extras"] == [MEMORY.path]  # an unknown id is ignored
    assert (final[0]["conf"], final[0]["note"]) == (2, "oil name")


def test_other_kinds_and_unknown_businesses_stay_unlabelled():
    rows = [row(1, "none"), row(2, "none"), row(3, "none")]
    answers = {
        1: {"id": 1, "k": "spac", "v": 0, "c": 3},
        2: {"id": 2, "k": "stock", "v": 0, "c": 0},
        3: {"id": 3, "k": "bond", "v": 0, "c": 3},
    }
    final, _, problems = fold(rows, answers)
    assert not problems
    assert [(r["kind"], r["main"]) for r in final] == [("spac", None), ("stock", None), ("bond", None)]
    assert final[1]["conf"] == 0  # a stock the model could not place


def test_missing_and_malformed_answers_are_reported():
    rows = [row(1, "none"), row(2, "none")]
    final, _, problems = fold(rows, {2: {"id": 2, "k": "banana", "v": 1, "c": 3}})
    assert len(problems) == 2 and "no answer for 1" in problems[0] and "kind 'banana'" in problems[1]
    assert all(r["main"] is None for r in final)


def test_read_answers_checks_ids_and_order(tmp_path):
    (tmp_path / "in_01.txt").write_text("11|A|ALPHA|5|1\n12|B|BETA|4|1\n")
    (tmp_path / "out_01.jsonl").write_text('{"id":11,"k":"stock","v":1,"c":3}\n{"id":12,"k":"stock","v":2,"c":3}\n')
    answers, problems = merge_batches.read_answers(tmp_path)
    assert sorted(answers) == [11, 12] and not problems
    (tmp_path / "out_01.jsonl").write_text('{"id":12,"k":"stock","v":2,"c":3}\nnot json\n')
    _, problems = merge_batches.read_answers(tmp_path)
    assert any("line 2" in p for p in problems) and any("out_01.jsonl: 1 answers for 2" in p for p in problems)
