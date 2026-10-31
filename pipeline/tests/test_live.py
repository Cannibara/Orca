import logging
import re
from datetime import date
from pathlib import Path

import httpx
import polars as pl
import pytest

from orca.http import Client, FetchError
from orca.sec.live import IndexEntry, fetch_new_filings, parse_daily_index, parse_infotable_xml

FIXTURES = Path(__file__).parent / "fixtures"

ALPHA = "0001111111-25-000010"  # 13F-HR in form.idx; submission.txt is its full submission
BETA = "0002222222-25-000020"  # 13F-HR/A in form.idx; submissions for it are built below
ALPHA_URL = f"https://www.sec.gov/Archives/edgar/data/1111111/{ALPHA}.txt"
BETA_URL = f"https://www.sec.gov/Archives/edgar/data/2222222/{BETA}.txt"
IDX_URL = "https://www.sec.gov/Archives/edgar/daily-index/2025/QTR1/form.20250331.idx"

FILINGS_SCHEMA = pl.Schema(
    {
        "accession": pl.String,
        "cik": pl.Int64,
        "period": pl.Int16,
        "filed": pl.Date,
        "form": pl.String,
        "amendment_type": pl.String,
        "manager_name": pl.String,
        "source": pl.String,
    }
)
HOLDINGS_SCHEMA = pl.Schema(
    {
        "accession": pl.String,
        "cusip": pl.String,
        "issuer": pl.String,
        "title": pl.String,
        "shares": pl.Float64,
        "sh_type": pl.String,
        "put_call": pl.String,
        "value_usd": pl.Float64,
    }
)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def info_xml(*rows: tuple) -> str:
    """An info table; each row is (issuer, value, shares, sh_type[, put_call]); None omits a tag."""
    entries = []
    for issuer, value, shares, sh_type, *rest in rows:
        put_call = rest[0] if rest else None
        parts = [
            f"<nameOfIssuer>{issuer}</nameOfIssuer>",
            "<titleOfClass>COM</titleOfClass>",
            "<cusip>037833100</cusip>",
            f"<value>{value}</value>" if value is not None else "",
            "<shrsOrPrnAmt>",
            f"<sshPrnamt>{shares}</sshPrnamt>" if shares is not None else "",
            f"<sshPrnamtType>{sh_type}</sshPrnamtType>" if sh_type is not None else "",
            "</shrsOrPrnAmt>",
            f"<putCall>{put_call}</putCall>" if put_call is not None else "",
        ]
        entries.append("<infoTable>" + "".join(parts) + "</infoTable>")
    return '<?xml version="1.0"?><informationTable xmlns="urn:test">' + "".join(entries) + "</informationTable>"


def primary_xml(period: str | None = "12-31-2024", amendment: str = "RESTATEMENT", name: str = "BETA PARTNERS, L.P.") -> str:
    parts = ['<?xml version="1.0"?><edgarSubmission xmlns="urn:test"><formData><coverPage>']
    if period is not None:
        parts.append(f"<reportCalendarOrQuarter>{period}</reportCalendarOrQuarter>")
    parts.append(f"<isAmendment>{'Y' if amendment else 'N'}</isAmendment>")
    if amendment:
        parts.append(f"<amendmentInfo><amendmentType>{amendment}</amendmentType></amendmentInfo>")
    parts.append(f"<filingManager><name>{name}</name></filingManager></coverPage></formData></edgarSubmission>")
    return "".join(parts)


def document(doc_type: str, xml: str) -> str:
    return f"<DOCUMENT>\n<TYPE>{doc_type}\n<SEQUENCE>1\n<TEXT>\n<XML>\n{xml}\n</XML>\n</TEXT>\n</DOCUMENT>\n"


def submission(form: str = "13F-HR/A", primary: str | None = None, info: str | None = "default") -> bytes:
    """A full submission text file; primary / info of None leave that document out."""
    primary = primary_xml() if primary is None else primary
    if info == "default":
        info = info_xml(("MICROSOFT CORP", 7, 3, "SH"))
    text = "<SEC-DOCUMENT>\n<SEC-HEADER>\nCONFORMED SUBMISSION TYPE:\t" + form + "\n</SEC-HEADER>\n"
    text += document(form, primary) if primary != "" else ""
    text += document("INFORMATION TABLE", info) if info is not None else ""
    return (text + "</SEC-DOCUMENT>\n").encode()


