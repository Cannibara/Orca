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


def test_is_excluded_name_is_case_insensitive_from_the_start_of_a_word():
    assert is_excluded_name("First Bank of Ohio")
    assert is_excluded_name("STATE RETIREMENT SYSTEM")
    assert is_excluded_name("Acme Securities LLC")
    assert is_excluded_name("First Bankshares Inc")  # the word starts as listed
    assert is_excluded_name("ZIONS BANCORPORATION")
    assert is_excluded_name("Bessemer Trust Company")
    assert is_excluded_name("bank-of-ohio")
    assert not is_excluded_name("Alpha Capital")
    assert not is_excluded_name("DRIFTBANK PARTNERS")  # not a bank: BANK inside a word
    assert not is_excluded_name("CITRUST COMPANY LLC")


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


def test_wins_losses_ignores_funds_that_have_not_filed_the_latest_quarter():
    fresh = snap(1, pnl_latest={11: 100.0, 12: -100.0})
    stale = snap(2, period_q=LATEST_Q - 1, pnl_latest={21: 900.0, 22: -900.0})
    out = wins_losses([fresh, stale])
    assert [r["fund_id"] for r in out["wins"]] == [1]
    assert [r["fund_id"] for r in out["losses"]] == [1]
    assert wins_losses([]) == {"wins": [], "losses": []}


def test_wins_losses_keeps_only_top_n():
    pnl = {i: float(i) for i in range(1, 6)} | {10 + i: -float(i) for i in range(1, 6)}
    out = wins_losses([snap(1, pnl_latest=pnl)], n=2)
    assert [r["stock_id"] for r in out["wins"]] == [5, 4]
    assert [r["stock_id"] for r in out["losses"]] == [15, 14]


# --- concentrated funds and conviction moves ----------------------------------------------


def conviction_fund(fund_id=10, **kw) -> FundSnapshot:
    """A fund the conviction list looks at: $1B book now and last quarter, last quarter filed,
    20 positions of 5% each last quarter (so its largest holding was 5%), and its biggest single
    move of the previous four quarters 2% of the book. `now` adds stocks to its weights now."""
    now = spread(20) | kw.pop("now", {})
    name = kw.pop("name", "CONVICTION FUND")
    fields = dict(
        n_priced=20,
        book=1e9,
        book_prev=1e9,
        prev_filed=True,
        usual_move=0.02,
        weights_now=now,
        weights_prev=spread(20),
    )
    fields.update(kw)
    return snap(fund_id, name, **fields)


def bought(usd: float, kind="new", px=10.0, q=LATEST_Q) -> Trade:
    """A trade of `usd` dollars (negative: sold) at `px`."""
    return trade(kind, usd / px, px, q)


def test_conviction_rules():
    fund = conviction_fund(
        now={10: 0.06, 11: 0.07, 12: 0.03, 13: 0.025},
        weights_prev=spread(20) | {1: 0.08, 2: 0.04, 12: 0.08},
        trades_latest=[
            (10, bought(60e6, "new")),  # 6% of the book: 3x its usual, 75% of its top holding
            (11, bought(35e6, "add")),  # 3.5%: under twice its usual 2%
            (2, bought(-45e6, "exit", px=40.0)),  # 4.5%, 56% of its top holding
            (12, bought(-50e6, "trim", px=50.0)),  # trims count: 5%, 62.5%
            (13, bought(25e6, "new")),  # 2.5%: under the 3% floor
        ],
    )
    rows = conviction_moves([fund])
    assert [(r["stock_id"], r["move"]) for r in rows] == [(10, "new"), (12, "trim"), (2, "exit")]
    by_stock = {r["stock_id"]: r for r in rows}
    assert by_stock[10]["usd"] == pytest.approx(60e6)
    assert by_stock[10]["size"] == pytest.approx(0.06)
    assert by_stock[10]["vs_top"] == pytest.approx(0.75)
    assert by_stock[10]["vs_usual"] == pytest.approx(3.0)
    assert by_stock[10]["weight_now"] == 0.06
    assert by_stock[10]["change_pts"] == pytest.approx(6.0)
    assert by_stock[10]["est_price"] == 10.0
    assert by_stock[2]["usd"] == pytest.approx(-45e6)
    assert by_stock[2]["weight_now"] == 0.0
    assert by_stock[2]["change_pts"] == pytest.approx(-4.0)
    assert by_stock[2]["est_price"] == 40.0
    assert by_stock[2]["q"] == LATEST_Q
    assert by_stock[2]["fund_id"] == 10 and by_stock[2]["name"] == "CONVICTION FUND"
    json.dumps(rows)


def test_conviction_thresholds_are_inclusive():
    # exactly 3% of the book, exactly twice the usual 1.5%, exactly half the 6% top holding
    fund = conviction_fund(
        usual_move=0.015,
        weights_prev=spread(20) | {1: 0.06},
        trades_latest=[(10, bought(30e6))],
    )
    assert [r["stock_id"] for r in conviction_moves([fund])] == [10]


