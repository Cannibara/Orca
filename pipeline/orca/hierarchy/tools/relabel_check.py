"""Show what an edit to `labels.txt` or `data/stock_nodes.csv` moves, before you re-run the pipeline.

Compares the labels at a git revision (default HEAD) with the working tree: each stock that moved, and every
hierarchy label whose index changes. With --universe (from `top_funds_universe.py`) it also shows the dollars
the top funds bought of each moved stock.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/relabel_check.py [--rev HEAD] [--universe universe.json]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
from pathlib import Path

from orca.hierarchy import parse
from orca.hierarchy.assign import STOCK_FILE, moves, resolve
from orca.hierarchy.model import LABELS_FILE


def at_rev(rev: str, path: Path) -> str:
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
    rel = path.resolve().relative_to(top)
    return subprocess.run(["git", "show", f"{rev}:{rel}"], capture_output=True, text=True, check=True).stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rev", default="HEAD")
    parser.add_argument("--universe", type=Path)
    args = parser.parse_args()
    before = resolve(csv.DictReader(io.StringIO(at_rev(args.rev, STOCK_FILE))), parse(at_rev(args.rev, LABELS_FILE)))
    after = resolve(csv.DictReader(io.StringIO(STOCK_FILE.read_text())), parse(LABELS_FILE.read_text()))
    moved, touched = moves(before, after)
    bought = {r["stock_id"]: r["invested"] for r in json.loads(args.universe.read_text())["rows"]} if args.universe else {}
    for sid, ticker, old, new in moved:
        usd = f"  ${bought[sid] / 1e6:,.0f}m bought" if sid in bought else ""
        print(f"{sid:>6} {ticker:8s} {old or '(none)'}  ->  {new or '(none)'}{usd}")
    print(f"\n{len(moved)} stocks moved; {len(touched)} hierarchy labels' indices change:")
    for path in touched:
        print("  ", path)


if __name__ == "__main__":
    main()
