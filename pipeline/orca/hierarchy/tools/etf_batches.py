"""Classify the ETFs the funds held: what they hold, and for a sector ETF which node of the hierarchy.

ETFs are not stock picks, but a fund that buys SOXX is making a semiconductor call, so a single-sector ETF is
worth a label (rule R12). `make` writes batch files for a model (one Claude agent per batch, `etf_prompt.md`);
`merge` adds the answers to `final.json` as an `etf` field on each ETF row.

Run from `pipeline/`, after `merge_batches.py` and with `menu.txt` in DIR (`make_batches.py` writes it):
  uv run python orca/hierarchy/tools/etf_batches.py make --final final.json --out DIR [--top 400]
  uv run python orca/hierarchy/tools/etf_batches.py merge --final final.json --batches DIR --out final_etf.json

When the stock list changes, `make --missing --first 3` writes a batch for only the big ETFs no earlier batch answered.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from orca.hierarchy import LABELS_FILE, Node, load

CLASSES = {"broad", "intl", "bond", "cash", "commodity", "crypto", "sector", "theme", "multi", "other"}
LEVELS = ("sector", "industry", "vertical")
LABEL = {"broad": "US stocks, broad", "intl": "non-US stocks", "bond": "bonds", "cash": "cash", "commodity": "commodity",
         "crypto": "crypto", "sector": "sector ETF", "theme": "theme across sectors", "multi": "mixed or leveraged", "other": "unclear"}  # fmt: skip


def path_at(node: Node, level: str) -> str:
    parts = node.path.split(" > ")
    return " > ".join(parts[: LEVELS.index(level) + 1])


def fold_etfs(rows: list[dict], answers: dict[int, dict], nodes: dict[int, Node]) -> tuple[list[dict], list[str]]:
    """Add an `etf` field ({k, label, c, note, and for a sector ETF lv and path, and lev if leveraged}) to every ETF row with an answer."""
    problems: list[str] = []
    for row in rows:
        a = answers.get(row["stock_id"])
        if row["kind"] != "etf" or a is None:
            continue
        kind = a.get("k")
        if kind not in CLASSES:
            problems.append(f"{row['stock_id']} {row['ticker']}: class {kind!r}")
            continue
        etf = {"k": kind, "label": LABEL[kind], "c": a.get("c", 0), "note": a.get("n", "")}
        if a.get("lev"):
            etf["lev"] = a["lev"]
        if kind == "sector":
            if a.get("lv") not in LEVELS or a.get("v") not in nodes:
                problems.append(f"{row['stock_id']} {row['ticker']}: sector ETF without a level or a vertical")
                continue
            etf.update(lv=a["lv"], path=path_at(nodes[a["v"]], a["lv"]))
        row["etf"] = etf
    return rows, problems


def read_answers(folder: Path) -> tuple[dict[int, dict], list[str]]:
    answers: dict[int, dict] = {}
    problems: list[str] = []
    for out in sorted(folder.glob("etf_out_*.jsonl")):
        expected = [int(line.split("|", 1)[0]) for line in (folder / out.name.replace("_out_", "_in_").replace(".jsonl", ".txt")).read_text().splitlines()]
        got = []
        for n, line in enumerate(out.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                answer = json.loads(line)
                got.append(answer["id"])
                answers[answer["id"]] = answer
            except (ValueError, KeyError, TypeError) as err:
                problems.append(f"{out.name} line {n}: {err}")
        if got != expected:
            problems.append(f"{out.name}: {len(got)} answers for {len(expected)} ETFs, or ids out of order")
    return answers, problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    make = sub.add_parser("make")
    make.add_argument("--final", type=Path, required=True)
    make.add_argument("--out", type=Path, required=True)
    make.add_argument("--top", type=int, default=400, help="how many ETFs, biggest dollars first")
    make.add_argument("--per-batch", type=int, default=200)
    make.add_argument("--missing", action="store_true", help="only ETFs no etf_out_NN.jsonl in --out has answered")
    make.add_argument("--first", type=int, default=1, help="number of the first batch to write")
    merge = sub.add_parser("merge")
    merge.add_argument("--final", type=Path, required=True)
    merge.add_argument("--batches", type=Path, required=True)
    merge.add_argument("--labels", type=Path, default=LABELS_FILE)
    merge.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    rows = json.loads(args.final.read_text())
    if args.cmd == "make":
        etfs = sorted((r for r in rows if r["kind"] == "etf"), key=lambda r: -r["invested"])[: args.top]
        if args.missing:
            answered = {json.loads(line)["id"] for f in args.out.glob("etf_out_*.jsonl") for line in f.read_text().splitlines() if line.strip()}
            etfs = [r for r in etfs if r["stock_id"] not in answered]
        n = max(1, round(len(etfs) / args.per_batch))
        args.out.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(__file__).with_name("etf_prompt.md"), args.out / "etf_prompt.md")
        for b in range(n):
            lines = [f"{r['stock_id']}|{r['ticker']}|{r['name']}|{round(r['invested'] / 1e6)}" for r in etfs[b::n]]
            (args.out / f"etf_in_{b + args.first:02d}.txt").write_text("\n".join(lines) + "\n")
        print(f"{len(etfs)} ETFs ({sum(r['invested'] for r in etfs) / 1e9:.1f}bn bought) in {n} batches")
        return

    nodes = dict(enumerate(load(args.labels).nodes, 1))
    answers, problems = read_answers(args.batches)
    rows, more = fold_etfs(rows, answers, nodes)
    problems += more
    args.out.write_text(json.dumps(rows, separators=(",", ":")))
    done = [r for r in rows if "etf" in r]
    total = sum(r["invested"] for r in rows if r["kind"] == "etf") or 1
    print(f"problems: {len(problems)}")
    for p in problems[:20]:
        print("  ", p)
    for k in sorted({r["etf"]["k"] for r in done}):
        part = [r for r in done if r["etf"]["k"] == k]
        print(f"{LABEL[k]:24s} {len(part):4d} ETFs  {sum(r['invested'] for r in part) / total:6.1%} of ETF dollars")
    print(f"classified {len(done)} of {sum(r['kind'] == 'etf' for r in rows)} ETFs; wrote {args.out}")


if __name__ == "__main__":
    main()
