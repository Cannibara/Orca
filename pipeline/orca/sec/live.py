"""Live 13F filings: find new ones in the EDGAR daily index and read their submission files.

The bulk data sets lag a quarter, so recent filings come straight from EDGAR. For each day we
read the daily form index, keep the 13F-HR / 13F-HR/A lines, and download each filing's full
submission text file (one request). That file holds a <DOCUMENT> per document; two matter:
the primary document (report period, amendment type, manager name) and the INFORMATION
TABLE (the holdings). The output frames match parse_bulk_zip's, with source="live".
"""

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

import polars as pl

from orca.http import Client, FetchError
from orca.quarters import q_of_date
from orca.sec.bulk import AMENDMENT_TYPES, KEPT_FORMS, MAX_LOGGED_ACCESSIONS, raw_holdings

log = logging.getLogger(__name__)

ARCHIVES = "https://www.sec.gov/Archives/"
NO_INDEX_STATUSES = (403, 404)  # what EDGAR answers for a day with no index: weekend, holiday
INFO_TABLE_TYPE = "INFORMATION TABLE"
PERIOD_FORMAT = "%m-%d-%Y"  # 03-31-2025

# Same columns and dtypes as parse_bulk_zip's `filings`.
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
# Info table fields as read from the XML, before raw_holdings types and cleans them.
INFO_FIELDS = ["accession", "issuer", "title", "cusip", "value", "shares", "sh_type", "put_call"]
INFO_SCHEMA = pl.Schema({name: pl.String for name in INFO_FIELDS})

_SEPARATOR = re.compile(r"-{10,}\s*$")
_CIK = re.compile(r"[0-9]+")
_PATH = re.compile(r"edgar/data/[0-9]+/[0-9]{10}-[0-9]{2}-[0-9]{6}\.txt")
_DOCUMENT = re.compile(rb"<DOCUMENT>(.*?)</DOCUMENT>", re.DOTALL | re.IGNORECASE)
_TYPE = re.compile(rb"<TYPE>[ \t]*([^\r\n<]+)", re.IGNORECASE)
_XML = re.compile(rb"<XML>\s*(.*?)\s*</XML>", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True)
class IndexEntry:
    form: str
    cik: int
    company: str
    filed: date
    path: str  # edgar/data/<cik>/<accession>.txt

    @property
    def accession(self) -> str:
        return PurePosixPath(self.path).stem


def _index_entry(form: str, line: str) -> IndexEntry | None:
    """One kept-form index line, or None if its CIK, date or file name is unusable."""
    parts = line.rsplit(None, 3)  # from the right: the company name may contain spaces
    if len(parts) != 4:
        return None
    head, cik, filed, path = parts
    if not _CIK.fullmatch(cik) or not _PATH.fullmatch(path):
        return None
    try:
        filed_on = date.fromisoformat(filed)  # YYYYMMDD or YYYY-MM-DD
    except ValueError:
        return None
    name = head.split(None, 1)[1:]  # head is "<form>  <company>"
    return IndexEntry(form, int(cik), name[0] if name else "", filed_on, path)


def parse_daily_index(text: str, stats: dict | None = None) -> list[IndexEntry]:
    """The 13F-HR and 13F-HR/A lines of one daily form index.

    Rows follow the dashed separator line (all lines are tried if there is none). A kept-form
    line whose CIK, date or file name is unusable is dropped, never fatal, and counted in
    stats["dropped_filings"] if `stats` is given. Other forms are ignored silently.
    """
    lines = text.splitlines()
    start = next((i + 1 for i, line in enumerate(lines) if _SEPARATOR.match(line)), 0)
    entries, dropped = [], 0
    for line in lines[start:]:
        form = line.split(None, 1)[0].upper() if line.strip() else ""
        if form not in KEPT_FORMS:
            continue
        entry = _index_entry(form, line)
        if entry is None:
            dropped += 1
        else:
            entries.append(entry)
    if stats is not None:
        stats["dropped_filings"] = dropped
    return entries


