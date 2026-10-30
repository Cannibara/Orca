import csv
import json

import httpx
import polars as pl
import pytest

from orca import securities
from orca.http import Client, FetchError, FigiClient, figi_client
from orca.securities import (
    assign_stock_ids,
    fetch_shares_outstanding,
    fetch_sic,
    load_sec_tickers,
    map_cusips,
    normalise_name,
    normalise_ticker,
    sector_for_sic,
)

FIGI_URL = "https://api.openfigi.com/v3/mapping"


def make_client(handler) -> Client:
    return Client(1000, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None)


def make_figi_client(handler, jobs_per_request: int = 100) -> FigiClient:
    return FigiClient(
        1000,
        {},
        transport=httpx.MockTransport(handler),
        sleep=lambda s: None,
        jobs_per_request=jobs_per_request,
    )


def tickers_frame(*rows: tuple[str, int, str]) -> pl.DataFrame:
    return pl.DataFrame(
        rows,
        schema=pl.Schema({"ticker": pl.String, "cik": pl.Int64, "title": pl.String}),
        orient="row",
    )


NO_TICKERS = tickers_frame()


def hit(figi, ticker, name, **extra):
    return {
        "figi": figi,
        "ticker": ticker,
        "name": name,
        "exchCode": "US",
        "securityType": "Common Stock",
        **extra,
    }


def found(*listings: dict) -> dict:
    return {"data": list(listings)}


def figi_handler(results: dict[str, dict], seen: list | None = None):
    """OpenFIGI stub: answers each job from `results` (cusip -> response entry)."""

    def handler(request):
        jobs = json.loads(request.content)
        if seen is not None:
            seen.append(request)
        body = [results.get(job["idValue"], {"warning": "No identifier found."}) for job in jobs]
        return httpx.Response(200, json=body)

    return handler


def mapped_frame(*rows: tuple) -> pl.DataFrame:
    """Rows of (cusip, figi, ticker, name, is_etf, method)."""
    return pl.DataFrame(
        rows,
        schema=pl.Schema(
            {
                "cusip": pl.String,
                "figi": pl.String,
                "ticker": pl.String,
                "name": pl.String,
                "is_etf": pl.Boolean,
                "method": pl.String,
            }
        ),
        orient="row",
    )


def securities_frame(*rows: tuple) -> pl.DataFrame:
    """Rows of (stock_id, figi, ticker, name, is_etf)."""
    return pl.DataFrame(
        rows,
        schema=pl.Schema(
            {
                "stock_id": pl.Int32,
                "figi": pl.String,
                "ticker": pl.String,
                "name": pl.String,
                "is_etf": pl.Boolean,
            }
        ),
        orient="row",
    )


# --- OpenFIGI ---------------------------------------------------------------------------


def test_openfigi_batches_of_100(monkeypatch):
    monkeypatch.setenv("OPENFIGI_KEY", "k")
    cusips = [f"{i:09d}" for i in range(250)]
    results = {c: found(hit(f"BBG{c}", f"T{c}", f"Name {c}")) for c in cusips}
    seen = []
    client = figi_client(httpx.MockTransport(figi_handler(results, seen)), sleep=lambda s: None)

    out = map_cusips(cusips, {}, client, NO_TICKERS)

    assert [len(json.loads(r.content)) for r in seen] == [100, 100, 50]
    assert all(r.method == "POST" and str(r.url) == FIGI_URL for r in seen)
    sent = [job for r in seen for job in json.loads(r.content)]
    assert sent == [{"idType": "ID_CUSIP", "idValue": c} for c in cusips]
    assert out["cusip"].to_list() == cusips
    assert out["method"].unique().to_list() == ["openfigi"]


def test_openfigi_without_key_uses_batches_of_10(monkeypatch):
    monkeypatch.delenv("OPENFIGI_KEY", raising=False)
    cusips = [f"{i:09d}" for i in range(25)]
    seen = []
    client = figi_client(httpx.MockTransport(figi_handler({}, seen)), sleep=lambda s: None)

    map_cusips(cusips, {}, client, NO_TICKERS)

    assert [len(json.loads(r.content)) for r in seen] == [10, 10, 5]


