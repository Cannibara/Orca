"""Label Orca's securities with the hierarchy, as far as a name match against Damodaran's global file allows.

Inputs (not committed; `fetch_inputs.sh` downloads indname.xlsx):
  --securities  Orca's published securities.json (stock_id, ticker, name, sector columns)
  --stocks      optional JSON with the stock ids to label: a list, or {"rows": [{"stock_id": ...}]}
  --refs        Damodaran's indname.xlsx (48,000 companies, 94 industry groups, all exchanges)

Writes one row per stock:
  kind          etf | bond | fund | stock (from fields Orca already publishes)
  tier          auto (strong match to a US-listed company) | verify (strong match elsewhere, or partial) | none
  ref           the best match: name, exchange, ticker, country, group, and how well it fits
  main, extras  hierarchy paths from labels.txt for tier auto and verify (the match's Damodaran ticker and group)
  how           placed | rule | default: how the main label was found
Rows of tier verify and none, and every ETF, still need a person or a model: see the README.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/label_securities.py --securities securities.json --refs indname.xlsx \
      --stocks universe.json --out labelled.json
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

import openpyxl

from orca.hierarchy import LABELS_FILE, load
from orca.hierarchy.matching import Matcher, Ref, kind, tier


def read_refs(path: Path) -> list[Ref]:
    sheet = openpyxl.load_workbook(path, read_only=True)["By industry"]
    rows = sheet.iter_rows(values_only=True)
    header = next(r for r in rows if r and "Industry Group" in r)
    col = {h: i for i, h in enumerate(header)}
    refs = []
    for r in rows:
        if not r or not r[col["Company Name"]]:
            continue
        exchange, _, ticker = str(r[col["Exchange:Ticker"]]).partition(":")
        name = re.sub(r"\s*\([A-Za-z]+:[^)]*\)\s*$", "", str(r[col["Company Name"]])).strip()
        refs.append(Ref(name, exchange, ticker, str(r[col["Country"]]), str(r[col["Industry Group"]]), str(r[col["SIC Code"]])))
    return refs


def stock_ids(path: Path | None, everything: list[int]) -> list[int]:
    if path is None:
        return everything
    data = json.loads(path.read_text())
    rows = data["rows"] if isinstance(data, dict) else data
    return [r["stock_id"] if isinstance(r, dict) else r for r in rows]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--securities", type=Path, required=True)
    parser.add_argument("--refs", type=Path, required=True)
    parser.add_argument("--stocks", type=Path)
    parser.add_argument("--labels", type=Path, default=LABELS_FILE)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    h = load(args.labels)
    refs = read_refs(args.refs)
    unknown = sorted({r.group for r in refs} - set(h.defaults))
    if unknown:
        raise SystemExit(f"Damodaran groups with no @default in labels.txt: {unknown}")
    matcher = Matcher(refs)

    sec = json.loads(args.securities.read_text())
    meta = {s: (t, n, x) for s, t, n, x in zip(sec["stock_id"], sec["ticker"], sec["name"], sec["sector"])}
    out, counts = [], collections.Counter()
    for sid in stock_ids(args.stocks, list(meta)):
        ticker, name, published = meta[sid]
        row: dict = {"stock_id": sid, "ticker": ticker, "name": name, "kind": kind(ticker, published)}
        if row["kind"] == "etf":
            row["tier"] = "etf"
        else:
            cands = matcher.match(name, ticker)
            best = cands[0] if cands else None
            row["tier"] = tier(best)
            if best is not None and row["tier"] != "none":
                ref = best.ref
                main_label, extras, how = h.label(ref.ticker, ref.group, ref.name)
                row.update(
                    ref={"name": ref.name, "exchange": ref.exchange, "ticker": ref.ticker, "country": ref.country,
                         "group": ref.group, "score": best.score, "cover": best.cover, "cover_ref": best.cover_ref,
                         "ticker_equal": best.ticker_equal, "gap": best.gap},
                    main=main_label.path, extras=[n.path for n in extras], how=how,
                )  # fmt: skip
        counts[(row["kind"], row["tier"])] += 1
        out.append(row)
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    for key, n in sorted(counts.items()):
        print(f"{key[0]:6s} {key[1]:7s} {n}")
    print(f"wrote {args.out} ({len(out)} stocks)")


if __name__ == "__main__":
    main()
