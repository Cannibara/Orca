import pytest

from orca.engine.position import PositionResult, Trade
from orca.engine.whatif import ExitRow, beat_spy_pct, buys_vs_sells, exit_rows
from orca.quarter_px import QuarterPx


def qpx(close, vwap=None) -> QuarterPx:
    return QuarterPx(vwap, None, None, close, 0.0, (None,) * 3)


def trade(q, kind, delta, px) -> Trade:
    return Trade(q=q, type=kind, delta=delta, px=px, low=None, high=None, shares_after=0.0)


def position(stock_id, trades, to_q=None, sold_shares=0.0, sold_usd=0.0) -> PositionResult:
    return PositionResult(
        stock_id=stock_id,
        from_q=trades[0].q,
        to_q=to_q,
        quarters=[],
        trades=trades,
        invested=0.0,
        realised=0.0,
        dividends=0.0,
        shares_now=0.0,
        cost_now=0.0,
        avg_cost=0.0,
        avg_exit=None,
        sold_shares=sold_shares,
        sold_usd=sold_usd,
    )


def sold_position(stock_id=1, sale_q=10, sale_px=20.0, to_q=None) -> PositionResult:
    trades = [
        trade(8, "new", 100, 10.0),
        trade(9, "trim", -40, 15.0),
        trade(sale_q, "exit" if to_q else "trim", -60, sale_px),
    ]
    return position(stock_id, trades, to_q=to_q, sold_shares=100, sold_usd=40 * 15 + 60 * sale_px)


SPY = {10: qpx(close=100.0, vwap=95.0), 14: qpx(close=114.0, vwap=110.0)}


def test_exit_row_for_a_position_sold_entirely():
    px = {1: {10: qpx(20.0), 14: qpx(30.0)}}
    (row,) = exit_rows([sold_position(to_q=10)], px, SPY)
    assert row == ExitRow(
        stock_id=1,
        status="sold_all",
        sold_shares=100,
        sold_usd=1800,
        avg_exit=pytest.approx(18.0),
        last_sale_q=10,
        one_y=pytest.approx(30.0 / 20.0 - 1),
        spy_one_y=pytest.approx(114.0 / 95.0 - 1),
    )


def test_trimmed_position_is_reported_and_unsold_positions_are_not():
    held = position(2, [trade(8, "new", 100, 10.0), trade(9, "add", 50, 12.0)])
    px = {1: {14: qpx(30.0)}}
    rows = exit_rows([sold_position(), held], px, SPY)
    assert [(r.stock_id, r.status, r.last_sale_q) for r in rows] == [(1, "trimmed", 10)]


def test_one_year_after_uses_the_last_sale_not_the_first():
    # trims in q9 (px 15) and q10 (px 20): the one-year figure follows the q10 sale
    px = {1: {13: qpx(99.0), 14: qpx(40.0)}}
    (row,) = exit_rows([sold_position()], px, SPY)
    assert row.last_sale_q == 10 and row.one_y == pytest.approx(40.0 / 20.0 - 1)


def test_one_year_after_missing_is_none():
    # the last sale is in the latest quarter: there is no close four quarters later
    px = {1: {10: qpx(20.0)}}
    (row,) = exit_rows([sold_position()], px, {10: qpx(close=100.0, vwap=95.0)})
    assert row.one_y is None and row.spy_one_y is None


def test_delisted_stock_has_no_one_year_figure_despite_an_earlier_close():
    # the stock stopped trading after q11; q14 has no row, and the stale q11 close is not used
    px = {1: {10: qpx(20.0), 11: qpx(21.0)}}
    (row,) = exit_rows([sold_position(to_q=10)], px, SPY)
    assert row.one_y is None
    assert row.spy_one_y == pytest.approx(114.0 / 95.0 - 1)


def test_one_year_after_needs_a_close_in_that_exact_quarter():
    px = {1: {14: qpx(close=None, vwap=30.0), 15: qpx(50.0)}}
    (row,) = exit_rows([sold_position()], px, SPY)
    assert row.one_y is None
    assert exit_rows([sold_position()], {}, SPY)[0].one_y is None


def test_spy_one_year_needs_both_prices():
    px = {1: {14: qpx(30.0)}}
    assert (
        exit_rows([sold_position()], px, {10: qpx(100.0, vwap=None), 14: qpx(114.0)})[0].spy_one_y
        is None
    )
    assert exit_rows([sold_position()], px, {10: qpx(100.0, vwap=95.0)})[0].spy_one_y is None
    assert exit_rows([sold_position()], px, {})[0].spy_one_y is None


def test_buys_vs_sells():
    positions = [
        position(1, [trade(8, "new", 100, 10.0), trade(9, "trim", -40, 20.0)]),
        position(
            2, [trade(8, "new", 50, 50.0), trade(9, "add", 10, 40.0), trade(10, "exit", -60, 30.0)]
        ),
    ]
    px = {
        1: {
            12: qpx(15.0),
            13: qpx(10.0),
        },  # the new in q8 -> q12 close; the trim in q9 -> q13 close
        2: {12: qpx(75.0), 13: qpx(20.0), 14: qpx(33.0)},  # q8 -> 75, q9 -> 20, q10 -> 33
    }
    buys, sells = buys_vs_sells(positions, px)
    assert buys == pytest.approx((15 / 10 - 1 + 75 / 50 - 1 + 20 / 40 - 1) / 3)
    assert sells == pytest.approx((10 / 20 - 1 + 33 / 30 - 1) / 2)


def test_buys_vs_sells_skips_trades_without_a_later_close_and_empty_sides_are_none():
    positions = [position(1, [trade(8, "new", 100, 10.0), trade(9, "add", 10, 12.0)])]
    px = {1: {12: qpx(15.0)}}  # no q13 close: the add is skipped
    assert buys_vs_sells(positions, px) == (pytest.approx(0.5), None)
    assert buys_vs_sells(positions, {}) == (None, None)
    assert buys_vs_sells([], {}) == (None, None)


def row(one_y, spy_one_y) -> ExitRow:
    return ExitRow(1, "trimmed", 1.0, 1.0, 1.0, 10, one_y, spy_one_y)


def test_beat_spy_pct():
    rows = [
        row(0.2, 0.1),
        row(0.0, 0.1),
        row(None, 0.1),
        row(0.3, None),
        row(0.5, 0.4),
        row(0.1, 0.1),
    ]
    assert beat_spy_pct(rows) == pytest.approx(2 / 4)


def test_beat_spy_pct_none_without_comparable_rows():
    assert beat_spy_pct([row(None, 0.1), row(0.3, None)]) is None
    assert beat_spy_pct([]) is None