def test_duplicate_cusips_are_looked_up_once():
    seen = []
    client = make_figi_client(figi_handler({"A": found(hit("BBG1", "AAA", "Aaa Inc"))}, seen))

    out = map_cusips(["A", "A", "B", "A"], {}, client, NO_TICKERS)

    assert [job["idValue"] for r in seen for job in json.loads(r.content)] == ["A", "B"]
    assert out["cusip"].to_list() == ["A", "B"]


def test_no_cusips_makes_no_request_and_keeps_schema():
    client = make_figi_client(lambda request: pytest.fail("unexpected request"))

    out = map_cusips([], {}, client, NO_TICKERS)

    assert out.height == 0
    assert out.schema == mapped_frame().schema


def test_openfigi_prefers_us_listing_and_composite_figi():
    results = {
        "C1": {
            "data": [
                hit("BBG-LSE", "AAPL", "Apple Inc", exchCode="LN"),
                hit("BBG-US", "AAPL", "APPLE INC", compositeFIGI="BBG-COMP"),
                hit("BBG-US2", "AAPL2", "Other", exchCode="US"),
            ]
        },
        # no US listing: first entry; no compositeFIGI: figi
        "C2": found(
            hit("BBG-X1", "XXX", "Xxx Plc", exchCode="LN"),
            hit("BBG-X2", "XXY", "Y", exchCode="GR"),
        ),
    }
    client = make_figi_client(figi_handler(results))

    out = map_cusips(["C1", "C2"], {}, client, NO_TICKERS).to_dicts()

    assert out[0] == {
        "cusip": "C1",
        "figi": "BBG-COMP",
        "ticker": "AAPL",
        "name": "APPLE INC",
        "is_etf": False,
        "method": "openfigi",
    }
    assert (out[1]["figi"], out[1]["ticker"], out[1]["name"]) == ("BBG-X1", "XXX", "Xxx Plc")


def test_etp_security_type_is_an_etf_case_insensitively():
    results = {
        "C1": {"data": [hit("F1", "SPY", "SPDR S&P 500 ETF", securityType="ETP")]},
        "C2": {"data": [hit("F2", "QQQ", "Invesco QQQ", securityType="etp")]},
        "C3": {"data": [hit("F3", "AAA", "Aaa", securityType="Depositary Receipt")]},
        "C4": {"data": [hit("F4", "BBB", "Bbb", securityType=None)]},
    }
    client = make_figi_client(figi_handler(results))

    out = map_cusips(["C1", "C2", "C3", "C4"], {}, client, NO_TICKERS)

    assert out["is_etf"].to_list() == [True, True, False, False]


def test_misaligned_openfigi_response_is_an_error():
    client = make_figi_client(lambda request: httpx.Response(200, json=[{"warning": "x"}]))

    with pytest.raises(ValueError, match="2 jobs"):
        map_cusips(["A", "B"], {}, client, NO_TICKERS)


def test_openfigi_http_error_propagates():
    client = make_figi_client(lambda request: httpx.Response(401))

    with pytest.raises(FetchError) as exc:
        map_cusips(["A"], {}, client, NO_TICKERS)

    assert exc.value.status == 401


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("AAPL", "AAPL"),
        ("BRK/B", "BRK-B"),
        ("BRK.B", "BRK-B"),
        ("brk-b", "BRK-B"),
        (" bf.b ", "BF-B"),
        (None, None),
    ],
)
def test_normalise_ticker(raw, expected):
    assert normalise_ticker(raw) == expected


def test_openfigi_tickers_use_the_sec_style():
    results = {
        "C1": found(hit("F1", "BRK/B", "BERKSHIRE HATHAWAY INC-CL B")),
        "C2": found(hit("F2", "bf.b", "BROWN FORMAN CORP-CLASS B")),
        "C3": found(hit("F3", None, "NO TICKER")),
    }
    client = make_figi_client(figi_handler(results))

    out = map_cusips(["C1", "C2", "C3"], {}, client, NO_TICKERS)

    assert out["ticker"].to_list() == ["BRK-B", "BF-B", None]


