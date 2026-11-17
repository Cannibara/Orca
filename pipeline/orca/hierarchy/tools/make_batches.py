"""Split the stocks `label_securities.py` could not settle into batch files for a model to label, plus a blind audit.

A model (a Claude agent, one per batch) reads `model_prompt.md`, the numbered menu and one batch file, and writes a
JSON line per stock. `merge_batches.py` then folds the answers into the labelled file.

The audit is a random sample of stocks that already have a label (tier auto). They are mixed into the batches
without their label, so the model labels them blind and `merge_batches.py` can report how often it agrees.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/make_batches.py --labelled labelled.json --universe universe.json --out DIR
Writes DIR/menu.txt, DIR/prompt.md, DIR/in_01.txt ... and DIR/index.json.

When the stock list changes (a new monthly run, a fund added or dropped), `--missing --first 12` writes batches for only
the stocks no earlier batch answered: the ones the match could not settle, and with `--recheck-min 80` the default-labelled
ones that fund at least $80m. The earlier answers stay valid because they are keyed by stock id.

Afterwards, if the audit shows the group defaults are weak, the biggest default-labelled stocks can be labelled
blind as well (`--recheck 600 --first 10` adds batches from in_10.txt on, leaving the others alone); `merge_batches.py`
then lets a model that knows the company override a default.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import shutil
from pathlib import Path

from orca.hierarchy import LABELS_FILE, load

PER_BATCH = 295
AUDIT_DEFAULT, AUDIT_OTHER = 240, 60  # label found by group default / by name or rule


def menu_text(h, caps: dict[str, float]) -> str:
    """Numbered verticals under their industry, each with up to four example tickers (largest first)."""
    examples = collections.defaultdict(list)
    for ticker, node in h.main.items():
        examples[node].append(ticker)
    lines: list[str] = []
    last = None
    for i, node in enumerate(h.nodes, 1):
        if (node.sector, node.industry) != last:
            last = (node.sector, node.industry)
            note = h.descriptions.get(last, "")
            lines.append(f"\n## {node.sector} > {node.industry}" + (f"  -- {note}" if note else ""))
        tickers = sorted(examples[node], key=lambda t: -caps.get(t, 0))[:4]
        lines.append(f"{i}|{node.vertical}|{' '.join(tickers)}")
    return "\n".join(lines).strip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--labelled", type=Path, required=True)
    parser.add_argument("--universe", type=Path, required=True, help="rows with stock_id, invested, n_funds")
    parser.add_argument("--caps", type=Path, help="hierarchy.json from build_hierarchy.py (orders the menu's examples)")
    parser.add_argument("--labels", type=Path, default=LABELS_FILE)
    parser.add_argument("--seed", type=int, default=20261116)
    parser.add_argument("--recheck", type=int, metavar="N", help="only add batches for the N biggest default-labelled stocks")
    parser.add_argument("--first", type=int, default=10, help="number of the first recheck or missing batch")
    parser.add_argument("--missing", action="store_true", help="only stocks no existing out_NN.jsonl in --out has answered")
    parser.add_argument("--recheck-min", type=float, default=0, metavar="USD_M", help="with --missing: also default-labelled stocks bought for at least this many $m")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    h = load(args.labels)
    vertical_id = {n.path: i for i, n in enumerate(h.nodes, 1)}
    caps = {s[0]: s[2] for s in json.loads(args.caps.read_text())["st"]} if args.caps else {}
    labelled = json.loads(args.labelled.read_text())
    universe = {r["stock_id"]: r for r in json.loads(args.universe.read_text())["rows"]}

    if args.missing:
        answered = {json.loads(line)["id"] for f in args.out.glob("out_*.jsonl") for line in f.read_text().splitlines() if line.strip()}
        rows = [r for r in labelled if r["stock_id"] not in answered and r["kind"] != "etf" and r["tier"] in ("verify", "none")]
        if args.recheck_min:
            rows += [r for r in labelled if r["stock_id"] not in answered and r["kind"] == "stock" and r["tier"] == "auto" and r["how"] == "default"
                     and universe[r["stock_id"]]["invested"] >= args.recheck_min * 1e6]  # fmt: skip
        rows = sorted(rows, key=lambda r: -universe[r["stock_id"]]["invested"])
        n = max(1, -(-len(rows) // PER_BATCH))
        for b, part in enumerate([rows[i::n] for i in range(n)], args.first):
            lines = []
            for r in part:
                u = universe[r["stock_id"]]
                line = f"{r['stock_id']}|{r['ticker']}|{r['name']}|{round(u['invested'] / 1e6)}|{u['n_funds']}"
                if r["tier"] == "verify" and "ref" in r:
                    f = r["ref"]
                    line += f"|MATCH? {f['name']} ({f['exchange']}:{f['ticker']}, {f['country']}) [{f['group']}] => {vertical_id[r['main']]}"
                lines.append(line)
            (args.out / f"in_{b:02d}.txt").write_text("\n".join(lines) + "\n")
        print(f"{len(rows)} stocks without an answer, in {n} batches from in_{args.first:02d}.txt")
        return

    if args.recheck:
        index = json.loads((args.out / "index.json").read_text())
        taken = set(index["audit"]) | {i for b in index["batches"] for i in b}
        rows = [r for r in labelled if r["kind"] == "stock" and r["tier"] == "auto" and r["how"] == "default" and r["stock_id"] not in taken]
        rows = sorted(rows, key=lambda r: -universe[r["stock_id"]]["invested"])[: args.recheck]
        n = max(1, round(len(rows) / PER_BATCH))
        extra = [rows[i::n] for i in range(n)]
        for b, part in enumerate(extra, args.first):
            lines = [f"{r['stock_id']}|{r['ticker']}|{r['name']}|{round(universe[r['stock_id']]['invested'] / 1e6)}|{universe[r['stock_id']]['n_funds']}" for r in part]
            (args.out / f"in_{b:02d}.txt").write_text("\n".join(lines) + "\n")
        index["recheck"] = [[r["stock_id"] for r in part] for part in extra]
        (args.out / "index.json").write_text(json.dumps(index))
        print(f"{len(rows)} default-labelled stocks in {n} recheck batches from in_{args.first:02d}.txt")
        return

    need = [r for r in labelled if r["kind"] != "etf" and r["tier"] in ("verify", "none")]
    auto = [r for r in labelled if r["kind"] == "stock" and r["tier"] == "auto"]
    rng = random.Random(args.seed)
    audit = rng.sample([r for r in auto if r["how"] == "default"], AUDIT_DEFAULT)
    audit += rng.sample([r for r in auto if r["how"] != "default"], AUDIT_OTHER)
    items = sorted(need + audit, key=lambda r: -universe[r["stock_id"]]["invested"])
    n_batches = max(1, round(len(items) / PER_BATCH))
    batches = [items[i::n_batches] for i in range(n_batches)]  # round-robin: big names and audit items spread out

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "menu.txt").write_text(menu_text(h, caps))
    shutil.copy(Path(__file__).with_name("model_prompt.md"), args.out / "prompt.md")
    for b, rows in enumerate(batches, 1):
        lines = []
        for r in rows:
            u = universe[r["stock_id"]]
            line = f"{r['stock_id']}|{r['ticker']}|{r['name']}|{round(u['invested'] / 1e6)}|{u['n_funds']}"
            if r["tier"] == "verify" and "ref" in r:
                f = r["ref"]
                line += f"|MATCH? {f['name']} ({f['exchange']}:{f['ticker']}, {f['country']}) [{f['group']}] => {vertical_id[r['main']]}"
            lines.append(line)
        (args.out / f"in_{b:02d}.txt").write_text("\n".join(lines) + "\n")
    index = {"need": [r["stock_id"] for r in need], "audit": [r["stock_id"] for r in audit],
             "batches": [[r["stock_id"] for r in rows] for rows in batches]}  # fmt: skip
    (args.out / "index.json").write_text(json.dumps(index))
    print(f"{len(need)} stocks need a model, {len(audit)} audit stocks, {n_batches} batches of about {PER_BATCH}")


if __name__ == "__main__":
    main()
