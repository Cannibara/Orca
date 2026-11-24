"""Ordinary shares per ADS, read from a foreign issuer's latest 20-F (lake table `adr_ratios`).

A 20-F filer reports its count in ordinary shares, but its US price is per American Depositary Share, so its
market cap needs the ratio (Banco Santander-Chile: 400 shares to an ADS, read as one, put it at 4–14% of the
market in run 43). `hierarchy/data/share_overrides.csv` held these by hand; this reads them for every filer.

Up to three SEC calls per company, on the shared SEC client:

1. `data.sec.gov/submissions/CIK##########.json`: its recent filings. No 20-F among them: not a foreign issuer
   with ADSs (a 40-F filer lists its shares as they are), ratio None.
2. The 20-F's cover page as the SEC renders it from the inline XBRL, `R1.htm` (~80 KB): the titles of the
   registered securities (`dei:Security12bTitle`), e.g. "American Depositary Shares, each representing 5
   ordinary shares". 20 of 35 known ratios are there.
3. Else the 20-F itself (up to ~20 MB): its tagged titles, then its text, taking the ratio stated most often.
   34 of the 35 known ratios are found this way, none wrongly; AstraZeneca states none (the CSV keeps it).
"""

from __future__ import annotations

import html
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date

import polars as pl

from orca.http import Client, FetchError
from orca.securities import SUBMISSIONS_URL

TABLE = "adr_ratios"
# One row per CIK. form: "20-F" when the company files one, else None (ratio None). filed: that 20-F's date.
# ratio: ordinary shares per ADS (None: the 20-F states none, or no 20-F). source: "cover" (R1.htm or the tagged
# titles), "text", or None. checked: the day of the lookup.
SCHEMA = pl.Schema(
    {"cik": pl.Int64, "form": pl.String, "filed": pl.Date, "ratio": pl.Float64, "source": pl.String, "checked": pl.Date}
)
DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{folder}/{document}"

WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "twenty-five": 25, "thirty": 30, "forty": 40, "fifty": 50,
    "one hundred": 100, "hundred": 100, "two hundred": 200, "four hundred": 400, "five hundred": 500, "one thousand": 1000,
    "two thousand": 2000, "ten thousand": 10000,
}  # fmt: skip
PARTS = {"half": 2, "third": 3, "fourth": 4, "quarter": 4, "fifth": 5, "tenth": 10}
_NUM = r"(?:\d[\d,]*(?:\.\d+)?|" + "|".join(sorted((re.escape(w) for w in WORDS), key=len, reverse=True)) + r")"
_NOT_PCT = r"(?!\s*(?:%|per ?cent))"  # "ADSs, representing 18.3% of the share capital" is no ratio
_FRAC = r"(?:(?:one|1)[- ](?P<part>half|third|fourth|quarter|fifth|tenth)|(?P<top>\d+)/(?P<bottom>\d+))(?: of (?:one|an?|1))?"
_HOLDER = r"(?:american deposit[ao]ry (?:shares?|receipts?)|ads'?s?)"  # Ecopetrol writes "Depository"
_KIND = r"(?:[\w.\-$€£¥]+ ){0,5}?(?:shares?|stock)\b"
# "ADSs, each representing 5 ordinary shares", "each ADS represents one-half of one share"
_FWD = re.compile(
    _HOLDER + r"[^.;:]{0,100}?\brepresent(?:s|ing)\b(?: the right to receive)?(?: an aggregate of)? "
    r"(?:(?P<frac>" + _FRAC + r")|(?P<num>" + _NUM + r"))\b" + _NOT_PCT + r"(?=[^.;]{0,6}" + _KIND + r")",
    re.I,
)
# "three ADSs represent one share", "ADSs, each three representing one share" (TAL)
_BACK = re.compile(
    r"(?:(?P<num>" + _NUM + r") (?:" + _HOLDER + r")(?: together)?|" + _HOLDER + r"[^.;:]{0,30}?\beach (?P<num2>" + _NUM
    + r")(?: of which)?) represent(?:s|ing)? (?:one|1) " + _KIND,
    re.I,
)  # fmt: skip
_TITLE = re.compile(r'(?is)<ix:nonNumeric[^>]*name="dei:Security12bTitle"[^>]*>(.*?)</ix:nonNumeric>')


@dataclass(frozen=True)
class Adr:
    form: str | None
    filed: date | None
    ratio: float | None
    source: str | None


def text_of(doc: str) -> str:
    t = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", doc)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"[\s​ ]+", " ", html.unescape(t))


def _number(s: str) -> float:
    s = s.lower().replace(",", "")
    return float(WORDS[s]) if s in WORDS else float(s)


def ratios(text: str) -> Counter:
    """Each ordinary-shares-per-ADS ratio the text states, with how often."""
    found: Counter = Counter()
    taken = []
    for m in _BACK.finditer(text):
        n = _number(m.group("num") or m.group("num2"))
        if n > 0:
            found[round(1 / n, 4)] += 1
            taken.append(m.span())
    for m in _FWD.finditer(text):
        if any(a < m.end() and m.start() < b for a, b in taken):
            continue  # "three ADSs representing one share" is _BACK's
        if m.group("top"):  # SMFG: "each American Depositary Share representing 3/5 of one share"
            if int(m.group("bottom")) > 0:
                found[round(int(m.group("top")) / int(m.group("bottom")), 4)] += 1
        elif m.group("frac"):
            found[round(1 / PARTS[m.group("part").lower()], 4)] += 1
        elif (n := _number(m.group("num"))) > 0:
            found[n] += 1
    return found


def ratio_in(doc: str, cover: bool = False) -> tuple[float | None, str | None]:
    """The ratio a 20-F (or its rendered cover, `cover`) states: its tagged titles first, then its text."""
    titles = " ; ".join(text_of(t) for t in _TITLE.findall(doc))
    found = ratios(titles) if titles else Counter()
    if found:
        return found.most_common(1)[0][0], "cover"
    found = ratios(text_of(doc))
    if found:
        return found.most_common(1)[0][0], "cover" if cover else "text"
    return None, None


def fetch_adr(client: Client, cik: int) -> Adr:
    """The company's ADS ratio from its latest 20-F (see the module notes). Raises FetchError only when the
    submissions record cannot be read; a missing cover page or document just ends the lookup there."""
    try:
        record = client.get(SUBMISSIONS_URL.format(cik=cik)).json()
    except FetchError as err:
        if err.status == 404:
            return Adr(None, None, None, None)
        raise
    recent = (record.get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    i = next((i for i, f in enumerate(forms) if f == "20-F"), None)
    if i is None:
        return Adr(None, None, None, None)
    folder = recent["accessionNumber"][i].replace("-", "")
    filed = date.fromisoformat(recent["filingDate"][i])
    for document, cover in (("R1.htm", True), (recent["primaryDocument"][i], False)):
        try:
            body = client.get(DOC_URL.format(cik=cik, folder=folder, document=document)).text
        except FetchError:
            continue
        r, source = ratio_in(body, cover)
        if r is not None:
            return Adr("20-F", filed, r, source)
    return Adr("20-F", filed, None, None)
