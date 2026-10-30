import math
import random
from dataclasses import replace

import pytest

from orca.engine.fund import FundQuarter, aggregate_fund, check_bridge
from orca.engine.position import PositionQuarter, PositionResult, compute_position
from orca.quarter_px import QuarterPx


def qpx(vwap, close, div_ps=0.0) -> QuarterPx:
    return QuarterPx(vwap, None, None, close, div_ps, (None,) * 3)


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
    # the stock is held throughout but unpriced in q10 and q11: nothing is in the book until it is
    # priced in q12, so that quarter has no starting value and no return
    px = {12: qpx(16, 13), 13: qpx(20, 21)}
    shares = {10: 100, 11: 100, 12: 100, 13: 100}
    p = compute_position(1, shares, px, segment_start_q=10, last_q=13, implied_px={})
    quarters = aggregate_fund([p], segment_start_q=10, last_q=13)
    assert [fq.q for fq in quarters] == [10, 11, 12, 13]
    assert [(fq.start, fq.end) for fq in quarters] == [(0, 0), (0, 0), (0, 1300), (1300, 2100)]
    assert [fq.ret for fq in quarters[:3]] == [None, None, None]  # q12: bought into an empty book
    assert quarters[3].ret == pytest.approx(800 / 1300)
    assert all(fq.ret is None or math.isfinite(fq.ret) for fq in quarters)
    assert all(check_bridge(fq) for fq in quarters)


def test_no_positions_means_empty_quarters_without_returns():
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


def liquidated_book(n_positions: int) -> list:
    """Positions bought at the q10 close and all sold in q11 at the q11 VWAP: a ~$25B book that
    ends at exactly 0, built from awkward decimals so rounding does not cancel."""
    rng = random.Random(1)
    positions = []
    for stock_id in range(n_positions):
        shares = round(rng.uniform(1e4, 1e6), 3)
        close10, close11, vwap11 = (round(rng.uniform(5, 300), 4) for _ in range(3))
        px = {10: qpx(close10, close10), 11: qpx(vwap11, close11)}
        p = compute_position(
            stock_id, {10: shares}, px, segment_start_q=10, last_q=11, implied_px={}
        )
        positions.append(p)
    return positions


def test_bridge_holds_when_a_large_book_is_fully_liquidated():
    fq = aggregate_fund(liquidated_book(300), segment_start_q=10, last_q=11)[1]
    assert fq.start > 2e9 and fq.end == 0 and fq.sells > 2e9
    # rounding alone exceeds an absolute 1e-6, so the tolerance must scale with the book
    gap = fq.end - (fq.start + fq.market_move + fq.net_buying + fq.trade_gains)
    assert abs(gap) > 1e-6
    assert check_bridge(fq)


def test_bridge_still_fails_when_a_large_book_is_off():
    fq = aggregate_fund(liquidated_book(300), segment_start_q=10, last_q=11)[1]
    assert not check_bridge(replace(fq, trade_gains=fq.trade_gains + 0.001 * fq.start))
    assert not check_bridge(replace(fq, market_move=fq.market_move - 1e6))


def test_check_bridge_scales_with_start_and_with_traded_amount():
    sold_off = {"start": 3e9, "end": 0, "net_buying": -3e9, "buys": 0, "sells": 3e9}
    assert check_bridge(fund_quarter(**sold_off, trade_gains=1e-3))
    assert not check_bridge(fund_quarter(**sold_off, trade_gains=1e4))
    churn = {"start": 0, "end": 0, "net_buying": 0, "buys": 3e9, "sells": 3e9}
    assert check_bridge(fund_quarter(**churn, trade_gains=1e-3))
    assert not check_bridge(fund_quarter(**churn, trade_gains=1e4))


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
    assert [fq.ret for fq in quarters][:2] == [None, None]  # start value 0 in q9 and q10
    assert quarters[2].ret == pytest.approx((2250 - 1200 - 700 + 50) / (1200 + 350))
    assert quarters[4].ret == pytest.approx((0 - 780 + 1200) / (780 - 600))
    assert sum(fq.market_move + fq.trade_gains for fq in quarters) == pytest.approx(940)
    assert sum(fq.dividends for fq in quarters) == 125
