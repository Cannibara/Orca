"""SEC Form 13F bulk data sets: find the quarterly ZIPs and parse them.

Each ZIP holds tab-separated tables (SUBMISSION, COVERPAGE, INFOTABLE, ...). We read the
three we need and return two tidy frames: one row per 13F-HR / 13F-HR/A filing, and one row
per reported holding with VALUE converted to dollars.
"""

import logging
import zipfile
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import polars as pl

from orca.config import VALUE_DOLLARS_FROM
from orca.http import Client
from orca.quarters import q_of_date

log = logging.getLogger(__name__)

DATASETS_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
SEC_HOST = "www.sec.gov"
ZIP_SUFFIX = "form13f.zip"

# Our column name -> header in the SEC TSVs. The only place SEC header spellings live.
COLUMNS = {
    "accession": "ACCESSION_NUMBER",
    "filed": "FILING_DATE",
    "form": "SUBMISSIONTYPE",
    "cik": "CIK",
    "period": "PERIODOFREPORT",
    "amendment_type": "AMENDMENTTYPE",
    "manager_name": "FILINGMANAGER_NAME",
    "issuer": "NAMEOFISSUER",
    "title": "TITLEOFCLASS",
    "cusip": "CUSIP",
    "value": "VALUE",
    "shares": "SSHPRNAMT",
    "sh_type": "SSHPRNAMTTYPE",
    "put_call": "PUTCALL",
}

# Which of our columns come from which TSV in the ZIP.
TABLES = {
    "SUBMISSION": ["accession", "filed", "form", "cik", "period"],
    "COVERPAGE": ["accession", "amendment_type", "manager_name"],
    "INFOTABLE": ["accession", "issuer", "title", "cusip", "value", "shares", "sh_type", "put_call"],
}

KEPT_FORMS = ["13F-HR", "13F-HR/A"]  # 13F-NT, 13F-NT/A and the rest carry no holdings
AMENDMENT_TYPES = {"RESTATEMENT": "restatement", "NEW HOLDINGS": "new_holdings"}
SH_TYPES = ["SH", "PRN"]
PUT_CALLS = ["PUT", "CALL"]
DATE_FORMAT = "%d-%b-%Y"  # 14-NOV-2022
MAX_LOGGED_ACCESSIONS = 5


class _Hrefs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.hrefs.extend(value for name, value in attrs if name == "href" and value)


def list_bulk_zips(client: Client) -> list[str]:
    """URLs of every bulk ZIP linked from the SEC data-sets page, sorted and de-duplicated.

    Takes the shared SEC client so the page request counts against the same rate limit.
    Links to other hosts are ignored: the client's User-Agent must only go to sec.gov.
    """
    page = _Hrefs()
    page.feed(client.get(DATASETS_PAGE).text)
    urls = set()
    for href in page.hrefs:
        href = href.strip()
        if not href.lower().endswith(ZIP_SUFFIX):
            continue
        url = urljoin(DATASETS_PAGE, href)
        parts = urlsplit(url)
        if parts.scheme == "https" and parts.netloc.lower() == SEC_HOST:
            urls.add(url)
    return sorted(urls)


def _unit_multiplier(filed: date) -> float:
    """13F VALUE is in thousands of dollars before VALUE_DOLLARS_FROM, dollars from it."""
    return 1.0 if filed >= VALUE_DOLLARS_FROM else 1000.0


def value_to_usd(value: float, filed: date) -> float:
    return value * _unit_multiplier(filed)


def _member(z: zipfile.ZipFile, table: str) -> str:
    wanted = f"{table}.tsv".lower()
    for name in z.namelist():
        if Path(name).name.lower() == wanted:
            return name
    raise ValueError(f"{z.filename}: no {table}.tsv in the ZIP")


def _read_table(z: zipfile.ZipFile, table: str) -> pl.DataFrame:
    """One TSV as all-string columns under our names, only the columns we use.

    Quoting is off: issuer names contain bare quote characters. Invalid UTF-8 bytes are
    replaced rather than aborting the quarter.
    """
    member = _member(z, table)
    names = TABLES[table]
    headers = [COLUMNS[n] for n in names]
    with z.open(member) as f:
        present = f.readline().decode("utf-8-sig", errors="replace").rstrip("\r\n").split("\t")
    missing = [h for h in headers if h not in present]
    if missing:
        raise ValueError(f"{z.filename}: {table}.tsv has no column(s) {', '.join(missing)}")
    with z.open(member) as f:
        df = pl.read_csv(
            f,
            separator="\t",
            quote_char=None,
            infer_schema=False,
            columns=headers,
            encoding="utf8-lossy",
        )
    return df.rename({COLUMNS[n]: n for n in names})


def _clean_upper(name: str) -> pl.Expr:
    return pl.col(name).str.strip_chars().str.to_uppercase()