def test_name_matched_ticker_uses_the_sec_style():
    sec = tickers_frame(("BRK.B", 1067983, "Berkshire Hathaway Inc"))
    client = make_figi_client(figi_handler({}))

    out = map_cusips(["C1"], {"C1": "BERKSHIRE HATHAWAY INC"}, client, sec)

    assert out.row(0, named=True)["ticker"] == "BRK-B"


# --- name fallback and unmapped -------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("APPLE INC", "APPLE"),
        ("Apple Inc.", "APPLE"),
        ("AMAZON COM INC", "AMAZON"),
        ("Amazon.com, Inc.", "AMAZON"),
        ("ALPHABET INC CL A", "ALPHABET"),
        ("BERKSHIRE HATHAWAY INC CL B", "BERKSHIRE HATHAWAY"),
        ("LIBERTY GLOBAL PLC CL A/B", "LIBERTY GLOBAL"),
        ("MOODYS CORP", "MOODYS"),
        ("Moody's Corp", "MOODYS"),
        ("PROCTER & GAMBLE CO", "PROCTER GAMBLE"),
        ("AT&T INC", "AT T"),
        ("SOME HOLDINGS LTD", "SOME HOLDINGS"),
        ("INC", ""),
    ],
)
def test_normalise_name(raw, expected):
    assert normalise_name(raw) == expected


def test_name_fallback_exact_normalised_match():
    sec = tickers_frame(
        ("AAPL", 320193, "Apple Inc."),
        ("APLE", 1418121, "Apple Hospitality REIT, Inc."),
    )
    client = make_figi_client(figi_handler({}))

    out = map_cusips(
        ["037833100", "03784Y200"],
        {"037833100": "APPLE INC", "03784Y200": "APPLE HOSPITALITY"},
        client,
        sec,
    ).to_dicts()

    assert out[0] == {
        "cusip": "037833100",
        "figi": None,
        "ticker": "AAPL",
        "name": "Apple Inc.",
        "is_etf": False,
        "method": "name",
    }
    assert out[1]["method"] == "unmapped"


def test_name_fallback_needs_exactly_one_sec_row():
    sec = tickers_frame(
        ("GOOGL", 1652044, "Alphabet Inc."),
        ("GOOG", 1652044, "Alphabet Inc."),
    )
    client = make_figi_client(figi_handler({}))

    out = map_cusips(["02079K305"], {"02079K305": "ALPHABET INC CL A"}, client, sec)

    assert out["method"].to_list() == ["unmapped"]


def test_name_fallback_is_only_for_cusips_openfigi_did_not_map():
    sec = tickers_frame(("AAPL", 320193, "Apple Inc."))
    client = make_figi_client(figi_handler({"C1": {"data": [hit("F1", "APC", "APPLE CO")]}}))

    out = map_cusips(["C1", "C2"], {"C1": "APPLE INC", "C2": "APPLE INC"}, client, sec).to_dicts()

    assert (out[0]["method"], out[0]["ticker"], out[0]["figi"]) == ("openfigi", "APC", "F1")
    assert (out[1]["method"], out[1]["ticker"], out[1]["figi"]) == ("name", "AAPL", None)


def test_unmapped_marked():
    sec = tickers_frame(("AAPL", 320193, "Apple Inc."))
    client = make_figi_client(figi_handler({"C3": {"error": "Invalid idValue format"}}))

    out = map_cusips(["C1", "C2", "C3"], {"C1": "UNKNOWN CORP"}, client, sec).to_dicts()

    # C1: name matches nothing. C2: no issuer name at all. C3: an error entry.
    for row, cusip in zip(out, ["C1", "C2", "C3"]):
        assert row == {
            "cusip": cusip,
            "figi": None,
            "ticker": None,
            "name": None,
            "is_etf": False,
            "method": "unmapped",
        }


def test_mapped_frame_schema():
    client = make_figi_client(figi_handler({"A": found(hit("F", "T", "N"))}))

    out = map_cusips(["A", "B"], {}, client, NO_TICKERS)

    assert out.schema == mapped_frame().schema


# --- stock ids ------------------------------------------------------------------------------


