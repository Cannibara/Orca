"""Each security's hierarchy label, as the pipeline reads it.

`data/stock_nodes.csv` is where a stock's label is edited (one row per stock_id; set how=owner to keep a manual
move). For a row placed by name (how=placed), `labels.txt` wins, so moving such a stock is one edit in either
file; other rows are moved in the CSV, because Orca keeps delisted tickers (stock 611 "AMT" is TD Ameritrade). Labels are read fresh on every run and never cached, so a relabel needs only a re-run.
`data/sic_nodes.csv` labels stocks the CSV does not cover, by SIC code; `data/etf_nodes.csv` says what each ETF
tracks (a single-sector ETF carries its tier and hierarchy label; every other class is neutral).
"""

from __future__ import annotations

import csv
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from orca.hierarchy.model import SEP, Hierarchy, HierarchyError, Node, load

DATA = Path(__file__).with_name("data")
STOCK_FILE = DATA / "stock_nodes.csv"
ETF_FILE = DATA / "etf_nodes.csv"
SIC_FILE = DATA / "sic_nodes.csv"
STOCK_COLUMNS = ["stock_id", "ticker", "kind", "vertical", "extras", "how", "conf"]
TIERS = ("sector", "industry", "vertical")


@dataclass(frozen=True)
class StockLabel:
    ticker: str
    kind: str
    node: Node
    how: str  # owner | placed | rule | model | default | sic


@dataclass(frozen=True)
class EtfLabel:
    cls: str  # sector, or a neutral class (broad, intl, bond, ...)
    tier: str  # sector | industry | vertical for a sector ETF, else ""
    path: str  # the hierarchy label it tracks, at that tier, else ""
    ticker: str = ""  # a guard, like the stock CSV's: Orca's ids are a local counter


def resolve(rows: Iterable[dict], h: Hierarchy) -> dict[int, StockLabel]:
    """stock_id -> label. Raises HierarchyError listing every row whose vertical is not in `labels.txt`."""
    by_path = {n.path: n for n in h.nodes}
    out: dict[int, StockLabel] = {}
    bad: list[str] = []
    for r in rows:
        sid, ticker, how = int(r["stock_id"]), r["ticker"], r["how"]
        node = by_path.get(r["vertical"])
        if how == "placed" and ticker in h.main:  # only rows placed by name: Orca reuses delisted tickers
            node, how = h.main[ticker], "placed"
        if node is None:
            bad.append(f"{sid} {ticker}: {r['vertical']!r} is not a vertical in labels.txt")
            continue
        out[sid] = StockLabel(ticker, r["kind"], node, how)
    if bad:
        raise HierarchyError("\n".join(bad))
    return out


def load_stock_labels(path: Path = STOCK_FILE, h: Hierarchy | None = None) -> dict[int, StockLabel]:
    with open(path, newline="", encoding="utf-8") as f:
        return resolve(csv.DictReader(f), h or load())


def merge_rows(old: Iterable[dict], new: Iterable[dict]) -> list[dict]:
    """A regenerated CSV: new rows replace old ones, except that an owner row is never overwritten."""
    merged = {r["stock_id"]: r for r in old}
    for r in new:
        if merged.get(r["stock_id"], {}).get("how") != "owner":
            merged[r["stock_id"]] = r
    return sorted(merged.values(), key=lambda r: int(r["stock_id"]))


def write_rows(rows: Iterable[dict], path: Path = STOCK_FILE) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, STOCK_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def ticker_mismatches(labels: dict[int, StockLabel], tickers: dict[int, str]) -> list[tuple[int, str, str]]:
    """(stock_id, ticker in the CSV, ticker now) for ids whose ticker changed: a sign the lake's ids moved."""
    return [(sid, lab.ticker, tickers[sid]) for sid, lab in sorted(labels.items()) if sid in tickers and tickers[sid] != lab.ticker]


class SicTable:
    """SIC code -> vertical, trying the 4-digit code, then its 3- and 2-digit prefixes."""

    def __init__(self, table: dict[str, Node]):
        self.table = table

    def label(self, sic: int | None) -> Node | None:
        if sic is None:
            return None
        code = f"{int(sic):04d}"
        return next((self.table[code[:n]] for n in (4, 3, 2) if code[:n] in self.table), None)

    @classmethod
    def load(cls, path: Path = SIC_FILE, h: Hierarchy | None = None) -> SicTable:
        by_path = {n.path: n for n in (h or load()).nodes}
        with open(path, newline="", encoding="utf-8") as f:
            return cls({r["sic"]: by_path[r["vertical"]] for r in csv.DictReader(f)})


def build_sic_table(firms: Iterable[tuple[str, Node]], min_firms: int = 3) -> dict[str, Node]:
    """SIC code (4 digits, and its 3- and 2-digit prefixes) -> the vertical most firms with that code have.

    `firms` are (SIC code, vertical) pairs, e.g. Damodaran's US companies labelled through `labels.txt`.
    Codes with fewer than `min_firms` firms are left out, so a lookup falls back to the shorter prefix.
    """
    counts: dict[str, Counter[Node]] = defaultdict(Counter)
    for sic, node in firms:
        code = f"{int(sic):04d}"
        for n in (4, 3, 2):
            counts[code[:n]][node] += 1
    return {code: c.most_common(1)[0][0] for code, c in counts.items() if c.total() >= min_firms}


def label_of(stock_id: int, sic: int | None, labels: dict[int, StockLabel], sic_table: SicTable) -> tuple[Node | None, str]:
    """(vertical, how) for one stock: the CSV first, then the SIC table; (None, "") if neither knows it."""
    if stock_id in labels:
        return labels[stock_id].node, labels[stock_id].how
    node = sic_table.label(sic)
    return (node, "sic") if node else (None, "")


def read_etf_labels(f: IO[str], h: Hierarchy) -> tuple[dict[int, EtfLabel], list[str]]:
    paths = {n.path for n in h.nodes}
    paths |= {SEP.join(p.split(SEP)[:2]) for p in paths} | {p.split(SEP)[0] for p in paths}
    out: dict[int, EtfLabel] = {}
    problems: list[str] = []
    for r in csv.DictReader(f):
        sid = int(r["stock_id"])
        if r["class"] != "sector" or r["leverage"]:  # a 3x fund is not a bet on the sector's return (R12)
            out[sid] = EtfLabel(r["class"] if r["class"] != "sector" else "leveraged", "", "", r["ticker"])
            continue
        tier, path = r["level"], r["node"]
        if tier not in TIERS or path not in paths or len(path.split(SEP)) != TIERS.index(tier) + 1:
            problems.append(f"{sid} {r['ticker']}: no hierarchy label {path!r} at tier {tier}")
            continue
        out[sid] = EtfLabel("sector", tier, path, r["ticker"])
    return out, problems


def moves(before: dict[int, StockLabel], after: dict[int, StockLabel]) -> tuple[list[tuple[int, str, str, str]], list[str]]:
    """Stocks whose vertical changed ((id, ticker, old path, new path); "" = unlabelled) and every hierarchy label
    whose index the change touches (the verticals and their industries and sectors), sorted."""
    moved, touched = [], set()
    for sid in sorted(before.keys() | after.keys()):
        old, new = before.get(sid), after.get(sid)
        if (old and old.node) == (new and new.node):
            continue
        moved.append((sid, (new or old).ticker, old.node.path if old else "", new.node.path if new else ""))
        for lab in (old, new):
            if lab:
                parts = lab.node.path.split(SEP)
                touched.update(SEP.join(parts[: i + 1]) for i in range(3))
    return moved, sorted(touched)
