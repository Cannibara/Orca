import json
import logging
from datetime import date

import httpx
import polars as pl
import pytest

from orca.http import FetchError, tiingo_client
from orca.prices import (
    DAILY_SCHEMA,
    PRICES_SCHEMA,
    FixtureSource,
    TiingoSource,
    compact_prices,
    part_stocks,
    price_runs,
    read_prices,
    run_parts,
    split_adjust_prices,
    split_adjust_shares,
    split_factors_by_quarter,
    update_prices,
)
from orca.quarters import q_index
from orca.storage import Lake

TABLE = "prices_daily"
D = date  # short alias: the tests are full of dates


def bar(d: date, close: float, split: float = 1.0, dividend: float = 0.0, volume: float = 1000.0):
    """One raw daily bar as a vendor returns it; open/high/low are fixed offsets from close."""
    return {
        "date": d,
        "open": close - 1,
        "high": close + 2,
        "low": close - 2,
        "close": close,
        "volume": volume,
        "split_factor": split,
        "dividend": dividend,
    }


def daily(*bars) -> pl.DataFrame:
    return pl.DataFrame(list(bars), schema=DAILY_SCHEMA)


def stored(*rows) -> pl.DataFrame:
    """Rows (stock_id, date, close, split_factor, volume, dividend) as read_prices returns them."""
    return pl.DataFrame(
        [
            {"stock_id": sid, **bar(d, close, split, div, vol)}
            for sid, d, close, split, vol, div in rows
        ],
        schema=PRICES_SCHEMA,
    )


class Recording:
    """Wraps a source, remembers each request it receives and raises `errors[ticker]` if set."""

    def __init__(self, inner, errors: dict[str, Exception] | None = None):
        self.inner = inner
        self.errors = errors or {}
        self.calls: list[tuple[str, date, date]] = []

    def daily(self, ticker, start, end):
        self.calls.append((ticker, start, end))
        if ticker in self.errors:
            raise self.errors[ticker]
        return self.inner.daily(ticker, start, end)


def fetch_error(ticker: str, status: int | None) -> FetchError:
    return FetchError(f"https://api.tiingo.com/tiingo/daily/{ticker}/prices", status)


# Mon 6 May 2024 .. Fri 17 May 2024
WEEK1 = [bar(D(2024, 5, d), 10.0 + d) for d in (6, 7, 8, 9, 10)]
WEEK2 = [bar(D(2024, 5, d), 10.0 + d) for d in (13, 14, 15, 16, 17)]


# --- split adjustment -------------------------------------------------------------------


def test_split_does_not_create_trade():
    splits = pl.DataFrame({"date": [date(2024, 5, 10)], "split_factor": [2.0]})
    assert split_adjust_shares(100, q_index(2024, 1), splits) == 200
    assert split_adjust_shares(210, q_index(2024, 2), splits) == 210  # delta = +10, not +110


def test_split_adjust_shares_without_splits_is_unchanged():
    assert split_adjust_shares(100, q_index(2024, 1), pl.DataFrame()) == 100
    empty = pl.DataFrame(schema={"date": pl.Date, "split_factor": pl.Float32})
    assert split_adjust_shares(100, q_index(2024, 1), empty) == 100


def test_split_adjust_shares_counts_only_splits_after_quarter_end():
    q = q_index(2024, 1)  # ends 2024-03-31
    splits = pl.DataFrame(
        {
            "date": [D(2023, 6, 1), D(2024, 3, 31), D(2024, 4, 1), D(2024, 9, 2), D(2025, 1, 2)],
            "split_factor": [10.0, 5.0, 2.0, 1.5, 1.0],  # 1.0 rows are harmless
        }
    )
    # the 31 March split is already in the quarter-end share count; 1 April on is not.
    assert split_adjust_shares(100, q, splits) == pytest.approx(100 * 2.0 * 1.5)


def test_split_adjust_shares_handles_reverse_splits_and_returns_float():
    splits = pl.DataFrame({"date": [D(2024, 5, 10)], "split_factor": [0.125]})  # 1-for-8
    out = split_adjust_shares(800, q_index(2024, 1), splits)
    assert out == 100.0
    assert isinstance(out, float)


def test_split_factors_by_quarter_agree_exactly_with_split_adjust_shares():
    splits = pl.DataFrame(
        {
            "date": [D(2014, 6, 9), D(2020, 8, 31), D(2022, 8, 25), D(2024, 3, 31), D(2024, 4, 1)],
            "split_factor": [7.0, 5.0, 3.0, 0.1, 2.5],
        }
    )
    factors = split_factors_by_quarter(splits)

    assert max(factors.by_q) == q_index(2024, 1)  # no split after a later quarter: 1.0
    for q in range(-12, q_index(2026, 4)):  # a report period before 2013 included
        for shares in (1.0, 333.0, 123456789.0, 0.3):
            assert shares * factors.of(q) == split_adjust_shares(shares, q, splits), q
    assert split_factors_by_quarter(splits.clear()).of(-1) == 1.0


def test_split_factors_before_their_first_quarter_are_every_split():
    splits = pl.DataFrame({"date": [D(2013, 2, 1), D(2020, 8, 31)], "split_factor": [7.0, 4.0]})
    factors = split_factors_by_quarter(splits)

    for q in (-40, -1):
        assert 100 * factors.of(q) == 2800 == split_adjust_shares(100, q, splits)
    assert 100 * factors.of(0) == 400  # the first split is in Q1 2013's share count