def test_stock_ids_are_stable():
    first = assign_stock_ids(
        mapped_frame(
            ("C1", "F1", "AAA", "Aaa", False, "openfigi"),
            ("C2", "F2", "BBB", "Bbb", True, "openfigi"),
        ),
        securities_frame(),
    )
    assert first["stock_id"].to_list() == [1, 2]

    second = assign_stock_ids(
        mapped_frame(
            ("C2", "F2", "BBB", "Bbb renamed", True, "openfigi"),
            ("C3", "F3", "CCC", "Ccc", False, "openfigi"),
            ("C1", "F1", "AAA", "Aaa", False, "openfigi"),
        ),
        first,
    )

    assert second["stock_id"].to_list() == [1, 2, 3]
    assert second["figi"].to_list() == ["F1", "F2", "F3"]
    assert second.head(2).equals(first)  # existing rows unchanged, even a changed name
    assert second.schema == first.schema


def test_new_ids_continue_from_max_in_first_seen_order():
    existing = securities_frame((5, "F5", "EEE", "Eee", False), (9, "F9", "III", "Iii", False))

    out = assign_stock_ids(
        mapped_frame(
            ("C1", "FB", "BBB", "Bbb", False, "openfigi"),
            ("C2", "FA", "AAA", "Aaa", False, "openfigi"),
            ("C3", "F9", "III", "Iii", False, "openfigi"),
        ),
        existing,
    )

    assert out["stock_id"].to_list() == [5, 9, 10, 11]
    assert out["figi"].to_list() == ["F5", "F9", "FB", "FA"]


def test_identity_key_is_figi_else_ticker():
    existing = securities_frame((1, None, "AAPL", "Apple Inc.", False))

    out = assign_stock_ids(
        mapped_frame(
            ("C1", None, "AAPL", "Apple Inc.", False, "name"),  # ticker key: already known
            ("C2", "F2", "TSLA", "Tesla", False, "openfigi"),  # figi key: new
            ("C3", "F2", "TSLA", "Tesla", False, "openfigi"),  # same figi: same security
            ("C4", None, "MSFT", "Microsoft Corp.", False, "name"),  # ticker key: new
            ("C5", None, "MSFT", "Microsoft Corp.", False, "name"),  # same ticker: same security
        ),
        existing,
    )

    assert out["stock_id"].to_list() == [1, 2, 3]
    assert out["ticker"].to_list() == ["AAPL", "TSLA", "MSFT"]
    assert out["figi"].to_list() == [None, "F2", None]


def test_figi_and_ticker_keys_do_not_collide():
    out = assign_stock_ids(
        mapped_frame(
            ("C1", "ABC", "XYZ", "Xyz", False, "openfigi"),
            ("C2", None, "ABC", "Abc", False, "name"),
        ),
        securities_frame(),
    )

    assert out["stock_id"].to_list() == [1, 2]


def test_ticker_only_row_joins_the_figi_row_with_that_ticker_in_the_same_call():
    # The same issuer, seen once through OpenFIGI and once through the name fallback.
    for rows in (
        [
            ("C1", None, "AAPL", "Apple Inc.", False, "name"),
            ("C2", "F1", "AAPL", "APPLE INC", False, "openfigi"),
        ],
        [
            ("C2", "F1", "AAPL", "APPLE INC", False, "openfigi"),
            ("C1", None, "AAPL", "Apple Inc.", False, "name"),
        ],
    ):
        out = assign_stock_ids(mapped_frame(*rows), securities_frame())

        assert out["stock_id"].to_list() == [1]
        assert out["figi"].to_list() == ["F1"]
        assert out["ticker"].to_list() == ["AAPL"]


def test_ticker_only_row_joins_the_existing_figi_row_with_that_ticker():
    existing = securities_frame((7, "F1", "AAPL", "Apple Inc.", False))

    out = assign_stock_ids(
        mapped_frame(
            ("C1", None, "AAPL", "Apple Inc.", False, "name"),
            ("C2", None, "MSFT", "Microsoft Corp.", False, "name"),
        ),
        existing,
    )

    assert out["stock_id"].to_list() == [7, 8]
    assert out["ticker"].to_list() == ["AAPL", "MSFT"]
    assert out.head(1).equals(existing)


