"""Sector → Industry → Industry vertical hierarchy: parse `labels.txt` and label stocks.

`labels.txt` is the hand-edited source of truth (format in README.md). `parse` checks it and
collects every problem into one `HierarchyError`; `Hierarchy.label` gives a stock its main label and
its extra labels. Standard library only, so the tests need no data files.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

LABELS_FILE = Path(__file__).with_name("labels.txt")
SEP = " > "
TICKER = re.compile(r"[A-Z0-9]{1,6}(\.[A-Z])?")
NAME = re.compile(r"[^<>:#]+")
_RULE = re.compile(r"@rule (.+?) /(.*)/ => (.+)")


class HierarchyError(ValueError):
    """`labels.txt` has problems; the message lists all of them, one per line."""


@dataclass(frozen=True)
class Node:
    """One industry vertical, with the industry and sector above it."""

    sector: str
    industry: str
    vertical: str

    @property
    def path(self) -> str:
        return SEP.join((self.sector, self.industry, self.vertical))


@dataclass
class Hierarchy:
    nodes: list[Node]  # every industry vertical, in file order
    descriptions: dict[tuple[str, str], str]  # (sector, industry) -> one line
    main: dict[str, Node]  # ticker -> main label placed by name
    extra: dict[str, set[Node]]  # ticker -> extra labels placed by name
    defaults: dict[str, Node]  # Damodaran industry group -> main label of its other stocks
    rules: list[tuple[str, re.Pattern[str], Node]]  # (group, name regex, main label)
    umbrellas: list[tuple[Node, tuple[Node, ...]]]  # members of the children also get the parent
    nosector: set[Node]  # verticals scored against the whole market

    @property
    def sectors(self) -> list[str]:
        return list(dict.fromkeys(n.sector for n in self.nodes))

    @property
    def industries(self) -> list[tuple[str, str]]:
        return list(dict.fromkeys((n.sector, n.industry) for n in self.nodes))

    def label(self, ticker: str, group: str, name: str) -> tuple[Node, list[Node], str]:
        """(main label, extra labels, how the main label was found).

        How: "placed" (named in labels.txt), "rule" (a name rule for the stock's Damodaran group)
        or "default" (the group's default). A KeyError means the group has no default.
        """
        main, how = self.main.get(ticker), "placed"
        if main is None:
            main, how = next(((n, "rule") for g, rx, n in self.rules if g == group and rx.search(name)), (None, ""))
        if main is None:
            main, how = self.defaults[group], "default"
        extra = set(self.extra.get(ticker, ()))
        extra.update(parent for parent, children in self.umbrellas if main in children)
        extra.discard(main)
        order = {n: i for i, n in enumerate(self.nodes)}
        return main, sorted(extra, key=order.__getitem__), how


def _path(text: str) -> Node:
    parts = [p.strip() for p in text.split(SEP)]
    if len(parts) != 3 or not all(NAME.fullmatch(p) for p in parts):
        raise ValueError(f"not a 'Sector > Industry > Industry vertical' path: {text!r}")
    return Node(*parts)


def load(path: Path = LABELS_FILE) -> Hierarchy:
    return parse(path.read_text(encoding="utf-8"))


def parse(text: str) -> Hierarchy:
    nodes: dict[Node, None] = {}  # insertion-ordered set
    descriptions: dict[tuple[str, str], str] = {}
    main: dict[str, Node] = {}
    extra: dict[str, set[Node]] = {}
    later: list[tuple[int, str]] = []  # '@' lines and cross-branch extras, checked once all nodes exist
    errors: list[str] = []
    prefix: tuple[str, str] | None = None

    def place(tickers: str, node: Node, is_extra: bool, n: int) -> None:
        for ticker in tickers.split():
            if not TICKER.fullmatch(ticker):
                errors.append(f"line {n}: {ticker!r} is not a ticker")
            elif is_extra:
                extra.setdefault(ticker, set()).add(node)
            elif main.setdefault(ticker, node) != node:
                errors.append(f"line {n}: {ticker} already has the main label {main[ticker].path}")

    for n, line in enumerate(text.splitlines(), 1):
        line = line.rstrip()
        if not line.strip() or (line.startswith("#") and not line.startswith("##")):
            continue
        try:
            if line.startswith("## "):
                head, _, desc = line[3:].partition(" # ")
                parts = tuple(p.strip() for p in head.split(SEP))
                if len(parts) != 2 or not all(NAME.fullmatch(p) for p in parts):
                    raise ValueError(f"not a 'Sector > Industry' header: {head!r}")
                prefix = (parts[0], parts[1])
                if desc.strip():
                    descriptions[prefix] = desc.strip()
            elif line.startswith("@"):
                later.append((n, line))
            else:
                is_extra = line.startswith("+")
                head, sep, tickers = (line[1:].lstrip() if is_extra else line).partition(":")
                if not sep:
                    raise ValueError("expected 'Name: TICKERS'")
                tickers = tickers.partition(" # ")[0].strip()
                if head.count(SEP) == 2:
                    node = _path(head)
                    if is_extra:
                        later.append((n, f"+ {node.path}: {tickers}"))
                        continue
                else:
                    if prefix is None:
                        raise ValueError("line before the first '## Sector > Industry' header")
                    if not NAME.fullmatch(head.strip()):
                        raise ValueError(f"bad name {head.strip()!r}")
                    node = Node(*prefix, head.strip())
                nodes.setdefault(node)
                place(tickers, node, is_extra, n)
        except ValueError as err:
            errors.append(f"line {n}: {err}")

    def node_at(path: str) -> Node:
        node = _path(path)
        if node not in nodes:
            raise ValueError(f"{node.path} is not declared in a section")
        return node

    defaults: dict[str, Node] = {}
    rules: list[tuple[str, re.Pattern[str], Node]] = []
    umbrellas: list[tuple[Node, tuple[Node, ...]]] = []
    nosector: set[Node] = set()
    for n, line in later:
        try:
            if line.startswith("+ "):
                head, _, tickers = line[2:].partition(": ")
                place(tickers, node_at(head), True, n)
            elif line.startswith("@default "):
                group, _, path = line[9:].partition(" => ")
                defaults[group.strip()] = node_at(path)
            elif line.startswith("@rule "):
                match = _RULE.fullmatch(line)
                if match is None:
                    raise ValueError("expected '@rule Group /regex/ => path'")
                rules.append((match[1], re.compile(match[2], re.IGNORECASE), node_at(match[3])))
            elif line.startswith("@nosector "):
                nosector.add(node_at(line[10:]))
            elif line.startswith("@umbrella "):
                parent, _, kids = line[10:].partition(" <= ")
                umbrellas.append((node_at(parent), tuple(node_at(k) for k in kids.split(" ; "))))
            else:
                raise ValueError("unknown '@' directive")
        except (ValueError, re.error) as err:
            errors.append(f"line {n}: {err}")
    if errors:
        raise HierarchyError("\n".join(errors))
    return Hierarchy(list(nodes), descriptions, main, extra, defaults, rules, umbrellas, nosector)
