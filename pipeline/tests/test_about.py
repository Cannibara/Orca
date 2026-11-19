"""SEC facts for the About tab: the filer's record (submissions JSON) and its latest 13F cover page.

The fixtures under fixtures/about are in the SEC's shapes, modelled on Berkshire Hathaway's record and its
13F-HR for Q3 2026 (see the note in the XML); no test touches the network."""

import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import httpx
import pytest

from orca.http import Client, FetchError
from orca.sec.about import About, fetch_about, parse_cover, parse_submissions

FIXTURES = Path(__file__).parent / "fixtures" / "about"
BERKSHIRE = 1067983
SUBMISSIONS = f"https://data.sec.gov/submissions/CIK{BERKSHIRE:010d}.json"
COVER = f"https://www.sec.gov/Archives/edgar/data/{BERKSHIRE}/000119312526463399/primary_doc.xml"


def submissions() -> dict:
    return json.loads((FIXTURES / "berkshire_submissions.json").read_text())


def cover_xml() -> bytes:
    return (FIXTURES / "berkshire_primary_doc.xml").read_bytes()


def sec_stub(pages: dict[str, httpx.Response | bytes | dict]) -> tuple[Client, list[str]]:
    """A Client answering from `pages` (url -> body or response; others 404), and the URLs asked."""
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        asked.append(url)
        page = pages.get(url)
        if page is None:
            return httpx.Response(404)
        if isinstance(page, httpx.Response):
            return page
        if isinstance(page, dict):
            return httpx.Response(200, json=page)
        return httpx.Response(200, content=page)

    client = Client(1e6, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None)
    return client, asked


# --- the filer's record ----------------------------------------------------------------------


def test_record_facts_of_berkshire():
    about, document = parse_submissions(submissions())
    assert about.name == "BERKSHIRE HATHAWAY INC"
    assert (about.street, about.city, about.state) == ("3555 FARNAM STREET", "OMAHA", "NE")
    assert about.incorporated == "DE"
    assert about.former_names == (("NBH INC", date(1998, 8, 10), date(1999, 1, 5)),)
    assert about.sic == "Fire, Marine & Casualty Insurance"
    assert about.tickers == ("BRK-B", "BRK-A")
    assert about.exchanges == ("NYSE", "NYSE")
    # The newest 13F-HR, not the newest filing (a Form 4 the next day) nor the first 13F listed.
    assert (about.accession, about.filed) == ("0001193125-26-463399", date(2026, 11, 16))
    assert document == "primary_doc.xml"  # the raw XML at the folder root, not the xsl rendering
    assert (about.signer, about.signer_title, about.signed, about.other_managers) == (None, None, None, ())


def test_the_newest_13f_is_found_by_date_whatever_the_order():
    body = submissions()
    recent = body["filings"]["recent"]
    for key in recent:
        recent[key] = list(reversed(recent[key]))
    about, _ = parse_submissions(body)
    assert about.accession == "0001193125-26-463399"


def test_an_amendment_counts_as_a_13f():
    body = submissions()
    recent = body["filings"]["recent"]
    recent["form"][1] = "13F-NT"  # a notice is no 13F-HR
    recent["form"][2] = "13F-HR/A"
    about, document = parse_submissions(body)
    assert (about.accession, about.filed) == ("0001193125-26-455871", date(2026, 11, 3))
    assert document == "primary_doc.xml"


def test_a_record_without_a_13f_or_an_address():
    body = submissions()
    body["filings"]["recent"]["form"] = ["4"] * 6
    body["addresses"] = {}
    body["formerNames"] = []
    body.update(stateOfIncorporation="", sicDescription="", tickers=[], exchanges=[])
    about, document = parse_submissions(body)
    assert document is None and about.accession is None and about.filed is None
    assert (about.street, about.city, about.state, about.incorporated, about.sic) == (None,) * 5
    assert (about.tickers, about.exchanges, about.former_names) == ((), (), ())


def test_a_text_filing_has_no_xml_cover():
    # Before mid-2013 a 13F was a text filing: there is no primary_doc.xml to read.
    body = submissions()
    body["filings"]["recent"]["primaryDocument"][1] = "0001193125-26-463399.txt"
    _, document = parse_submissions(body)
    assert document is None


def test_record_names_are_unescaped_and_former_names_oldest_first():
    body = submissions()
    body["name"] = "SMITH &amp; JONES CAPITAL"
    body["formerNames"] = [
        {"name": "SMITH &amp;amp; CO", "from": "2005-03-01T00:00:00.000Z", "to": "2010-06-30T00:00:00.000Z"},
        {"name": "SMITH ADVISERS", "from": "1999-02-01", "to": None},
    ]
    about, _ = parse_submissions(body)
    assert about.name == "SMITH & JONES CAPITAL"
    assert about.former_names == (
        ("SMITH ADVISERS", date(1999, 2, 1), None),
        ("SMITH & CO", date(2005, 3, 1), date(2010, 6, 30)),
    )


def test_a_ticker_without_an_exchange_keeps_its_place():
    body = submissions()
    body.update(tickers=["ABC", "ABC-P"], exchanges=["Nasdaq", None])
    about, _ = parse_submissions(body)
    assert (about.tickers, about.exchanges) == (("ABC", "ABC-P"), ("Nasdaq", None))


# --- the 13F cover page ----------------------------------------------------------------------


def test_cover_of_berkshire():
    cover = parse_cover(cover_xml())
    assert (cover.signer, cover.signer_title, cover.signed) == (
        "Marc D. Hamburg",
        "Senior Vice President",
        date(2026, 11, 16),
    )
    assert len(cover.other_managers) == 14
    assert cover.other_managers[0] == "Buffett Warren E"
    assert "GEICO Corp" in cover.other_managers
    assert "National Fire & Marine Insurance Co" in cover.other_managers