def test_split_adjust_prices():
    df = stored(
        (1, D(2024, 5, 8), 100.0, 1.0, 1000.0, 0.5),
        (1, D(2024, 5, 9), 102.0, 1.0, 1200.0, 0.0),
        (1, D(2024, 5, 10), 51.0, 2.0, 2000.0, 0.0),  # split day: already post-split
        (1, D(2024, 5, 13), 52.0, 1.0, 1800.0, 0.0),
    )

    out = split_adjust_prices(df)

    assert out["close"].to_list() == [50.0, 51.0, 51.0, 52.0]  # 100 before the 2:1 split -> 50
    assert out["volume"].to_list() == [2000.0, 2400.0, 2000.0, 1800.0]  # volume doubles
    assert out["open"].to_list() == [49.5, 50.5, 50.0, 51.0]
    assert out["high"].to_list() == [51.0, 52.0, 53.0, 54.0]
    assert out["low"].to_list() == [49.0, 50.0, 49.0, 50.0]
    assert out["dividend"].to_list() == [0.25, 0.0, 0.0, 0.0]
    assert out["split_factor"].to_list() == [1.0, 1.0, 2.0, 1.0]  # raw factors stay visible
    assert out["date"].to_list() == df["date"].to_list()


def test_split_adjust_prices_multiplies_later_splits_and_handles_reverse_splits():
    df = stored(
        (1, D(2024, 1, 2), 120.0, 1.0, 100.0, 0.0),
        (1, D(2024, 2, 1), 60.0, 2.0, 200.0, 0.0),
        (1, D(2024, 3, 1), 20.0, 3.0, 600.0, 0.0),
        (1, D(2024, 4, 1), 25.0, 1.0, 500.0, 0.0),
    )
    out = split_adjust_prices(df)
    assert out["close"].to_list() == [20.0, 20.0, 20.0, 25.0]  # all on today's share basis
    assert out["volume"].to_list() == [600.0, 600.0, 600.0, 500.0]

    reverse = stored(
        (1, D(2024, 1, 2), 2.0, 1.0, 800.0, 0.0),
        (1, D(2024, 2, 1), 16.0, 0.125, 100.0, 0.0),  # 1-for-8
    )
    out = split_adjust_prices(reverse)
    assert out["close"].to_list() == [16.0, 16.0]
    assert out["volume"].to_list() == [100.0, 100.0]


def test_split_adjust_prices_per_stock_and_any_row_order():
    df = stored(
        (2, D(2024, 5, 13), 7.0, 1.0, 10.0, 0.0),
        (1, D(2024, 5, 10), 51.0, 2.0, 2000.0, 0.0),
        (2, D(2024, 5, 8), 6.0, 1.0, 10.0, 0.0),
        (1, D(2024, 5, 8), 100.0, 1.0, 1000.0, 0.0),
    )

    out = split_adjust_prices(df)

    assert out.select("stock_id", "date", "close").rows() == [
        (1, D(2024, 5, 8), 50.0),
        (1, D(2024, 5, 10), 51.0),
        (2, D(2024, 5, 8), 6.0),  # stock 2 never split
        (2, D(2024, 5, 13), 7.0),
    ]


def test_split_adjust_prices_is_float64_and_treats_missing_factor_as_no_split():
    df = stored(
        (1, D(2024, 5, 8), 100.0, 1.0, 1000.0, 0.0), (1, D(2024, 5, 9), 90.0, 1.0, 1.0, 0.0)
    )
    df = df.with_columns(split_factor=pl.Series([1.0, None], dtype=pl.Float32))

    out = split_adjust_prices(df)

    assert out["close"].to_list() == [100.0, 90.0]
    assert {out.schema[c] for c in ("open", "high", "low", "close", "volume", "dividend")} == {
        pl.Float64
    }


# --- sources ----------------------------------------------------------------------------


def test_fixture_source_returns_rows_within_the_range():
    source = FixtureSource({"AAA": daily(*WEEK1, *WEEK2)})

    out = source.daily("AAA", D(2024, 5, 8), D(2024, 5, 13))

    assert out["date"].to_list() == [D(2024, 5, 8), D(2024, 5, 9), D(2024, 5, 10), D(2024, 5, 13)]
    assert out.schema == DAILY_SCHEMA


def test_fixture_source_unknown_ticker_is_empty():
    out = FixtureSource({}).daily("ZZZ", D(2024, 1, 1), D(2024, 12, 31))
    assert out.is_empty()
    assert out.schema == DAILY_SCHEMA


TIINGO_BODY = [
    {
        "date": "2024-05-09T00:00:00.000Z",
        "close": 183.0,
        "high": 184.0,
        "low": 181.0,
        "open": 182.0,
        "volume": 1000,
        "adjClose": 91.5,
        "adjHigh": 92.0,
        "adjLow": 90.5,
        "adjOpen": 91.0,
        "adjVolume": 2000,
        "divCash": 0.0,
        "splitFactor": 1.0,
    },
    {
        "date": "2024-05-10T00:00:00.000Z",
        "close": 92.5,
        "high": 93.0,
        "low": 91.0,
        "open": 91.5,
        "volume": 2500,
        "adjClose": 92.5,
        "adjHigh": 93.0,
        "adjLow": 91.0,
        "adjOpen": 91.5,
        "adjVolume": 2500,
        "divCash": 0.25,
        "splitFactor": 2.0,
    },
]


