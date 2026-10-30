import math

import polars as pl
import pytest

from orca.engine.fund import FundQuarter, fund_years
from orca.engine.metrics import hold_lengths, performance, priced_pct, turnover
from orca.engine.position import PositionResult

RETURNS = [0.10, -0.05, 0.20, 0.0]


def test_performance_example():
    p = performance(list(zip(range(4), RETURNS)), {})
    assert p.ann_return == pytest.approx(0.254)
    assert p.vol == pytest.approx(0.221736, rel=1e-4)
    assert p.sharpe == pytest.approx(1.12746, rel=1e-4)
    assert p.sortino == pytest.approx(5.0)
    assert p.max_dd == pytest.approx(-0.05) and p.calmar == pytest.approx(5.08)
    assert p.quarters_pos_pct == 0.5


def test_performance_needs_four_returns():
    assert performance(list(zip(range(3), RETURNS)), {}) is None
    assert performance([], {}) is None


def test_ann_return_scales_to_a_year():
    # eight quarters of 5%: (1.05 ** 8) ** (4 / 8) - 1 = 1.05 ** 4 - 1
    p = performance([(q, 0.05) for q in range(8)], {})
    assert p.ann_return == pytest.approx(1.05**4 - 1)


def test_excess_returns_use_the_risk_free_rate_of_the_quarters_year():
    # q0..q3 = 2013, q4..q7 = 2014; rf 4% in 2013 (1% a quarter), 8% in 2014 (2% a quarter)
    rets = [(0, 0.03), (1, 0.01), (2, 0.05), (3, 0.01), (4, 0.04), (5, 0.02), (6, 0.06), (7, 0.02)]
    p = performance(rets, {2013: 0.04, 2014: 0.08})
    excess = [0.02, 0.0, 0.04, 0.0, 0.02, 0.0, 0.04, 0.0]
    mean = sum(excess) / 8
    stdev = math.sqrt(sum((x - mean) ** 2 for x in excess) / 7)
    assert p.sharpe == pytest.approx(mean * 4 / (stdev * 2))
    assert p.sortino is None  # no excess return below zero


def test_missing_rf_year_uses_the_latest_earlier_year_else_zero():
    rets = [(q, 0.02 * (q % 2) + 0.01) for q in range(8)]  # 2013 then 2014
    assert performance(rets, {2013: 0.04}) == performance(rets, {2013: 0.04, 2014: 0.04})
    assert performance(rets, {2014: 0.04}).sharpe != performance(rets, {}).sharpe
    # 2013 has no rate and nothing is earlier: 0.0, as with no rates at all
    no_early = performance(rets[:4], {2014: 0.04})
    assert no_early == performance(rets[:4], {})


def test_sharpe_and_sortino_are_none_without_dispersion_or_downside():
    p = performance([(q, 0.01) for q in range(5)], {})
    assert p.vol == pytest.approx(0.0)
    assert p.sharpe is None and p.sortino is None
    assert p.max_dd == 0 and p.calmar is None


def test_sortino_with_downside_and_drawdown_from_the_chained_index():
    # index 1.0 -> 0.9 -> 0.72 -> 0.792 -> 0.8712 : peak stays 1.0, trough 0.72
    rets = [-0.10, -0.20, 0.10, 0.10]
    p = performance(list(zip(range(4), rets)), {})
    assert p.max_dd == pytest.approx(-0.28)
    assert p.calmar == pytest.approx(p.ann_return / 0.28)
    downside = math.sqrt((0.1**2 + 0.2**2) / 4)
    assert p.sortino == pytest.approx(sum(rets) / 4 * 4 / (downside * 2))


def test_drawdown_is_measured_from_the_running_peak():
    # 1.0 -> 1.5 -> 1.2 -> 1.8 -> 0.9 : worst fall is from 1.8 to 0.9
    p = performance(list(zip(range(5), [0.5, -0.2, 0.5, -0.5, 0.0])), {})
    assert p.max_dd == pytest.approx(-0.5)


def test_a_return_below_minus_one_hundred_percent_stays_a_real_number():
    p = performance(list(zip(range(4), [0.1, -1.5, 0.1, 0.1])), {})
    assert p.ann_return == -1.0
    for value in (p.vol, p.sharpe, p.sortino, p.max_dd, p.calmar, p.quarters_pos_pct):
        assert value is None or (isinstance(value, float) and math.isfinite(value))


def quarter(q, start=0, end=0, buys=0, sells=0, ret=0.0) -> FundQuarter:
    return FundQuarter(
        q=q,
        start=start,
        end=end,
        net_buying=buys - sells,
        buys=buys,
        sells=sells,
        market_move=0.0,
        trade_gains=0.0,
        dividends=0.0,
        ret=ret,
    )


def test_turnover():
    # 2014: buys 300, sells 200, mean of start and the four ends (1000 each) = 1000
    quarters = [
        quarter(3, start=0, end=1000, buys=1000),
        quarter(4, start=1000, end=1000, buys=100, sells=50),
        quarter(5, start=1000, end=1000, buys=100, sells=50),
        quarter(6, start=1000, end=1000, buys=50, sells=50),
        quarter(7, start=1000, end=1000, buys=50, sells=50),
    ]
    assert turnover(fund_years(quarters), quarters) == pytest.approx(0.2)


