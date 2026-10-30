import math

import pytest

from orca.engine.fund import FundQuarter, aggregate_fund, check_bridge
from orca.engine.position import PositionQuarter, PositionResult, compute_position
from orca.quarter_px import QuarterPx


def pq(q, value, net_buying=0.0, market_move=0.0, trade_gain=0.0, dividends=0.0) -> PositionQuarter:
    """A position quarter with the given fund-level figures; the rest is filler."""
    return PositionQuarter(
        q=q,
        shares=1.0,
        delta=0.0,
        trade_px=None,
        cost=0.0,
        realised=0.0,
        market_move=market_move,
        trade_gain=trade_gain,
        dividends=dividends,
        value=value,
        net_buying=net_buying,
    )


def position(*quarters: PositionQuarter, stock_id: int = 1) -> PositionResult:
    return PositionResult(
        stock_id=stock_id,
        from_q=quarters[0].q,
        to_q=None,
        quarters=list(quarters),
        trades=[],
        invested=0.0,
        realised=0.0,
        dividends=0.0,
        shares_now=1.0,
        cost_now=0.0,
        avg_cost=1.0,
        avg_exit=None,
        sold_shares=0.0,
        sold_usd=0.0,
    )


def test_fund_return_and_bridge():
    # start 1000, end 1300, net buying 100, dividends 10, market move 150, trade gains 50
    p = position(
        pq(10, value=1000, net_buying=1000),
        pq(11, value=1300, net_buying=100, market_move=150, trade_gain=50, dividends=10),
    )
    fq = aggregate_fund([p], segment_start_q=10, last_q=11)[1]
    assert (fq.start, fq.end, fq.net_buying, fq.buys, fq.sells) == (1000, 1300, 100, 100, 0)
    assert (fq.market_move, fq.trade_gains, fq.dividends) == (150, 50, 10)
    # (1300 - 1000 - 100 + 10) / (1000 + 50)
    assert fq.ret == pytest.approx(0.2) and check_bridge(fq)


def test_first_quarter_is_all_buying_and_has_no_return():
    p = position(pq(10, value=1000, net_buying=1000), pq(11, value=1000))
    first = aggregate_fund([p], segment_start_q=10, last_q=11)[0]
    assert (first.q, first.start, first.end) == (10, 0, 1000)
    assert (first.net_buying, first.buys, first.sells) == (1000, 1000, 0)
    assert first.ret is None  # the denominator, 500, is positive; the first quarter has no return
    assert check_bridge(first)


def test_return_none_when_denominator_not_positive():
    # every position unpriced: nothing in the book in any quarter
    quarters = aggregate_fund([], segment_start_q=10, last_q=12)
    assert [fq.q for fq in quarters] == [10, 11, 12]
    for fq in quarters:
        assert (fq.start, fq.end, fq.net_buying, fq.buys, fq.sells) == (0, 0, 0, 0, 0)
        assert fq.ret is None and check_bridge(fq)


def test_return_none_after_the_book_is_sold_off():
    p = position(
        pq(10, value=100, net_buying=100),
        pq(11, value=0, net_buying=-150, market_move=50),
    )
    quarters = aggregate_fund([p], segment_start_q=10, last_q=12)
    assert quarters[1].ret == pytest.approx((0 - 100 + 150) / (100 - 75))
    assert quarters[2].start == 0 and quarters[2].ret is None  # start 0, no buying


def test_return_none_for_a_negative_denominator():
    p = position(
        pq(10, value=100, net_buying=100),
        pq(11, value=0, net_buying=-300, market_move=200),  # start 100 + half of -300 < 0
    )
    fq = aggregate_fund([p], segment_start_q=10, last_q=11)[1]
    assert fq.ret is None


def test_start_is_the_previous_quarters_end():
    a = position(pq(10, 500, net_buying=500), pq(11, 700, net_buying=100, market_move=100))
    b = position(pq(11, 300, net_buying=300), stock_id=2)
    quarters = aggregate_fund([a, b], segment_start_q=10, last_q=11)
    assert [(fq.start, fq.end) for fq in quarters] == [(0, 500), (500, 1000)]
    assert all(check_bridge(fq) for fq in quarters)


def test_buys_and_sells_split_by_sign_across_positions():
    a = position(pq(10, 1000, net_buying=1000), pq(11, 1200, net_buying=300, market_move=-100))
    b = position(
        pq(10, 1000, net_buying=1000), pq(11, 1000, net_buying=-100, market_move=100), stock_id=2
    )
    fq = aggregate_fund([a, b], segment_start_q=10, last_q=11)[1]
    assert (fq.buys, fq.sells, fq.net_buying) == (300, 100, 200)
    assert (fq.start, fq.end, fq.market_move) == (2000, 2200, 0)
    assert check_bridge(fq)


def fund_quarter(**fields) -> FundQuarter:
    zeros = {
        "start": 0,
        "end": 0,
        "net_buying": 0,
        "buys": 0,
        "sells": 0,
        "market_move": 0,
        "trade_gains": 0,
        "dividends": 0,
    }
    return FundQuarter(q=1, ret=None, **{**zeros, **fields})


def test_check_bridge_tolerance():
    def fq(end):
        return fund_quarter(
            start=1000, end=end, net_buying=100, buys=100, market_move=150, trade_gains=50
        )

    assert check_bridge(fq(1300))
    assert check_bridge(fq(1300 + 1e-6 * 1300 * 0.9))
    assert not check_bridge(fq(1300 + 1e-6 * 1300 * 1.1))
    assert not check_bridge(fq(1301))
    assert not check_bridge(fq(math.nan))


def test_check_bridge_tolerance_floor_is_one_dollar_of_value():
    assert check_bridge(fund_quarter(end=0.5e-6))
    assert not check_bridge(fund_quarter(end=2e-6))


def test_engine_position_through_the_fund():
    shares = {10: 100, 11: 150, 12: 60, 13: 0}
    px = {
        10: QuarterPx(10, None, None, 12, 0.0, (None,) * 3),
        11: QuarterPx(14, None, None, 15, 0.5, (None,) * 3),
        12: QuarterPx(16, None, None, 13, 0.5, (None,) * 3),
        13: QuarterPx(20, None, None, 21, 0.0, (None,) * 3),
    }
    p = compute_position(1, shares, px, segment_start_q=9, last_q=13, implied_px={})
    quarters = aggregate_fund([p], segment_start_q=9, last_q=13)
    assert [fq.q for fq in quarters] == [9, 10, 11, 12, 13]
    assert [fq.end for fq in quarters] == pytest.approx([0, 1200, 2250, 780, 0])
    assert [fq.start for fq in quarters] == pytest.approx([0, 0, 1200, 2250, 780])
    assert all(check_bridge(fq) for fq in quarters)
    assert [fq.ret for fq in quarters][:2] == [None, pytest.approx(200 / 500)]
    assert quarters[2].ret == pytest.approx((2250 - 1200 - 700 + 50) / (1200 + 350))
    assert quarters[4].ret == pytest.approx((0 - 780 + 1200) / (780 - 600))
    assert sum(fq.market_move + fq.trade_gains for fq in quarters) == pytest.approx(940)
    assert sum(fq.dividends for fq in quarters) == 125
