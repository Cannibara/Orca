import json
from datetime import date

import pytest

from orca.engine.metrics import Performance
from orca.engine.position import Trade
from orca.home import (
    FundSnapshot,
    calls,
    conviction_moves,
    crowded_buys,
    is_excluded_name,
    just_filed,
    top_funds,
    wins_losses,
)

FILED = date(2026, 8, 14)
LATEST_Q = 50


def perf(ann_return=0.10, max_dd=-0.20, sharpe=0.8) -> Performance:
    return Performance(
        ann_return=ann_return,
        sharpe=sharpe,
        sortino=1.0,
        vol=0.15,
        max_dd=max_dd,
        calmar=0.5,
        quarters_pos_pct=0.6,
    )


def trade(kind="new", delta=100.0, px=10.0, q=LATEST_Q) -> Trade:
    return Trade(q=q, type=kind, delta=delta, px=px, low=None, high=None, shares_after=0.0)


def spread(n: int, top: float = 0.5) -> dict[int, float]:
    """n positions, ids 1000..: the first ten share `top` of the book, the rest the remainder."""
    return {1000 + i: top / 10 if i < 10 else (1 - top) / max(n - 10, 1) for i in range(n)}


def snap(fund_id=1, name="ALPHA CAPITAL", **kw) -> FundSnapshot:
    fields = dict(
        fund_id=fund_id,
        name=name,
        book=2e9,
        n_priced=30,
        priced_pct=0.95,
        quarters_filed=20,
        excluded=False,
        weights_now=spread(30),
        weights_prev={},
        trades_latest=[],
        pnl_latest={},
        buys_recent=[],
        perf={"1y": perf(), "3y": perf(), "5y": perf(), "max": perf()},
        filed=FILED,
        period_q=LATEST_Q,
    )
    fields.update(kw)
    return FundSnapshot(**fields)


def ids(rows) -> list[int]:
    return [r["fund_id"] for r in rows]


# --- exclusion ---------------------------------------------------------------------------


def test_is_excluded_name_is_case_insensitive_substring():
    assert is_excluded_name("First Bank of Ohio")
    assert is_excluded_name("STATE RETIREMENT SYSTEM")
    assert is_excluded_name("Acme Securities LLC")
    assert not is_excluded_name("Alpha Capital")


# --- top funds ---------------------------------------------------------------------------


def test_top_funds_rules():
    good = snap(1, "GOOD CAPITAL")
    small = snap(2, "SMALL CAPITAL", book=9e8)
    young = snap(3, "YOUNG CAPITAL", quarters_filed=11)
    few = snap(4, "FEW CAPITAL", n_priced=3, weights_now=spread(3))
    unpriced = snap(5, "UNPRICED CAPITAL", priced_pct=0.79)
    bank = snap(6, "FIRST BANK")
    giant = snap(7, "INDEX GIANT", n_priced=1000, weights_now=spread(1000, top=0.1))
    out = top_funds([good, small, young, few, unpriced, bank, giant], "3y")
    assert ids(out["eligible"]) == [1]
    assert ids(out["giants"]) == [7]


def test_top_funds_thresholds_are_inclusive():
    edge = snap(1, book=1e9, quarters_filed=12, n_priced=4, priced_pct=0.80, weights_now=spread(4))
    giant = snap(2, n_priced=1000)
    out = top_funds([edge, giant], "max")
    assert ids(out["eligible"]) == [1]
    assert ids(out["giants"]) == [2]


def test_top_funds_skips_flagged_funds_and_missing_period_perf():
    flagged = snap(1, "FLAGGED", excluded=True)
    no_3y = snap(2, "NO3Y", perf={"1y": perf(ann_return=0.3), "3y": None})
    no_key = snap(3, "NOKEY", perf={})
    ok = snap(4, "OK", perf={"1y": perf(ann_return=0.1), "3y": perf()})
    assert ids(top_funds([flagged, no_3y, no_key, ok], "3y")["eligible"]) == [4]
    assert ids(top_funds([flagged, no_3y, no_key, ok], "1y")["eligible"]) == [2, 4]


