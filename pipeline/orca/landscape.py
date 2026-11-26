"""The home page's Landscape: every current 13F filer by type of investor (orca/investors.py), sized by its
13F book and coloured by its estimated return over each home period. A plain function of the fund
snapshots, JSON-ready (contract.md, `home/landscape.json`).

A filer is in it when it filed the latest quarter or the one before (a late filer keeps its last book)
and has a book. Each leaf type lists its LANDSCAPE_PER_TYPE largest filers; the rest of the type comes as
one row of `rest`: how many, their book, and their book-weighted mean annual return over each period
(of those with one) with the share of that book it covers. The map then needs no 9,000 rows.

The books add up what each filer reports: an ETF firm's 13F holds the stocks of its funds, and an
adviser's 13F holds the ETF shares its clients own, so ETF money is counted at both (the page says so;
the ETF providers' total is the scale of it)."""

from collections.abc import Mapping, Sequence

from orca.config import PERIODS, TOP_MIN_PRICED
from orca.home import FundSnapshot
from orca.investors import TYPES, Classifier

LANDSCAPE_PER_TYPE = 150  # filers listed one by one in each leaf type, the largest
RET_PLACES = 4  # an annual return to 0.01 percentage point


def _ret(s: FundSnapshot, period: str) -> float | None:
    """The filer's annual return over `period`, None without one or with under TOP_MIN_PRICED of its
    book priced (the Famous funds rule: below that the return says little)."""
    p = s.perf.get(period)
    if p is None or p.ann_return is None or s.priced_pct < TOP_MIN_PRICED:
        return None
    return round(float(p.ann_return), RET_PLACES)


def landscape(
    snaps: Sequence[FundSnapshot],
    classifier: Classifier,
    latest_q: int,
    sic: Mapping[int, str | None] | None = None,
) -> dict:
    """The Landscape file's body for the quarter `latest_q`. `sic` maps a CIK to its SEC industry
    description (lake table fund_about), for the classifier's step 4."""
    sic = sic or {}
    by_type: dict[str, list[tuple[FundSnapshot, str]]] = {}
    for s in snaps:
        if s.excluded or s.period_q < latest_q - 1 or not s.book > 0:
            continue
        kind, _ = classifier.type_of(s.fund_id, s.name, sic.get(s.fund_id))
        by_type.setdefault(kind, []).append((s, kind))
    periods = list(PERIODS)
    funds: dict[str, list] = {"fund_id": [], "name": [], "book": [], "type": []}
    fund_ret: dict[str, list] = {p: [] for p in periods}
    rest: dict[str, list] = {"type": [], "n": [], "book": []}
    rest_ret: dict[str, list] = {p: [] for p in periods}
    rest_cov: dict[str, list] = {p: [] for p in periods}
    n_filers, total = 0, 0.0
    for t in TYPES:
        rows = sorted(by_type.get(t.key, []), key=lambda r: (-r[0].book, r[0].fund_id))
        if not rows:
            continue
        n_filers += len(rows)
        total += sum(s.book for s, _ in rows)
        for s, kind in rows[:LANDSCAPE_PER_TYPE]:
            funds["fund_id"].append(s.fund_id)
            funds["name"].append(s.name)
            funds["book"].append(round(float(s.book)))
            funds["type"].append(kind)
            for p in periods:
                fund_ret[p].append(_ret(s, p))
        others = [s for s, _ in rows[LANDSCAPE_PER_TYPE:]]
        if not others:
            continue
        book = sum(s.book for s in others)
        rest["type"].append(t.key)
        rest["n"].append(len(others))
        rest["book"].append(round(float(book)))
        for p in periods:
            known = [(s.book, r) for s in others if (r := _ret(s, p)) is not None]
            covered = sum(b for b, _ in known)
            rest_ret[p].append(round(sum(b * r for b, r in known) / covered, RET_PLACES) if covered > 0 else None)
            rest_cov[p].append(round(covered / book, 3) if book > 0 else 0.0)
    return {
        "latest_q": latest_q,
        "n_filers": n_filers,
        "total": round(total),
        "types": {
            "key": [t.key for t in TYPES],
            "label": [t.label for t in TYPES],
            "parent": [t.parent for t in TYPES],
        },
        "funds": {**funds, "ret": fund_ret},
        "rest": {**rest, "ret": rest_ret, "covered": rest_cov},
    }
