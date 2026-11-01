import io
import zipfile
from datetime import date

import httpx
import polars as pl

from orca.http import Client
from orca.vendor import (
    UNIVERSE_SCHEMA,
    candidates,
    load_universe,
    parse_universe,
    resolve,
)

CSV = b"""ticker,exchange,assetType,priceCurrency,startDate,endDate
AAPL,NASDAQ,Stock,USD,1980-12-12,2026-10-30
brk.b,NYSE,Stock,USD,1996-05-09,2026-10-30
XLNX,NASDAQ,Stock,USD,1990-06-18,2022-02-14
000001,SHE,Stock,CNY,2007-01-04,2026-10-30
NODATE,NYSE,Stock,USD,,
"""


def universe(*rows) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=UNIVERSE_SCHEMA, orient="row")


def test_parse_keeps_usd_tickers_with_dates_in_sec_style():
    parsed = parse_universe(CSV)
    assert parsed.rows() == [
        ("AAPL", date(1980, 12, 12), date(2026, 10, 30)),
        ("BRK-B", date(1996, 5, 9), date(2026, 10, 30)),
        ("XLNX", date(1990, 6, 18), date(2022, 2, 14)),
    ]


def test_load_universe_reads_the_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("supported_tickers.csv", CSV)
    body = buffer.getvalue()
    serve = httpx.MockTransport(lambda request: httpx.Response(200, content=body))
    client = Client(1e6, {}, transport=serve)
    assert load_universe(client)["ticker"].to_list() == ["AAPL", "BRK-B", "XLNX"]


def test_candidates_drop_a_currency_suffix():
    assert candidates("XLNXEUR") == ["XLNXEUR", "XLNX"]
    assert candidates("TWTRUSD") == ["TWTRUSD", "TWTR"]
    assert candidates("AAPL") == ["AAPL"]
    assert candidates("USD") == ["USD"]
    assert candidates(None) == []


def test_resolve_picks_the_listed_ticker_over_the_held_days():
    u = universe(
        ("AAPL", date(1980, 12, 12), date(2026, 10, 30)),
        ("XLNX", date(1990, 6, 18), date(2022, 2, 14)),
        ("FB", date(2025, 6, 26), date(2026, 10, 30)),  # a later fund reusing the ticker
        ("OLD", date(2010, 1, 4), date(2014, 3, 31)),
        ("OLD", date(2019, 1, 2), date(2026, 10, 30)),  # reused: both lines are kept
    )
    held = {
        1: (date(2013, 1, 1), date(2026, 9, 30)),
        2: (date(2015, 1, 1), date(2021, 12, 31)),
        3: (date(2013, 1, 1), date(2021, 12, 31)),  # held only before FB's line starts
        4: (date(2013, 1, 1), date(2013, 12, 31)),
    }
    out = resolve({1: "AAPL", 2: "XLNXEUR", 3: "FB", 4: "OLD", 5: "NONE", 6: None}, held, u)
    assert out.rows() == [
        (1, "AAPL", date(2026, 10, 30)),
        (2, "XLNX", date(2022, 2, 14)),
        (4, "OLD", date(2014, 3, 31)),
    ]


def test_resolve_takes_any_span_for_a_stock_never_held():
    u = universe(("SPY", date(1993, 1, 29), date(2026, 10, 30)))
    assert resolve({9: "SPY"}, {}, u).rows() == [(9, "SPY", date(2026, 10, 30))]