def test_top_funds_rows_sorted_by_return_and_json_ready():
    a = snap(1, "A", perf={"3y": perf(ann_return=0.05)})
    b = snap(2, "B", perf={"3y": perf(ann_return=0.20, max_dd=-0.1, sharpe=None)})
    g1 = snap(3, "G1", n_priced=1500, perf={"3y": perf(ann_return=0.01)})
    g2 = snap(4, "G2", n_priced=1500, perf={"3y": perf(ann_return=0.09)})
    out = top_funds([a, b, g1, g2], "3y")
    assert ids(out["eligible"]) == [2, 1]
    assert ids(out["giants"]) == [4, 3]
    assert out["eligible"][0] == {
        "fund_id": 2,
        "name": "B",
        "book": 2e9,
        "n_positions": 30,
        "ann_return": 0.20,
        "max_dd": -0.1,
        "sharpe": None,
    }
    json.dumps(out)


def test_top_funds_lists_a_missing_return_last():
    a = snap(1, "A", perf={"max": perf(ann_return=None)})
    b = snap(2, "B", perf={"max": perf(ann_return=-0.30)})
    out = top_funds([a, b], "max")
    assert ids(out["eligible"]) == [2, 1]
    assert out["eligible"][1]["ann_return"] is None


def test_top_funds_rejects_an_unknown_period():
    with pytest.raises(ValueError):
        top_funds([snap(1)], "2y")


# --- wins and losses ---------------------------------------------------------------------


def test_wins_losses_ranks_pnl_of_top_fund_eligible_funds():
    a = snap(1, "A", pnl_latest={11: 500.0, 12: -300.0, 13: 0.0, 14: 100.0})
    giant = snap(2, "GIANT", n_priced=1200, pnl_latest={21: 900.0, 22: -900.0})
    no_perf = snap(3, "NOPERF", perf={}, pnl_latest={31: 700.0, 32: -50.0})
    small = snap(4, "SMALL", book=9e8, pnl_latest={41: 10_000.0, 42: -10_000.0})
    bank = snap(5, "FIRST BANK", pnl_latest={51: 10_000.0})
    out = wins_losses([a, giant, no_perf, small, bank])
    assert [(r["fund_id"], r["stock_id"], r["pnl"]) for r in out["wins"]] == [
        (2, 21, 900.0),
        (3, 31, 700.0),
        (1, 11, 500.0),
        (1, 14, 100.0),
    ]
    assert [(r["fund_id"], r["stock_id"], r["pnl"]) for r in out["losses"]] == [
        (2, 22, -900.0),
        (1, 12, -300.0),
        (3, 32, -50.0),
    ]
    assert out["wins"][0]["name"] == "GIANT"
    json.dumps(out)


def test_wins_losses_keeps_only_top_n():
    pnl = {i: float(i) for i in range(1, 6)} | {10 + i: -float(i) for i in range(1, 6)}
    out = wins_losses([snap(1, pnl_latest=pnl)], n=2)
    assert [r["stock_id"] for r in out["wins"]] == [5, 4]
    assert [r["stock_id"] for r in out["losses"]] == [15, 14]


# --- concentrated funds and conviction moves ----------------------------------------------


def conviction_fund(fund_id=10, **kw) -> FundSnapshot:
    """A concentrated fund: 20 positions, top ten at 50%, $1B book. `weights_now` of the
    stocks under test are added to its spread."""
    now = spread(20) | kw.pop("now", {})
    return snap(fund_id, "CONVICTION FUND", n_priced=20, book=1e9, weights_now=now, **kw)


