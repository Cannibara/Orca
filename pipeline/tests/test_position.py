import pytest

from orca.engine.position import PositionResult, compute_position
from orca.quarter_px import QuarterPx

NO_MONTHS = (None, None, None)


def qpx(vwap, close, div_ps=0.0, low=None, high=None) -> QuarterPx:
    return QuarterPx(
        vwap=vwap, low=low, high=high, close=close, div_ps=div_ps, monthly_vwap=NO_MONTHS
    )


# shares: q10 100, q11 150, q12 60, q13 0
SHARES = {10: 100, 11: 150, 12: 60, 13: 0}
PX = {
    10: qpx(vwap=10, close=12, low=9, high=13),
    11: qpx(vwap=14, close=15, div_ps=0.5),
    12: qpx(vwap=16, close=13, div_ps=0.5),
    13: qpx(vwap=20, close=21),
}


def assert_quarters_bridge(r: PositionResult) -> None:
    """Each quarter's value is the previous value plus market move, net buying and trade gain."""
    previous_value = 0.0
    for pq in r.quarters:
        expected = previous_value + pq.market_move + pq.net_buying + pq.trade_gain
        assert pq.value == pytest.approx(expected)
        previous_value = pq.value


def test_average_cost_example():
    r = compute_position(1, SHARES, PX, segment_start_q=9, last_q=13, implied_px={})
    assert [t.type for t in r.trades] == ["new", "add", "trim", "exit"]
    assert r.invested == 1700 and r.realised == pytest.approx(940)
    assert r.avg_cost == pytest.approx(1700 / 150) and r.avg_exit == pytest.approx(17.6)
    assert r.dividends == 125 and r.cost_now == 0 and r.to_q == 13
    assert sum(pq.market_move + pq.trade_gain for pq in r.quarters) == pytest.approx(940)


def test_average_cost_example_quarter_by_quarter():
    r = compute_position(1, SHARES, PX, segment_start_q=9, last_q=13, implied_px={})
    assert (r.stock_id, r.from_q, r.to_q) == (1, 10, 13)
    assert [pq.q for pq in r.quarters] == [10, 11, 12, 13]
    assert [pq.shares for pq in r.quarters] == [100, 150, 60, 0]
    assert [pq.delta for pq in r.quarters] == [100, 50, -90, -60]
    assert [pq.trade_px for pq in r.quarters] == [10, 14, 16, 20]
    assert [pq.net_buying for pq in r.quarters] == pytest.approx([1000, 700, -1440, -1200])
    assert [pq.value for pq in r.quarters] == pytest.approx([1200, 2250, 780, 0])
    assert [pq.cost for pq in r.quarters] == pytest.approx([1000, 1700, 680, 0])
    assert [pq.realised for pq in r.quarters] == pytest.approx([0, 0, 420, 520])
    assert [pq.market_move for pq in r.quarters] == pytest.approx([0, 300, -300, 480])
    assert [pq.trade_gain for pq in r.quarters] == pytest.approx([200, 50, 270, -60])
    assert [pq.dividends for pq in r.quarters] == [0, 50, 75, 0]
    assert_quarters_bridge(r)


def test_trades_carry_signed_delta_range_and_shares_after():
    r = compute_position(1, SHARES, PX, segment_start_q=9, last_q=13, implied_px={})
    new, add, trim, exit_ = r.trades
    assert (new.q, new.delta, new.px, new.low, new.high, new.shares_after) == (
        10,
        100,
        10,
        9,
        13,
        100,
    )
    assert (add.delta, add.px, add.low, add.high, add.shares_after) == (50, 14, None, None, 150)
    assert (trim.delta, trim.shares_after) == (-90, 60)
    assert (exit_.q, exit_.delta, exit_.px, exit_.shares_after) == (13, -60, 20, 0)
    assert (r.sold_shares, r.sold_usd) == (150, 2640)


def test_first_report_bought_at_close():
    # the segment starts at q10: the holding is taken as bought at that quarter's close (12)
    r = compute_position(1, SHARES, PX, segment_start_q=10, last_q=13, implied_px={})
    first = r.trades[0]
    assert (first.type, first.q, first.delta, first.px) == ("new", 10, 100, 12)
    q10 = r.quarters[0]
    assert q10.net_buying == 1200 and q10.trade_gain == 0 and q10.market_move == 0
    assert r.invested == 1200 + 700
    assert_quarters_bridge(r)


def test_shares_before_the_segment_are_ignored():
    shares = {8: 500, 9: 500, **SHARES}
    r = compute_position(1, shares, PX, segment_start_q=10, last_q=13, implied_px={})
    assert r.trades[0].delta == 100 and r.from_q == 10


def test_still_held_has_no_exit_quarter():
    r = compute_position(1, SHARES, PX, segment_start_q=9, last_q=12, implied_px={})
    assert r.to_q is None and r.shares_now == 60
    assert r.cost_now == pytest.approx(680)
    assert r.avg_exit == pytest.approx(16) and r.sold_shares == 90 and r.sold_usd == 1440
    assert [t.type for t in r.trades] == ["new", "add", "trim"]


def test_no_sells_means_no_average_exit():
    r = compute_position(1, {10: 100, 11: 100}, PX, segment_start_q=9, last_q=11, implied_px={})
    assert r.avg_exit is None and r.sold_shares == 0 and r.sold_usd == 0
    assert r.avg_cost == pytest.approx(10)
    assert [t.type for t in r.trades] == ["new"] and r.to_q is None


def test_missing_quarter_means_zero_shares():
    r = compute_position(1, {10: 100}, PX, segment_start_q=9, last_q=12, implied_px={})
    assert [t.type for t in r.trades] == ["new", "exit"]
    assert r.to_q == 11 and [pq.q for pq in r.quarters] == [10, 11]


