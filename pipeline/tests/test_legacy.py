import gzip
from datetime import date

import httpx
import pytest

from orca.http import Client, FetchError
from orca.quarters import q_index
from orca.sec import legacy
from orca.sec.legacy import (
    CLOSE,
    MISMATCH,
    NO_PERIOD,
    NO_ROWS,
    OK,
    PAPER,
    UNVERIFIED,
    declared_totals,
    document_texts,
    fetch_quarter,
    index_quarters,
    read_holdings,
    read_submission,
    read_table,
    valid_cusip,
)
from orca.sec.live import IndexEntry

ACCESSION = "0001111111-05-000001"
ENTRY = IndexEntry(
    "13F-HR", 1111111, "EXAMPLE CAPITAL", date(2005, 2, 14), f"edgar/data/1111111/{ACCESSION}.txt"
)

SUMMARY = """FORM 13F SUMMARY PAGE
Form 13F Information Table Entry Total:        {entries}
Form 13F Information Table Value Total:   $  {value}
                                          (thousands)
"""

FIXED = """<TABLE>
NAME OF ISSUER    TITLE   CUSIP       VALUE(X$1000)   SHARES   SH/PRN PUT/CALL  INV DISC
<S>               <C>     <C>         <C>             <C>
APPLE INC         COM     037833100         1,000      10,000  SH               SOLE
MICROSOFT CORP    COM     594918104           300       5,000  SH     PUT       SOLE
GENERAL ELEC      NOTE    369604103           200     200,000  PRN              SOLE
</TABLE>
"""


def submission(
    body: str,
    form: str = "13F-HR",
    period: str | None = "20041231",
    extra: str = "",
) -> bytes:
    header = f"""<SEC-DOCUMENT>{ACCESSION}.txt : 20050214
<SEC-HEADER>
ACCESSION NUMBER:		{ACCESSION}
CONFORMED SUBMISSION TYPE:	{form}
{f"CONFORMED PERIOD OF REPORT:	{period}" if period else ""}
FILED AS OF DATE:		20050214
FILER:
	COMPANY DATA:
		COMPANY CONFORMED NAME:			EXAMPLE CAPITAL LLC
		CENTRAL INDEX KEY:			0001111111
</SEC-HEADER>
<DOCUMENT>
<TYPE>{form}
<SEQUENCE>1
<TEXT>
{body}
</TEXT>
</DOCUMENT>
{extra}</SEC-DOCUMENT>
"""
    return header.encode("latin-1")


def table(text: str, eight: bool = False):
    return read_table(document_texts(submission(text).decode("latin-1")), eight)


def test_cusip_check_digit():
    assert valid_cusip("037833100")  # Apple
    assert valid_cusip("G491BT108")  # letters in the issue number
    assert not valid_cusip("084423100")  # a typo of 084423102
    assert not valid_cusip("03783310")


def test_index_quarters_cover_1999_to_the_xml_switch():
    quarters = index_quarters()
    assert quarters[0] == "1999Q1" and quarters[-1] == "2013Q3"
    assert len(quarters) == 59 and quarters[4] == "2000Q1"
    assert legacy.index_url("2005Q2").endswith("/edgar/full-index/2005/QTR2/form.gz")


def test_fixed_width_table_with_summary_totals():
    filing, rows, check = read_submission(
        submission(SUMMARY.format(entries=3, value="1,500") + FIXED), ENTRY
    )
    assert check["status"] == OK and check["rows"] == 3
    assert filing["period"] == q_index(2004, 4) == -33
    assert filing["source"] == "legacy" and filing["manager_name"] == "EXAMPLE CAPITAL LLC"
    assert filing["amendment_type"] is None
    by_cusip = {r["cusip"]: r for r in rows}
    assert by_cusip["037833100"]["value_usd"] == 1_000_000.0  # thousands before 2023
    assert by_cusip["037833100"]["shares"] == 10_000.0
    assert by_cusip["594918104"]["put_call"] == "PUT"
    assert by_cusip["369604103"]["sh_type"] == "PRN"
    assert by_cusip["037833100"]["issuer"] == "APPLE INC COM"


