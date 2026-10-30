from datetime import date, timedelta

import polars as pl
import pytest

from orca.quarter_px import QuarterPx, close_on, last_close_before, quarter_px
from orca.quarters import q_index

Q2_2024 = q_index(2024, 2)
Q3_2024 = q_index(2024, 3)

SCHEMA = {
    "date": pl.Date,
    "high": pl.Float64,
    "low": pl.Float64,
    "close": pl.Float64,
    "volume": pl.Float64,
    "dividend": pl.Float64,
}


def bar(d: date, high, low, close, volume: float = 100.0, dividend: float = 0.0) -> dict:
    return {
        "date": d,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "dividend": dividend,
    }


def frame(*bars: dict) -> pl.DataFrame:
    return pl.DataFrame(list(bars), schema=SCHEMA)


def days(rows, first: date = date(2024, 5, 1)) -> pl.DataFrame:
    """Consecutive days from `first`, one per (high, low, close, volume) row."""
    return frame(*[bar(first + timedelta(days=i), *row) for i, row in enumerate(rows)])


def test_vwap_from_typical_price():
    d = days([(11, 9, 10, 100), (13, 11, 12, 300)])  # typical 10 and 12
    p = quarter_px(d)[Q2_2024]
    assert p.vwap == 11.5 and p.low == 9 and p.high == 13 and p.close == 12


def test_quarter_px_fields_are_a_frozen_dataclass():
    p = quarter_px(days([(11, 9, 10, 100)]))[Q2_2024]
    assert isinstance(p, QuarterPx)
    with pytest.raises(AttributeError):
        p.vwap = 1.0  # type: ignore[misc]


def test_quarter_without_data_is_absent():
    d = frame(bar(date(2024, 5, 3), 11, 9, 10), bar(date(2024, 11, 4), 15, 13, 14))
    px = quarter_px(d)
    assert sorted(px) == [Q2_2024, q_index(2024, 4)]
    assert Q3_2024 not in px
    assert quarter_px(frame()) == {}


def test_delisted_exit_uses_last_close():
    # The stock trades through Q2 2024 and then disappears: no rows in Q3 or later.
    d = frame(
        bar(date(2024, 4, 2), 11, 9, 10),
        bar(date(2024, 6, 28), 14, 12, 13),
    )
    px = quarter_px(d)
    assert Q3_2024 not in px
    assert last_close_before(px, Q3_2024) == 13
    assert last_close_before(px, q_index(2025, 2)) == 13  # also across several empty quarters


def test_last_close_before_is_strictly_before_and_none_without_history():
    px = quarter_px(days([(11, 9, 10, 100)]))
    assert last_close_before(px, Q2_2024) is None  # q itself does not count
    assert last_close_before(px, Q2_2024 - 1) is None
    assert last_close_before({}, Q2_2024) is None
    assert last_close_before(px, Q2_2024 + 1) == 10


def test_last_close_before_skips_quarters_without_a_close():
    px = {
        Q2_2024 - 1: QuarterPx(1.0, 1.0, 1.0, 7.0, 0.0, (1.0, 1.0, 1.0)),
        Q2_2024: QuarterPx(None, None, None, None, 0.5, (None, None, None)),
    }
    assert last_close_before(px, Q3_2024) == 7.0


def test_dividends_summed_per_quarter():
    d = frame(
        bar(date(2024, 4, 10), 11, 9, 10, dividend=0.25),
        bar(date(2024, 5, 10), 11, 9, 10),
        bar(date(2024, 6, 10), 11, 9, 10, dividend=0.5),
        bar(date(2024, 7, 10), 11, 9, 10, dividend=1.0),
        bar(date(2024, 8, 10), 11, 9, 10),
    )
    px = quarter_px(d)
    assert px[Q2_2024].div_ps == 0.75
    assert px[Q3_2024].div_ps == 1.0
    assert quarter_px(days([(11, 9, 10, 100)]))[Q2_2024].div_ps == 0.0


def test_vwap_falls_back_to_mean_typical_when_volume_is_zero():
    p = quarter_px(days([(11, 9, 10, 0), (13, 11, 12, 0)]))[Q2_2024]
    assert p.vwap == 11.0  # plain mean of typical 10 and 12


def test_zero_volume_days_do_not_move_the_vwap():
    p = quarter_px(days([(11, 9, 10, 100), (31, 29, 30, 0)]))[Q2_2024]
    assert p.vwap == 10.0


def test_null_volume_counts_as_zero():
    d = frame(bar(date(2024, 5, 1), 11, 9, 10, volume=100), bar(date(2024, 5, 2), 31, 29, 30, None))
    assert quarter_px(d)[Q2_2024].vwap == 10.0


