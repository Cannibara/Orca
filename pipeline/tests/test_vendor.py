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
        4: (date(2013, 1, 1), date(2013, 12, 31)),  # only the older line of a reused ticker
        7: (date(2020, 1, 1), date(2026, 9, 30)),  # the current line of that ticker
    }
    tickers = {1: "AAPL", 2: "XLNXEUR", 3: "FB", 4: "OLD", 5: "NONE", 6: None, 7: "OLD"}
    out = resolve(tickers, held, u)
    # The vendor serves "OLD" for whoever trades under it today: stock 4 would get the later
    # company's prices, so it gets none.
    assert out.rows() == [
        (1, "AAPL", date(2026, 10, 30)),
        (2, "XLNX", date(2022, 2, 14)),
        (7, "OLD", date(2026, 10, 30)),
    ]


def test_resolve_takes_any_span_for_a_stock_never_held():
    u = universe(("SPY", date(1993, 1, 29), date(2026, 10, 30)))
    assert resolve({9: "SPY"}, {}, u).rows() == [(9, "SPY", date(2026, 10, 30))]


def test_candidates_repair_foreign_listings_of_a_delisted_us_stock():
    assert candidates("EA*") == ["EA*", "EA"]  # a Mexican listing
    assert candidates("PXGBX") == ["PXGBX", "PX"]  # pence
    assert candidates("RTN1USD") == ["RTN1USD", "RTN1", "RTN"]
    assert candidates("LEG1*") == ["LEG1*", "LEG1", "LEG"]
    assert candidates("18322EUR") == ["18322EUR", "18322"]  # no empty ticker
    assert candidates("HN9") == ["HN9"]  # digits alone are never cut
    assert candidates("*") == ["*"]


def test_candidates_end_with_the_alternates_once():
    assert candidates("EXMOC", ["XOM", "XOM", ""]) == ["EXMOC", "XOM"]
    assert candidates(None, ["ZK"]) == ["ZK"]
    assert candidates("AAPL", ["AAPL"]) == ["AAPL"]


def test_resolve_tries_the_alternates_after_the_own_ticker():
    u = universe(
        ("XOM", date(1970, 1, 2), date(2026, 11, 13)),
        ("ZK", date(2024, 5, 10), date(2025, 12, 19)),
        ("OLDCO", date(2000, 1, 3), date(2005, 6, 30)),
    )
    held = {
        1: (date(2013, 1, 1), date(2026, 9, 30)),
        2: (date(2024, 7, 1), date(2025, 9, 30)),
        3: (date(2013, 1, 1), date(2020, 12, 31)),  # the alternate traded before it was held
    }
    out = resolve(
        {1: "EXMOC", 2: "ZKN", 3: "OLDC"}, held, u, {1: ["XOM"], 2: ["ZK"], 3: ["OLDCO"]}
    )
    assert out.rows() == [(1, "XOM", date(2026, 11, 13)), (2, "ZK", date(2025, 12, 19))]


def test_resolve_refuses_a_ticker_reused_after_the_stock_was_held():
    u = universe(
        ("APC", date(1986, 9, 9), date(2019, 8, 8)),  # Anadarko
        ("APC", date(2026, 2, 12), date(2026, 11, 13)),  # another company
        ("WOLF", date(1993, 2, 9), date(2025, 9, 26)),
        ("WOLF", date(2025, 9, 29), date(2026, 11, 13)),  # the same listing after 3 days
    )
    held = {
        1: (date(2013, 1, 1), date(2026, 6, 30)),  # a filer still reports Anadarko in 2026
        2: (date(2026, 4, 1), date(2026, 9, 30)),  # the new company, held only after its listing
        3: (date(2013, 1, 1), date(2026, 9, 30)),
    }
    out = resolve({1: "APC", 2: "APC", 3: "WOLF"}, held, u)
    assert out.rows() == [(2, "APC", date(2026, 11, 13)), (3, "WOLF", date(2026, 11, 13))]