def test_continuation_rows_repeat_the_cusip_above_and_totals_are_not_rows():
    text = """
Name of       Title of    CUSIP        Value     Shares
American
 Express Co.     Com   025816 10 9     970,996   17,225,400          X            5, 2, 6, 16             17,225,400
                                       450,658    7,994,634          X            5, 12, 16                7,994,634
Coca Cola        Com   191216 10 0      16,656      400,000          X            5, 16                      400,000
                                        73,953    1,776,000          X            5, 14, 16                1,776,000
                                    ----------
                                     1,512,263
                                    ----------
  GRAND TOTAL                       $1,512,263    27,396,034
"""
    read = table(SUMMARY.format(entries=4, value="1,512,263") + text)
    assert [(r.cusip, r.value, r.shares) for r in read.rows] == [
        ("025816109", 970_996.0, 17_225_400.0),
        ("025816109", 450_658.0, 7_994_634.0),
        ("191216100", 16_656.0, 400_000.0),
        ("191216100", 73_953.0, 1_776_000.0),
    ]
    assert read.invalid == []


def test_a_line_of_totals_without_a_label_is_not_a_row():
    text = """
INVESCO LTD     Equity   G491BT108          318,878           22,083
APPLE INC       COM      037833100          100,000            1,000
                                            418,878           23,083
"""
    assert len(table(text).rows) == 2


def test_wrapped_rows_and_one_field_per_line():
    wrapped = """
3M Co                COM        88579Y101               841
9695SH                    Sole                9695
Abbott Labs          COM        002824100             63633
1188291SH                    Sole             1188291
"""
    assert [(r.value, r.shares) for r in table(wrapped).rows] == [
        (841.0, 9695.0),
        (63633.0, 1188291.0),
    ]
    vertical = "ADC TELECOMMUNICATIONS INC\nCOM\n000886101\n4031\n116000\nX\n\n116000\n"
    assert [(r.cusip, r.value, r.shares) for r in table(vertical).rows] == [
        ("000886101", 4031.0, 116000.0)
    ]


def test_quoted_tab_separated_and_html_tables():
    quoted = '3M Co.\tCommon\t88579Y101\t439.5 \t"5,128 "\t"5,128 "\n'
    assert [(r.value, r.shares) for r in table(quoted).rows] == [(439.5, 5128.0)]
    html = (
        "<HTML><BODY><TABLE><TR><TD>APPLE&nbsp;INC</TD><TD>COM</TD><TD>037833100</TD>"
        "<TD>1,000</TD><TD>10,000</TD><TD>SH</TD></TR></TABLE></BODY></HTML>"
    )
    assert [(r.cusip, r.value, r.shares) for r in table(html).rows] == [
        ("037833100", 1000.0, 10000.0)
    ]


def test_eight_character_cusips_are_read_when_nine_find_nothing():
    text = SUMMARY.format(entries=2, value="7,841") + """
General Electric   Common   36960410        7,300   71569
Gillette           Common   37576610          541   11330
"""
    texts = document_texts(submission(text).decode("latin-1"))
    assert table(text).rows == []
    read, status, _, _ = read_holdings(texts)
    assert status == OK
    assert [r.cusip for r in read.rows] == ["369604103", "375766102"]


def test_rows_with_a_mistyped_cusip_are_counted_but_not_stored():
    text = SUMMARY.format(entries=3, value="1,500") + """
NAME OF ISSUER    TITLE   CUSIP       VALUE      SHARES
APPLE INC         COM     037833100   1,000      10,000  SH   SOLE
BERKLEY W R CORP  COM     084423 10 0   300       5,000  SH   SOLE
MICROSOFT CORP    COM     594918104     200       2,000  SH   SOLE
"""
    filing, rows, check = read_submission(submission(text), ENTRY)
    assert check["status"] == OK  # the value total adds up with the mistyped row
    assert check["rows"] == 2 and check["invalid_rows"] == 1
    assert {r["cusip"] for r in rows} == {"037833100", "594918104"}


