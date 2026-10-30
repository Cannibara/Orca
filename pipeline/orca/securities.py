"""Security master: map CUSIPs to FIGI/ticker, assign stable stock ids, sectors from SIC codes,
shares outstanding. All SEC calls go through the one shared SEC `Client`."""

import csv
import re
from functools import cache
from pathlib import Path

import polars as pl

from orca.http import FIGI_JOBS_KEYED, Client, FetchError

FIGI_URL = "https://api.openfigi.com/v3/mapping"
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
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


# --- CUSIP -> security -------------------------------------------------------------------


def map_cusips(
    cusips: list[str],
    issuer_names: dict[str, str],
    figi: Client,
    sec_tickers: pl.DataFrame,
) -> pl.DataFrame:
    """Map each distinct CUSIP, in first-seen order, to a security.

    OpenFIGI first; for CUSIPs it cannot map, an exact normalised-name match against exactly
    one SEC ticker row (`issuer_names`: cusip -> name from the 13F; `sec_tickers`: the frame
    from `load_sec_tickers`); otherwise unmapped. `figi` is normally `figi_client()`, whose
    `jobs_per_request` sets the batch size (a plain Client gets the keyed maximum, 100).
    """
    distinct = list(dict.fromkeys(cusips))
    batch_size = getattr(figi, "jobs_per_request", FIGI_JOBS_KEYED)
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


def _openfigi_batch(client: Client, cusips: list[str]) -> list[_Match | None]:
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
    return figi, listing.get("ticker"), listing.get("name"), is_etf


def _titles_by_normalised_name(sec_tickers: pl.DataFrame) -> dict[str, list[tuple[str, str]]]:
    """Normalised SEC title -> every (ticker, title) row that has it."""
    titles: dict[str, list[tuple[str, str]]] = {}
    for ticker, title in sec_tickers.select("ticker", "title").iter_rows():
        if key := normalise_name(title):
            titles.setdefault(key, []).append((ticker, title))
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

    A security is identified by its FIGI, or by its ticker when it has no FIGI; rows with
    neither (unmapped) get no id. `existing` may be empty, with or without columns.
    """
    if existing.width == 0:
        existing = pl.DataFrame(schema=SECURITIES_SCHEMA)
    known = {_identity(row["figi"], row["ticker"]) for row in existing.iter_rows(named=True)}
    next_id = existing["stock_id"].max() or 0

    new_rows = []
    for row in mapped.iter_rows(named=True):
        key = _identity(row["figi"], row["ticker"])
        if key is None or key in known:
            continue
        known.add(key)
        next_id += 1
        new_rows.append((next_id, row["figi"], row["ticker"], row["name"], row["is_etf"]))
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
    """SEC's ticker list as a frame of ticker, cik, title."""
    entries = client.get(SEC_TICKERS_URL).json().values()
    rows = [(e["ticker"], int(e["cik_str"]), e["title"]) for e in entries]
    return pl.DataFrame(rows, schema=SEC_TICKERS_SCHEMA, orient="row")


def fetch_sic(client: Client, cik: int) -> int | None:
    """The company's SIC code, or None when it has none or the SEC does not know the CIK."""
    body = _get_json_or_none(client, SUBMISSIONS_URL.format(cik=cik))
    sic = str((body or {}).get("sic") or "").strip()
    return int(sic) if sic.isdigit() else None


def fetch_shares_outstanding(client: Client, cik: int) -> float | None:
    """Latest `dei:EntityCommonStockSharesOutstanding`: the value with the latest period end,
    ties broken by filing date (then by the larger value, so the answer never depends on the
    order the SEC lists facts in). None when the company does not report it."""
    body = _get_json_or_none(client, COMPANY_FACTS_URL.format(cik=cik))
    try:
        facts = body["facts"]["dei"]["EntityCommonStockSharesOutstanding"]["units"]["shares"]
    except (KeyError, TypeError):
        return None
    reported = [
        (f["end"], f.get("filed") or "", f["val"])
        for f in facts
        if f.get("end") and f.get("val") is not None
    ]
    return float(max(reported)[2]) if reported else None


def _get_json_or_none(client: Client, url: str):
    """The JSON body of a GET; None when the SEC answers 404 (unknown CIK)."""
    try:
        return client.get(url).json()
    except FetchError as err:
        if err.status == 404:
            return None
        raise