def tiingo(handler, monkeypatch, key="secret-key") -> TiingoSource:
    monkeypatch.setenv("TIINGO_KEY", key)
    return TiingoSource(tiingo_client(httpx.MockTransport(handler), sleep=lambda s: None))


def test_tiingo_requests_the_daily_prices_with_the_key_in_the_header_only(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=TIINGO_BODY)

    out = tiingo(handler, monkeypatch).daily("BRK-B", D(2024, 5, 9), D(2024, 5, 17))

    (request,) = seen
    assert request.url.host == "api.tiingo.com"
    assert request.url.path == "/tiingo/daily/BRK-B/prices"
    assert dict(request.url.params) == {"startDate": "2024-05-09", "endDate": "2024-05-17"}
    assert request.headers["Authorization"] == "Token secret-key"
    assert "secret-key" not in str(request.url)
    assert out.schema == DAILY_SCHEMA
    # raw fields only: the vendor's adj* columns are not used
    assert out.rows() == [
        (D(2024, 5, 9), 182.0, 184.0, 181.0, 183.0, 1000.0, 1.0, 0.0),
        (D(2024, 5, 10), 91.5, 93.0, 91.0, 92.5, 2500.0, 2.0, 0.25),
    ]


def test_tiingo_empty_answer_is_an_empty_frame(monkeypatch):
    out = tiingo(lambda r: httpx.Response(200, json=[]), monkeypatch).daily(
        "AAA", D(2024, 5, 9), D(2024, 5, 17)
    )
    assert out.is_empty()
    assert out.schema == DAILY_SCHEMA


def test_tiingo_unknown_ticker_404_is_an_empty_frame(monkeypatch):
    def handler(request):
        return httpx.Response(404, json={"detail": "Not found."})

    out = tiingo(handler, monkeypatch).daily("GONE", D(2013, 1, 1), D(2024, 5, 17))

    assert out.is_empty()
    assert out.schema == DAILY_SCHEMA


def test_tiingo_other_errors_propagate_without_leaking_the_key(monkeypatch):
    def handler(request):
        return httpx.Response(401, json={"detail": "Invalid token."})

    with pytest.raises(FetchError) as exc:
        tiingo(handler, monkeypatch).daily("AAA", D(2024, 5, 9), D(2024, 5, 17))

    assert exc.value.status == 401
    assert "secret-key" not in str(exc.value)
    assert "secret-key" not in exc.value.url


@pytest.mark.parametrize(
    "body",
    [
        {"detail": "Error: hourly request allocation exceeded"},
        [{"date": "2024-05-09T00:00:00.000Z", "open": 1.0}],  # fields missing
        [dict(TIINGO_BODY[0], date="not a date")],
        [dict(TIINGO_BODY[0], close="n/a")],
    ],
)
def test_tiingo_unexpected_body_is_a_fetch_error(monkeypatch, body):
    with pytest.raises(FetchError) as exc:
        tiingo(lambda r: httpx.Response(200, json=body), monkeypatch).daily(
            "AAA", D(2024, 5, 9), D(2024, 5, 17)
        )
    assert "secret-key" not in str(exc.value)


def test_tiingo_drops_bars_whose_split_factor_is_not_finite_and_positive(monkeypatch, caplog):
    def bad(day, factor):
        return dict(TIINGO_BODY[0], date=f"2024-05-{day}T00:00:00.000Z", splitFactor=factor)

    body = [
        bad("06", 1.0),
        bad("07", 0.0),
        bad("08", -2.0),
        bad("09", float("nan")),
        bad("10", float("inf")),
        bad("13", None),
        bad("14", 2.0),
    ]

    def handler(request):  # json.dumps (unlike httpx's json=) lets NaN and Infinity through
        return httpx.Response(200, content=json.dumps(body).encode())

    with caplog.at_level(logging.WARNING, logger="orca.prices"):
        out = tiingo(handler, monkeypatch).daily("AAA", D(2024, 5, 6), D(2024, 5, 17))

    assert out["date"].to_list() == [D(2024, 5, 6), D(2024, 5, 14)]
    assert out["split_factor"].to_list() == [1.0, 2.0]
    assert out.schema == DAILY_SCHEMA
    assert any("AAA" in r.getMessage() and "5" in r.getMessage() for r in caplog.records)


# --- store ------------------------------------------------------------------------------


def test_update_fetches_only_new_days(tmp_path):
    lake = Lake(tmp_path)
    source = Recording(FixtureSource({"AAA": daily(*WEEK1, *WEEK2)}))

    first = update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 10))
    second = update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 17))

    assert source.calls == [
        ("AAA", D(2013, 1, 1), D(2024, 5, 10)),  # no rows yet: from the start of the history
        ("AAA", D(2024, 5, 5), D(2024, 5, 17)),  # last stored date (10 May) - 5 days
    ]
    assert first == [1]  # a stock new to the store counts as changed
    assert second == []  # plain new days (and the unchanged overlap) are not a change
    prices = read_prices(lake)
    assert prices["date"].to_list() == [b["date"] for b in WEEK1 + WEEK2]
    assert prices.height == 10


def test_update_stores_numbered_parts_per_run_in_the_documented_types(tmp_path):
    lake = Lake(tmp_path)
    source = FixtureSource({"AAA": daily(*WEEK1, *WEEK2)})

    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 10))
    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 17), run_id="20240517T0623")

    assert lake.parts(TABLE) == ["z20240510-0001", "z20240517T0623-0001"]  # default id: today
    assert lake.read(TABLE).schema == PRICES_SCHEMA
    assert read_prices(lake).schema == PRICES_SCHEMA
    assert read_prices(lake).select("stock_id").to_series().unique().to_list() == [1]