def test_a_table_that_does_not_add_up_is_not_stored():
    text = SUMMARY.format(entries=5, value="9,000") + FIXED
    filing, rows, check = read_submission(submission(text), ENTRY)
    assert check["status"] == MISMATCH and filing is None and rows == []
    assert check["declared_entries"] == 5 and check["declared_value"] == 9000.0


def test_close_and_unverified_tables_are_stored():
    close = read_submission(submission(SUMMARY.format(entries=9, value="1,520") + FIXED), ENTRY)
    assert close[2]["status"] == CLOSE and close[0] is not None
    bare = read_submission(submission(FIXED), ENTRY)
    assert bare[2]["status"] == UNVERIFIED and len(bare[1]) == 3


def test_declared_totals():
    assert declared_totals(["Entry Total: 407\n\nEntry Total:       $718,999\n"]) == (718999.0, 407)
    assert declared_totals(["Value Total (x$1000): 35,759\nEntry Total: 66\n"]) == (35759.0, 66)
    assert declared_totals(
        ["Form 13F Information Table Entry Total:\nForm 13F Information Table Value Total: 500\n"]
    ) == (500.0, None)
    assert declared_totals(["no summary page"]) == (None, None)


def test_a_heading_with_shares_before_value_swaps_the_columns():
    text = """
NAME OF ISSUER               TITLE OF CLASS   CUSIP     SHARES     VALUE    INVESTMENT
ACCURIDE CORP NEW               COM NEW     00439T206 2,433,370  $ 21,146  (OTHER)
"""
    assert [(r.value, r.shares) for r in table(text).rows] == [(21_146.0, 2_433_370.0)]


def test_a_table_in_dollars_is_stored_in_dollars():
    text = """
APPLE INC         COM     037833100   1,000,000   10,000  SH
MICROSOFT CORP    COM     594918104     250,000    5,000  SH
GENERAL ELEC      COM     369604103     200,000    4,000  SH
"""
    _, rows, _ = read_submission(submission(text), ENTRY)
    assert [r["value_usd"] for r in rows] == [1_000_000.0, 250_000.0, 200_000.0]


def test_amendment_types_from_the_cover_page():
    entry = IndexEntry("13F-HR/A", ENTRY.cik, ENTRY.company, ENTRY.filed, ENTRY.path)
    restated = "Check here if Amendment [X]\n[X] is a restatement.\n[ ] adds new holdings entries.\n"
    added = "Check here if Amendment [X]\n[ ] is a restatement.\n[x] adds new holdings entries.\n"
    neither = "[ ] is a restatement.\n[ ] adds new holdings entries.\n"
    for cover, kind in ((restated, "restatement"), (added, "new_holdings"), (neither, None)):
        filing, _, _ = read_submission(submission(cover + FIXED, form="13F-HR/A"), entry)
        assert filing["amendment_type"] == kind


def test_paper_filings_and_filings_without_a_period_are_not_stored():
    paper = submission("This document was generated as part of a paper submission.").replace(
        b"<SEC-HEADER>", b"<SEC-HEADER>\n<PAPER>"
    )
    assert read_submission(paper, ENTRY)[2]["status"] == PAPER
    assert read_submission(submission(FIXED, period=None), ENTRY)[2]["status"] == NO_PERIOD
    assert read_submission(submission("No table here."), ENTRY)[2]["status"] == NO_ROWS