def test_unmapped_rows_get_no_id():
    out = assign_stock_ids(
        mapped_frame(
            ("C1", None, None, None, False, "unmapped"),
            ("C2", "F2", "BBB", "Bbb", False, "openfigi"),
        ),
        securities_frame(),
    )

    assert out["stock_id"].to_list() == [1]
    assert out["figi"].to_list() == ["F2"]


def test_assign_stock_ids_accepts_empty_inputs():
    empty = securities_frame()

    out = assign_stock_ids(mapped_frame(), empty)

    assert out.height == 0
    assert out.schema == empty.schema


def test_assign_stock_ids_accepts_lake_style_empty_existing():
    # Lake.read returns a frame with no columns when nothing has been written yet.
    out = assign_stock_ids(
        mapped_frame(("C1", "F1", "AAA", "Aaa", True, "openfigi")), pl.DataFrame()
    )

    assert out.schema == securities_frame().schema
    assert out.row(0) == (1, "F1", "AAA", "Aaa", True)


def test_assign_stock_ids_keeps_extra_columns_of_existing():
    existing = securities_frame((1, "F1", "AAA", "Aaa", False)).with_columns(sector=pl.lit("Tech"))

    out = assign_stock_ids(mapped_frame(("C2", "F2", "BBB", "Bbb", False, "openfigi")), existing)

    assert out["sector"].to_list() == ["Tech", None]
    assert out["stock_id"].to_list() == [1, 2]
    assert out.schema["stock_id"] == pl.Int32


# --- sectors ---------------------------------------------------------------------------------


def test_sector_for_sic():
    assert sector_for_sic(1221, False) == "Energy"
    assert sector_for_sic(2834, False) == "Health care"
    assert sector_for_sic(7372, False) == "Tech"
    assert sector_for_sic(6798, False) == "Real estate"
    assert sector_for_sic(None, False) == "Other"
    assert sector_for_sic(7372, True) == "ETF/Fund"
    assert sector_for_sic(None, True) == "ETF/Fund"


@pytest.mark.parametrize(
    ("sic", "sector"),
    [
        # specific ranges that sit inside broader ones must win
        (2834, "Health care"),  # pharma, inside chemicals 2800-2899
        (2836, "Health care"),
        (2810, "Materials"),
        (2844, "Consumer staples"),  # cosmetics, inside chemicals
        (2860, "Materials"),
        (3631, "Consumer discretionary"),  # appliances, inside electronics 3600-3699
        (3674, "Tech"),
        (3711, "Consumer discretionary"),  # cars, inside transport equipment 3700-3799
        (3721, "Industrials"),
        (5411, "Consumer staples"),  # grocery, inside retail 5200-5999
        (5812, "Consumer discretionary"),
        # one example per remaining range family
        (1311, "Energy"),
        (2911, "Energy"),
        (1040, "Materials"),
        (2621, "Materials"),
        (3312, "Materials"),
        (1531, "Industrials"),
        (3533, "Industrials"),
        (3585, "Industrials"),
        (4011, "Industrials"),
        (8711, "Industrials"),
        (2086, "Consumer staples"),
        (2111, "Consumer staples"),
        (2300, "Consumer discretionary"),
        (7011, "Consumer discretionary"),
        (7990, "Consumer discretionary"),
        (3845, "Health care"),
        (8062, "Health care"),
        (6022, "Financials"),
        (6770, "Financials"),
        (6799, "Financials"),
        (6512, "Real estate"),
        (3571, "Tech"),
        (2711, "Communication"),
        (4813, "Communication"),
        (7812, "Communication"),
        (4911, "Utilities"),
        (4941, "Utilities"),
        # ranges around the carve-outs
        (5122, "Health care"),  # drug wholesale, inside wholesale 5000-5199
        (5141, "Consumer staples"),  # grocery wholesale
        (5065, "Industrials"),
        (2250, "Consumer discretionary"),  # textiles
        (2450, "Materials"),  # wood products
        (3050, "Materials"),  # rubber and plastics
        (3021, "Consumer discretionary"),  # footwear, inside rubber and plastics 3000-3099
        (3011, "Materials"),
        (3150, "Consumer discretionary"),  # leather
        (3812, "Industrials"),  # search, detection and navigation systems
        (3811, "Other"),
        (3813, "Other"),
        # outside every range
        (100, "Other"),
        (9995, "Other"),
        (6600, "Other"),
    ],
)
def test_sector_for_sic_ranges(sic, sector):
    assert sector_for_sic(sic, False) == sector