def _filings(submission: pl.DataFrame, coverpage: pl.DataFrame) -> tuple[pl.DataFrame, list[str]]:
    """Kept filings, and the accessions of kept-form filings dropped for a missing CIK, date or period."""
    kept = submission.with_columns(form=_clean_upper("form")).filter(pl.col("form").is_in(KEPT_FORMS))
    # strict=False: a value that does not parse is as unusable as an empty one.
    parsed = kept.with_columns(
        cik=pl.col("cik").cast(pl.Int64, strict=False),
        filed=pl.col("filed").str.to_date(DATE_FORMAT, strict=False),
        period=pl.col("period").str.to_date(DATE_FORMAT, strict=False),
    )
    usable = pl.col("cik").is_not_null() & pl.col("filed").is_not_null() & pl.col("period").is_not_null()
    bad = parsed.filter(~usable)["accession"].to_list()
    good = parsed.filter(usable)
    periods = pl.Series("period", [q_of_date(d) for d in good["period"]], dtype=pl.Int16)
    # A repeated COVERPAGE row must not repeat the filing (and so its holdings): first one wins.
    coverpage = coverpage.unique(subset="accession", keep="first", maintain_order=True)
    filings = (
        good.with_columns(period=periods)
        .join(coverpage, on="accession", how="left", maintain_order="left")
        .with_columns(
            amendment_type=_clean_upper("amendment_type").replace_strict(
                AMENDMENT_TYPES, default=None, return_dtype=pl.String
            ),
            source=pl.lit("bulk"),
        )
        .select("accession", "cik", "period", "filed", "form", "amendment_type", "manager_name", "source")
    )
    return filings, bad


def _raw_holdings(
    infotable: pl.DataFrame, filings: pl.DataFrame, bad_filings: list[str]
) -> tuple[pl.DataFrame, list[str]]:
    """Holdings of the kept filings, and one accession per holding dropped as bad input.

    Holdings of filings we left out on purpose (13F-NT ...) vanish silently; holdings of
    filings dropped for bad input, and holdings with an unusable share type, are reported.
    """
    units = pl.DataFrame(
        {
            "accession": filings["accession"],
            "unit": pl.Series([_unit_multiplier(d) for d in filings["filed"]], dtype=pl.Float64),
        }
    )
    dropped = infotable.filter(pl.col("accession").is_in(bad_filings))["accession"].to_list()
    holdings = infotable.join(units, on="accession", how="inner", maintain_order="left").with_columns(
        sh_type=_clean_upper("sh_type")
    )
    usable = pl.col("sh_type").is_in(SH_TYPES).fill_null(False)
    dropped += holdings.filter(~usable)["accession"].to_list()
    holdings = holdings.filter(usable).with_columns(
        shares=pl.col("shares").cast(pl.Float64),
        put_call=_clean_upper("put_call").replace_strict(
            {p: p for p in PUT_CALLS}, default=None, return_dtype=pl.String
        ),
        value_usd=pl.col("value").cast(pl.Float64) * pl.col("unit"),
    )
    holdings = holdings.select(
        "accession", "cusip", "issuer", "title", "shares", "sh_type", "put_call", "value_usd"
    )
    return holdings, dropped


def parse_bulk_zip(path: Path, stats: dict | None = None) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Parse one bulk ZIP into (filings, raw_holdings); only 13F-HR and 13F-HR/A filings.

    Bad input is dropped, never fatal: a kept-form filing with no usable CIK, filing date or
    report period goes with its holdings, and a holding whose share type is not SH/PRN goes
    alone. Drops are logged in one warning per ZIP and, if `stats` is given, counted in
    stats["dropped_filings"] and stats["dropped_holdings"]. A ZIP missing a table or a
    required column raises ValueError: that is a format change, not a bad row.
    """
    with zipfile.ZipFile(path) as z:
        submission = _read_table(z, "SUBMISSION")
        coverpage = _read_table(z, "COVERPAGE")
        infotable = _read_table(z, "INFOTABLE")
    filings, bad_filings = _filings(submission, coverpage)
    holdings, bad_holdings = _raw_holdings(infotable, filings, bad_filings)
    if stats is not None:
        stats["dropped_filings"] = len(bad_filings)
        stats["dropped_holdings"] = len(bad_holdings)
    if bad_filings or bad_holdings:
        offending = list(dict.fromkeys([*bad_filings, *bad_holdings]))
        log.warning(
            "%s: dropped %d filing(s) and %d holding(s) with bad input; accessions: %s%s",
            Path(path).name,
            len(bad_filings),
            len(bad_holdings),
            ", ".join(offending[:MAX_LOGGED_ACCESSIONS]),
            ", ..." if len(offending) > MAX_LOGGED_ACCESSIONS else "",
        )
    return filings, holdings