def test_an_xml_information_table_is_read_as_the_live_feed_reads_it():
    primary = """<XML><edgarSubmission><formData><coverPage>
<reportCalendarOrQuarter>03-31-2013</reportCalendarOrQuarter>
<filingManager><name>Example Capital</name></filingManager>
</coverPage></formData></edgarSubmission></XML>"""
    info = """<XML><informationTable><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer>
<titleOfClass>COM</titleOfClass><cusip>037833100</cusip><value>1000</value>
<shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
</infoTable></informationTable></XML>"""
    body = submission(primary).replace(
        b"</SEC-DOCUMENT>",
        b"<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n" + info.encode() + b"\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>",
    )
    entry = IndexEntry("13F-HR", ENTRY.cik, ENTRY.company, date(2013, 5, 14), ENTRY.path)
    filing, rows, check = read_submission(body, entry)
    assert check["status"] == OK and filing["source"] == "legacy"
    assert filing["period"] == 0 and rows[0]["value_usd"] == 1_000_000.0


# --- fetch_quarter ------------------------------------------------------------------------

INDEX_URL = "https://www.sec.gov/Archives/edgar/full-index/2005/QTR1/form.gz"


def index_text(*rows: tuple[str, int, str]) -> bytes:
    lines = ["Form Type   Company Name   CIK   Date Filed   File Name", "-" * 60]
    for form, cik, accession in rows:
        lines.append(
            f"{form:<17}EXAMPLE CAPITAL {cik}  {cik}     2005-02-14  edgar/data/{cik}/{accession}.txt"
        )
    return gzip.compress("\n".join(lines).encode())


def make_client(routes: dict[str, bytes | int]) -> Client:
    def handler(request: httpx.Request) -> httpx.Response:
        route = routes.get(str(request.url), 404)
        if isinstance(route, int):
            return httpx.Response(route)
        return httpx.Response(200, content=route)

    return Client(1e6, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None, max_retries=0)


def filing_url(cik: int, accession: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession}.txt"


def test_fetch_quarter_reads_skips_and_records_failures():
    good, stored, failed = "0001111111-05-000001", "0002222222-05-000002", "0003333333-05-000003"
    routes = {
        INDEX_URL: index_text(
            ("13F-HR", 1111111, good),
            ("13F-HR/A", 2222222, stored),
            ("13F-HR", 3333333, failed),
            ("10-K", 4444444, "0004444444-05-000004"),
        ),
        filing_url(1111111, good): submission(SUMMARY.format(entries=3, value="1,500") + FIXED),
        filing_url(3333333, failed): 404,
    }
    stats: dict = {}
    filings, raw, checks = fetch_quarter(make_client(routes), "2005Q1", {stored}, stats, workers=2)
    assert stats == {"entries": 3, "skipped": 1}
    assert filings["accession"].to_list() == [good] and filings["source"].to_list() == ["legacy"]
    assert raw.height == 3 and set(raw["accession"]) == {good}
    statuses = dict(checks.select("accession", "status").iter_rows())
    assert statuses == {good: OK, failed: "download_failed"}


def test_fetch_quarter_stops_on_throttling():
    accession = "0001111111-05-000001"
    routes = {
        INDEX_URL: index_text(("13F-HR", 1111111, accession)),
        filing_url(1111111, accession): 429,
    }
    with pytest.raises(FetchError):
        fetch_quarter(make_client(routes), "2005Q1", set())


def test_a_count_match_from_the_wrong_columns_is_not_ok():
    # The second number is the value in hundreds, not shares: the count matches, the value does
    # not, and the "shares" add up to the declared value total.
    text = SUMMARY.format(entries=2, value="15") + """
APPLE INC         COM     037833100   1,000,000   10  SH
MICROSOFT CORP    COM     594918104     500,000    5  SH
"""
    assert read_submission(submission(text), ENTRY)[2]["status"] == MISMATCH


def test_a_value_total_with_an_in_thousands_note():
    assert declared_totals(["Value Total (in thousands): 1,234\n"]) == (1234.0, None)
