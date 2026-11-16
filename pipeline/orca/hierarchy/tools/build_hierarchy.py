"""Label every US-listed stock and write the data the review page reads.

Inputs (not committed; `fetch_inputs.sh` downloads them, `../README.md` gives their terms):
  indname.xlsx   Damodaran's company file: industry group, SIC code, country, exchange:ticker
  screener.json  Nasdaq screener download: market caps, used only to rank and size stocks
  ffi48.html     WRDS page with the Fama-French 48 SIC ranges (a cross-check label)

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/build_hierarchy.py INPUT_DIR --out hierarchy.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import openpyxl

from orca.hierarchy import LABELS_FILE, Node, load

EXCHANGES = {"NYSE", "NasdaqGS", "NasdaqGM", "NasdaqCM", "NYSEAM", "NYSEArca"}  # US-listed only
HOW = {"default": 0, "rule": 1, "placed": 2}


@dataclass
class Firm:
    ticker: str
    name: str
    group: str
    sic: object
    cap_bn: float


def norm(ticker: str) -> str:
    """Nasdaq writes BRK/B, Damodaran BRK.B: compare them on one spelling."""
    return re.sub(r"[^A-Z0-9]", "-", ticker.upper().replace("/", "-").replace(".", "-")).strip("-")


def read_caps(path: Path) -> dict[str, float]:
    caps: dict[str, float] = {}
    for row in json.loads(path.read_text())["data"]["rows"]:
        try:
            caps[norm(row["symbol"])] = float(row["marketCap"] or 0)
        except ValueError:
            pass
    return caps


def read_ff48(path: Path) -> list[tuple[int, int, str]]:
    text = html.unescape(re.sub(r"<[^>]+>", " ", path.read_text(encoding="utf-8", errors="ignore")))
    found = re.findall(r"(\d+)<=&SIC_Code<=(\d+) then do; FFI48=\d+; FFI48_desc='([^']+)'", text)
    return [(int(a), int(b), name) for a, b, name in found]


def ff48(ranges: list[tuple[int, int, str]], sic: object) -> str:
    try:
        code = int(sic)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return ""
    return next((name for a, b, name in ranges if a <= code <= b), "Other")


def read_firms(path: Path, caps: dict[str, float]) -> dict[str, Firm]:
    sheet = openpyxl.load_workbook(path, read_only=True)["By industry"]
    rows = sheet.iter_rows(values_only=True)
    header = next(r for r in rows if r and "Industry Group" in r)
    col = {h: i for i, h in enumerate(header)}
    firms: dict[str, Firm] = {}
    for r in rows:
        if not r or r[col["Country"]] != "United States":
            continue
        exchange, _, ticker = str(r[col["Exchange:Ticker"]]).partition(":")
        if exchange not in EXCHANGES:
            continue
        name = re.sub(r"\s*\([A-Za-z]+:[^)]*\)\s*$", "", str(r[col["Company Name"]])).replace(", Inc.", " Inc.").strip()
        firms[ticker] = Firm(ticker, name, r[col["Industry Group"]], r[col["SIC Code"]], caps.get(norm(ticker), 0.0) / 1e9)
    return firms


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", type=Path, help="folder with indname.xlsx, screener.json and ffi48.html")
    parser.add_argument("--labels", type=Path, default=LABELS_FILE)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    h = load(args.labels)
    firms = read_firms(args.inputs / "indname.xlsx", read_caps(args.inputs / "screener.json"))
    ff_ranges = read_ff48(args.inputs / "ffi48.html")
    groups = sorted({f.group for f in firms.values()})
    index: dict[Node, int] = {n: i for i, n in enumerate(h.nodes)}

    stocks, how_count = [], Counter()
    for f in sorted(firms.values(), key=lambda f: -f.cap_bn):
        main, extra, how = h.label(f.ticker, f.group, f.name)
        how_count[how] += 1
        stocks.append(
            [f.ticker, f.name, round(f.cap_bn, 2), groups.index(f.group), f.sic, ff48(ff_ranges, f.sic),
             index[main], [index[n] for n in extra], HOW[how]]
        )  # fmt: skip

    sectors, industries = h.sectors, h.industries
    data = {
        "sec": sectors,
        "ind": [[sectors.index(s), i, *([h.descriptions[(s, i)]] if (s, i) in h.descriptions else [])] for s, i in industries],
        "sub": [[industries.index((n.sector, n.industry)), n.vertical, int(n in h.nosector)] for n in h.nodes],
        "st": stocks,
        "groups": groups,
        "um": [[index[parent], [index[k] for k in kids]] for parent, kids in h.umbrellas],
    }
    args.out.write_text(json.dumps(data, separators=(",", ":")))

    unknown = sorted({t for t in [*h.main, *h.extra] if t not in firms})
    used = Counter(s[6] for s in stocks) + Counter(e for s in stocks for e in s[7])
    print(f"{len(sectors)} sectors, {len(industries)} industries, {len(h.nodes)} industry verticals, {len(stocks)} stocks")
    print(f"main label found by: {dict(how_count)}")
    print(f"tickers in labels.txt that are not US-listed in Damodaran's file ({len(unknown)}): {unknown}")
    print(f"verticals with no stock: {[n.vertical for n in h.nodes if used[index[n]] == 0]}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