def _parse_xml(xml: bytes, what: str) -> ET.Element:
    """Parse XML and strip namespaces from every tag, so `ns1:infoTable` and `infoTable` match alike."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as err:
        raise ValueError(f"{what}: not valid XML ({err})") from err
    for element in root.iter():
        element.tag = element.tag.rpartition("}")[2]
    return root


def _text(element: ET.Element, path: str) -> str | None:
    value = (element.findtext(path) or "").strip()
    return value or None


def _info_rows(xml: bytes, accession: str) -> list[dict[str, str | None]]:
    """The info table's holdings as raw strings; ValueError if this is not an info table."""
    root = _parse_xml(xml, f"{accession}: information table")
    if root.tag != "informationTable":
        raise ValueError(f"{accession}: information table has root <{root.tag}>")
    return [
        {
            "accession": accession,
            "issuer": _text(entry, "nameOfIssuer"),
            "title": _text(entry, "titleOfClass"),
            "cusip": _text(entry, "cusip"),
            "value": _text(entry, "value"),
            "shares": _text(entry, "shrsOrPrnAmt/sshPrnamt"),
            "sh_type": _text(entry, "shrsOrPrnAmt/sshPrnamtType"),
            "put_call": _text(entry, "putCall"),
        }
        for entry in root.findall("infoTable")
    ]


def parse_infotable_xml(xml: bytes, accession: str, filed: date, stats: dict | None = None) -> pl.DataFrame:
    """One filing's info table as raw_holdings-shaped rows, VALUE in dollars (units follow `filed`).

    Holdings whose share type is not SH/PRN, or whose value or share count is missing or not a
    number, are dropped as in the bulk parser and counted in stats["dropped_holdings"] if
    `stats` is given. XML that is not an information table raises ValueError.
    """
    rows = _info_rows(xml, accession)
    filing = pl.DataFrame({"accession": [accession], "filed": [filed]})
    holdings, dropped = raw_holdings(pl.DataFrame(rows, schema=INFO_SCHEMA), filing, [])
    if stats is not None:
        stats["dropped_holdings"] = len(dropped)
    return holdings


def _xml_documents(submission: bytes) -> dict[str, bytes]:
    """The XML body of each <DOCUMENT> in a submission text file, by its upper-cased <TYPE>."""
    documents: dict[str, bytes] = {}
    for match in _DOCUMENT.finditer(submission):
        doc_type, xml = _TYPE.search(match[1]), _XML.search(match[1])
        if doc_type and xml:
            documents.setdefault(doc_type[1].decode("ascii", "replace").strip().upper(), xml[1])
    return documents


def _read_cover(xml: bytes, accession: str) -> tuple[date, str | None, str | None]:
    """(report period, amendment type, manager name) from the primary document."""
    root = _parse_xml(xml, f"{accession}: primary document")
    period_text = _text(root, ".//coverPage/reportCalendarOrQuarter")
    try:
        period = datetime.strptime(period_text, PERIOD_FORMAT).date()
    except (TypeError, ValueError):
        raise ValueError(f"{accession}: unusable report period {period_text!r}") from None
    amendment = (_text(root, ".//coverPage/amendmentInfo/amendmentType") or "").upper()
    return period, AMENDMENT_TYPES.get(amendment), _text(root, ".//coverPage/filingManager/name")


def _read_submission(submission: bytes, entry: IndexEntry) -> tuple[dict, list[dict[str, str | None]]]:
    """(filings row, raw info rows) of one submission file; ValueError if it is unusable."""
    accession = entry.accession
    documents = _xml_documents(submission)
    primary = next((documents[form] for form in KEPT_FORMS if form in documents), None)
    if primary is None:
        raise ValueError(f"{accession}: no {entry.form} document")
    if INFO_TABLE_TYPE not in documents:
        # An empty portfolio is not a missing table: losing it would wipe the fund's holdings.
        raise ValueError(f"{accession}: no {INFO_TABLE_TYPE} document")
    period, amendment_type, manager_name = _read_cover(primary, accession)
    rows = _info_rows(documents[INFO_TABLE_TYPE], accession)
    filing = {
        "accession": accession,
        "cik": entry.cik,
        "period": q_of_date(period),
        "filed": entry.filed,
        "form": entry.form,
        "amendment_type": amendment_type,
        "manager_name": manager_name,
        "source": "live",
    }
    return filing, rows


