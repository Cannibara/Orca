"""The curated "Famous funds" lists: well-known managers shown on the home page whatever the Top
funds rules say (a famous fund can be small, young or concentrated), one list per investing style.
Kept by hand in famous.csv. The order they show in (Most searched, and each list's most popular
first) is famous_rank.csv, one name per line, top first; funds not in it follow by Google score."""

import csv
from dataclasses import dataclass, replace
from pathlib import Path

FAMOUS_CSV = Path(__file__).with_name("famous.csv")
SEARCH_CSV = Path(__file__).with_name("famous_search.csv")
RANK_CSV = Path(__file__).with_name("famous_rank.csv")

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
    # What people search Google for to find this fund: its manager or founder, or the firm for
    # venture firms (whose partners are searched for other things). Sovereign and pension funds
    # have none: their names are searched by members, citizens and markets, not investors. Its Google
    # Trends score (famous_search.csv) ranks the Most searched list; rows sharing a keyword
    # (Sequoia's filers) share one place in it. "" = not ranked.
    search: str = ""
    # The owner's place for this fund in famous_rank.csv, 1 = first; None when not listed there.
    # Listed funds lead Most searched and every list's most popular order, ahead of any score.
    rank: int | None = None


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
        search = (r.get("search") or "").strip()
        out.append(Famous(fund_id, match, r["manager"].strip(), group, search))
    return tuple(out)


@dataclass(frozen=True, slots=True)
class SearchScores:
    """Google Trends search interest of the famous funds' keywords, Warren Buffett = 100, over the
    12 months to `asof` (an ISO date), worldwide. A snapshot kept in famous_search.csv: Google has
    no Trends API, so scripts/google_trends.py refreshes it by hand."""

    asof: str | None
    scores: dict[str, float]


def load_search(path: Path = SEARCH_CSV) -> SearchScores:
    """famous_search.csv as keyword -> score; empty when the file is missing."""
    if not path.exists():
        return SearchScores(None, {})
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    asof = max((r["asof"] for r in rows if r.get("asof")), default=None)
    return SearchScores(asof, {r["keyword"]: float(r["score"]) for r in rows if r.get("score")})


def load_rank(path: Path = RANK_CSV) -> tuple[str, ...]:
    """famous_rank.csv's `name` column, in file order (the first line is rank 1); empty when the
    file is missing. Other columns are notes for whoever keeps the list and are not read."""
    if not path.exists():
        return ()
    with open(path, newline="", encoding="utf-8") as fh:
        return tuple(n for r in csv.DictReader(fh) if (n := (r.get("name") or "").strip()))


def apply_rank(famous: tuple[Famous, ...], names: tuple[str, ...]) -> tuple[Famous, ...]:
    """Sets each fund's `rank` from famous_rank.csv's names: a name is a search keyword of
    famous.csv (every filer of it shares the place, as they share a Google score) or, for a fund
    with no keyword, its CIK. Raises ValueError on a name listed twice or matching no fund, so a
    typo fails the tests rather than quietly dropping a fund from the order."""
    keywords = {f.search for f in famous if f.search}
    ciks = {str(f.fund_id) for f in famous}
    place: dict[str, int] = {}
    for i, name in enumerate(names, 1):
        if name in place:
            raise ValueError(f"famous_rank.csv lists {name!r} twice")
        if name not in keywords and name not in ciks:
            raise ValueError(f"famous_rank.csv: {name!r} is no search keyword or CIK in famous.csv")
        place[name] = i
    return tuple(
        replace(f, rank=place.get(f.search) or place.get(str(f.fund_id))) if place else f
        for f in famous
    )


def load_ranked_famous() -> tuple[Famous, ...]:
    """famous.csv with the owner's order from famous_rank.csv: what a run publishes."""
    return apply_rank(load_famous(), load_rank())
