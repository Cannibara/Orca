"""The curated "Famous funds" lists: well-known managers shown on the home page whatever the Top
funds rules say (a famous fund can be small, young or concentrated), one list per investing style.
Kept by hand in famous.csv."""

import csv
from dataclasses import dataclass
from pathlib import Path

FAMOUS_CSV = Path(__file__).with_name("famous.csv")

# The styles, in the order the home page lists them (the web keeps the same order and adds a
# line about each; a group it does not know goes last).
FAMOUS_GROUPS = (
    "Buffett inspired",
    "Moat investing",
    "Value",
    "Tiger cubs",
    "Fundamental long/short",
    "Healthcare specialists",
    "Tech & growth",
    "Venture capital",
    "Activists",
    "Macro",
    "Family offices",
    "Quant & multi-strategy",
    "Big companies",
    "Sovereign & pension funds",
)


@dataclass(frozen=True, slots=True)
class Famous:
    """One famous fund in one list: its CIK (the site's fund id), a word of its SEC filer name
    that guards against a mistyped CIK (`match`, upper case), the person or brand behind it (""
    when the firm's name says it all) and the list it is shown in (`group`, one of
    FAMOUS_GROUPS). A fund can be in two lists. The csv's
    filer_name column is for whoever keeps the list and is not read.

    How to add one: find the CIK of the entity that files 13F-HR on EDGAR (a manager can have
    several; one that stopped filing is listed with its figures to its last quarter) and pick a
    match word from its filer name. A filer that changed its name can take alternatives split
    by "|" ("BROOKSIDE CAPITAL|BAIN CAPITAL PUBLIC EQUITY"): any one of them matches."""

    fund_id: int
    match: str
    manager: str
    group: str
    # Wikipedia titles of the fund and the person behind it (canonical, not redirects): their
    # page views rank the Most searched list. Rows sharing titles share one place in it.
    wiki: tuple[str, ...] = ()


def load_famous(path: Path = FAMOUS_CSV) -> tuple[Famous, ...]:
    """The rows of famous.csv. Raises ValueError on a CIK listed twice in one group, an empty
    match word or an unknown group, so a bad edit fails the tests rather than the site."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r["fund_id"].strip()]
    out, seen = [], set()
    for r in rows:
        fund_id, match, group = int(r["fund_id"]), r["match"].strip().upper(), r["group"].strip()
        if (fund_id, group) in seen:
            raise ValueError(f"famous.csv lists CIK {fund_id} twice in {group!r}")
        if not match:
            raise ValueError(f"famous.csv: CIK {fund_id} has no match word")
        if group not in FAMOUS_GROUPS:
            raise ValueError(f"famous.csv: CIK {fund_id} has unknown group {group!r}")
        seen.add((fund_id, group))
        wiki = tuple(t.strip() for t in (r.get("wiki") or "").split("|") if t.strip())
        out.append(Famous(fund_id, match, r["manager"].strip(), group, wiki))
    return tuple(out)