def _daily_index(client: Client, day: date) -> str | None:
    """The day's index text, or None for a day EDGAR has no index for."""
    quarter = (day.month - 1) // 3 + 1
    url = f"{ARCHIVES}edgar/daily-index/{day.year}/QTR{quarter}/form.{day:%Y%m%d}.idx"
    try:
        return client.get(url).text
    except FetchError as err:
        if err.status in NO_INDEX_STATUSES:
            return None
        raise


def _index_entries(
    client: Client, since: date, until: date
) -> tuple[list[IndexEntry], int, list[date]]:
    """13F entries of every day since..until, each filing once, the count of unusable lines, and
    the days EDGAR had no index for."""
    entries: dict[str, IndexEntry] = {}
    dropped = 0
    no_index: list[date] = []
    day = since
    while day <= until:
        text = _daily_index(client, day)
        if text is None:
            no_index.append(day)
        else:
            day_stats: dict = {}
            for entry in parse_daily_index(text, day_stats):
                # A filing with several filers is listed once per filer: keep the first.
                entries.setdefault(entry.accession, entry)
            dropped += day_stats["dropped_filings"]
        day += timedelta(days=1)
    return list(entries.values()), dropped, no_index


def fetch_new_filings(
    client: Client, since: date, until: date, stats: dict | None = None
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(filings, raw_holdings) for 13F-HR / 13F-HR/A filings indexed from `since` to `until` inclusive.

    Same shapes as parse_bulk_zip, with source="live". Takes the one shared SEC client so
    every request counts against the same rate limit. A day with no index (403 / 404) is
    skipped; any other failed index request raises FetchError.

    Bad input is dropped, never fatal: an index line, or a filing whose primary document, info
    table or report period is missing or unreadable, goes with its holdings; a holding with an
    unusable share type, value or share count goes alone; a filing that cannot be downloaded is
    skipped. If `stats` is given, these are counted in stats["dropped_filings"],
    stats["dropped_holdings"] and stats["failed_filings"], and one warning names the offenders;
    stats["no_index_days"] lists the days that had no index, oldest first (a recent one may only
    not be published yet, so a caller should read it again later).
    """
    entries, dropped_lines, no_index_days = _index_entries(client, since, until)
    filing_rows: list[dict] = []
    info_rows: list[dict[str, str | None]] = []
    bad_filings: list[str] = []
    failed_filings: list[str] = []
    for entry in entries:
        try:
            submission = client.get(ARCHIVES + entry.path).content
        except FetchError as err:
            log.debug("could not download %s: %s", entry.accession, err)
            failed_filings.append(entry.accession)
            continue
        try:
            filing, rows = _read_submission(submission, entry)
        except ValueError as err:
            log.debug("dropped filing: %s", err)
            bad_filings.append(entry.accession)
            continue
        filing_rows.append(filing)
        info_rows.extend(rows)

    filings = pl.DataFrame(filing_rows, schema=FILINGS_SCHEMA)
    holdings, bad_holdings = raw_holdings(pl.DataFrame(info_rows, schema=INFO_SCHEMA), filings, [])

    dropped_filings = dropped_lines + len(bad_filings)
    if stats is not None:
        stats["dropped_filings"] = dropped_filings
        stats["dropped_holdings"] = len(bad_holdings)
        stats["failed_filings"] = len(failed_filings)
        stats["no_index_days"] = no_index_days
    if dropped_filings or bad_holdings or failed_filings:
        offending = list(dict.fromkeys([*bad_filings, *failed_filings, *bad_holdings]))
        log.warning(
            "live filings %s to %s: dropped %d filing(s) and %d holding(s) with bad input, "
            "%d download(s) failed; accessions: %s%s",
            since,
            until,
            dropped_filings,
            len(bad_holdings),
            len(failed_filings),
            ", ".join(offending[:MAX_LOGGED_ACCESSIONS]),
            ", ..." if len(offending) > MAX_LOGGED_ACCESSIONS else "",
        )
    return filings, holdings