def test_conviction_rules():
    fund = conviction_fund(
        now={1: 0.05, 2: 0.065, 3: 0.035, 6: 0.07},
        weights_prev={2: 0.04, 3: 0.01, 4: 0.05, 5: 0.04, 6: 0.10},
        trades_latest=[
            (1, trade("new", 100, 10.0)),  # new at 5%: counts
            (2, trade("add", 50, 20.0)),  # 4% -> 6.5%: counts
            (3, trade("add", 50, 30.0)),  # 1% -> 3.5%: +2.5 points, below 5%: no
            (4, trade("exit", -100, 40.0)),  # exit of a 5% position: counts
            (5, trade("exit", -100, 50.0)),  # exit of a 4% position: no
            (6, trade("trim", -10, 60.0)),  # trims never count
        ],
    )
    rows = conviction_moves([fund])
    assert [(r["stock_id"], r["move"]) for r in rows] == [(1, "new"), (4, "exit"), (2, "add")]
    by_stock = {r["stock_id"]: r for r in rows}
    assert by_stock[1]["weight_now"] == 0.05
    assert by_stock[1]["change_pts"] == pytest.approx(5.0)
    assert by_stock[1]["est_price"] == 10.0
    assert by_stock[2]["change_pts"] == pytest.approx(2.5)
    assert by_stock[4]["weight_now"] == 0.0
    assert by_stock[4]["change_pts"] == pytest.approx(-5.0)
    assert by_stock[4]["est_price"] == 40.0
    assert by_stock[4]["q"] == LATEST_Q
    assert by_stock[4]["fund_id"] == 10 and by_stock[4]["name"] == "CONVICTION FUND"
    json.dumps(rows)


def test_conviction_counts_a_three_point_jump_below_five_percent():
    fund = conviction_fund(
        now={1: 0.046},
        weights_prev={1: 0.015},
        trades_latest=[(1, trade("add", 10, 5.0))],
    )
    assert [r["stock_id"] for r in conviction_moves([fund])] == [1]


def test_conviction_only_from_concentrated_funds():
    trades = [(1, trade("new", 100, 10.0))]
    now = {1: 0.06}
    sixty_one = snap(1, n_priced=61, book=1e9, weights_now=spread(61) | now, trades_latest=trades)
    sixty = snap(2, n_priced=60, book=1e9, weights_now=spread(60) | now, trades_latest=trades)
    three = snap(3, n_priced=3, book=1e9, weights_now=spread(3) | now, trades_latest=trades)
    four_now = {7: 0.5, 8: 0.2, 9: 0.2} | now
    four = snap(4, n_priced=4, book=1e9, weights_now=four_now, trades_latest=trades)
    diffuse_now = spread(30, top=0.4) | now
    diffuse = snap(5, n_priced=30, book=1e9, weights_now=diffuse_now, trades_latest=trades)
    small = snap(6, n_priced=20, book=4e8, weights_now=spread(20) | now, trades_latest=trades)
    kw = dict(n_priced=20, book=1e9, weights_now=spread(20) | now, trades_latest=trades)
    bank = snap(7, "FIRST BANK", **kw)
    flagged = snap(8, excluded=True, **kw)
    snaps = [sixty_one, sixty, three, four, diffuse, small, bank, flagged]
    assert ids(conviction_moves(snaps)) == [2, 4]


def test_conviction_sorted_by_absolute_change():
    fund = conviction_fund(
        now={1: 0.06, 2: 0.09},
        weights_prev={1: 0.05, 3: 0.07},
        trades_latest=[
            (1, trade("add", 10, 1.0)),
            (2, trade("new", 10, 2.0)),
            (3, trade("exit", -10, 3.0)),
        ],
    )
    assert [r["stock_id"] for r in conviction_moves([fund])] == [2, 3, 1]


# --- crowded buys ------------------------------------------------------------------------