def test_missing_high_and_low_use_close():
    d = frame(bar(date(2024, 5, 1), None, None, 10, 100), bar(date(2024, 5, 2), 13, None, 12, 300))
    p = quarter_px(d)[Q2_2024]
    assert p.high == 13 and p.low == 10
    assert p.close == 12
    # typical prices: (10 + 10 + 10) / 3 = 10 and (13 + 12 + 12) / 3 = 37 / 3
    assert p.vwap == pytest.approx((10 * 100 + 37 / 3 * 300) / 400)


def test_close_is_the_last_trading_day_whatever_the_row_order():
    d = frame(
        bar(date(2024, 6, 28), 14, 12, 13),
        bar(date(2024, 4, 2), 11, 9, 10),
        bar(date(2024, 5, 15), 20, 8, 15),
    )
    p = quarter_px(d)[Q2_2024]
    assert p.close == 13 and p.low == 8 and p.high == 20


def test_quarters_split_at_the_calendar_boundaries():
    d = frame(
        bar(date(2023, 12, 29), 11, 9, 10),
        bar(date(2024, 1, 2), 12, 10, 11),
        bar(date(2024, 3, 28), 13, 11, 12),
        bar(date(2024, 4, 1), 14, 12, 13),
    )
    px = quarter_px(d)
    assert {q: p.close for q, p in px.items()} == {
        q_index(2023, 4): 10,
        q_index(2024, 1): 12,
        q_index(2024, 2): 13,
    }


def test_monthly_vwap_per_month_of_the_quarter():
    d = frame(
        bar(date(2024, 4, 5), 11, 9, 10, 100),  # April
        bar(date(2024, 4, 25), 15, 13, 14, 100),  # April
        bar(date(2024, 6, 3), 21, 19, 20, 50),  # June; nothing in May
    )
    p = quarter_px(d)[Q2_2024]
    assert p.monthly_vwap == (12.0, None, 20.0)
    assert p.vwap == (10 * 100 + 14 * 100 + 20 * 50) / 250


def test_monthly_vwap_falls_back_to_mean_typical_without_volume():
    d = frame(bar(date(2024, 5, 1), 11, 9, 10, 0), bar(date(2024, 5, 2), 13, 11, 12, 0))
    assert quarter_px(d)[Q2_2024].monthly_vwap == (None, 11.0, None)


def test_rows_without_a_close_are_not_priced_but_still_pay_dividends():
    d = frame(bar(date(2024, 5, 1), 11, 9, None, 100, dividend=0.3))
    p = quarter_px(d)[Q2_2024]
    assert p == QuarterPx(None, None, None, None, 0.3, (None, None, None))


def test_a_missing_close_on_the_last_day_leaves_the_previous_close():
    d = frame(bar(date(2024, 5, 1), 11, 9, 10), bar(date(2024, 5, 2), 13, 11, None))
    p = quarter_px(d)[Q2_2024]
    assert p.close == 10 and p.vwap == 10.0


def test_extra_columns_are_ignored():
    d = days([(11, 9, 10, 100), (13, 11, 12, 300)]).with_columns(
        stock_id=pl.lit(7), open=pl.lit(1.0), split_factor=pl.lit(1.0)
    )
    assert quarter_px(d)[Q2_2024].vwap == 11.5


def test_float32_input_gives_python_floats():
    d = days([(11, 9, 10, 100), (13, 11, 12, 300)]).cast(
        {"high": pl.Float32, "low": pl.Float32, "close": pl.Float32}
    )
    p = quarter_px(d)[Q2_2024]
    assert type(p.vwap) is float and type(p.close) is float and type(p.div_ps) is float
    assert all(type(m) is float for m in p.monthly_vwap if m is not None)
    assert all(type(q) is int for q in quarter_px(d))


def test_close_on_is_the_last_close_on_or_before_the_day():
    d = frame(
        bar(date(2024, 5, 3), 11, 9, 10),  # Friday
        bar(date(2024, 5, 6), 13, 11, 12),  # Monday
    )
    assert close_on(d, date(2024, 5, 3)) == 10  # on the day
    assert close_on(d, date(2024, 5, 4)) == 10  # weekend: the Friday close
    assert close_on(d, date(2024, 5, 6)) == 12
    assert close_on(d, date(2025, 1, 1)) == 12  # after the last row: still the last close
    assert close_on(d, date(2024, 5, 2)) is None  # before the first row
    assert close_on(frame(), date(2024, 5, 2)) is None


def test_close_on_ignores_row_order_and_skips_rows_without_a_close():
    d = frame(
        bar(date(2024, 5, 6), 13, 11, None),
        bar(date(2024, 5, 3), 11, 9, 10),
        bar(date(2024, 5, 2), 11, 9, 9),
    )
    assert close_on(d, date(2024, 5, 6)) == 10
