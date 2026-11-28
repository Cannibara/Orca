"""Write the owner's picks from the Filer type review page into orca/investor_types.csv (the hand list):

    cd pipeline && uv run python scripts/investor_review_apply.py --review DIR/review.json --choices DIR

--choices is a folder of the page's saved documents (collection `pages`, one JSON file per 50 rows, as the
artifact database tool saves them) or one JSON file of them. Each document holds {"e": {fund_id: {"t": type,
"note": ..., "at": ...}}}. A pick that differs from the row's type then shown replaces the hand label or
adds one; a pick equal to it ("confirmed") adds a hand label too, so later register refreshes cannot flip a
reviewed filer. A filer already in the hand list with the same type is left as it is. Prints what changed;
the notes are printed for the WORKLOG, not stored."""

import argparse
import json
from pathlib import Path

from orca.investors import HAND_CSV, LEAVES

HEADER = "# Owner review on the Filer type review page ({date}): confirmed or corrected"


def load_choices(path: Path) -> dict[int, dict]:
    files = sorted(path.rglob("*.json")) if path.is_dir() else [path]
    out: dict[int, dict] = {}
    for f in files:
        doc = json.loads(f.read_text())
        docs = doc if isinstance(doc, list) else [doc]
        for d in docs:
            body = d.get("data", d) if isinstance(d, dict) else {}
            for k, v in (body.get("e") or {}).items():
                if isinstance(v, dict) and v.get("t") in LEAVES:
                    out[int(k)] = v
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--review", type=Path, required=True)
    ap.add_argument("--choices", type=Path, required=True)
    ap.add_argument("--date", required=True, help="the review's date, for the comment line")
    a = ap.parse_args()
    review = {r["id"]: r for r in json.loads(a.review.read_text())}
    picks = load_choices(a.choices)

    lines = HAND_CSV.read_text(encoding="utf-8").splitlines()
    index = {}
    for i, line in enumerate(lines[1:], 1):
        head = line.split(",", 1)[0].strip()
        if head.isdigit():
            index[int(head)] = i
    changed, confirmed, added, notes = [], 0, [], []
    for fund_id, v in sorted(picks.items(), key=lambda kv: review.get(kv[0], {}).get("rank", 10**9)):
        r = review.get(fund_id)
        name = (r or {}).get("hand_note") or (r or {}).get("name") or ""
        name = name.replace('"', "'")
        row = f'{fund_id},{v["t"]},"{name}"' if "," in name else f"{fund_id},{v['t']},{name}"
        was = (r or {}).get("type")
        if v.get("note"):
            notes.append(f"{fund_id} {name}: {was} -> {v['t']}: {v['note']}")
        if fund_id in index:
            old = lines[index[fund_id]].split(",")[1].strip()
            if old != v["t"]:
                lines[index[fund_id]] = row
                changed.append(f"{name}: {old} -> {v['t']}")
            continue
        added.append(row)
        if was == v["t"]:
            confirmed += 1
        else:
            changed.append(f"{name}: {was} -> {v['t']}")
    if added:
        lines += [HEADER.format(date=a.date), *added]
    HAND_CSV.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(picks)} picks: {len(changed)} changed, {confirmed} confirmed as they were, {len(added)} rows added")
    for c in changed:
        print("  changed", c)
    for n in notes:
        print("  note", n)


if __name__ == "__main__":
    main()
