"""Pre-2013 13F filings: the EDGAR full index and the free-text information tables.

Before the SEC's XML format (filings from mid-2013) a 13F's holdings were a text table in the
filing, laid out by each filer: fixed-width columns, tabs, quotes, wrapped rows, one field per
line, now and then HTML. A row is found by its CUSIP, the one field with a check digit; its value
and share count are the two numbers after it. Each filing is then checked against the totals its
own summary page declares (entry count, value total), and only a filing that passes, or that
declares nothing to check against, is stored. The output frames match `parse_bulk_zip`'s, with
source="legacy", plus one check row per filing read (`CHECKS_SCHEMA`).
"""

import gzip
import html
import logging
import re
import statistics
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date

import polars as pl

from orca.http import Client, FetchError
from orca.quarters import q_of_date
from orca.sec.bulk import KEPT_FORMS, raw_holdings, value_to_usd
from orca.sec.live import (
    ARCHIVES,
    FILINGS_SCHEMA,
    INFO_SCHEMA,
    INFO_TABLE_TYPE,
    RATE_LIMITED,
    REFUSED,
    THROTTLED_AFTER,
    IndexEntry,
    _read_submission,
    _xml_documents,
    parse_daily_index,
)

log = logging.getLogger(__name__)

SOURCE = "legacy"
FIRST_INDEX = (
    1999,
    1,
)  # electronic 13F-HR filings start in 1999 (13F-E before: no tables)
LAST_INDEX = (2013, 3)  # filings from mid-2013 are XML, read from the bulk data sets
WORKERS = 4  # downloads at once, so the client's rate limit sets the pace, not latency
CHUNK = (
    64  # downloads handed to the workers at a time (throttling stops within one chunk)
)