def test_sic_table_covers_the_eleven_sectors():
    with (securities.SIC_TO_SECTOR_CSV).open(newline="") as f:
        rows = list(csv.DictReader(f))

    assert list(rows[0]) == ["sic_from", "sic_to", "sector"]
    assert {r["sector"] for r in rows} == {
        "Tech",
        "Communication",
        "Consumer discretionary",
        "Consumer staples",
        "Health care",
        "Financials",
        "Real estate",
        "Energy",
        "Industrials",
        "Materials",
        "Utilities",
    }
    assert all(int(r["sic_from"]) <= int(r["sic_to"]) for r in rows)


# --- SEC lookups -----------------------------------------------------------------------------


def test_load_sec_tickers():
    payload = {
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "1": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
    }
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=payload)

    out = load_sec_tickers(make_client(handler))

    assert seen == ["https://www.sec.gov/files/company_tickers.json"]
    assert out.schema == pl.Schema({"ticker": pl.String, "cik": pl.Int64, "title": pl.String})
    assert out.rows() == [("AAPL", 320193, "Apple Inc."), ("MSFT", 789019, "MICROSOFT CORP")]


def test_load_sec_tickers_normalises_tickers():
    payload = {
        "0": {"cik_str": 1067983, "ticker": "BRK.B", "title": "BERKSHIRE HATHAWAY INC"},
        "1": {"cik_str": 14693, "ticker": "bf/b", "title": "BROWN FORMAN CORP"},
    }

    out = load_sec_tickers(make_client(lambda request: httpx.Response(200, json=payload)))

    assert out["ticker"].to_list() == ["BRK-B", "BF-B"]


def test_load_sec_tickers_empty_keeps_schema():
    out = load_sec_tickers(make_client(lambda request: httpx.Response(200, json={})))

    assert out.height == 0
    assert out.schema == pl.Schema({"ticker": pl.String, "cik": pl.Int64, "title": pl.String})


def test_fetch_sic():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"cik": "320193", "sic": "3571", "name": "Apple Inc."})

    assert fetch_sic(make_client(handler), 320193) == 3571
    assert seen == ["https://data.sec.gov/submissions/CIK0000320193.json"]


@pytest.mark.parametrize("body", [{"sic": ""}, {"sic": None}, {"name": "No SIC Corp"}])
def test_fetch_sic_missing_or_empty_is_none(body):
    assert fetch_sic(make_client(lambda request: httpx.Response(200, json=body)), 1) is None


def test_fetch_sic_404_is_none_and_other_errors_raise():
    assert fetch_sic(make_client(lambda request: httpx.Response(404)), 1) is None

    with pytest.raises(FetchError) as exc:
        fetch_sic(make_client(lambda request: httpx.Response(403)), 1)
    assert exc.value.status == 403


def concept(*entries: dict) -> dict:
    """A companyconcept response for dei:EntityCommonStockSharesOutstanding."""
    return {
        "cik": 1652044,
        "taxonomy": "dei",
        "tag": "EntityCommonStockSharesOutstanding",
        "units": {"shares": list(entries)},
    }


def entry(end, val, accn, filed, form="10-Q", fp="Q2"):
    return {"end": end, "val": val, "accn": accn, "filed": filed, "form": form, "fp": fp}


def shares_of(body: dict, cik: int = 1) -> float | None:
    return fetch_shares_outstanding(make_client(lambda r: httpx.Response(200, json=body)), cik)