def test_update_reports_price_corrections_in_the_overlap(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    corrected = [bar(D(2024, 5, 9), 99.0) if b["date"] == D(2024, 5, 9) else b for b in WEEK1]

    changed = update_prices(
        lake, FixtureSource({"AAA": daily(*corrected, *WEEK2)}), {1: "AAA"}, today=D(2024, 5, 17)
    )

    assert changed == [1]
    prices = read_prices(lake)
    assert prices.filter(pl.col("date") == D(2024, 5, 9))["close"].to_list() == [
        99.0
    ]  # later run wins
    assert prices.height == 10  # no duplicate for the corrected day


@pytest.mark.parametrize(
    "field", ["open", "high", "low", "close", "volume", "dividend", "split_factor"]
)
def test_update_reports_a_change_in_any_field(tmp_path, field):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    revised = [dict(b, **{field: b[field] + 1}) if b["date"] == D(2024, 5, 8) else b for b in WEEK1]

    changed = update_prices(
        lake, FixtureSource({"AAA": daily(*revised)}), {1: "AAA"}, today=D(2024, 5, 17)
    )

    assert changed == [1]


def test_update_reports_a_split_on_a_new_day(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    # 2:1 split on Monday 13 May, after the last stored day: every older price is now on a new basis
    week2 = [bar(D(2024, 5, 13), 6.0, split=2.0), *WEEK2[1:]]

    changed = update_prices(
        lake, FixtureSource({"AAA": daily(*WEEK1, *week2)}), {1: "AAA"}, today=D(2024, 5, 17)
    )

    assert changed == [1]


def test_update_reports_a_day_the_vendor_filled_in_behind_the_last_stored_day(tmp_path):
    lake = Lake(tmp_path)
    gappy = [b for b in WEEK1 if b["date"] != D(2024, 5, 8)]
    update_prices(lake, FixtureSource({"AAA": daily(*gappy)}), {1: "AAA"}, today=D(2024, 5, 10))

    changed = update_prices(
        lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 17)
    )

    assert changed == [1]
    assert read_prices(lake).height == 5


def test_update_reports_only_the_stocks_that_changed(tmp_path):
    lake = Lake(tmp_path)
    frames = {
        "AAA": daily(*WEEK1, *WEEK2),
        "BBB": daily(*WEEK1, *WEEK2),
        "CCC": daily(*WEEK1, *WEEK2),
    }
    update_prices(lake, FixtureSource(frames), {3: "CCC", 1: "AAA", 2: "BBB"}, today=D(2024, 5, 10))
    frames["BBB"] = daily(*[bar(b["date"], b["close"] + 1) for b in WEEK1], *WEEK2)  # BBB restated
    frames["DDD"] = daily(*WEEK1)

    changed = update_prices(
        lake,
        FixtureSource(frames),
        {1: "AAA", 2: "BBB", 3: "CCC", 4: "DDD"},
        today=D(2024, 5, 17),
    )

    assert changed == [2, 4]  # BBB restated, DDD new; AAA and CCC only gained plain days


def test_update_without_any_rows_for_a_stock_stores_nothing_and_reports_nothing(tmp_path):
    lake = Lake(tmp_path)
    source = Recording(FixtureSource({"AAA": daily(*WEEK1)}))

    assert update_prices(lake, source, {9: "GONE"}, today=D(2024, 5, 10)) == []
    assert lake.parts(TABLE) == []

    assert update_prices(lake, source, {1: "AAA", 9: "GONE"}, today=D(2024, 5, 10)) == [1]
    assert update_prices(lake, source, {1: "AAA", 9: "GONE"}, today=D(2024, 5, 17)) == []
    assert source.calls[-1] == ("GONE", D(2013, 1, 1), D(2024, 5, 17))  # still a stock with no rows
    assert read_prices(lake)["stock_id"].unique().to_list() == [1]


def test_update_with_nothing_new_writes_no_part(tmp_path):
    lake = Lake(tmp_path)
    source = FixtureSource({"AAA": daily(*WEEK1)})
    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 10))

    assert update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 12)) == []

    assert lake.parts(TABLE) == ["z20240510-0001"]


def test_update_leaves_stocks_it_is_not_asked_about_alone(tmp_path):
    lake = Lake(tmp_path)
    frames = {"AAA": daily(*WEEK1, *WEEK2), "BBB": daily(*WEEK1, *WEEK2)}
    update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 5, 10))
    source = Recording(FixtureSource(frames))

    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 17))

    assert [c[0] for c in source.calls] == ["AAA"]
    prices = read_prices(lake)
    assert prices.filter(stock_id=1).height == 10
    assert prices.filter(stock_id=2).height == 5


def test_update_twice_with_one_run_id_keeps_both_runs_rows(tmp_path):
    lake = Lake(tmp_path)
    source = FixtureSource({"AAA": daily(*WEEK1, *WEEK2)})

    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 8), run_id="r1")
    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 17), run_id="r1")

    assert lake.parts(TABLE) == ["zr1-0001", "zr1-0002"]  # the second goes on numbering
    assert read_prices(lake).height == 10