# Same columns and dtypes as the lake's raw_holdings (without `source`).
RAW_COLUMNS = pl.Schema(
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
CHECKS_SCHEMA = pl.Schema(
    {
        "accession": pl.String,
        "cik": pl.Int64,
        "period": pl.Int16,
        "filed": pl.Date,
        "form": pl.String,
        "status": pl.String,
        "rows": pl.Int32,
        "invalid_rows": pl.Int32,
        "parsed_value": pl.Float64,
        "declared_value": pl.Float64,
        "declared_entries": pl.Int64,
    }
)

# Check statuses. Only STORED ones are ingested.
OK, CLOSE, UNVERIFIED = "ok", "close", "unverified"
MISMATCH, NO_ROWS, EMPTY, PAPER, NO_PERIOD, FAILED = (
    "mismatch",
    "no_rows",
    "empty",
    "paper",
    "no_period",
    "download_failed",
)
STORED = frozenset({OK, CLOSE, UNVERIFIED})
EXACT, NEAR = 0.005, 0.02  # value total tolerances of OK and CLOSE
UNIT_SCALES = (
    1.0,
    1000.0,
    0.001,
)  # filers mix thousands and dollars between table and summary
LOOKAHEAD = 4  # lines read on for the numbers of a wrapped row
COLUMN_SLACK = 3  # characters a continuation row's numbers may sit off the row above's
DOLLARS_ABOVE = (
    1.0  # median value per share above this: the table is in dollars, not thousands
)
MIN_ROWS_FOR_UNITS = 3

_DOCUMENT = re.compile(r"<DOCUMENT>(.*?)</DOCUMENT>", re.DOTALL | re.IGNORECASE)
_TYPE = re.compile(r"<TYPE>[ \t]*([^\r\n<]+)", re.IGNORECASE)
_TEXT = re.compile(r"<TEXT>(.*?)</TEXT>", re.DOTALL | re.IGNORECASE)
_HTML_TABLE = re.compile(r"<\s*t[dr][\s>]", re.IGNORECASE)
_HTML_CELL_END = re.compile(r"<\s*/\s*t[dh]\s*>", re.IGNORECASE)
_HTML_LINE_END = re.compile(r"<\s*(?:/\s*tr|br|/?\s*p|/\s*div)\b[^>]*>", re.IGNORECASE)
_TAG = re.compile(r"<[^<>\n]{0,400}>")
_BINARY_TYPES = ("GRAPHIC", "ZIP", "PDF", "EXCEL", "XML", "JSON", "XBRL")
_UUENCODED = re.compile(r"^begin [0-7]{3} ", re.MULTILINE)

_CUSIP9 = re.compile(
    r"(?<![0-9A-Z])([0-9A-Z]{6})([ -]?)([0-9A-Z]{2})\2([0-9])(?![0-9A-Z])"
)
NINE, EIGHT, PADDED = "nine", "eight", "padded"  # how CUSIPs are written, tried in this order
_SHORT_CODE = re.compile(r"(?<![0-9A-Z.,$])([0-9]{7,8})(?![0-9A-Z.,])")
_CUSIP8 = re.compile(
    r"(?<![0-9A-Z.,$])([0-9]{3}[0-9A-Z]{3})([ -]?)([0-9A-Z]{2})(?![0-9A-Z.,])"
)
_TOKEN = re.compile(r"\S+")
_NUMBER = re.compile(r"^\$?\(?([0-9][0-9,]*(?:\.[0-9]*)?)\)?(SH|PRN)?$")  # "74,650,000.PRN" too
# A value with cents run into a grouped share count: "4,530.0010,100,000" is 4,530.00 and 10,100,000.
_GLUED_PAIR = re.compile(
    r"^([0-9][0-9,]*\.[0-9]{2})([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?(?:SH|PRN)?)$"
)
# A CUSIP run into a grouped value: "4642876551,526,435".
_CUSIP_GLUED = re.compile(
    r"(?<![0-9A-Z])([0-9A-Z]{9})(?=[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?(?![0-9,]))"
)
# Longest first: "Table Entry Total" must not be taken as "Table Entry" (filers also drop "Total").
_TOTAL_LABEL = re.compile(
    r"(TABLE\s+ENTRY\s+TOTAL|TABLE\s+VALUES?\s+TOTAL|VALUES?\s+TOTAL|TOTAL\s+VALUE|ENTRY\s+TOTAL"
    r"|TABLE\s+ENTRY|TABLE\s+VALUE)",
    re.IGNORECASE,
)
_TOTAL_WORD = re.compile(r"\bTOTALS?\b")
_SCALE_WORD = re.compile(r"\s*(BILLION|MILLION)")
_SCALES = {"BILLION": 1e6, "MILLION": 1e3}  # to thousands
_UNIT_NOTE = re.compile(
    r"\(?\s*(?:X|IN)\s*\$?\s*1,?000'?S?\s*\)?|\(\s*\$?\s*000'?S?\s*\)|\$\s*1,?000\b"
    r"|\(\s*(?:IN\s+)?(?:THOUSANDS|DOLLARS)\s*\)",
    re.IGNORECASE,
)
# The label's number: before any word (the next label's "13F" is not it).
# Thousands may be grouped with spaces ("$1 335 366 000").
_LABEL_NUMBER = re.compile(
    r"[^A-Z0-9]*?(\$)?\s*([0-9]{1,3}(?:[ ,][0-9]{3})+(?:\.[0-9]+)?|[0-9][0-9,]*(?:\.[0-9]+)?)"
)
_HEADER_PERIOD = re.compile(r"CONFORMED PERIOD OF REPORT:\s*([0-9]{8})")
_HEADER_NAME = re.compile(r"COMPANY CONFORMED NAME:\s*([^\r\n]+)")
_HEADER_CIK = re.compile(r"CENTRAL INDEX KEY:\s*([0-9]+)")
_RESTATEMENT = re.compile(
    r"\[\s*[XY]\s*\]\s*IS\s+A\s+RE(?:IN)?STATE?MENT", re.IGNORECASE
)
_NEW_HOLDINGS = re.compile(r"\[\s*[XY]\s*\]\s*ADDS\s+NEW\s+HOLDINGS", re.IGNORECASE)
_PAPER = re.compile(r"<PAPER>|AUTO-GENERATED PAPER DOCUMENT")
_SEPARATOR = re.compile(r"^[\s=_-]+$")
_OPTION_WORDS = ("PUT", "CALL")
_VALUE_WORD = re.compile(r"\bVALUE\b")
_SHARES_WORD = re.compile(r"\b(?:SHARES|SHRS)\b")
HEADER_LINES = 12  # lines above the first row searched for the column headings


@dataclass(frozen=True)
class Row:
    cusip: str
    value: float  # as written in the table (thousands, as a rule)
    shares: float
    sh_type: str  # SH or PRN
    put_call: str | None
    issuer: str | None


@dataclass(frozen=True)
class Table:
    rows: list[Row]
    invalid: list[float]  # values of rows whose code is not a valid CUSIP
    orphans: int  # CUSIPs found without their two numbers
    totals: list[float] = field(default_factory=list)  # numbers on the table's own TOTAL lines


def index_quarters() -> list[str]:
    """Every full-index quarter the legacy reader covers, oldest first ("1999Q1", ...)."""
    keys = []
    year, quarter = FIRST_INDEX
    while (year, quarter) <= LAST_INDEX:
        keys.append(f"{year}Q{quarter}")
        year, quarter = (year, quarter + 1) if quarter < 4 else (year + 1, 1)
    return keys


def index_url(key: str) -> str:
    year, quarter = key.split("Q")
    return f"{ARCHIVES}edgar/full-index/{year}/QTR{quarter}/form.gz"


def check_digit(code: str) -> int:
    """The CUSIP check digit of the first 8 characters (the "modulus 10 double add double")."""
    total = 0
    for i, ch in enumerate(code[:8]):
        v = (
            int(ch)
            if ch.isdigit()
            else ord(ch) - 55
            if "A" <= ch <= "Z"
            else 36 + "*@#".index(ch)
        )
        if i % 2:
            v *= 2
        total += v // 10 + v % 10
    return (10 - total % 10) % 10


def valid_cusip(code: str) -> bool:
    return len(code) == 9 and code[8].isdigit() and check_digit(code) == int(code[8])


# --- text ----------------------------------------------------------------------------------


def document_texts(submission: str) -> list[str]:
    """The plain text of each document of a submission that can hold a table. HTML tables become
    lines of tab-separated cells; SGML tags (<TABLE>, <S>, <C>, <PAGE>) and other tags go."""
    texts = []
    for match in _DOCUMENT.finditer(submission):
        body = match[1]
        kind = _TYPE.search(body)
        kind = kind[1].strip().upper() if kind else ""
        if kind.startswith(_BINARY_TYPES) or _UUENCODED.search(body):
            continue
        text = _TEXT.search(body)
        text = text[1] if text else body
        if _HTML_TABLE.search(text):
            text = _HTML_LINE_END.sub("\n", _HTML_CELL_END.sub("\t", text))
        text = html.unescape(_TAG.sub(" ", text)).replace("\xa0", " ")
        texts.append(text)
    return texts


def _lines(texts: list[str]) -> list[list[str]]:
    """Each text's lines, upper-cased, quotes blanked and tabs expanded (columns line up)."""
    return [
        [raw.replace('"', " ").expandtabs(8).upper() for raw in t.splitlines()]
        for t in texts
    ]


def _number(token: str) -> tuple[float | None, str | None]:
    """A table number (`1,234`, `$1,234.5`, `(12)`, `9695SH`) and the share type glued to it."""
    m = _NUMBER.match(token)
    if not m:
        return None, None
    return float(m[1].replace(",", "")), m[2]


def _tokens(line: str, start: int = 0):
    """(token, start column, end column) from column `start`; a glued value-and-shares pair is
    split in two."""
    for m in _TOKEN.finditer(line, start):
        pair = _GLUED_PAIR.match(m.group())
        if pair:
            cut = m.start() + len(pair[1])
            yield pair[1], m.start(), cut
            yield pair[2], cut, m.end()
        else:
            yield m.group(), m.start(), m.end()


def _numbers(
    line: str, start: int = 0
) -> tuple[list[tuple[float, int, int]], list[str]]:
    """The first two numbers from column `start` with the columns each starts and ends at, and
    the words after the first one (where SH/PRN and PUT/CALL are)."""
    found: list[tuple[float, int, int]] = []
    words: list[str] = []
    for token, begin, end in _tokens(line, start):
        if token == "$":
            continue
        value, glued = _number(token) if len(found) < 2 else (None, None)
        if value is not None:
            # A glued "SH" is not part of the number: "1860000.00SH" ends where "13684.00 SH" does.
            found.append((value, begin, end - len(glued or "")))
            if glued:
                words.append(glued)
        elif found:
            words.append(token)
    return found, words


def _all_numbers(line: str) -> list[tuple[float, int, int]]:
    """Every number on the line with its start and end columns."""
    found = []
    for token, begin, end in _tokens(line):
        value, glued = _number(token)
        if value is not None:
            found.append((value, begin, end - len(glued or "")))
    return found


def _aligned_numbers(
    line: str, columns: tuple[int, int]
) -> list[tuple[float, int, int]] | None:
    """Two numbers in a row of the line that end in the value and shares columns (within
    COLUMN_SLACK), else None. Numbers before them (parts of a mistyped code) do not count."""
    found = _all_numbers(line)
    for first, second in zip(found, found[1:]):
        if (
            abs(first[2] - columns[0]) <= COLUMN_SLACK
            and abs(second[2] - columns[1]) <= COLUMN_SLACK
        ):
            return [first, second]
    return None


def _cusip(line: str, mode: str) -> tuple[str, int, int] | None:
    """The first CUSIP on the line: (code, start column, end column). In mode EIGHT, 8-character
    codes (three digits first) take their computed check digit; in mode PADDED, a 7- or
    8-digit code gets back the leading zeros a filer dropped (9269101 is 009269101), if its check
    digit then holds."""
    if mode in (EIGHT, PADDED) and _cusip(line, NINE):
        return None  # a line with a real CUSIP has no other code ("132200 SH" is a share count)
    if mode == EIGHT:
        for m in _CUSIP8.finditer(line):
            code = m[1] + m[3]
            if m[2] or code[6:].isalpha():  # "132200 SH": a count and its share type, not a code
                continue
            return code + str(check_digit(code)), m.start(), m.end()
        return None
    if mode == PADDED:
        for m in _SHORT_CODE.finditer(line):
            code = m[1].zfill(9)
            if valid_cusip(code) and len(_all_numbers(line[m.end() :])) >= 2:
                return code, m.start(), m.end()
    for pattern in (_CUSIP9, _CUSIP_GLUED):
        for m in pattern.finditer(line):
            code = m[1] + m[3] + m[4] if pattern is _CUSIP9 else m[1]
            # A 9-digit voting count after the row's numbers passes the check digit 1 time in 10;
            # a real CUSIP has the row's numbers after it (names hold numbers too: "S&P 500").
            if len(_all_numbers(line[: m.start()])) >= 2 and len(_all_numbers(line[m.end() :])) < 2:
                break
            if any(ch.isdigit() for ch in code[:6]) and valid_cusip(code):
                return code, m.start(), m.end()
    return None


def _shares_first(lines: list[str], mode: str) -> bool:
    """Whether the column headings above the first row put the share count before the value
    (on one heading line: "CUSIP  SHARES  VALUE (X$1000)"). The form asks for value first."""
    first = next((i for i, line in enumerate(lines) if _cusip(line, mode)), None)
    for line in lines[max(0, (first or 0) - HEADER_LINES) : first or 0]:
        value, shares = _VALUE_WORD.search(line), _SHARES_WORD.search(line)
        if value and shares:
            return shares.start() < value.start()
    return False


def _issuer(line: str, start: int) -> str | None:
    name = " ".join(line[:start].split())
    return name or None


def read_table(texts: list[str], mode: str = NINE) -> Table:
    """The holdings rows of a filing's texts. See the module docstring and section 5 of
    docs/superpowers/specs/2026-11-17-pre-2013-13f-design.md for the rules."""
    rows: list[Row] = []
    invalid: list[float] = []
    totals: list[float] = []
    orphans = 0
    for lines in _lines(texts):
        above: Row | None = None  # the row a continuation line repeats
        above_invalid = False  # the row above had no valid CUSIP: its repeats are invalid too
        columns: tuple[int, int] | None = None  # where the last row's two numbers end
        since_total = 0.0  # values since the text began or its last total line
        text_total = 0.0  # values since the text began
        swapped = _shares_first(lines, mode)
        i = 0
        while i < len(lines):
            line = lines[i]
            found = _cusip(line, mode)
            if found:
                code, start, end = found
                numbers, words = _numbers(line, end)
                j = i
                # A wrapped row, or one field per line: read on to the next CUSIP.
                while len(numbers) < 2 and j + 1 < len(lines) and j - i < LOOKAHEAD:
                    if _cusip(lines[j + 1], mode):
                        break
                    j += 1
                    more, more_words = _numbers(lines[j])
                    numbers += more[: 2 - len(numbers)]
                    words += more_words
                if len(numbers) < 2:
                    orphans += 1
                    above, above_invalid = None, False
                    i += 1
                    continue
                value, shares = numbers[0][0], numbers[1][0]
                row = Row(
                    cusip=code,
                    value=shares if swapped else value,
                    shares=value if swapped else shares,
                    sh_type="PRN" if "PRN" in words[:3] else "SH",
                    put_call=next((w for w in words[:4] if w in _OPTION_WORDS), None),
                    issuer=_issuer(line, start),
                )
                rows.append(row)
                since_total += row.value
                text_total += row.value
                above = row if j == i else None
                above_invalid = False
                columns = (numbers[0][2], numbers[1][2]) if j == i else columns
                i = j + 1
                continue
            if not line.strip():
                i += 1
                continue
            if _TOTAL_WORD.search(line):  # the check's fallback when no summary page has totals
                totals += [value for value, _, _ in _all_numbers(line)]
            numbers = _aligned_numbers(line, columns) if columns else None
            if numbers is None:
                if _SEPARATOR.match(line) or not _numbers(line)[0]:
                    above, above_invalid = None, False
                i += 1
                continue
            (first, first_start, _), (second, _, _) = numbers
            value, shares = (second, first) if swapped else (first, second)
            lead = line[:first_start]
            if (
                "TOTAL" in line
                or _adds_up(value, since_total)
                or _adds_up(value, text_total)
            ):
                since_total = 0.0  # a total or page subtotal of the rows above
                above, above_invalid = None, False
            elif not lead.replace("$", "").strip():
                if above is not None:
                    rows.append(
                        Row(above.cusip, value, shares, above.sh_type, above.put_call, above.issuer)
                    )
                    since_total += value
                    text_total += value
                elif above_invalid:
                    invalid.append(value)
            else:  # a row without a valid CUSIP: a typo, a SEDOL, no code at all
                invalid.append(value)
                above, above_invalid = None, True
            i += 1
    return Table(rows, invalid, orphans, totals)


def _adds_up(value: float, total: float) -> bool:
    return total > 0 and abs(value - total) <= EXACT * total


def declared_totals(texts: list[str]) -> tuple[float | None, int | None]:
    """(value total, entry count) the summary page declares, None where absent. A unit note
    after the label is skipped; a "$" amount under an "Entry Total" label is the value total
    (a common slip)."""
    whole = "\n".join(texts)
    value = entries = None
    for m in _TOTAL_LABEL.finditer(whole):
        # The label's line and the next non-blank one ("Entry Total:" then blank lines, then 131).
        window = "\n".join(
            [line for line in whole[m.end() : m.end() + 400].split("\n") if line.strip()][:2]
        )
        text = _UNIT_NOTE.sub(" ", window).upper()
        n = _LABEL_NUMBER.match(text)
        if not n:
            continue
        number = float(n[2].replace(",", "").replace(" ", ""))
        if "ENTRY" in m[1].upper() and not n[1]:
            entries = int(number) if entries is None else entries
        elif value is None:
            # "$43.7 Billion": in thousands, like the table (the scales in `_within` do the rest).
            scale = _SCALE_WORD.match(text, n.end())
            value = number * _SCALES[scale[1]] if scale else number
    return value, entries


def _within(parsed: float, declared: float, tolerance: float) -> bool:
    return any(
        abs(parsed / (declared * scale) - 1) <= tolerance for scale in UNIT_SCALES
    )


def check_table(
    table: Table, value: float | None, entries: int | None, strict: bool = False
) -> str:
    """The check status of a read table against the declared totals (see STORED). `strict` (the
    8-character and zero-padded readings, whose codes cannot fail a check digit) passes a table
    only on its coded rows' count or on the value total, never on a count that needs uncoded rows
    or on no totals at all."""
    n, n_all = len(table.rows), len(table.rows) + len(table.invalid)
    parsed = sum(r.value for r in table.rows)
    parsed_all = parsed + sum(table.invalid)
    if n == 0:
        return EMPTY if (value == 0 or entries == 0) else NO_ROWS
    shares = sum(r.shares for r in table.rows)
    misread = bool(value) and _within(shares, value, EXACT) and not _within(parsed_all, value, NEAR)
    if entries is not None and n == entries and not misread:
        # Filers' counts are more reliable than their value totals, unless the share column is
        # what adds up to the value total: the numbers came from the wrong columns.
        return OK
    if value:
        # Rows without a valid CUSIP count towards the total: they explain a gap, not a misread.
        if _within(parsed, value, EXACT) or _within(parsed_all, value, EXACT):
            return OK
        if _within(parsed, value, NEAR) or _within(parsed_all, value, NEAR):
            return CLOSE
        return MISMATCH
    if entries is not None:
        return CLOSE if n_all == entries and not strict else MISMATCH
    if any(_within(parsed, t, EXACT) or _within(parsed_all, t, EXACT) for t in table.totals if t):
        return OK  # the summary page is blank, but the table's own total line adds up
    return UNVERIFIED if table.orphans == 0 else MISMATCH


def read_holdings(texts: list[str]) -> tuple[Table, str, float | None, int | None]:
    """The best reading of a filing's table, its check status and the declared totals: 9-character
    CUSIPs first, then 8-character ones, then ones missing their leading zeros, each only if the
    one before does not pass (the later readings are kept only when the filer's totals agree)."""
    value, entries = declared_totals(texts)
    table = read_table(texts)
    status = check_table(table, value, entries)
    for mode in (EIGHT, PADDED):
        if status in STORED:
            break
        other = read_table(texts, mode)
        other_status = check_table(other, value, entries, strict=True)
        if other_status in (OK, CLOSE):
            return other, other_status, value, entries
    return table, status, value, entries


def unit_multiplier(rows: list[Row], filed: date) -> float:
    """Dollars per table unit: thousands as the form asks (until 2023, `value_to_usd`), unless
    the table's median value per share is above DOLLARS_ABOVE, i.e. over $1,000 a share in
    thousands: then the filer wrote dollars."""
    per_share = [
        r.value / r.shares
        for r in rows
        if r.sh_type == "SH" and r.shares > 0 and r.value > 0
    ]
    if (
        len(per_share) >= MIN_ROWS_FOR_UNITS
        and statistics.median(per_share) > DOLLARS_ABOVE
    ):
        return 1.0
    return value_to_usd(1.0, filed)


# --- filings -------------------------------------------------------------------------------


def _amendment_type(text: str, form: str) -> str | None:
    if form != "13F-HR/A":
        return None
    if _RESTATEMENT.search(text):
        return "restatement"
    if _NEW_HOLDINGS.search(text):
        return "new_holdings"
    return None


def read_submission(
    submission: bytes, entry: IndexEntry
) -> tuple[dict, list[dict], dict]:
    """(filings row, raw holdings rows, check row) of one submission; the filings row is None
    when the filing is not stored (see the check's status). A filing with an XML information
    table is read as the live feed reads it."""
    accession = entry.accession
    text = submission.decode("latin-1")
    # The first filer of the SEC header, as the bulk data sets have it (the index lists a joint
    # filing once per filer, in name order).
    header_cik = _HEADER_CIK.search(text)
    cik = int(header_cik[1]) if header_cik else entry.cik
    check = {
        "accession": accession,
        "cik": cik,
        "period": None,
        "filed": entry.filed,
        "form": entry.form,
        "status": NO_ROWS,
        "rows": 0,
        "invalid_rows": 0,
        "parsed_value": None,
        "declared_value": None,
        "declared_entries": None,
    }
    if INFO_TABLE_TYPE in _xml_documents(submission):
        try:
            filing, info = _read_submission(submission, entry)
        except ValueError:
            return None, [], check
        holdings, _ = raw_holdings(
            pl.DataFrame(info, schema=INFO_SCHEMA), pl.DataFrame([filing]), []
        )
        filing.update(cik=cik, source=SOURCE)
        check.update(period=filing["period"], status=OK, rows=holdings.height)
        return filing, holdings.to_dicts(), check
    if _PAPER.search(text):
        check["status"] = PAPER
        return None, [], check
    period = _HEADER_PERIOD.search(text)
    try:
        period_q = q_of_date(
            date(int(period[1][:4]), int(period[1][4:6]), int(period[1][6:]))
        )
    except (TypeError, ValueError):
        check["status"] = NO_PERIOD
        return None, [], check
    texts = document_texts(text)
    table, status, value, entries = read_holdings(texts)
    check.update(
        period=period_q,
        status=status,
        rows=len(table.rows),
        invalid_rows=len(table.invalid),
        parsed_value=sum(r.value for r in table.rows),
        declared_value=value,
        declared_entries=entries,
    )
    if status not in STORED:
        return None, [], check
    name = _HEADER_NAME.search(text)
    filing = {
        "accession": accession,
        "cik": cik,
        "period": period_q,
        "filed": entry.filed,
        "form": entry.form,
        "amendment_type": _amendment_type(text, entry.form),
        "manager_name": name[1].strip() if name else None,
        "source": SOURCE,
    }
    unit = unit_multiplier(table.rows, entry.filed)
    rows = [
        {
            "accession": accession,
            "cusip": r.cusip,
            "issuer": r.issuer,
            "title": None,
            "shares": r.shares,
            "sh_type": r.sh_type,
            "put_call": r.put_call,
            "value_usd": r.value * unit,
        }
        for r in table.rows
    ]
    return filing, rows, check


def fetch_index(client: Client, key: str) -> list[IndexEntry]:
    """The 13F-HR and 13F-HR/A entries of one full-index quarter, one per accession."""
    text = gzip.decompress(client.get(index_url(key)).content).decode("latin-1")
    entries: dict[str, IndexEntry] = {}
    for entry in parse_daily_index(text):
        entries.setdefault(
            entry.accession, entry
        )  # a multi-filer filing is listed per filer
    return list(entries.values())


def fetch_quarter(
    client: Client,
    key: str,
    skip: set[str],
    stats: dict | None = None,
    workers: int = WORKERS,
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """(filings, raw_holdings, checks) of the 13F-HR / 13F-HR/A filings of full-index quarter
    `key` whose accession is not in `skip`. A download that fails is a check row with status
    "download_failed"; SEC throttling (429, or 403 on THROTTLED_AFTER downloads in a row) raises
    FetchError, and so does a failed index request, so nothing of the quarter is kept.
    `stats` gets "entries" (the quarter's filings) and "skipped" (already stored)."""
    entries = [e for e in fetch_index(client, key) if e.form in KEPT_FORMS]
    todo = [e for e in entries if e.accession not in skip]
    if stats is not None:
        stats.update(entries=len(entries), skipped=len(entries) - len(todo))

    def download(entry: IndexEntry) -> bytes | FetchError:
        try:
            return client.get(ARCHIVES + entry.path).content
        except FetchError as err:
            return err

    filings: list[dict] = []
    rows: list[dict] = []
    checks: list[dict] = []
    refused = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        got_all = (
            got
            for start in range(0, len(todo), CHUNK)
            for got in pool.map(download, todo[start : start + CHUNK])
        )
        for entry, got in zip(todo, got_all):
            if isinstance(got, FetchError):
                if got.status == RATE_LIMITED:
                    raise got
                refused = refused + 1 if got.status == REFUSED else 0
                if refused >= THROTTLED_AFTER:
                    raise FetchError(
                        got.url,
                        REFUSED,
                        f"{refused} downloads in a row refused: throttled",
                    )
                checks.append(
                    {
                        "accession": entry.accession,
                        "cik": entry.cik,
                        "filed": entry.filed,
                        "form": entry.form,
                        "status": FAILED,
                    }
                )
                continue
            refused = 0
            filing, holdings, check = read_submission(got, entry)
            checks.append(check)
            if filing is not None:
                filings.append(filing)
                rows.extend(holdings)
    return (
        pl.DataFrame(filings, schema=FILINGS_SCHEMA),
        pl.DataFrame(rows, schema=RAW_COLUMNS),
        pl.DataFrame(checks, schema=CHECKS_SCHEMA),
    )
