"""The curated "Famous funds" list: well-known managers shown on the home page whatever the Top
funds rules say (a famous fund can be small, young or concentrated). Kept by hand in famous.csv."""

import csv
from dataclasses import dataclass
from pathlib import Path

FAMOUS_CSV = Path(__file__).with_name("famous.csv")


@dataclass(frozen=True, slots=True)
class Famous:
    """One famous fund: its CIK (the site's fund id), a word of its SEC filer name that guards
    against a mistyped CIK (`match`, upper case), the person behind it and the group it is listed
    under in famous.csv (for whoever keeps the list; not published)."""

    fund_id: int
    match: str
    manager: str
    group: str


def load_famous(path: Path = FAMOUS_CSV) -> tuple[Famous, ...]:
    """The rows of famous.csv. Raises ValueError on a repeated CIK or an empty match word, so a
    bad edit fails the tests rather than the site."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r["fund_id"].strip()]
    out, seen = [], set()
    for r in rows:
        fund_id, match = int(r["fund_id"]), r["match"].strip().upper()
        if fund_id in seen:
            raise ValueError(f"famous.csv lists CIK {fund_id} twice")
        if not match:
            raise ValueError(f"famous.csv: CIK {fund_id} has no match word")
        seen.add(fund_id)
        out.append(Famous(fund_id, match, r["manager"].strip(), r["group"].strip()))
    return tuple(out)
