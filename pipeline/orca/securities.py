"""Security master: map CUSIPs to FIGI/ticker, assign stable stock ids, sectors from SIC codes,
shares outstanding. All SEC calls go through the one shared SEC `Client`."""

import csv
import re
from functools import cache
from pathlib import Path

import polars as pl

from orca.http import Client, FetchError, FigiClient

FIGI_URL = "https://api.openfigi.com/v3/mapping"
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
SHARES_CONCEPT_URL = (
    "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010d}/dei/"
    "EntityCommonStockSharesOutstanding.json"
)
SIC_TO_SECTOR_CSV = Path(__file__).with_name("sic_to_sector.csv")

OPENFIGI, NAME, UNMAPPED = "openfigi", "name", "unmapped"
ETF_SECTOR, OTHER_SECTOR = "ETF/Fund", "Other"

MAPPED_SCHEMA = pl.Schema(
    {
        "cusip": pl.String,
        "figi": pl.String,
        "ticker": pl.String,
        "name": pl.String,
        "is_etf": pl.Boolean,
        "method": pl.String,
    }
)
SECURITIES_SCHEMA = pl.Schema(
    {
        "stock_id": pl.Int32,
        "figi": pl.String,
        "ticker": pl.String,
        "name": pl.String,
        "is_etf": pl.Boolean,
    }
)
SEC_TICKERS_SCHEMA = pl.Schema({"ticker": pl.String, "cik": pl.Int64, "title": pl.String})

# A security as the mapping stage sees it: (figi, ticker, name, is_etf).
_Match = tuple[str | None, str | None, str | None, bool]

# Name suffixes dropped from the end of a name, repeatedly: "ALPHABET INC CL A" -> "ALPHABET".
_NAME_SUFFIX = re.compile(r"(?:^| )(?:INC|CORP|CO|LTD|PLC|COM|CL [AB]( [AB])?)$")


def normalise_name(name: str) -> str:
    """Upper-case, drop punctuation and trailing INC/CORP/CO/LTD/PLC/COM/CL A/CL B suffixes."""
    text = name.upper().replace("'", "").replace("’", "")
    text = " ".join(re.sub(r"[^A-Z0-9]+", " ", text).split())
    while (suffix := _NAME_SUFFIX.search(text)) is not None:
        text = text[: suffix.start()]
    return text


def normalise_ticker(ticker: str | None) -> str | None:
    """SEC style: upper case, "/" and "." as "-" (OpenFIGI "BRK/B" and SEC "BRK-B" agree)."""
    if ticker is None:
        return None
    return ticker.strip().upper().replace("/", "-").replace(".", "-")


# --- CUSIP -> security -------------------------------------------------------------------


def map_cusips(
    cusips: list[str],
    issuer_names: dict[str, str],
    figi: FigiClient,
    sec_tickers: pl.DataFrame,
) -> pl.DataFrame:
    """Map each distinct CUSIP, in first-seen order, to a security.

    OpenFIGI first; for CUSIPs it cannot map, an exact normalised-name match against exactly
    one SEC ticker row (`issuer_names`: cusip -> name from the 13F; `sec_tickers`: the frame
    from `load_sec_tickers`); otherwise unmapped. `figi` is `figi_client()`; its
    `jobs_per_request` sets the batch size. Tickers come out in SEC style (`normalise_ticker`).
    """
    distinct = list(dict.fromkeys(cusips))
    batch_size = figi.jobs_per_request
    found: dict[str, _Match | None] = {}
    for start in range(0, len(distinct), batch_size):
        batch = distinct[start : start + batch_size]
        found.update(zip(batch, _openfigi_batch(figi, batch)))

    titles = _titles_by_normalised_name(sec_tickers)
    rows = []
    for cusip in distinct:
        if (match := found[cusip]) is not None:
            method = OPENFIGI
        elif (match := _name_match(issuer_names.get(cusip), titles)) is not None:
            method = NAME
        else:
            match, method = (None, None, None, False), UNMAPPED
        rows.append((cusip, *match, method))
    return pl.DataFrame(rows, schema=MAPPED_SCHEMA, orient="row")


def _openfigi_batch(client: FigiClient, cusips: list[str]) -> list[_Match | None]:
    jobs = [{"idType": "ID_CUSIP", "idValue": cusip} for cusip in cusips]
    results = client.post_json(FIGI_URL, jobs).json()
    if not isinstance(results, list) or len(results) != len(jobs):
        raise ValueError(f"OpenFIGI answered {len(jobs)} jobs with an unaligned response")
    return [_pick_listing(result.get("data")) for result in results]


def _pick_listing(data: list[dict] | None) -> _Match | None:
    """The US listing if there is one, else the first; None when OpenFIGI found nothing."""
    if not data:
        return None
    listing = next((d for d in data if d.get("exchCode") == "US"), data[0])
    figi = listing.get("compositeFIGI") or listing.get("figi")
    is_etf = str(listing.get("securityType") or "").upper() == "ETP"
    return figi, normalise_ticker(listing.get("ticker")), listing.get("name"), is_etf


def _titles_by_normalised_name(sec_tickers: pl.DataFrame) -> dict[str, list[tuple[str, str]]]:
    """Normalised SEC title -> every (ticker, title) row that has it."""
    titles: dict[str, list[tuple[str, str]]] = {}
    for ticker, title in sec_tickers.select("ticker", "title").iter_rows():
        if key := normalise_name(title):
            titles.setdefault(key, []).append((normalise_ticker(ticker), title))
    return titles