def _prefixed(xml: str) -> str:
    """The cover with every element under an `ns1:` prefix, as some filers' software writes it."""
    body = xml.replace('xmlns="http://www.sec.gov/edgar/thirteenffiler"', 'xmlns:ns1="http://www.sec.gov/edgar/thirteenffiler"')
    head, _, rest = body.partition("<edgarSubmission")
    rest = "<edgarSubmission" + rest
    import re

    rest = re.sub(r"<(/?)(?!com:)([A-Za-z])", r"<\1ns1:\2", rest)
    return head + rest


@pytest.mark.parametrize("variant", ["prefixed", "no namespace"])
def test_cover_parses_whatever_the_namespaces(variant):
    xml = cover_xml().decode()
    if variant == "prefixed":
        xml = _prefixed(xml)
    else:
        xml = xml.replace(' xmlns="http://www.sec.gov/edgar/thirteenffiler"', "")
        xml = xml.replace(' xmlns:com="http://www.sec.gov/edgar/common"', "").replace("com:", "")
    cover = parse_cover(xml.encode())
    assert cover == parse_cover(cover_xml())


def test_cover_ignores_the_managers_who_report_for_this_one():
    # A combination report's cover page lists the managers reporting for the filer
    # (otherManagersInfo): they are not managers included in the report.
    xml = cover_xml().decode().replace(
        "<reportType>13F HOLDINGS REPORT</reportType>",
        "<reportType>13F COMBINATION REPORT</reportType><otherManagersInfo><otherManager>"
        "<form13FFileNumber>028-99999</form13FFileNumber><name>Elsewhere Advisers LLC</name>"
        "</otherManager></otherManagersInfo>",
    )
    assert "Elsewhere Advisers LLC" not in parse_cover(xml.encode()).other_managers


def test_cover_names_are_unescaped_once_more():
    # Some filers escape twice: "&amp;amp;" reads as "&amp;" in the XML and is unescaped again.
    xml = cover_xml().replace(b"National Fire &amp; Marine", b"National Fire &amp;amp; Marine")
    assert "National Fire & Marine Insurance Co" in parse_cover(xml).other_managers


@pytest.mark.parametrize(
    "written, read",
    [("11-16-2026", date(2026, 11, 16)), ("11/16/2026", date(2026, 11, 16)),
     ("2026-11-16", date(2026, 11, 16)), ("16 Nov", None), ("", None)],
)  # fmt: skip
def test_cover_signature_dates(written, read):
    xml = cover_xml().replace(b"<signatureDate>11-16-2026</signatureDate>", f"<signatureDate>{written}</signatureDate>".encode())
    assert parse_cover(xml).signed == read


def test_cover_without_a_signature_or_managers():
    xml = cover_xml().decode()
    start, end = xml.index("<signatureBlock>"), xml.index("</summaryPage>") + len("</summaryPage>")
    cover = parse_cover((xml[:start] + xml[end:]).encode())
    assert (cover.signer, cover.signer_title, cover.signed, cover.other_managers) == (None, None, None, ())


@pytest.mark.parametrize(
    "body",
    [b"<edgarSubmission><formData>", b"not xml at all",
     b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><edgarSubmission>&a;</edgarSubmission>'],
)  # fmt: skip
def test_an_unreadable_cover_is_a_value_error(body):
    with pytest.raises(ValueError):
        parse_cover(body)


# --- the two calls ------------------------------------------------------------------------------


def test_fetch_about_asks_the_record_then_the_latest_13f_cover():
    client, asked = sec_stub({SUBMISSIONS: submissions(), COVER: cover_xml()})
    about = fetch_about(client, BERKSHIRE)
    assert asked == [SUBMISSIONS, COVER]
    record, _ = parse_submissions(submissions())
    cover = parse_cover(cover_xml())
    assert about == replace(
        record,
        signer=cover.signer,
        signer_title=cover.signer_title,
        signed=cover.signed,
        other_managers=cover.other_managers,
    )
    assert isinstance(about, About)


def test_fetch_about_of_a_cik_the_sec_does_not_know():
    client, asked = sec_stub({})
    assert fetch_about(client, BERKSHIRE) is None
    assert asked == [SUBMISSIONS]


def test_fetch_about_without_an_xml_cover_makes_one_call():
    body = submissions()
    body["filings"]["recent"]["primaryDocument"][1] = "0001193125-26-463399.txt"
    client, asked = sec_stub({SUBMISSIONS: body})
    about = fetch_about(client, BERKSHIRE)
    assert asked == [SUBMISSIONS]
    assert about.accession == "0001193125-26-463399" and about.signer is None


@pytest.mark.parametrize("page", [None, b"<half"])
def test_fetch_about_keeps_the_record_when_the_cover_is_missing_or_unreadable(page):
    pages = {SUBMISSIONS: submissions()} | ({} if page is None else {COVER: page})
    client, asked = sec_stub(pages)
    about = fetch_about(client, BERKSHIRE)
    assert asked == [SUBMISSIONS, COVER]
    assert about.name == "BERKSHIRE HATHAWAY INC" and about.signer is None


def test_fetch_about_raises_when_the_sec_keeps_failing():
    client, _ = sec_stub({SUBMISSIONS: httpx.Response(503)})
    with pytest.raises(FetchError):
        fetch_about(client, BERKSHIRE)
    client, _ = sec_stub({SUBMISSIONS: submissions(), COVER: httpx.Response(503)})
    with pytest.raises(FetchError):
        fetch_about(client, BERKSHIRE)
