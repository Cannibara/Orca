"""Add stocks the name match settles (tier auto) to `data/stock_nodes.csv`, without a model.

Rows already in the CSV are left alone (model answers and owner edits keep priority); only new stock ids
are added, with how = placed | rule | default from the match. Stocks the match cannot settle get their label
from the SIC table at run time instead.

Run from `pipeline/`, after `label_securities.py` over all of `securities.json`:
  uv run python orca/hierarchy/tools/extend_labels.py --labelled all_labelled.json
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from orca.hierarchy.assign import STOCK_FILE, merge_rows, write_rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--labelled", type=Path, required=True)
    parser.add_argument("--csv", type=Path, default=STOCK_FILE)
    args = parser.parse_args()
    with open(args.csv, newline="", encoding="utf-8") as f:
        old = list(csv.DictReader(f))
    have = {r["stock_id"] for r in old}
    new = [
        {"stock_id": str(r["stock_id"]), "ticker": r["ticker"], "kind": "stock", "vertical": r["main"],
         "extras": ";".join(r["extras"]), "how": r["how"], "conf": ""}
        for r in json.loads(args.labelled.read_text())
        if r["kind"] == "stock" and r["tier"] == "auto" and str(r["stock_id"]) not in have
    ]  # fmt: skip
    write_rows(merge_rows(old, new), args.csv)
    print(f"added {len(new)} stocks to {len(old)} rows; wrote {args.csv}")


if __name__ == "__main__":
    main()