def test_turnover_averages_full_years_and_uses_the_mean_book():
    quarters = [quarter(3, end=1000, buys=1000)]
    # 2014: start 1000, ends 1000, 1200, 1400, 1600 -> mean 1240; min(400, 500) / 1240
    # 2015: start 1600, ends 2000 x 4 -> mean 1920; min(600, 900) / 1920
    rows = [
        (4, 1000, 1000, 100, 150),
        (5, 1000, 1200, 100, 150),
        (6, 1200, 1400, 100, 100),
        (7, 1400, 1600, 100, 100),
        (8, 1600, 2000, 150, 225),
        (9, 2000, 2000, 150, 225),
        (10, 2000, 2000, 150, 225),
        (11, 2000, 2000, 150, 225),
    ]
    quarters += [quarter(q, start, end, buys, sells) for q, start, end, buys, sells in rows]
    mean_2014 = (1000 + 1000 + 1200 + 1400 + 1600) / 5
    mean_2015 = (1600 + 2000 * 4) / 5
    expected = (min(400, 500) / mean_2014 + min(600, 900) / mean_2015) / 2
    assert turnover(fund_years(quarters), quarters) == pytest.approx(expected)


def test_turnover_excludes_the_year_with_the_segment_start_and_partial_years():
    quarters = [quarter(q, start=1000, end=1000, buys=100, sells=100) for q in range(4, 8)]
    assert turnover(fund_years(quarters), quarters) is None  # the only full year holds q4
    quarters = [quarter(q, start=1000, end=1000, buys=100, sells=100) for q in range(5, 11)]
    assert turnover(fund_years(quarters), quarters) is None  # 2014 is partial, 2015 partial too
    assert turnover([], []) is None


def test_turnover_skips_a_year_with_a_quarter_without_a_return():
    # the same quarters as test_turnover, with q5's return missing: 2014 is no longer a full year
    quarters = [
        quarter(3, start=0, end=1000, buys=1000),
        quarter(4, start=1000, end=1000, buys=100, sells=50),
        quarter(5, start=1000, end=1000, buys=100, sells=50, ret=None),
        quarter(6, start=1000, end=1000, buys=50, sells=50),
        quarter(7, start=1000, end=1000, buys=50, sells=50),
    ]
    assert turnover(fund_years(quarters), quarters) is None


def test_turnover_ignores_years_the_quarters_do_not_cover():
    quarters = [quarter(q, start=1000, end=1000, buys=100, sells=100) for q in range(3, 8)]
    years = fund_years(quarters)
    assert turnover(years, [fq for fq in quarters if fq.q != 5]) is None  # no KeyError


def test_turnover_skips_a_year_with_an_empty_book():
    quarters = [quarter(q) for q in range(3, 8)]
    assert turnover(fund_years(quarters), quarters) is None


def position(stock_id, from_q, to_q) -> PositionResult:
    return PositionResult(
        stock_id=stock_id,
        from_q=from_q,
        to_q=to_q,
        quarters=[],
        trades=[],
        invested=0.0,
        realised=0.0,
        dividends=0.0,
        shares_now=0.0,
        cost_now=0.0,
        avg_cost=0.0,
        avg_exit=None,
        sold_shares=0.0,
        sold_usd=0.0,
    )


def test_hold_lengths():
    # held q10..q13 = 4 quarters = 1 year (sold); q12..q17 (still held, last_q 17) = 6 quarters
    positions = [position(1, 10, 13), position(2, 12, None), position(3, 16, 16)]
    all_years, sold_years = hold_lengths(positions, last_q=17)
    assert all_years == pytest.approx((1.0 + 1.5 + 0.25) / 3)
    assert sold_years == pytest.approx((1.0 + 0.25) / 2)


def test_hold_lengths_without_sold_positions_or_positions():
    assert hold_lengths([position(1, 10, None)], last_q=13) == (1.0, None)
    assert hold_lengths([], last_q=13) == (0.0, None)


def holdings(rows) -> pl.DataFrame:
    return pl.DataFrame(
        rows,
        schema={"cusip": pl.String, "kind": pl.String, "value_usd": pl.Float64},
        orient="row",
    )


def test_priced_pct():
    latest = holdings(
        [("A", "SH", 400.0), ("B", "SH", 200.0), ("C", "SH", 300.0), ("D", "PUT", 100.0)]
    )
    assert priced_pct(latest, {"A", "B"}) == pytest.approx(0.6)


def test_priced_pct_ignores_priced_cusips_of_other_kinds_and_empty_books():
    assert priced_pct(holdings([("A", "PUT", 100.0), ("A", "SH", 100.0)]), {"A"}) == 0.5
    assert priced_pct(holdings([]), {"A"}) == 0.0
    assert priced_pct(holdings([("A", "SH", 0.0)]), {"A"}) == 0.0
