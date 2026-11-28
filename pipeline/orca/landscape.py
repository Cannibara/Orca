"""The home page's Landscape: every current 13F filer by type of investor (orca/investors.py), sized by its
13F book and coloured by its estimated return over each home period. A plain function of the fund
snapshots, JSON-ready (contract.md, `home/landscape.json`).

A filer is in it when it filed the latest quarter or the one before (a late filer keeps its last book)
and has a book. A firm filing under several names (investor_parents.csv) is one row per type. Each leaf type
lists its LANDSCAPE_PER_TYPE largest rows; the rest of the type comes as
one row of `rest`: how many, their book, and their book-weighted mean annual return over each period
(of those with one) with the share of that book it covers. The map then needs no 9,000 rows.

The books add up what each filer reports: an ETF firm's 13F holds the stocks of its funds, and an
adviser's 13F holds the ETF shares its clients own, so ETF money is counted at both (the page says so;
the ETF providers' total is the scale of it)."""

from collections.abc import Mapping, Sequence

from orca.config import PERIODS, TOP_MIN_PRICED
from orca.home import FundSnapshot
from orca.investors import TYPES, Classifier, refine_hedge

LANDSCAPE_PER_TYPE = 150  # rows listed one by one in each leaf type, the largest
RET_PLACES = 4  # an annual return to 0.01 percentage point


def _ret(s: FundSnapshot, period: str) -> float | None:
    """The filer's annual return over `period`, None without one or with under TOP_MIN_PRICED of its
    book priced (the Famous funds rule: below that the return says little)."""
    p = s.perf.get(period)
    if p is None or p.ann_return is None or s.priced_pct < TOP_MIN_PRICED:
        return None
    return round(float(p.ann_return), RET_PLACES)


def _mean(members: Sequence[FundSnapshot], period: str) -> tuple[float | None, float]:
    """(book-weighted mean annual return of the members with one, their book)."""
    known = [(s.book, r) for s in members if (r := _ret(s, period)) is not None]
    covered = sum(b for b, _ in known)
    return (round(sum(b * r for b, r in known) / covered, RET_PLACES) if covered > 0 else None), covered


def landscape(
    snaps: Sequence[FundSnapshot],
    classifier: Classifier,
    latest_q: int,
    sic: Mapping[int, str | None] | None = None,
    parents: Mapping[int, str] | None = None,
    sector: Mapping[int, str] | None = None,
) -> dict:
    """The Landscape file's body for the quarter `latest_q`. `sic` maps a CIK to its SEC industry
    description (lake table fund_about), for the classifier's step 4; `sector` a stock to its sector, for a
    hedge fund's style from its holdings (`investors.refine_hedge`); `parents` a CIK to the firm it files
    for (investor_parents.csv): a firm's filers of one type are one row, named after the firm, with their
    books added and their returns weighted by book, linked to the largest of them."""
    sic, parents, sector = sic or {}, parents or {}, sector or {}
    units: dict[tuple[str, str], list[FundSnapshot]] = {}
    for s in snaps:
        if s.excluded or s.period_q < latest_q - 1 or not s.book > 0:
            continue
        kind, _ = classifier.type_of(s.fund_id, s.name, sic.get(s.fund_id))
        kind = refine_hedge(kind, s.weights_now, s.n_priced, sector)
        firm = parents.get(s.fund_id) or f"#{s.fund_id}"
        units.setdefault((kind, firm), []).append(s)
    by_type: dict[str, list[tuple[str, list[FundSnapshot]]]] = {}
    for (kind, firm), members in units.items():
        members.sort(key=lambda m: (-m.book, m.fund_id))
        by_type.setdefault(kind, []).append((firm, members))
    periods = list(PERIODS)
    funds: dict[str, list] = {"fund_id": [], "name": [], "book": [], "type": [], "n": [], "members": []}
    fund_ret: dict[str, list] = {p: [] for p in periods}
    rest: dict[str, list] = {"type": [], "n": [], "book": []}
    rest_ret: dict[str, list] = {p: [] for p in periods}
    rest_cov: dict[str, list] = {p: [] for p in periods}
    n_filers, total = 0, 0.0
    for t in TYPES:
        rows = sorted(
            by_type.get(t.key, []), key=lambda u: (-sum(m.book for m in u[1]), u[1][0].fund_id)
        )
        if not rows:
            continue
        n_filers += sum(len(m) for _, m in rows)
        total += sum(s.book for _, m in rows for s in m)
        for firm, members in rows[:LANDSCAPE_PER_TYPE]:
            lead = members[0]
            alone = len(members) == 1
            funds["fund_id"].append(lead.fund_id)
            funds["name"].append(lead.name if alone else firm)
            funds["book"].append(round(float(sum(m.book for m in members))))
            funds["type"].append(t.key)
            funds["n"].append(len(members))
            funds["members"].append(None if alone else [m.name for m in members])
            for p in periods:
                fund_ret[p].append(_ret(lead, p) if alone else _mean(members, p)[0])
        others = [s for _, m in rows[LANDSCAPE_PER_TYPE:] for s in m]
        if not others:
            continue
        book = sum(s.book for s in others)
        rest["type"].append(t.key)
        rest["n"].append(len(others))
        rest["book"].append(round(float(book)))
        for p in periods:
            mean, covered = _mean(others, p)
            rest_ret[p].append(mean)
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