def test_conviction_quiet_fund_is_labelled_not_given_a_multiple():
    # no move of 1% or more in a year: the usual move counts as 1%, so any 3% move is unusual
    quiet = conviction_fund(usual_move=0.004, trades_latest=[(10, bought(35e6))])
    [row] = conviction_moves([quiet])
    assert row["vs_usual"] is None
    assert row["vs_top"] == pytest.approx(0.7)


def test_conviction_move_must_be_big_for_the_fund_s_largest_holding():
    # a quiet fund whose largest holding was 12%: a 3.5% move is under half of it
    fund = conviction_fund(
        usual_move=0.0,
        weights_prev=spread(20) | {1: 0.12},
        trades_latest=[(10, bought(35e6))],
    )
    assert conviction_moves([fund]) == []


def test_conviction_leaves_out_funds_whose_largest_holding_was_over_a_third():
    trades = [(10, bought(200e6))]
    at_limit = conviction_fund(1, weights_prev=spread(20) | {1: 0.33}, trades_latest=trades)
    over = conviction_fund(2, weights_prev=spread(20) | {1: 0.34}, trades_latest=trades)
    assert ids(conviction_moves([at_limit, over])) == [1]


def test_conviction_needs_a_filed_previous_quarter_and_a_history():
    trades = [(10, bought(60e6))]
    ok = conviction_fund(1, trades_latest=trades)
    carried = conviction_fund(2, prev_filed=False, trades_latest=trades)
    first = conviction_fund(3, usual_move=None, trades_latest=trades)
    no_book = conviction_fund(4, book_prev=0.0, trades_latest=trades)
    nothing_before = conviction_fund(5, weights_prev={}, trades_latest=trades)
    assert ids(conviction_moves([ok, carried, first, no_book, nothing_before])) == [1]


def test_conviction_funds_any_size_of_portfolio_from_500m_but_not_giants_or_banks():
    trades = [(10, bought(60e6))]
    wide = conviction_fund(1, n_priced=400, trades_latest=trades)
    floor = conviction_fund(2, book=5e8, trades_latest=trades)
    small = conviction_fund(3, book=4.9e8, trades_latest=trades)
    giant = conviction_fund(4, n_priced=1000, trades_latest=trades)
    bank = conviction_fund(5, name="FIRST BANK", trades_latest=trades)
    flagged = conviction_fund(6, excluded=True, trades_latest=trades)
    assert ids(conviction_moves([wide, floor, small, giant, bank, flagged])) == [1, 2]


def test_conviction_sorted_by_size_against_the_largest_holding():
    fund = conviction_fund(
        trades_latest=[(1, bought(40e6)), (2, bought(90e6)), (3, bought(-60e6, "exit"))]
    )
    assert [r["stock_id"] for r in conviction_moves([fund])] == [2, 3, 1]


def test_conviction_ignores_funds_that_have_not_filed_the_latest_quarter():
    trades = [(1, bought(60e6))]
    fresh = conviction_fund(10, now={1: 0.06}, trades_latest=trades)
    stale = conviction_fund(11, now={1: 0.06}, trades_latest=trades, period_q=LATEST_Q - 1)
    assert ids(conviction_moves([fresh, stale])) == [10]
    assert ids(conviction_moves([stale])) == [11]  # the newest of the snapshots given
    assert conviction_moves([]) == []


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


def test_crowded_ignores_funds_that_have_not_filed_the_latest_quarter():
    def buyer(fund_id, **kw):
        return conviction_fund(
            fund_id, now={7: 0.04}, trades_latest=[(7, trade("add", 10, 10.0))], **kw
        )

    fresh = [buyer(1), buyer(2)]
    stale = buyer(3, period_q=LATEST_Q - 1)
    assert crowded_buys([*fresh, stale]) == []  # two current buyers, the stale one is not current
    rows = crowded_buys([*fresh, buyer(4), stale])
    assert [(r["stock_id"], r["funds_buying"]) for r in rows] == [(7, 3)]
    assert crowded_buys([]) == []


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
    giant = one_buy(6, n_priced=1000, weights_now=spread(1000, top=0.1))  # an index giant
    almost = one_buy(7, n_priced=999, weights_now=spread(30, top=0.3))  # just under the giants
    snaps = [top, concentrated, neither, bank, flagged, giant, almost]
    rows = calls(snaps, mcap, latest_px, filed_price, "q")
    assert sorted(ids(rows)) == [1, 2, 7]


def test_calls_thresholds_are_inclusive():
    buys = [(1, LATEST_Q, 0.5, 0.01, FILED)]
    rows = calls([snap(1, buys_recent=buys)], {1: 3e8}, {1: 1.0}, filed_price, "q")
    assert [r["stock_id"] for r in rows] == [1]