def test_update_keeps_a_corrected_value_after_a_later_unchanged_run(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    fixed = FixtureSource({"AAA": daily(bar(D(2024, 5, 10), 77.0))})
    update_prices(lake, fixed, {1: "AAA"}, today=D(2024, 5, 17))

    assert (
        update_prices(lake, fixed, {1: "AAA"}, today=D(2024, 5, 24)) == []
    )  # 77.0 is the stored value

    assert read_prices(lake).filter(pl.col("date") == D(2024, 5, 10))["close"].to_list() == [77.0]


def test_update_does_not_read_the_whole_table(tmp_path, monkeypatch):
    lake = Lake(tmp_path)
    frames = {"AAA": daily(*WEEK1, *WEEK2), "BBB": daily(*WEEK1, *WEEK2)}
    update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 5, 10))
    compact_prices(lake)
    update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 5, 13))

    def no_full_read(self, table, part=None):
        assert part is not None, "update_prices must not read the whole table"
        return real_read(self, table, part)

    real_read = Lake.read
    monkeypatch.setattr(Lake, "read", no_full_read)
    monkeypatch.setattr("orca.prices.read_prices", lambda lake: pytest.fail("full-table read"))

    assert (
        update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 5, 17)) == []
    )

    monkeypatch.undo()
    assert read_prices(lake).height == 20


def test_update_change_detection_sees_the_newest_stored_value_across_parts(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    compact_prices(lake)  # y2024 holds the original 10 May
    fixed = FixtureSource({"AAA": daily(bar(D(2024, 5, 10), 77.0))})
    assert update_prices(lake, fixed, {1: "AAA"}, today=D(2024, 5, 17)) == [1]  # z over y

    assert update_prices(lake, fixed, {1: "AAA"}, today=D(2024, 5, 24)) == []  # 77.0 is current


def test_update_change_detection_sees_the_newest_value_within_one_run(tmp_path):
    lake = Lake(tmp_path)
    first = daily(*WEEK1[:3])  # 6-8 May
    second = daily(bar(D(2024, 5, 8), 55.0), *WEEK1[3:])  # 8 May restated, 9-10 May new
    update_prices(lake, FixtureSource({"AAA": first}), {1: "AAA"}, today=D(2024, 5, 8), run_id="r1")
    update_prices(
        lake, FixtureSource({"AAA": second}), {1: "AAA"}, today=D(2024, 5, 10), run_id="r1"
    )
    assert lake.parts(TABLE) == ["zr1-0001", "zr1-0002"]  # 8 May twice: 55.0 in the later part

    assert (
        update_prices(lake, FixtureSource({"AAA": second}), {1: "AAA"}, today=D(2024, 5, 17)) == []
    )


# --- failures: spec section 8, skip a failed input, keep the last good data ---------------


def test_one_failed_ticker_does_not_lose_the_others(tmp_path, caplog):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC")}
    source = Recording(FixtureSource(frames), {"BBB": fetch_error("BBB", 500)})
    stats: dict = {}

    with caplog.at_level(logging.WARNING, logger="orca.prices"):
        changed = update_prices(
            lake, source, {1: "AAA", 2: "BBB", 3: "CCC"}, today=D(2024, 5, 10), stats=stats
        )

    assert changed == [1, 3]
    assert read_prices(lake)["stock_id"].unique(maintain_order=True).to_list() == [1, 3]
    assert stats == {
        "failed": [(2, "BBB", 500)], "empty": 0, "fetched": 2, "answered": [1, 3], "stopped": None
    }  # fmt: skip
    assert any("BBB" in r.getMessage() for r in caplog.records)


def test_stats_count_tickers_that_come_back_empty_and_network_failures(tmp_path):
    lake = Lake(tmp_path)
    source = Recording(FixtureSource({"AAA": daily(*WEEK1)}), {"NET": fetch_error("NET", None)})
    stats: dict = {}

    update_prices(lake, source, {1: "AAA", 2: "GONE", 3: "NET"}, today=D(2024, 5, 10), stats=stats)

    assert stats == {
        "failed": [(3, "NET", None)], "empty": 1, "fetched": 1, "answered": [1, 2], "stopped": None
    }  # fmt: skip


def test_stats_are_optional_and_restarted_on_each_call(tmp_path):
    lake = Lake(tmp_path)
    source = FixtureSource({"AAA": daily(*WEEK1)})
    assert update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 10)) == [1]
    stats = {"failed": [(9, "OLD", 500)], "empty": 7, "fetched": 7, "answered": [9], "stopped": "old"}

    update_prices(lake, source, {1: "AAA"}, today=D(2024, 5, 17), stats=stats)

    assert stats == {"failed": [], "empty": 0, "fetched": 1, "answered": [1], "stopped": None}


def test_a_failed_ticker_keeps_its_last_good_data_and_is_retried_from_the_same_day(tmp_path):
    lake = Lake(tmp_path)
    frames = {"AAA": daily(*WEEK1, *WEEK2), "BBB": daily(*WEEK1, *WEEK2)}
    update_prices(lake, FixtureSource(frames), {1: "AAA"}, today=D(2024, 5, 10))

    down = Recording(FixtureSource(frames), {"AAA": fetch_error("AAA", 503)})
    assert update_prices(lake, down, {1: "AAA", 2: "BBB"}, today=D(2024, 5, 17)) == [2]
    assert read_prices(lake).filter(stock_id=1).height == 5  # nothing lost, nothing invented

    up = Recording(FixtureSource(frames))
    assert update_prices(lake, up, {1: "AAA", 2: "BBB"}, today=D(2024, 5, 24)) == []
    # the date AAA is retried from did not advance past its last good day (10 May)
    assert ("AAA", D(2024, 5, 5), D(2024, 5, 24)) in up.calls
    assert read_prices(lake).filter(stock_id=1).height == 10


