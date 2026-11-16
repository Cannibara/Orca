"""Write the labelled stocks as a CSV the owner can open (private: it holds Damodaran-derived labels; do not commit).

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/export_labels.py --final final.json --universe universe.json --out labels.csv
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

COLUMNS = [
    "stock_id", "ticker", "name", "kind", "sector", "industry", "industry_vertical", "extra_labels", "source", "how",
    "confidence", "was_group_default", "top_funds_bought_usd_m", "n_top_funds", "matched_company",
]  # fmt: skip


def csv_rows(final: list[dict], universe: dict[int, dict]) -> list[list]:
    """One row per stock, biggest dollars bought first."""
    out = []
    for r in sorted(final, key=lambda r: (-r["invested"], r["stock_id"])):
        main = (r["main"] or "").split(" > ")
        main += [""] * (3 - len(main))
        ref = r.get("ref") or {}
        out.append([
            r["stock_id"], r["ticker"], r["name"], r["kind"], *main, "; ".join(r["extras"]),
            "ETF" if r["kind"] == "etf" else (r["src"] or ""), r["how"] or "", "" if r["conf"] is None else r["conf"], r.get("was", ""),
            round(r["invested"] / 1e6, 1), universe.get(r["stock_id"], {}).get("n_funds", ""),
            f"{ref['name']} ({ref['exchange']}:{ref['ticker']})" if ref else "",
        ])  # fmt: skip
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--final", type=Path, required=True)
    parser.add_argument("--universe", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    universe = {r["stock_id"]: r for r in json.loads(args.universe.read_text())["rows"]}
    rows = csv_rows(json.loads(args.final.read_text()), universe)
    with args.out.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(COLUMNS)
        writer.writerows(rows)
    print(f"wrote {args.out} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