def test_calls_window_anchors_on_latest_period_of_non_excluded_snaps():
    mcap, latest_px, _ = make_calls_inputs()
    buys = [(1, LATEST_Q, 10.0, 0.02, FILED), (7, LATEST_Q - 1, 10.0, 0.02, FILED)]
    fund = snap(1, buys_recent=buys)
    late = snap(2, name="LATE FUND", book=1e6, period_q=LATEST_Q + 1)  # ineligible, but newest
    rows = calls([fund, late], mcap, latest_px, filed_price, "q")
    assert rows == []
    rows = calls([fund, late], mcap, latest_px, filed_price, "y")
    assert [r["stock_id"] for r in rows] == [7, 1]  # sorted by return since: 30/10 vs 15/10


# --- the latest-quarter anchor -----------------------------------------------------------


def season_snaps():
    """Three current funds, each concentrated and top-eligible, all buying stock 7 and holding
    a win and a loss; plus the market data that lets their buys through `calls`."""
    current = [
        conviction_fund(
            fund_id,
            now={7: 0.06},
            trades_latest=[(7, bought(60e6))],
            pnl_latest={7: 100.0 * fund_id, 8: -50.0 * fund_id},
            buys_recent=[(7, LATEST_Q, 10.0, 0.06, FILED)],
        )
        for fund_id in (1, 2, 3)
    ]
    return current, {7: 1e9}, {7: 15.0}


def early_filer(**kw) -> FundSnapshot:
    """A fund that already filed a quarter that is not yet due."""
    return conviction_fund(
        9,
        now={7: 0.06},
        trades_latest=[(7, bought(60e6, q=LATEST_Q + 1))],
        pnl_latest={7: 9999.0, 8: -9999.0},
        buys_recent=[(7, LATEST_Q + 1, 10.0, 0.06, FILED)],
        period_q=LATEST_Q + 1,
        **kw,
    )


def all_lists(snaps, mcap, latest_px, **kw):
    return {
        "conviction": ids(conviction_moves(snaps, **kw)),
        "crowded": [r["funds_buying"] for r in crowded_buys(snaps, **kw)],
        "wins": ids(wins_losses(snaps, **kw)["wins"]),
        "losses": ids(wins_losses(snaps, **kw)["losses"]),
        "calls_q": ids(calls(snaps, mcap, latest_px, filed_price, "q", **kw)),
        "calls_y": ids(calls(snaps, mcap, latest_px, filed_price, "y", **kw)),
    }


INTACT = {
    "conviction": [1, 2, 3],
    "crowded": [3],
    "wins": [3, 2, 1],
    "losses": [3, 2, 1],
    "calls_q": [1, 2, 3],
    "calls_y": [1, 2, 3],
}


def test_explicit_latest_q_keeps_the_lists_when_an_early_filer_is_ahead():
    current, mcap, latest_px = season_snaps()
    snaps = [*current, early_filer()]
    assert all_lists(snaps, mcap, latest_px, latest_q=LATEST_Q) == INTACT
    # without the anchor the early filer is taken for the newest quarter and the rest go stale
    assert all_lists(snaps, mcap, latest_px)["conviction"] == [9]


def test_fallback_anchor_ignores_excluded_funds():
    current, mcap, latest_px = season_snaps()
    flagged = early_filer(excluded=True)
    bank = conviction_fund(
        10, name="FIRST BANK", period_q=LATEST_Q + 2, trades_latest=[(7, bought(60e6))]
    )
    assert all_lists([*current, flagged, bank], mcap, latest_px) == INTACT


def test_no_anchor_when_every_fund_is_excluded():
    _, mcap, latest_px = season_snaps()
    assert all_lists([early_filer(excluded=True)], mcap, latest_px) == {
        "conviction": [],
        "crowded": [],
        "wins": [],
        "losses": [],
        "calls_q": [],
        "calls_y": [],
    }


def test_calls_year_window_never_reaches_past_the_latest_quarter():
    current, mcap, latest_px = season_snaps()
    rows = calls([*current, early_filer()], mcap, latest_px, filed_price, "y", latest_q=LATEST_Q)
    assert LATEST_Q + 1 not in {r["q"] for r in rows}


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


def test_calls_keep_the_50_best_and_the_50_worst():
    buys = [(sid, LATEST_Q, 10.0, 0.02, FILED) for sid in range(1, 121)]
    latest_px = {sid: 1.0 + sid / 10 for sid in range(1, 121)}  # stock 120 moved most
    mcap = dict.fromkeys(range(1, 121), 1e9)

    rows = calls([snap(1, buys_recent=buys)], mcap, latest_px, filed_price, "q")

    assert [r["stock_id"] for r in rows] == [*range(120, 70, -1), *range(50, 0, -1)]


def test_calls_keep_every_row_up_to_100():
    buys = [(sid, LATEST_Q, 10.0, 0.02, FILED) for sid in range(1, 101)]
    latest_px = {sid: 1.0 + sid / 10 for sid in range(1, 101)}
    mcap = dict.fromkeys(range(1, 101), 1e9)

    rows = calls([snap(1, buys_recent=buys)], mcap, latest_px, filed_price, "q")

    assert len(rows) == 100