def test_a_failed_new_ticker_is_retried_from_the_start_of_the_history(tmp_path):
    lake = Lake(tmp_path)
    frames = {"AAA": daily(*WEEK1)}
    down = Recording(FixtureSource(frames), {"AAA": fetch_error("AAA", 500)})
    assert update_prices(lake, down, {1: "AAA"}, today=D(2024, 5, 10)) == []
    assert lake.parts(TABLE) == []

    up = Recording(FixtureSource(frames))
    assert update_prices(lake, up, {1: "AAA"}, today=D(2024, 5, 17)) == [1]
    assert up.calls == [("AAA", D(2013, 1, 1), D(2024, 5, 17))]


@pytest.mark.parametrize("status", [401, 403, 429])
def test_the_breaker_stops_on_an_auth_or_rate_limit_error_and_keeps_earlier_rows(tmp_path, status):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC", "DDD")}
    source = Recording(FixtureSource(frames), {"CCC": fetch_error("CCC", status)})
    stats: dict = {}

    changed = update_prices(
        lake, source, {1: "AAA", 2: "BBB", 3: "CCC", 4: "DDD"}, today=D(2024, 5, 10), stats=stats
    )

    assert [c[0] for c in source.calls] == ["AAA", "BBB", "CCC"]  # DDD was never requested
    assert changed == [1, 2]
    assert read_prices(lake)["stock_id"].unique(maintain_order=True).to_list() == [1, 2]
    assert stats["failed"] == [(3, "CCC", status)]
    assert str(status) in stats["stopped"]


def test_the_breaker_stops_after_25_consecutive_failures_and_keeps_earlier_rows(tmp_path):
    lake = Lake(tmp_path)
    good = {f"G{i}": daily(*WEEK1) for i in range(1, 4)}
    tickers = {i: f"G{i}" for i in range(1, 4)} | {i: f"B{i}" for i in range(4, 40)}
    source = Recording(
        FixtureSource(good), {f"B{i}": fetch_error(f"B{i}", 500) for i in range(4, 40)}
    )
    stats: dict = {}

    changed = update_prices(lake, source, tickers, today=D(2024, 5, 10), stats=stats)

    assert changed == [1, 2, 3]
    assert len(source.calls) == 3 + 25
    assert len(stats["failed"]) == 25
    assert "25" in stats["stopped"]
    assert read_prices(lake)["stock_id"].n_unique() == 3


def test_a_success_resets_the_consecutive_failure_count(tmp_path):
    lake = Lake(tmp_path)
    tickers = {i: f"B{i}" for i in range(1, 25)} | {25: "AAA"} | {i: f"B{i}" for i in range(26, 50)}
    errors = {t: fetch_error(t, 500) for t in tickers.values() if t != "AAA"}
    source = Recording(FixtureSource({"AAA": daily(*WEEK1)}), errors)
    stats: dict = {}

    update_prices(lake, source, tickers, today=D(2024, 5, 10), stats=stats)

    assert len(source.calls) == 49  # 24 failures, a success, 24 failures: the breaker never trips
    assert len(stats["failed"]) == 48
    assert stats["stopped"] is None


def test_progress_is_flushed_every_n_tickers_so_a_crash_keeps_what_was_fetched(tmp_path):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC", "DDD", "EEE")}
    source = Recording(FixtureSource(frames), {"EEE": RuntimeError("job killed")})
    tickers = {1: "AAA", 2: "BBB", 3: "CCC", 4: "DDD", 5: "EEE"}

    with pytest.raises(RuntimeError, match="job killed"):
        update_prices(lake, source, tickers, today=D(2024, 5, 10), flush_every=2)

    # flushed after BBB and DDD (2 and 4 tickers done); nothing of EEE
    assert read_prices(lake)["stock_id"].unique(maintain_order=True).to_list() == [1, 2, 3, 4]
    assert lake.parts(TABLE) == ["z20240510-0001", "z20240510-0002"]


def test_each_flush_writes_a_new_part_and_none_is_rewritten(tmp_path, monkeypatch):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC", "DDD", "EEE")}
    tickers = {1: "AAA", 2: "BBB", 3: "CCC", 4: "DDD", 5: "EEE"}
    written, real_write = [], Lake.write

    def recording_write(self, table, df, part=None):
        written.append((part, df.height))
        return real_write(self, table, df, part)

    def no_part_read(self, table, part=None):
        pytest.fail(f"a flush read back {part}")  # extending a part is O(n^2) over a backfill

    monkeypatch.setattr(Lake, "write", recording_write)
    monkeypatch.setattr(Lake, "read", no_part_read)
    changed = update_prices(
        lake, FixtureSource(frames), tickers, today=D(2024, 5, 10), flush_every=2
    )
    monkeypatch.undo()

    assert changed == [1, 2, 3, 4, 5]
    assert written == [("z20240510-0001", 10), ("z20240510-0002", 10), ("z20240510-0003", 5)]
    assert lake.parts(TABLE) == ["z20240510-0001", "z20240510-0002", "z20240510-0003"]
    assert read_prices(lake).height == 25