def index_text(*lines: str) -> bytes:
    header = "Form Type   Company Name   CIK   Date Filed   File Name\n" + "-" * 60 + "\n"
    return (header + "\n".join(lines) + "\n").encode()


def make_client(routes: dict[str, bytes | int]) -> tuple[Client, list[str]]:
    """Client over a mock transport; a route is a body (200) or an error status (default 404)."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen.append(url)
        route = routes.get(url, 404)
        return httpx.Response(route) if isinstance(route, int) else httpx.Response(200, content=route)

    client = Client(1e6, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None, max_retries=0)
    return client, seen


def day_routes(beta: bytes | int | None = None, alpha: bytes | int | None = None) -> dict[str, bytes | int]:
    return {
        IDX_URL: fixture("form.idx"),
        ALPHA_URL: fixture("submission.txt") if alpha is None else alpha,
        BETA_URL: submission() if beta is None else beta,
    }


MARCH_31 = date(2025, 3, 31)


# --- parse_daily_index ---------------------------------------------------------------------


def test_parse_daily_index_keeps_13f_only():
    # form.idx holds a 13F-HR, a 13F-HR/A, a 10-K, a 13F-NT and an "SC 13G/A" (form with a space)
    entries = parse_daily_index(fixture("form.idx").decode())

    assert entries == [
        IndexEntry("13F-HR", 1111111, "Alpha Capital Management LP", MARCH_31, f"edgar/data/1111111/{ALPHA}.txt"),
        IndexEntry("13F-HR/A", 2222222, "Beta Partners, L.P.", MARCH_31, f"edgar/data/2222222/{BETA}.txt"),
    ]


@pytest.mark.parametrize("filed", ["20250331", "2025-03-31"])
def test_parse_daily_index_reads_both_date_formats(filed):
    text = index_text(f"13F-HR      Alpha Capital   1111111     {filed}    edgar/data/1111111/{ALPHA}.txt").decode()

    assert [e.filed for e in parse_daily_index(text)] == [MARCH_31]


def test_parse_daily_index_company_may_contain_single_spaces_and_form_case_is_ignored():
    text = index_text(f"13f-hr/a    Big Name  With  Gaps Inc   2222222   20250331   edgar/data/2222222/{BETA}.txt").decode()

    (entry,) = parse_daily_index(text)

    assert entry.form == "13F-HR/A"
    assert entry.company == "Big Name  With  Gaps Inc"


def test_parse_daily_index_without_separator_line_still_reads_rows():
    text = f"13F-HR      Alpha Capital   1111111     20250331    edgar/data/1111111/{ALPHA}.txt\n"

    assert [e.cik for e in parse_daily_index(text)] == [1111111]


def test_parse_daily_index_ignores_rows_above_the_separator():
    text = "13F-HR      Preamble Co   9   20250331   edgar/data/9/0000000009-25-000009.txt\n" + index_text().decode()

    assert parse_daily_index(text) == []


@pytest.mark.parametrize(
    "line",
    [
        "13F-HR      Broken LP   not-a-cik   20250331   edgar/data/5/0005555555-25-000050.txt",
        "13F-HR      Broken LP   5555555   20251345   edgar/data/5/0005555555-25-000050.txt",
        "13F-HR      Broken LP   5555555   20250331   edgar/data/5/not-an-accession.txt",
        "13F-HR      Broken LP   5555555   20250331   ../../elsewhere/0005555555-25-000050.txt",
        "13F-HR      Truncated",
    ],
)
def test_parse_daily_index_drops_and_counts_unusable_13f_lines(line):
    good = f"13F-HR      Alpha Capital   1111111     20250331    edgar/data/1111111/{ALPHA}.txt"
    stats: dict = {}

    entries = parse_daily_index(index_text(line, good).decode(), stats)

    assert [e.cik for e in entries] == [1111111]
    assert stats == {"dropped_filings": 1}


def test_parse_daily_index_does_not_count_other_forms_or_clean_files():
    stats: dict = {}

    parse_daily_index(fixture("form.idx").decode(), stats)

    assert stats == {"dropped_filings": 0}


# --- parse_infotable_xml -------------------------------------------------------------------


def test_parse_infotable_xml():
    rows = parse_infotable_xml(fixture("infotable.xml"), ALPHA, date(2024, 2, 14))

    assert rows.schema == HOLDINGS_SCHEMA
    assert rows.rows(named=True) == [
        {
            "accession": ALPHA,
            "cusip": "037833100",
            "issuer": "APPLE INC",
            "title": "COM",
            "shares": 10000.0,
            "sh_type": "SH",
            "put_call": None,
            "value_usd": 1_500_000.0,  # a 2024 filing reports dollars
        },
        {
            "accession": ALPHA,
            "cusip": "88160R101",
            "issuer": "TESLA INC",
            "title": "COM",
            "shares": 20000.0,
            "sh_type": "SH",
            "put_call": "PUT",
            "value_usd": 2_000_000.0,
        },
    ]


def test_parse_infotable_xml_ns1_prefixed_tags_parse_the_same():
    plain = fixture("infotable.xml").decode()
    prefixed = re.sub(r"<(/?)([A-Za-z])", r"<\1ns1:\2", plain).replace("xmlns=", "xmlns:ns1=")
    assert "<ns1:infoTable>" in prefixed and "<infoTable>" not in prefixed  # the rewrite did something

    got = parse_infotable_xml(prefixed.encode(), ALPHA, date(2024, 2, 14))

    assert got.equals(parse_infotable_xml(plain.encode(), ALPHA, date(2024, 2, 14)))
    assert got.height == 2


def test_parse_infotable_xml_value_is_in_thousands_before_2023():
    before = parse_infotable_xml(fixture("infotable.xml"), ALPHA, date(2022, 11, 14))
    after = parse_infotable_xml(fixture("infotable.xml"), ALPHA, date(2023, 1, 3))

    assert before["value_usd"].to_list() == [1_500_000_000.0, 2_000_000_000.0]
    assert after["value_usd"].to_list() == [1_500_000.0, 2_000_000.0]


def test_parse_infotable_xml_normalises_share_type_and_put_call():
    xml = info_xml(("A", 1, 1, "sh", "put"), ("B", 1, 1, " Prn ", " CALL "), ("C", 1, 1, "SH", "other"))

    rows = parse_infotable_xml(xml.encode(), ALPHA, MARCH_31)

    assert rows["sh_type"].to_list() == ["SH", "PRN", "SH"]
    assert rows["put_call"].to_list() == ["PUT", "CALL", None]


def test_parse_infotable_xml_drops_and_counts_bad_holdings():
    xml = info_xml(
        ("GOOD INC", 5, 2, "SH"),
        ("BAD TYPE", 5, 2, "XX"),
        ("NO TYPE", 5, 2, None),
        ("BAD VALUE", "n/a", 2, "SH"),
        ("NO VALUE", None, 2, "SH"),
        ("BAD SHARES", 5, "lots", "SH"),
        ("NO SHARES", 5, None, "SH"),
    )
    stats: dict = {}

    rows = parse_infotable_xml(xml.encode(), ALPHA, MARCH_31, stats)

    assert rows["issuer"].to_list() == ["GOOD INC"]
    assert stats == {"dropped_holdings": 6}


def test_parse_infotable_xml_clean_table_reports_no_drops():
    stats: dict = {}

    parse_infotable_xml(fixture("infotable.xml"), ALPHA, MARCH_31, stats)

    assert stats == {"dropped_holdings": 0}


def test_parse_infotable_xml_empty_table_gives_empty_frame_with_the_usual_columns():
    rows = parse_infotable_xml(info_xml().encode(), ALPHA, MARCH_31)

    assert rows.height == 0
    assert rows.schema == HOLDINGS_SCHEMA


@pytest.mark.parametrize("xml", [b"", b"<informationTable><infoTable>", b"<html><body/></html>", b"not xml"])
def test_parse_infotable_xml_rejects_what_is_not_an_info_table(xml):
    with pytest.raises(ValueError, match=ALPHA):
        parse_infotable_xml(xml, ALPHA, MARCH_31)


# --- fetch_new_filings ---------------------------------------------------------------------


def test_fetch_new_filings_reads_filings_and_holdings():
    client, seen = make_client(day_routes())
    stats: dict = {}

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31, stats)

    assert filings.schema == FILINGS_SCHEMA
    assert filings.rows(named=True) == [
        {
            "accession": ALPHA,
            "cik": 1111111,
            "period": 48,  # Q1 2025
            "filed": MARCH_31,
            "form": "13F-HR",
            "amendment_type": None,
            "manager_name": "ALPHA CAPITAL MANAGEMENT LP",
            "source": "live",
        },
        {
            "accession": BETA,
            "cik": 2222222,
            "period": 47,  # Q4 2024: the restatement is read from its own primary document
            "filed": MARCH_31,
            "form": "13F-HR/A",
            "amendment_type": "restatement",
            "manager_name": "BETA PARTNERS, L.P.",
            "source": "live",
        },
    ]
    assert holdings.schema == HOLDINGS_SCHEMA
    assert holdings["accession"].to_list() == [ALPHA, ALPHA, BETA]
    assert holdings["issuer"].to_list() == ["APPLE INC", "TESLA INC", "MICROSOFT CORP"]
    assert holdings["put_call"].to_list() == [None, "PUT", None]
    assert holdings["value_usd"].to_list() == [1_500_000.0, 2_000_000.0, 7.0]
    assert stats == {
        "dropped_holdings": 0, "dropped_filings": 0, "failed_filings": 0, "failed_days": [], "no_index_days": []
    }  # fmt: skip
    # One index request, then one request per 13F-HR / 13F-HR/A filing; the 10-K, 13F-NT, SC 13G/A are never fetched.
    assert seen == [IDX_URL, ALPHA_URL, BETA_URL]


def test_fetch_new_filings_walks_every_day_and_skips_days_without_an_index():
    routes = day_routes()
    routes["https://www.sec.gov/Archives/edgar/daily-index/2025/QTR1/form.20250330.idx"] = 403  # Sunday
    # 2025-03-29 (Saturday) and 2025-04-01 answer 404 by default
    client, seen = make_client(routes)

    filings, _ = fetch_new_filings(client, date(2025, 3, 29), date(2025, 4, 1))

    assert filings["accession"].to_list() == [ALPHA, BETA]
    assert [u for u in seen if u.endswith(".idx")] == [
        "https://www.sec.gov/Archives/edgar/daily-index/2025/QTR1/form.20250329.idx",
        "https://www.sec.gov/Archives/edgar/daily-index/2025/QTR1/form.20250330.idx",
        IDX_URL,
        "https://www.sec.gov/Archives/edgar/daily-index/2025/QTR2/form.20250401.idx",  # new quarter, new folder
    ]


def test_fetch_new_filings_any_other_index_error_propagates():
    client, _ = make_client({IDX_URL: 500})

    with pytest.raises(FetchError) as exc:
        fetch_new_filings(client, MARCH_31, MARCH_31)

    assert exc.value.status == 500


def test_fetch_new_filings_with_no_index_gives_empty_frames_and_zero_stats():
    client, seen = make_client({})
    stats: dict = {}

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31, stats)

    assert filings.height == 0 and filings.schema == FILINGS_SCHEMA
    assert holdings.height == 0 and holdings.schema == HOLDINGS_SCHEMA
    assert stats == {
        "dropped_holdings": 0, "dropped_filings": 0, "failed_filings": 0, "failed_days": [],
        "no_index_days": [MARCH_31],
    }  # fmt: skip
    assert seen == [IDX_URL]


def test_fetch_new_filings_since_after_until_makes_no_request():
    client, seen = make_client(day_routes())

    filings, _ = fetch_new_filings(client, date(2025, 4, 1), MARCH_31)

    assert filings.height == 0
    assert seen == []


def test_fetch_new_filings_counts_and_skips_a_failed_download():
    client, _ = make_client(day_routes(beta=500))
    stats: dict = {}

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31, stats)

    assert filings["accession"].to_list() == [ALPHA]
    assert set(holdings["accession"]) == {ALPHA}
    assert stats == {
        "dropped_holdings": 0, "dropped_filings": 0, "failed_filings": 1, "failed_days": [MARCH_31],
        "no_index_days": [],
    }  # fmt: skip


@pytest.mark.parametrize(
    "broken",
    [
        submission(info="<informationTable><infoTable>"),  # info table is not well-formed XML
        submission(info="<html><body/></html>"),  # info table document is something else
        submission(info=None),  # no info table document at all
        submission(primary=""),  # no primary document
        submission(primary="<edgarSubmission><formData"),  # primary document is not well-formed XML
        submission(primary=primary_xml(period=None)),  # no report period
        submission(primary=primary_xml(period="2024-12-31")),  # report period in the wrong format
        submission(primary=primary_xml(period="13-45-2024")),  # report period is not a date
        b"<html>An error page that is not a submission</html>",
    ],
    ids=[
        "info-not-xml",
        "info-wrong-root",
        "info-missing",
        "primary-missing",
        "primary-not-xml",
        "period-missing",
        "period-format",
        "period-not-a-date",
        "no-documents",
    ],
)
def test_fetch_new_filings_drops_and_counts_a_filing_it_cannot_read(broken):
    client, _ = make_client(day_routes(beta=broken))
    stats: dict = {}

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31, stats)

    assert filings["accession"].to_list() == [ALPHA]
    assert set(holdings["accession"]) == {ALPHA}  # nothing of the broken filing leaks through
    assert stats == {
        "dropped_holdings": 0, "dropped_filings": 1, "failed_filings": 0, "failed_days": [], "no_index_days": []
    }  # fmt: skip


def test_fetch_new_filings_sums_drops_across_filings():
    one_bad = submission(info=info_xml(("OK", 1, 1, "SH"), ("BAD", 1, 1, "XX")))
    two_bad = fixture("submission.txt").replace(b"<ns1:sshPrnamtType>SH", b"<ns1:sshPrnamtType>XX")
    client, _ = make_client(day_routes(beta=one_bad, alpha=two_bad))
    stats: dict = {}

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31, stats)

    assert filings["accession"].to_list() == [ALPHA, BETA]  # a filing with some bad holdings is kept
    assert holdings["issuer"].to_list() == ["OK"]
    assert stats["dropped_holdings"] == 3


def test_fetch_new_filings_fetches_a_filing_listed_under_several_filers_once():
    both = index_text(
        f"13F-HR      Alpha Capital   1111111     20250331    edgar/data/1111111/{ALPHA}.txt",
        f"13F-HR      Alpha Affiliate   9999999     20250331    edgar/data/9999999/{ALPHA}.txt",
    )
    client, seen = make_client({IDX_URL: both, ALPHA_URL: fixture("submission.txt")})

    filings, holdings = fetch_new_filings(client, MARCH_31, MARCH_31)

    assert filings["accession"].to_list() == [ALPHA]
    assert filings["cik"].to_list() == [1111111]
    assert holdings.height == 2
    assert seen == [IDX_URL, ALPHA_URL]


@pytest.mark.parametrize(
    "text, expected",
    [
        ("RESTATEMENT", "restatement"),
        ("restatement", "restatement"),
        ("NEW HOLDINGS", "new_holdings"),
        (" New Holdings ", "new_holdings"),
        ("SOMETHING ELSE", None),
        ("", None),
    ],
)
def test_fetch_new_filings_normalises_amendment_type(text, expected):
    routes = day_routes(beta=submission(primary=primary_xml(amendment=text)))
    client, _ = make_client(routes)

    filings, _ = fetch_new_filings(client, MARCH_31, MARCH_31)

    assert filings.filter(pl.col("accession") == BETA)["amendment_type"].to_list() == [expected]


def test_fetch_new_filings_value_unit_follows_the_index_filing_date():
    idx = index_text(f"13F-HR      Alpha Capital   1111111     20221114    edgar/data/1111111/{ALPHA}.txt")
    routes = {
        "https://www.sec.gov/Archives/edgar/daily-index/2022/QTR4/form.20221114.idx": idx,
        ALPHA_URL: fixture("submission.txt"),
    }
    client, _ = make_client(routes)

    filings, holdings = fetch_new_filings(client, date(2022, 11, 14), date(2022, 11, 14))

    assert filings["filed"].to_list() == [date(2022, 11, 14)]
    assert holdings["value_usd"].to_list() == [1_500_000_000.0, 2_000_000_000.0]


def test_fetch_new_filings_logs_one_warning_naming_the_offenders(caplog):
    client, _ = make_client(day_routes(beta=submission(info=None)))

    with caplog.at_level(logging.WARNING, logger="orca.sec.live"):
        fetch_new_filings(client, MARCH_31, MARCH_31)

    (record,) = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert BETA in record.getMessage()
    assert ALPHA not in record.getMessage()


def test_fetch_new_filings_clean_run_logs_nothing(caplog):
    client, _ = make_client(day_routes())

    with caplog.at_level(logging.DEBUG, logger="orca.sec.live"):
        fetch_new_filings(client, MARCH_31, MARCH_31)

    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_fetch_new_filings_lists_the_days_without_an_index():
    april_1 = IDX_URL.replace("QTR1/form.20250331", "QTR2/form.20250401")
    routes = {**day_routes(), april_1: 403}  # March 30 answers 404, March 31 has an index
    client, _ = make_client(routes)
    stats: dict = {}

    filings, _ = fetch_new_filings(client, date(2025, 3, 30), date(2025, 4, 1), stats)

    assert filings.height > 0
    assert stats["no_index_days"] == [date(2025, 3, 30), date(2025, 4, 1)]


def day_url(day: date) -> str:
    return f"https://www.sec.gov/Archives/edgar/daily-index/{day.year}/QTR{(day.month - 1) // 3 + 1}/form.{day:%Y%m%d}.idx"


def test_three_business_days_in_a_row_refused_is_throttling_not_closed_days():
    # SEC answers 403 when it throttles a client; a closed day (a holiday) is one day, not three.
    refused = {day_url(date(2025, 3, d)): 403 for d in (26, 27, 28)}  # Wednesday to Friday
    client, seen = make_client({**day_routes(), **refused})

    with pytest.raises(FetchError) as exc:
        fetch_new_filings(client, date(2025, 3, 26), MARCH_31)

    assert exc.value.status == 403
    assert seen == [day_url(date(2025, 3, d)) for d in (26, 27, 28)]  # stops there


def test_a_refused_business_day_before_an_index_is_a_closed_day():
    refused = {day_url(date(2025, 3, 27)): 403, day_url(date(2025, 3, 28)): 403}  # Thu, Fri
    client, _ = make_client({**day_routes(), **refused})
    stats: dict = {}

    filings, _ = fetch_new_filings(client, date(2025, 3, 27), MARCH_31, stats)

    assert filings["accession"].to_list() == [ALPHA, BETA]
    assert stats["no_index_days"] == [date(2025, 3, d) for d in (27, 28, 29, 30)]


def test_weekend_days_do_not_count_towards_throttling():
    refused = {day_url(date(2025, 3, d)): 403 for d in (28, 29, 30)}  # Friday, Saturday, Sunday
    client, _ = make_client({**day_routes(), **refused})

    filings, _ = fetch_new_filings(client, date(2025, 3, 28), MARCH_31)

    assert filings.height == 2


@pytest.mark.parametrize("status", [403, 429])
def test_a_refused_filing_download_stops_the_stage(status):
    client, _ = make_client(day_routes(beta=status))

    with pytest.raises(FetchError) as exc:
        fetch_new_filings(client, MARCH_31, MARCH_31)

    assert exc.value.status == status
