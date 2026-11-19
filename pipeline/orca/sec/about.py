"""SEC facts about a filer, for the fund page's About tab (lake table `fund_about`).

Two SEC calls per fund, both on the shared SEC client (its User-Agent, rate limit and retries):

1. `data.sec.gov/submissions/CIK##########.json`, the filer's record: its name, business address, state of
   incorporation, former names, industry (SIC description), its own tickers and exchanges, and, among its
   recent filings, the newest 13F-HR or 13F-HR/A.
2. That filing's cover document, `primary_doc.xml` at the root of the filing's folder (submissions names the
   `xslForm13F_X02/...` rendering): the signature block and the other managers included in the report.

Values are kept as the SEC gives them (names often in capitals), with HTML entities decoded: some filers
escape `&` twice, so `&amp;amp;` is read as `&`. Namespaces vary between filers' software and are ignored.
"""

import html
import re
from dataclasses import dataclass, replace
from datetime import date
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

import polars as pl

from orca.http import Client, FetchError
from orca.securities import SUBMISSIONS_URL

TABLE = "fund_about"
COVER_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/{document}"
# One row per CIK. accession / filed: the 13F the row was read from (when the record lists none, the lake's
# newest, so the row is not asked again until a newer one is filed); fetched: the day of the lookup.
SCHEMA = pl.Schema(
    {
        "cik": pl.Int64,
        "name": pl.String,
        "street": pl.String,
        "city": pl.String,
        "state": pl.String,
        "incorporated": pl.String,
        "sic": pl.String,
        "tickers": pl.List(pl.String),
        "exchanges": pl.List(pl.String),
        "former_names": pl.List(pl.Struct({"name": pl.String, "from": pl.Date, "to": pl.Date})),
        "signer": pl.String,
        "signer_title": pl.String,
        "signed": pl.Date,
        "other_managers": pl.List(pl.String),
        "accession": pl.String,
        "filed": pl.Date,
        "fetched": pl.Date,
    }
)
# The cover's MM-DD-YYYY, and what some filers write instead.
_DATE_FORMATS = (
    re.compile(r"(?P<m>\d{1,2})[-/](?P<d>\d{1,2})[-/](?P<y>\d{4})"),
    re.compile(r"(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})"),
)


@dataclass(frozen=True)
class Cover:
    """A 13F cover document's signature block and the names of the other managers included in the report."""

    signer: str | None
    signer_title: str | None
    signed: date | None
    other_managers: tuple[str, ...]


@dataclass(frozen=True)
class About:
    """What the SEC says about a filer. `former_names` are (name, from, to), oldest first; `exchanges[i]` is
    where `tickers[i]` trades. `accession` and `filed` are the newest 13F-HR(/A) the record lists (None:
    none), the signer fields that filing's cover page."""

    name: str | None = None
    street: str | None = None
    city: str | None = None
    state: str | None = None
    incorporated: str | None = None
    sic: str | None = None
    tickers: tuple[str, ...] = ()
    exchanges: tuple[str | None, ...] = ()
    former_names: tuple[tuple[str, date | None, date | None], ...] = ()
    signer: str | None = None
    signer_title: str | None = None
    signed: date | None = None
    other_managers: tuple[str, ...] = ()
    accession: str | None = None
    filed: date | None = None


def fetch_about(client: Client, cik: int) -> About | None:
    """The filer's facts from its record and its newest 13F's cover page; None when the SEC does not know
    the CIK (404). A cover that is missing (404) or unreadable leaves the signer fields empty; any other
    failure raises FetchError (ValueError for a record that is not JSON)."""
    try:
        body = client.get(SUBMISSIONS_URL.format(cik=cik)).json()
    except FetchError as err:
        if err.status == 404:
            return None
        raise
    about, document = parse_submissions(body)
    if document is None:
        return about
    folder = about.accession.replace("-", "")
    try:
        xml = client.get(COVER_URL.format(cik=cik, folder=folder, document=document)).content
        cover = parse_cover(xml)
    except FetchError as err:
        if err.status == 404:
            return about
        raise
    except ValueError:
        return about
    return replace(
        about,
        signer=cover.signer,
        signer_title=cover.signer_title,
        signed=cover.signed,
        other_managers=cover.other_managers,
    )