def test_crowded_needs_three_funds():
    def buyer(fund_id, weight, delta, px, kind="add", **kw):
        return conviction_fund(
            fund_id,
            now={7: weight},
            trades_latest=[(7, trade(kind, delta, px))],
            **kw,
        )

    a = buyer(1, 0.04, 100, 10.0)
    b = buyer(2, 0.06, 200, 20.0, kind="new")
    outsider = snap(
        3,
        n_priced=100,
        weights_now=spread(100, top=0.3) | {7: 0.02},
        trades_latest=[(7, trade("add", 999, 99.0))],
    )
    assert crowded_buys([a, b, outsider]) == []  # two concentrated buyers are not enough
    c = buyer(4, 0.05, 300, 30.0)
    seller = conviction_fund(5, now={7: 0.01}, trades_latest=[(7, trade("trim", -500, 40.0))])
    rows = crowded_buys([a, b, c, outsider, seller])
    assert rows == [
        {
            "stock_id": 7,
            "funds_buying": 3,
            "total_bought": pytest.approx(100 * 10.0 + 200 * 20.0 + 300 * 30.0),
            "avg_weight_after": pytest.approx(0.05),
        }
    ]
    json.dumps(rows)


def test_crowded_sorted_by_funds_then_dollars():
    def buyers(stock_id, n, px):
        return [
            conviction_fund(
                100 * stock_id + i,
                now={stock_id: 0.03},
                trades_latest=[(stock_id, trade("add", 10, px))],
            )
            for i in range(n)
        ]

    snaps = buyers(1, 3, 100.0) + buyers(2, 4, 1.0) + buyers(3, 3, 200.0)
    assert [(r["stock_id"], r["funds_buying"]) for r in crowded_buys(snaps)] == [
        (2, 4),
        (3, 3),
        (1, 3),
    ]


# --- calls -------------------------------------------------------------------------------


def make_calls_inputs():
    big = 1e9
    mcap = {1: big, 2: 2.99e8, 3: big, 4: big, 5: big, 7: big, 8: big, 9: big}  # 6 has none
    latest_px = {1: 15.0, 2: 15.0, 3: 0.90, 4: 15.0, 6: 15.0, 7: 30.0, 8: 15.0, 9: 5.0}  # 5 none
    buys = [
        (1, LATEST_Q, 10.0, 0.020, FILED),  # passes: +50%
        (2, LATEST_Q, 10.0, 0.020, FILED),  # market cap $299M
        (3, LATEST_Q, 1.0, 0.020, FILED),  # price $0.90
        (4, LATEST_Q, 10.0, 0.009, FILED),  # bought 0.9% of the book
        (5, LATEST_Q, 10.0, 0.020, FILED),  # no price
        (6, LATEST_Q, 10.0, 0.020, FILED),  # no market cap
        (7, LATEST_Q - 3, 10.0, 0.020, date(2025, 8, 14)),  # +200%, a year back
        (8, LATEST_Q - 4, 10.0, 0.020, date(2025, 5, 14)),  # older than the year window
        (9, LATEST_Q, 10.0, 0.010, FILED),  # exactly 1%: passes, -50%
    ]
    return mcap, latest_px, buys


def filed_price(stock_id, filed):
    return 100.0 + stock_id if filed == FILED else None


def test_calls_filters():
    mcap, latest_px, buys = make_calls_inputs()
    fund = snap(1, "ALPHA CAPITAL", buys_recent=buys)
    rows = calls([fund], mcap, latest_px, filed_price, "q")
    assert [r["stock_id"] for r in rows] == [1, 9]
    assert rows[0] == {
        "stock_id": 1,
        "fund_id": 1,
        "name": "ALPHA CAPITAL",
        "q": LATEST_Q,
        "est_price": 10.0,
        "price_on_filed": 101.0,
        "filed": "2026-08-14",
    }
    json.dumps(rows)


def test_calls_year_window_sorts_best_first():
    mcap, latest_px, buys = make_calls_inputs()
    fund = snap(1, buys_recent=buys)
    rows = calls([fund], mcap, latest_px, filed_price, "y")
    assert [r["stock_id"] for r in rows] == [7, 1, 9]
    assert rows[0]["q"] == LATEST_Q - 3
    assert rows[0]["price_on_filed"] is None  # the callback's answer passes through


