"""The stocks a set of funds ever held (`orca/hierarchy/tools/top_funds_universe.py`)."""

import importlib.util
from pathlib import Path

_PATH = Path(__file__).parents[1] / "orca" / "hierarchy" / "tools" / "top_funds_universe.py"
_spec = importlib.util.spec_from_file_location("top_funds_universe", _PATH)
universe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(universe)

SECURITIES = {"stock_id": [1, 2, 3], "ticker": ["AAA", "BBB", "CCC"], "name": ["A INC", "B INC", "C ETF"], "sector": ["Tech", "Other", "ETF/Fund"]}


def positions(stock_ids, invested, trades):
    return {"stock_id": stock_ids, "invested": invested, "trades": trades}


def test_dollars_add_up_across_funds_and_the_peak_is_the_biggest_single_position():
    fund_a = positions([1, 2], [100.0, None], [[[4, 10, 5.0, 4.0, 6.0, 10], [8, 5, 6.0, None, None, 15]], [[4, 3, None, None, None, 3]]])
    fund_b = positions([1], [50.0], [[[4, 20, 10.0, 9.0, 11.0, 20]]])
    rows = universe.build_universe([10, 20], {10: fund_a, 20: fund_b}, SECURITIES)
    assert [r["stock_id"] for r in rows] == [1, 2]  # biggest dollars first
    a, b = rows
    assert (a["invested"], a["n_funds"], a["funds"], a["peak"]) == (150, 2, [10, 20], 200)  # 10 × 20 shares beats 6 × 15
    assert (b["invested"], b["peak"], b["pub_sector"], b["name"]) == (0, 0, "Other", "B INC")  # no price, no peak


def test_a_stock_no_fund_held_is_not_listed_and_ties_break_on_the_stock_id():
    fund = positions([3, 1], [10.0, 10.0], [[], []])
    rows = universe.build_universe([7], {7: fund}, SECURITIES)
    assert [r["stock_id"] for r in rows] == [1, 3]


def test_an_excluded_fund_is_replaced_by_the_next_one_so_the_list_keeps_its_length():
    ranking = [{"fund_id": i} for i in range(1, 8)]
    assert [f["fund_id"] for f in universe.pick_funds(ranking, 3, [])] == [1, 2, 3]
    assert [f["fund_id"] for f in universe.pick_funds(ranking, 3, [2])] == [1, 3, 4]
    assert [f["fund_id"] for f in universe.pick_funds(ranking, 3, [9])] == [1, 2, 3]  # not in the ranking: nothing changes