def test_reentry_restarts_the_cost_basis():
    px = {10: qpx(10, 10), 11: qpx(20, 20), 12: qpx(30, 30), 13: qpx(40, 40)}
    shares = {10: 100, 12: 50, 13: 50}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=13, implied_px={})
    assert [t.type for t in r.trades] == ["new", "exit", "new"]
    assert r.to_q is None and r.shares_now == 50
    assert r.cost_now == pytest.approx(1500)  # the second stint costs 50 x 30, not a blend
    assert r.invested == 1000 + 1500 and r.realised == pytest.approx(1000)
    assert r.avg_cost == pytest.approx(2500 / 150)
    assert [pq.q for pq in r.quarters] == [10, 11, 12, 13]
    assert_quarters_bridge(r)


def test_flat_quarters_between_stints_are_left_out():
    px = {q: qpx(10, 10) for q in range(10, 16)}
    shares = {10: 100, 14: 100}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=15, implied_px={})
    assert [pq.q for pq in r.quarters] == [10, 11, 14, 15]


def test_trade_price_falls_back_to_last_close_when_the_stock_stopped_trading():
    # acquired after q11: no prices in q12, so the exit is at the q11 close
    px = {10: qpx(10, 12), 11: qpx(14, 15)}
    shares = {10: 100, 11: 100}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=12, implied_px={})
    exit_ = r.trades[-1]
    assert (exit_.type, exit_.q, exit_.px, exit_.low, exit_.high) == ("exit", 12, 15, None, None)
    q12 = r.quarters[-1]
    assert q12.market_move == 0 and q12.trade_gain == 0 and q12.value == 0
    assert q12.net_buying == -1500 and r.to_q == 12
    assert_quarters_bridge(r)


def test_trade_price_falls_back_to_last_close_when_vwap_is_missing():
    px = {10: qpx(10, 12), 11: qpx(None, 15)}
    shares = {10: 100, 11: 150}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=11, implied_px={})
    assert r.trades[1].px == 12  # last close before q11


def test_implied_price_prices_a_stock_without_market_data():
    shares = {10: 100, 11: 100, 12: 150}
    implied = {10: 8.0, 11: 9.0, 12: 11.0}
    r = compute_position(1, shares, {}, segment_start_q=9, last_q=12, implied_px=implied)
    assert [t.px for t in r.trades] == [8.0, 11.0]
    assert [pq.value for pq in r.quarters] == pytest.approx([800, 900, 1650])
    assert [pq.market_move for pq in r.quarters] == pytest.approx([0, 100, 200])
    assert_quarters_bridge(r)


def test_market_move_uses_the_valuation_close_of_the_previous_quarter():
    # q10 is valued at the implied price (8), q11 at the real close (12): the move is 100 x 4
    px = {11: qpx(vwap=11, close=12)}
    shares = {10: 100, 11: 100}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=11, implied_px={10: 8.0})
    q10, q11 = r.quarters
    assert q10.value == pytest.approx(800)
    assert q11.market_move == pytest.approx(400) and q11.value == pytest.approx(1200)
    assert_quarters_bridge(r)


def test_never_priced_is_none():
    assert compute_position(1, SHARES, {}, segment_start_q=9, last_q=13, implied_px={}) is None


def test_quarter_without_a_close_is_not_a_price():
    px = {10: qpx(vwap=10, close=None)}
    assert compute_position(1, {10: 100}, px, segment_start_q=9, last_q=10, implied_px={}) is None


def test_no_shares_is_none():
    assert compute_position(1, {}, PX, segment_start_q=9, last_q=13, implied_px={}) is None


def test_unpriced_quarters_before_the_first_price_stay_out_of_the_book():
    # held from q10 but priced only from q12: the position enters the book at q12 at its close
    px = {12: qpx(vwap=16, close=13), 13: qpx(vwap=20, close=21)}
    shares = {10: 100, 11: 100, 12: 100, 13: 100}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=13, implied_px={})
    assert r.from_q == 12 and [pq.q for pq in r.quarters] == [12, 13]
    assert [t.type for t in r.trades] == ["new"]
    assert r.trades[0].px == 13 and r.quarters[0].trade_gain == 0
    assert r.quarters[1].market_move == 800
    assert_quarters_bridge(r)


def test_an_unpriced_quarter_after_pricing_keeps_the_last_valuation():
    # implied prices only; q11 has none, so the position stays at the q10 value
    shares = {10: 100, 11: 100, 12: 100}
    r = compute_position(
        1, shares, {}, segment_start_q=9, last_q=12, implied_px={10: 8.0, 12: 10.0}
    )
    assert [t.type for t in r.trades] == ["new"]
    assert [pq.value for pq in r.quarters] == pytest.approx([800, 800, 1000])
    assert_quarters_bridge(r)


def test_dividends_use_the_shares_held_at_the_start_of_the_quarter():
    px = {10: qpx(10, 10, div_ps=1.0), 11: qpx(10, 10, div_ps=2.0)}
    r = compute_position(1, {10: 100, 11: 300}, px, segment_start_q=9, last_q=11, implied_px={})
    assert [pq.dividends for pq in r.quarters] == [0, 200]
    assert r.dividends == 200


def test_exit_leaves_exactly_zero_cost_despite_rounding():
    # 70 x 89.29, then 30 sold at the average cost, leaves a basis that does not divide evenly
    px = {10: qpx(89.29, 90), 11: qpx(95, 95), 12: qpx(97, 97)}
    shares = {10: 70, 11: 40, 12: 0}
    r = compute_position(1, shares, px, segment_start_q=9, last_q=12, implied_px={})
    assert [t.type for t in r.trades] == ["new", "trim", "exit"]
    assert r.cost_now == 0 and r.quarters[-1].cost == 0
