"""List every security the best funds ever held, from the public data files.

Downloads `home/top_<period>.json`, `securities.json` and each fund's `positions.json` from the data site (all public,
no CUSIPs) and writes `universe.json` for `label_securities.py --stocks` and `make_batches.py --universe`.

`positions.json` covers a fund's current tracking segment only, so a fund that stopped filing and came back
has its earlier holdings missing.

`--exclude FUND_ID` leaves a fund out and takes the next one in its place, so the list stays at `--top` funds.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/top_funds_universe.py --period max --top 100 --out DIR [--exclude 1818604]
Writes DIR/raw/ (the downloads) and DIR/universe.json.
"""

from __future__ import annotations

import argparse
import collections
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

BASE = "https://data.orcaetf.com"


def pick_funds(eligible: list[dict], top: int, exclude: list[int]) -> list[dict]:
    """The first `top` funds of the ranking, skipping the excluded ones."""
    return [f for f in eligible if f["fund_id"] not in set(exclude)][:top]


def build_universe(fund_ids: list[int], positions: dict[int, dict], securities: dict) -> list[dict]:
    """One row per security any of the funds ever held, biggest dollars bought first.

    `invested` is the dollars the funds bought of it in total (a size guide, not a market value); `peak` is the
    largest single position any of them held (trade price × shares after); `funds` lists who held it.
    """
    meta = {s: (t, n, x) for s, t, n, x in zip(securities["stock_id"], securities["ticker"], securities["name"], securities["sector"])}
    agg: dict[int, dict] = collections.defaultdict(lambda: {"invested": 0.0, "peak": 0.0, "funds": []})
    for fund in fund_ids:
        p = positions[fund]
        for i, stock in enumerate(p["stock_id"]):
            a = agg[stock]
            a["invested"] += p["invested"][i] or 0.0
            a["funds"].append(fund)
            for _q, _delta, price, _low, _high, after in p["trades"][i]:
                if price is not None and after is not None:
                    a["peak"] = max(a["peak"], price * after)
    rows = []
    for stock, a in agg.items():
        ticker, name, sector = meta[stock]
        rows.append({"stock_id": stock, "ticker": ticker, "name": name, "pub_sector": sector, "n_funds": len(a["funds"]),
                     "invested": round(a["invested"]), "peak": round(a["peak"]), "funds": a["funds"]})  # fmt: skip
    return sorted(rows, key=lambda r: (-r["invested"], r["stock_id"]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--period", default="max", choices=["1y", "3y", "5y", "10y", "15y", "max"])
    parser.add_argument("--top", type=int, default=100)
    parser.add_argument("--exclude", type=int, action="append", default=[], metavar="FUND_ID")
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    raw = args.out / "raw"
    raw.mkdir(parents=True, exist_ok=True)

    def fetch(path: str) -> dict:
        target = raw / path
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            for attempt in range(4):
                try:
                    r = httpx.get(f"{args.base}/{path}", timeout=60)
                    r.raise_for_status()
                    target.write_text(r.text)
                    break
                except httpx.HTTPError:
                    if attempt == 3:
                        raise
        return json.loads(target.read_text())

    top = fetch(f"home/top_{args.period}.json")
    funds = pick_funds(top["eligible"], args.top, args.exclude)
    ids = [f["fund_id"] for f in funds]
    securities = fetch("securities.json")
    with ThreadPoolExecutor(8) as pool:
        positions = dict(zip(ids, pool.map(lambda i: fetch(f"fund/{i}/positions.json"), ids)))
    rows = build_universe(ids, positions, securities)
    out = {"period": args.period, "n_funds": len(ids), "fund_ids": ids, "excluded": args.exclude, "rows": rows}
    (args.out / "universe.json").write_text(json.dumps(out))
    print(f"{len(ids)} funds ({args.period}), {len(rows)} securities, ${sum(r['invested'] for r in rows) / 1e9:,.0f}bn bought in total")


if __name__ == "__main__":
    main()
