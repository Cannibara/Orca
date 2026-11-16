"""Fold a model's batch answers into the labelled file, and report how far to trust the labels.

Reads `labelled.json` (from `label_securities.py`) and `out_NN.jsonl` files (from the model; see `make_batches.py`).

How each stock ends up:
  etf                      kind etf, no label
  tier auto                the hierarchy's label (placed, rule or default) from the matched company
  tier verify, m = 1       the same label, now checked: the model agrees the match is the same company
  tier verify, m = 0       the model's own vertical
  tier none                the model's own vertical; kind spac, fund, bond or other when it says so
The model's answer for a stock that already has a label (the blind audit) is compared with it and never replaces it.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/merge_batches.py --labelled labelled.json --batches DIR \
      --universe universe.json --out final.json
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path

from orca.hierarchy import LABELS_FILE, load

KINDS = {"stock", "spac", "fund", "bond", "other"}


def read_answers(folder: Path) -> tuple[dict[int, dict], list[str]]:
    """{stock_id: answer} from every out_NN.jsonl, and the problems found."""
    answers: dict[int, dict] = {}
    problems: list[str] = []
    for out in sorted(folder.glob("out_*.jsonl")):
        expected = [int(line.split("|", 1)[0]) for line in (folder / out.name.replace("out_", "in_").replace(".jsonl", ".txt")).read_text().splitlines()]
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
            problems.append(f"{out.name}: {len(got)} answers for {len(expected)} stocks, or ids out of order "
                            f"(missing {len(set(expected) - set(got))}, extra {len(set(got) - set(expected))})")  # fmt: skip
    return answers, problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--labelled", type=Path, required=True)
    parser.add_argument("--batches", type=Path, required=True)
    parser.add_argument("--universe", type=Path, required=True)
    parser.add_argument("--labels", type=Path, default=LABELS_FILE)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    h = load(args.labels)
    node = {i: n for i, n in enumerate(h.nodes, 1)}
    universe = {r["stock_id"]: r for r in json.loads(args.universe.read_text())["rows"]}
    answers, problems = read_answers(args.batches)
    final, agree = [], collections.defaultdict(collections.Counter)
    for row in json.loads(args.labelled.read_text()):
        a = answers.get(row["stock_id"])
        out = {k: row[k] for k in ("stock_id", "ticker", "name", "kind", "tier")}
        out.update(main=None, extras=[], src=None, how=None, conf=None, note="")
        if "ref" in row:
            out["ref"] = row["ref"]
        if row["kind"] == "etf":
            pass
        elif row["tier"] == "auto":
            out.update(main=row["main"], extras=row["extras"], src="hierarchy", how=row["how"], conf=3)
            if a is not None and a.get("k") == "stock" and a.get("v") in node:  # the blind audit
                mine, theirs = node[a["v"]], row["main"]
                agree[row["how"]]["n"] += 1
                agree[row["how"]]["vertical"] += mine.path == theirs
                agree[row["how"]]["industry"] += " > ".join(mine.path.split(" > ")[:2]) == " > ".join(theirs.split(" > ")[:2])
                agree[row["how"]]["sector"] += mine.sector == theirs.split(" > ")[0]
        elif a is None:
            problems.append(f"no answer for {row['stock_id']} {row['ticker']} {row['name']}")
        else:
            out["note"] = a.get("n", "")
            kind = a.get("k")
            if kind not in KINDS:
                problems.append(f"{row['stock_id']}: kind {kind!r}")
            elif kind != "stock":
                out["kind"] = kind
            elif a.get("v") not in node:
                out.update(src="model", conf=0)  # the model could not tell what the business is
            elif row["tier"] == "verify" and a.get("m") == 1:
                out.update(main=row["main"], extras=row["extras"], src="hierarchy", how=row["how"], conf=a.get("c", 2))
                out["checked"] = True
            else:
                out.update(main=node[a["v"]].path, src="model", how="model", conf=a.get("c", 1))
                out["extras"] = [node[x].path for x in a.get("x", []) if x in node]
        out["invested"] = universe[row["stock_id"]]["invested"] if row["stock_id"] in universe else 0
        final.append(out)
    args.out.write_text(json.dumps(final, separators=(",", ":")))

    total = sum(r["invested"] for r in final) or 1
    print("problems:", len(problems))
    for p in problems[:20]:
        print("  ", p)
    by = collections.Counter()
    weight = collections.Counter()
    for r in final:
        key = "etf" if r["kind"] == "etf" else r["src"] if r["main"] else f"no label ({r['kind']})"
        by[key] += 1
        weight[key] += r["invested"]
    for key in sorted(by, key=lambda k: -weight[k]):
        print(f"{key:24s} {by[key]:5d} stocks  {weight[key] / total:6.1%} of dollars bought")
    print("\nblind audit: model vs hierarchy label")
    for how, c in sorted(agree.items()):
        print(f"  label by {how:8s} n={c['n']:3d}  same vertical {c['vertical'] / c['n']:5.1%}  same industry {c['industry'] / c['n']:5.1%}  same sector {c['sector'] / c['n']:5.1%}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