def test_fetch_shares_outstanding_takes_latest_end():
    body = concept(
        entry("2024-01-19", 15_550_061_000, "0000320193-24-000006", "2024-02-02"),
        entry("2024-10-18", 15_115_823_000, "0000320193-24-000123", "2024-11-01"),
        entry("2023-10-20", 15_552_752_000, "0000320193-23-000106", "2023-11-03"),
    )
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=body)

    result = fetch_shares_outstanding(make_client(handler), 320193)

    assert result == 15_115_823_000.0
    assert isinstance(result, float)
    assert seen == [
        (
            "https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/dei/"
            "EntityCommonStockSharesOutstanding.json"
        )
    ]


def test_fetch_shares_outstanding_ties_on_end_take_latest_filing():
    body = concept(
        entry("2024-06-30", 100, "0001-24-000002", "2024-08-01"),
        entry("2024-06-30", 105, "0001-24-000009", "2024-08-20", form="10-Q/A"),
        entry("2024-06-30", 90, "0001-24-000001", "2024-07-15"),
    )

    assert shares_of(body) == 105.0


def test_fetch_shares_outstanding_sums_share_classes_of_one_filing():
    # Alphabet-shaped: one filing reports each class as its own entry with the same end/filed.
    body = concept(
        entry("2024-07-16", 5_800_000_000, "0001652044-24-000079", "2024-07-24"),  # class A
        entry("2024-07-16", 860_000_000, "0001652044-24-000079", "2024-07-24"),  # class B
        entry("2024-07-16", 5_500_000_000, "0001652044-24-000079", "2024-07-24"),  # class C
        entry("2024-04-17", 12_000_000_000, "0001652044-24-000052", "2024-04-25"),
    )

    assert shares_of(body) == 12_160_000_000.0


def test_fetch_shares_outstanding_counts_a_repeated_entry_once():
    body = concept(
        entry("2024-07-16", 5_800_000_000, "0001652044-24-000079", "2024-07-24"),
        entry("2024-07-16", 5_800_000_000, "0001652044-24-000079", "2024-07-24"),  # exact repeat
        entry("2024-07-16", 860_000_000, "0001652044-24-000079", "2024-07-24"),
    )

    assert shares_of(body) == 6_660_000_000.0


def test_fetch_shares_outstanding_ignores_older_filings_with_the_same_end():
    body = concept(
        entry("2024-06-30", 70, "0001-24-000001", "2024-07-15"),
        entry("2024-06-30", 30, "0001-24-000001", "2024-07-15"),
        entry("2024-06-30", 99, "0001-24-000005", "2024-08-01"),  # the latest filing: only this
    )

    assert shares_of(body) == 99.0


def test_fetch_shares_outstanding_same_filing_date_takes_larger_accn():
    body = concept(
        entry("2024-06-30", 70, "0001-24-000005", "2024-08-01"),
        entry("2024-06-30", 99, "0001-24-000007", "2024-08-01"),
        entry("2024-06-30", 80, "0001-24-000006", "2024-08-01"),
    )

    assert shares_of(body) == 99.0


def test_fetch_shares_outstanding_is_independent_of_listing_order():
    entries = [
        entry("2024-07-16", 5_800_000_000, "0001652044-24-000079", "2024-07-24"),
        entry("2024-07-16", 860_000_000, "0001652044-24-000079", "2024-07-24"),
        entry("2024-04-17", 12_000_000_000, "0001652044-24-000052", "2024-04-25"),
    ]

    assert shares_of(concept(*entries)) == shares_of(concept(*reversed(entries)))


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"units": {}},
        {"units": {"USD": [{"end": "2024-06-30", "val": 1}]}},
        concept(),
        concept({"end": "2024-06-30", "accn": "a", "filed": "2024-08-01"}),  # no val
        concept({"val": 5, "accn": "a", "filed": "2024-08-01"}),  # no end
    ],
)
def test_fetch_shares_outstanding_missing_concept_is_none(body):
    assert shares_of(body) is None


def test_fetch_shares_outstanding_404_is_none_and_other_errors_raise():
    assert fetch_shares_outstanding(make_client(lambda r: httpx.Response(404)), 1) is None

    with pytest.raises(FetchError):
        fetch_shares_outstanding(make_client(lambda r: httpx.Response(403)), 1)