def test_calls_fund_eligibility():
    mcap, latest_px, _ = make_calls_inputs()

    def one_buy(fund_id, **kw):
        return snap(fund_id, buys_recent=[(1, LATEST_Q, 10.0, 0.02, FILED)], **kw)

    top = one_buy(1, weights_now=spread(30, top=0.3))  # a top fund that is not concentrated
    concentrated = one_buy(2, book=6e8, n_priced=20, weights_now=spread(20), quarters_filed=3)
    neither = one_buy(3, book=6e8, n_priced=30, weights_now=spread(30, top=0.3))
    bank = one_buy(4, name="FIRST BANK")
    flagged = one_buy(5, excluded=True)
    rows = calls([top, concentrated, neither, bank, flagged], mcap, latest_px, filed_price, "q")
    assert sorted(ids(rows)) == [1, 2]


def test_calls_window_anchors_on_latest_period_across_snaps():
    mcap, latest_px, _ = make_calls_inputs()
    buys = [(1, LATEST_Q, 10.0, 0.02, FILED), (7, LATEST_Q - 1, 10.0, 0.02, FILED)]
    fund = snap(1, buys_recent=buys)
    late = snap(2, name="LATE FIRST BANK", period_q=LATEST_Q + 1)  # ineligible, but newest
    rows = calls([fund, late], mcap, latest_px, filed_price, "q")
    assert rows == []
    rows = calls([fund, late], mcap, latest_px, filed_price, "y")
    assert [r["stock_id"] for r in rows] == [7, 1]  # sorted by return since: 30/10 vs 15/10


def test_calls_empty_and_bad_window():
    assert calls([], {}, {}, filed_price, "q") == []
    with pytest.raises(ValueError):
        calls([snap(1)], {}, {}, filed_price, "m")


# --- just filed --------------------------------------------------------------------------


def test_just_filed_headline():
    moved = snap(
        1,
        "MOVED",
        weights_prev={1: 0.05, 2: 0.10},
        weights_now={2: 0.04, 3: 0.07},
        book=3e9,
        filed=date(2026, 8, 14),
        period_q=LATEST_Q,
    )
    exited = snap(
        2, "EXITED", weights_prev={5: 0.20, 6: 0.01}, weights_now={6: 0.05}, filed=date(2026, 8, 13)
    )
    empty = snap(3, "EMPTY", weights_prev={}, weights_now={}, filed=date(2026, 8, 12))
    rows = just_filed([moved, exited, empty])
    assert rows[0] == {
        "fund_id": 1,
        "name": "MOVED",
        "filed": "2026-08-14",
        "period_q": LATEST_Q,
        "book": 3e9,
        "headline_stock_id": 3,
        "headline_change_pts": pytest.approx(7.0),
    }
    assert (rows[1]["headline_stock_id"], rows[1]["headline_change_pts"]) == (
        5,
        pytest.approx(-20.0),
    )
    assert (rows[2]["headline_stock_id"], rows[2]["headline_change_pts"]) == (None, None)
    json.dumps(rows)


def test_just_filed_order_exclusions_and_limit():
    a = snap(1, "B FUND", filed=date(2026, 8, 14))
    b = snap(2, "A FUND", filed=date(2026, 8, 14))
    c = snap(3, "C FUND", filed=date(2026, 8, 15))
    d = snap(4, "OLD FUND", filed=date(2026, 7, 1))
    bank = snap(5, "FIRST BANK", filed=date(2026, 9, 1))
    flagged = snap(6, "FLAGGED", excluded=True, filed=date(2026, 9, 1))
    small = snap(7, "SMALL FUND", book=1e6, filed=date(2026, 8, 1))  # small funds still list
    assert ids(just_filed([a, b, c, d, bank, flagged, small])) == [3, 2, 1, 7, 4]
    assert ids(just_filed([a, b, c, d, bank, flagged, small], n=2)) == [3, 2]