def _name_match(issuer: str | None, titles: dict[str, list[tuple[str, str]]]) -> _Match | None:
    if not issuer or not (key := normalise_name(issuer)):
        return None
    rows = titles.get(key, [])
    if len(rows) != 1:  # no match, or ambiguous (e.g. several share classes)
        return None
    ticker, title = rows[0]
    return None, ticker, title, False


# --- stock ids ------------------------------------------------------------------------------


def assign_stock_ids(mapped: pl.DataFrame, existing: pl.DataFrame) -> pl.DataFrame:
    """The securities table with `mapped` added: existing rows (and their ids) are untouched,
    new securities get max + 1, max + 2 ... in first-seen order.

    A security is identified by its FIGI, or by its ticker when it has no FIGI. A row without
    FIGI whose ticker belongs to a row that has one (in `existing`, else anywhere in `mapped`)
    takes that FIGI, so one issuer never gets two ids in one call. Rows with
    neither FIGI nor ticker (unmapped) get no id. `existing` may be empty, with or without
    columns.
    """
    if existing.width == 0:
        existing = pl.DataFrame(schema=SECURITIES_SCHEMA)
    known = {_identity(row["figi"], row["ticker"]) for row in existing.iter_rows(named=True)}
    figi_of_ticker: dict[str, str] = {}
    for frame in (existing, mapped):
        for figi, ticker in frame.select("figi", "ticker").iter_rows():
            if figi and ticker:
                figi_of_ticker.setdefault(ticker, figi)
    next_id = existing["stock_id"].max() or 0

    new_rows = []
    for row in mapped.iter_rows(named=True):
        figi = row["figi"] or figi_of_ticker.get(row["ticker"])
        key = _identity(figi, row["ticker"])
        if key is None or key in known:
            continue
        known.add(key)
        next_id += 1
        new_rows.append((next_id, figi, row["ticker"], row["name"], row["is_etf"]))
    added = pl.DataFrame(new_rows, schema=SECURITIES_SCHEMA, orient="row")
    return pl.concat([existing, added], how="diagonal_relaxed")


def _identity(figi: str | None, ticker: str | None) -> tuple[str, str] | None:
    if figi:
        return ("figi", figi)
    if ticker:
        return ("ticker", ticker)
    return None


# --- sectors ---------------------------------------------------------------------------------


@cache
def _sic_ranges() -> tuple[tuple[int, int, str], ...]:
    with SIC_TO_SECTOR_CSV.open(newline="") as f:
        return tuple((int(r["sic_from"]), int(r["sic_to"]), r["sector"]) for r in csv.DictReader(f))


def sector_for_sic(sic: int | None, is_etf: bool) -> str:
    """Sector of a SIC code: the first row of sic_to_sector.csv that contains it, so specific
    ranges are listed before the broad ones around them. ETFs are "ETF/Fund", no match "Other"."""
    if is_etf:
        return ETF_SECTOR
    if sic is not None:
        for sic_from, sic_to, sector in _sic_ranges():
            if sic_from <= sic <= sic_to:
                return sector
    return OTHER_SECTOR


# --- SEC lookups -----------------------------------------------------------------------------


def load_sec_tickers(client: Client) -> pl.DataFrame:
    """SEC's ticker list as a frame of ticker (SEC style), cik, title."""
    entries = client.get(SEC_TICKERS_URL).json().values()
    rows = [(normalise_ticker(e["ticker"]), int(e["cik_str"]), e["title"]) for e in entries]
    return pl.DataFrame(rows, schema=SEC_TICKERS_SCHEMA, orient="row")


def fetch_sic(client: Client, cik: int) -> int | None:
    """The company's SIC code, or None when it has none or the SEC does not know the CIK."""
    body = _get_json_or_none(client, SUBMISSIONS_URL.format(cik=cik))
    sic = str((body or {}).get("sic") or "").strip()
    return int(sic) if sic.isdigit() else None


def fetch_shares_outstanding(client: Client, cik: int) -> float | None:
    """Shares outstanding from the company's latest `dei:EntityCommonStockSharesOutstanding`.

    Takes the entries with the latest period end, keeps those of the one filing (accn) with the
    latest `filed` date (a tie goes to the larger accn), drops exact repeats (same val, end,
    accn, form, fp) and sums the rest: a filer with several share classes reports one entry per
    class. None when the company does not report the concept or the SEC does not know the CIK.
    """
    body = _get_json_or_none(client, SHARES_CONCEPT_URL.format(cik=cik))
    try:
        facts = body["units"]["shares"]
    except (KeyError, TypeError):
        return None
    facts = [f for f in facts if f.get("end") and f.get("val") is not None]
    if not facts:
        return None
    latest_end = max(f["end"] for f in facts)
    latest = [f for f in facts if f["end"] == latest_end]

    def filing(f: dict) -> tuple[str, str]:
        return f.get("filed") or "", f.get("accn") or ""

    newest = max(filing(f) for f in latest)
    in_newest = [f for f in latest if filing(f) == newest]
    distinct = {(f["val"], f["end"], f.get("accn"), f.get("form"), f.get("fp")) for f in in_newest}
    return float(sum(val for val, *_ in distinct))


def _get_json_or_none(client: Client, url: str):
    """The JSON body of a GET; None when the SEC answers 404 (unknown CIK)."""
    try:
        return client.get(url).json()
    except FetchError as err:
        if err.status == 404:
            return None
        raise