def parse_submissions(body: dict) -> tuple[About, str | None]:
    """(the record's facts with its newest 13F-HR(/A), the file name of that filing's XML cover document at
    its folder's root, or None for a text filing or without a 13F)."""
    business = (body.get("addresses") or {}).get("business") or {}
    tickers = body.get("tickers") or []
    exchanges = list(body.get("exchanges") or [])
    exchanges += [None] * (len(tickers) - len(exchanges))
    pairs = [(_clean(t), _clean(x)) for t, x in zip(tickers, exchanges)]
    pairs = [(t, x) for t, x in pairs if t is not None]
    former = [
        (name, _day(f.get("from")), _day(f.get("to")))
        for f in body.get("formerNames") or []
        if (name := _clean(f.get("name"))) is not None
    ]
    former.sort(key=lambda f: (f[1] is not None, f[1] or date.min, f[0]))
    accession, filed, document = _latest_13f((body.get("filings") or {}).get("recent") or {})
    about = About(
        name=_clean(body.get("name")),
        street=_clean(business.get("street1")),
        city=_clean(business.get("city")),
        state=_clean(business.get("stateOrCountry")),
        incorporated=_clean(body.get("stateOfIncorporation")),
        sic=_clean(body.get("sicDescription")),
        tickers=tuple(t for t, _ in pairs),
        exchanges=tuple(x for _, x in pairs),
        former_names=tuple(former),
        accession=accession,
        filed=filed,
    )
    return about, document


def _latest_13f(recent: dict) -> tuple[str | None, date | None, str | None]:
    """(accession, filing date, XML cover file name) of the newest 13F-HR or 13F-HR/A among the record's
    recent filings, by filing date and acceptance time (the list's order is not relied on)."""
    columns = ("accessionNumber", "filingDate", "form", "primaryDocument", "acceptanceDateTime")
    rows = zip(*(list(recent.get(c) or []) for c in columns))
    found = [
        (filed, accepted or "", accession, document)
        for accession, filed_text, form, document, accepted in rows
        if str(form or "").upper().startswith("13F-HR") and accession
        and (filed := _day(filed_text)) is not None
    ]  # fmt: skip
    if not found:
        return None, None, None
    filed, _, accession, document = max(found)
    name = PurePosixPath(str(document or "")).name
    return accession, filed, name if name.lower().endswith(".xml") else None


def parse_cover(xml: bytes) -> Cover:
    """The signature block and the other included managers of a 13F cover document, whatever its namespaces.
    Only the summary page's list counts (otherManagers2Info): the cover page's otherManagersInfo names the
    managers that report for this one. ValueError when the document is not readable XML; a document that
    declares entities is refused, so no entity is ever expanded."""
    if b"<!ENTITY" in xml:
        raise ValueError("cover document declares entities")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as err:
        raise ValueError(f"cover document is not valid XML ({err})") from err
    for element in root.iter():
        element.tag = element.tag.rpartition("}")[2]
    signature = next(root.iter("signatureBlock"), None)
    managers = [
        name
        for listing in root.iter("otherManagers2Info")
        for manager in listing.iter("otherManager")
        if (name := _clean(manager.findtext("name"))) is not None
    ]
    if signature is None:
        return Cover(None, None, None, tuple(managers))
    return Cover(
        signer=_clean(signature.findtext("name")),
        signer_title=_clean(signature.findtext("title")),
        signed=_cover_date(signature.findtext("signatureDate")),
        other_managers=tuple(managers),
    )


def table_row(cik: int, about: About, fetched: date) -> dict:
    """`about` as a row of the lake table (SCHEMA)."""
    return {
        "cik": cik,
        "name": about.name,
        "street": about.street,
        "city": about.city,
        "state": about.state,
        "incorporated": about.incorporated,
        "sic": about.sic,
        "tickers": list(about.tickers),
        "exchanges": list(about.exchanges),
        "former_names": [{"name": n, "from": f, "to": t} for n, f, t in about.former_names],
        "signer": about.signer,
        "signer_title": about.signer_title,
        "signed": about.signed,
        "other_managers": list(about.other_managers),
        "accession": about.accession,
        "filed": about.filed,
        "fetched": fetched,
    }


def _clean(value: object) -> str | None:
    """A string field as the SEC gives it, entities decoded (twice-escaped ones too) and spaces trimmed;
    None when empty."""
    if value is None:
        return None
    text = " ".join(html.unescape(html.unescape(str(value))).split())
    return text or None


def _day(value: object) -> date | None:
    """An ISO date, or the date of an ISO timestamp ("1998-08-10T00:00:00.000Z"); None otherwise."""
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _cover_date(value: str | None) -> date | None:
    text = (value or "").strip()
    for pattern in _DATE_FORMATS:
        if (m := pattern.fullmatch(text)) is not None:
            try:
                return date(int(m["y"]), int(m["m"]), int(m["d"]))
            except ValueError:
                return None
    return None