def test_a_crash_before_the_first_flush_stores_nothing(tmp_path):
    lake = Lake(tmp_path)
    source = Recording(FixtureSource({"AAA": daily(*WEEK1)}), {"BBB": RuntimeError("bug")})

    with pytest.raises(RuntimeError):
        update_prices(lake, source, {1: "AAA", 2: "BBB"}, today=D(2024, 5, 10))

    assert lake.parts(TABLE) == []


def test_read_prices_of_an_empty_lake_has_the_schema(tmp_path):
    out = read_prices(Lake(tmp_path))
    assert out.is_empty()
    assert out.schema == PRICES_SCHEMA


def test_read_prices_keeps_the_last_occurrence_in_part_order_and_sorts(tmp_path):
    lake = Lake(tmp_path)
    lake.write(
        TABLE,
        stored((2, D(2024, 1, 3), 5.0, 1.0, 1.0, 0.0), (1, D(2024, 1, 3), 9.0, 1.0, 1.0, 0.0)),
        "y2024",
    )
    lake.write(
        TABLE,
        stored((1, D(2024, 1, 2), 8.0, 1.0, 1.0, 0.0), (1, D(2024, 1, 3), 10.0, 1.0, 1.0, 0.0)),
        "z20240110",
    )
    lake.write(TABLE, stored((1, D(2024, 1, 3), 11.0, 1.0, 1.0, 0.0)), "z20240120")

    out = read_prices(lake)

    assert out.select("stock_id", "date", "close").rows() == [
        (1, D(2024, 1, 2), 8.0),
        (1, D(2024, 1, 3), 11.0),  # newest run wins
        (2, D(2024, 1, 3), 5.0),
    ]


# --- compaction -------------------------------------------------------------------------


def test_compaction_keeps_rows(tmp_path):
    lake = Lake(tmp_path)
    year_end = [bar(D(2023, 12, 27), 20.0), bar(D(2023, 12, 28), 21.0), bar(D(2023, 12, 29), 22.0)]
    new_year = [bar(D(2024, 1, 2), 23.0), bar(D(2024, 1, 3), 24.0), bar(D(2024, 1, 4), 25.0)]
    frames = {"AAA": daily(*year_end, *new_year), "BBB": daily(*year_end, *new_year)}
    update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 1, 2))
    frames["AAA"] = daily(*year_end, bar(D(2024, 1, 2), 23.5), *new_year[1:])  # 2 Jan restated
    update_prices(lake, FixtureSource(frames), {1: "AAA", 2: "BBB"}, today=D(2024, 1, 4))
    before = read_prices(lake)
    assert lake.parts(TABLE) == ["z20240102-0001", "z20240104-0001"]

    compact_prices(lake)

    assert lake.parts(TABLE) == ["y2023", "y2024"]
    assert not list((tmp_path / TABLE).glob("z*.parquet"))
    assert read_prices(lake).equals(before)
    assert before.height == 12
    assert before.filter(stock_id=1, date=D(2024, 1, 2))["close"].to_list() == [23.5]
    assert lake.read(TABLE, part="y2023")["date"].dt.year().unique().to_list() == [2023]
    assert lake.read(TABLE, part="y2024")["date"].dt.year().unique().to_list() == [2024]
    assert lake.read(TABLE).height == 12  # compaction dropped the superseded 2 Jan row too


