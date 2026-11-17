"""Write `data/sic_nodes.csv`: SIC code -> the vertical most companies with that code have.

The pipeline labels a stock that `data/stock_nodes.csv` does not cover by its SEC SIC code through this table
(how=sic). Built from Damodaran's global company file, each company labelled through `labels.txt` (placements
by ticker only for US listings, where tickers are unambiguous).

Run from `pipeline/` (indname.xlsx from `fetch_inputs.sh`):
  uv run python orca/hierarchy/tools/build_sic_table.py --refs indname.xlsx
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from orca.hierarchy import LABELS_FILE, load
from orca.hierarchy.assign import SIC_FILE, build_sic_table

from label_securities import read_refs  # same folder


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--refs", type=Path, required=True)
    parser.add_argument("--labels", type=Path, default=LABELS_FILE)
    parser.add_argument("--out", type=Path, default=SIC_FILE)
    args = parser.parse_args()
    h = load(args.labels)
    firms = []
    for ref in read_refs(args.refs):
        if ref.sic.isdigit() and ref.group in h.defaults:
            firms.append((ref.sic, h.label(ref.ticker if ref.us else "", ref.group, ref.name)[0]))
    table = build_sic_table(firms)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["sic", "vertical"])
        for code in sorted(table, key=lambda c: (len(c), c)):
            w.writerow([code, table[code].path])
    print(f"{len(firms)} companies with a SIC code -> {len(table)} codes and prefixes; wrote {args.out}")


if __name__ == "__main__":
    main()