def test_compaction_merges_new_runs_into_existing_yearly_parts(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    compact_prices(lake)
    assert lake.parts(TABLE) == ["y2024"]
    fixed = [bar(D(2024, 5, 10), 77.0)]
    update_prices(
        lake, FixtureSource({"AAA": daily(*fixed, *WEEK2)}), {1: "AAA"}, today=D(2024, 5, 17)
    )
    assert lake.parts(TABLE) == ["y2024", "z20240517-0001"]
    before = read_prices(lake)

    compact_prices(lake)

    assert lake.parts(TABLE) == ["y2024"]
    assert lake.read(TABLE).height == 10  # one row per day, the restated 10 May replaced in place
    assert read_prices(lake).equals(before)
    assert before.filter(pl.col("date") == D(2024, 5, 10))["close"].to_list() == [77.0]


def test_compaction_is_idempotent_and_ignores_an_empty_lake(tmp_path):
    lake = Lake(tmp_path)
    compact_prices(lake)
    assert lake.parts(TABLE) == []

    update_prices(lake, FixtureSource({"AAA": daily(*WEEK1)}), {1: "AAA"}, today=D(2024, 5, 10))
    compact_prices(lake)
    once = read_prices(lake)
    compact_prices(lake)

    assert lake.parts(TABLE) == ["y2024"]
    assert read_prices(lake).equals(once)


def test_tickers_are_fetched_in_the_order_given(tmp_path):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC")}
    source = Recording(FixtureSource(frames))

    update_prices(lake, source, {3: "CCC", 1: "AAA", 2: "BBB"}, today=D(2024, 5, 10))

    assert [c[0] for c in source.calls] == ["CCC", "AAA", "BBB"]


def test_should_stop_ends_the_run_before_the_next_ticker_and_keeps_what_it_has(tmp_path):
    lake = Lake(tmp_path)
    frames = {t: daily(*WEEK1) for t in ("AAA", "BBB", "CCC")}
    source = Recording(FixtureSource(frames))
    stats: dict = {}

    changed = update_prices(
        lake,
        source,
        {1: "AAA", 2: "BBB", 3: "CCC"},
        today=D(2024, 5, 10),
        stats=stats,
        should_stop=lambda: len(source.calls) >= 2,
    )

    assert [c[0] for c in source.calls] == ["AAA", "BBB"]
    assert changed == [1, 2]
    assert stats["stopped"] == "time budget"
    assert read_prices(lake)["stock_id"].unique().sort().to_list() == [1, 2]


def test_run_parts_and_their_stocks_cover_old_and_numbered_parts(tmp_path):
    lake = Lake(tmp_path)
    row = (1, D(2024, 1, 3), 5.0, 1.0, 1.0, 0.0)
    lake.write(TABLE, stored(row), "y2024")
    lake.write(TABLE, stored(row), "z20240110")  # a part from before parts were numbered
    lake.write(TABLE, stored((2, *row[1:])), "z20240110-0001")
    lake.write(TABLE, stored((3, *row[1:])), "z20240110-0002")
    lake.write(TABLE, stored((4, *row[1:])), "z20240117-0001")

    assert run_parts(lake, "20240110") == ["z20240110", "z20240110-0001", "z20240110-0002"]
    assert part_stocks(lake, run_parts(lake, "20240110")) == {1, 2, 3}
    assert part_stocks(lake, []) == set()
    assert price_runs(lake) == {"20240110", "20240117"}


def test_compaction_folds_every_numbered_part_of_every_run(tmp_path):
    lake = Lake(tmp_path)
    year_end = [bar(D(2023, 12, 28), 21.0), bar(D(2023, 12, 29), 22.0)]
    new_year = [bar(D(2024, 1, 2), 23.0), bar(D(2024, 1, 3), 24.0)]
    frames = {t: daily(*year_end, *new_year) for t in ("AAA", "BBB", "CCC")}
    tickers = {1: "AAA", 2: "BBB", 3: "CCC"}
    update_prices(lake, FixtureSource(frames), tickers, today=D(2024, 1, 2), flush_every=1)
    frames["BBB"] = daily(*year_end, bar(D(2024, 1, 2), 23.5), *new_year[1:])  # 2 Jan restated
    update_prices(lake, FixtureSource(frames), tickers, today=D(2024, 1, 4), flush_every=1)
    assert len(lake.parts(TABLE)) == 6  # three flushes in each run
    before = read_prices(lake)

    compact_prices(lake)

    assert lake.parts(TABLE) == ["y2023", "y2024"]
    assert read_prices(lake).equals(before)
    assert before.filter(stock_id=2, date=D(2024, 1, 2))["close"].to_list() == [23.5]


# --- revisions in the open quarter -----------------------------------------------------------

JUNE = [bar(D(2024, 6, d), 10.0 + d) for d in (24, 25, 26, 27, 28)]
JULY = [bar(D(2024, 7, d), 40.0 + d) for d in (1, 2, 3)]  # Q3 2024, still open on 5 July
CLOSED_UNTIL = D(2024, 6, 30)  # the last closed quarter's end


def revised(bars, day, **fields):
    return [dict(b, **fields) if b["date"] == day else b for b in bars]


def test_a_revision_in_the_open_quarter_is_not_a_history_change(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*JUNE, *JULY)}), {1: "AAA"}, D(2024, 7, 3))
    fixed = revised(JULY, D(2024, 7, 2), close=99.0)

    changed = update_prices(
        lake,
        FixtureSource({"AAA": daily(*JUNE, *fixed)}),
        {1: "AAA"},
        D(2024, 7, 5),
        history_until=CLOSED_UNTIL,
    )

    assert changed == []  # no fund's files use the open quarter's prices
    assert read_prices(lake).filter(date=D(2024, 7, 2))["close"].to_list() == [99.0]  # stored


def test_a_revision_on_or_before_the_last_closed_quarter_end_is_a_change(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*JUNE, *JULY)}), {1: "AAA"}, D(2024, 7, 3))
    fixed = revised(JUNE, D(2024, 6, 28), close=99.0)

    changed = update_prices(
        lake,
        FixtureSource({"AAA": daily(*fixed, *JULY)}),
        {1: "AAA"},
        D(2024, 7, 5),
        history_until=CLOSED_UNTIL,
    )

    assert changed == [1]


@pytest.mark.parametrize("before, after", [(1.0, 2.0), (2.0, 1.0), (2.0, 3.0)])
def test_a_split_factor_change_in_the_open_quarter_is_a_change(tmp_path, before, after):
    lake = Lake(tmp_path)
    july = revised(JULY, D(2024, 7, 2), split_factor=before)
    update_prices(lake, FixtureSource({"AAA": daily(*JUNE, *july)}), {1: "AAA"}, D(2024, 7, 3))

    changed = update_prices(
        lake,
        FixtureSource({"AAA": daily(*JUNE, *revised(july, D(2024, 7, 2), split_factor=after))}),
        {1: "AAA"},
        D(2024, 7, 5),
        history_until=CLOSED_UNTIL,
    )

    assert changed == [1]  # a split re-bases every older price, open quarter or not


def test_a_new_split_day_in_the_open_quarter_is_a_change(tmp_path):
    lake = Lake(tmp_path)
    update_prices(lake, FixtureSource({"AAA": daily(*JUNE, *JULY)}), {1: "AAA"}, D(2024, 7, 3))
    later = [bar(D(2024, 7, 5), 21.0, split=2.0)]

    changed = update_prices(
        lake,
        FixtureSource({"AAA": daily(*JUNE, *JULY, *later)}),
        {1: "AAA"},
        D(2024, 7, 5),
        history_until=CLOSED_UNTIL,
    )

    assert changed == [1]
