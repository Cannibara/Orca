"""Build the review list for the Filer type review page (owner-only): the largest current 13F filers with
the type the Landscape gives each, why, and what else is known about it, so the owner can confirm or
correct it. Reads the published site files (no keys, no lake):

    cd pipeline && uv run python scripts/investor_review.py --out DIR [--top 2000] [--cache DIR]

DIR gets review.json: one record per filer, largest book first. The type is worked out as the run does
(orca/investors.py), from summary.json's name and SEC industry and its holdings now valued at the latest
prices; the run values them at quarter end, so a hedge fund's style from holdings can differ at the margin.

`flags` say why a row deserves a look: no type, a type from name words only, the adviser register
matched by name rather than CIK, or two sources that disagree (the register, the SEC industry code or a
word of the name pointing to another top-level type). Choices made on the page go back into
investor_types.csv with scripts/investor_review_apply.py."""

import argparse
import asyncio
import csv
import json
import re
from pathlib import Path

import httpx

from orca.famous import load_famous
from orca.investors import (
    ADV_CSV,
    BY_KEY,
    HAND_CSV,
    TYPES,
    from_name,
    from_sic,
    load_classifier,
    load_parents,
    refine_hedge,
)

SITE = "https://data.orcaetf.com"
FETCH_FACTOR = 1.6  # funds.json books include filers that stopped long ago; fetch more than --top
CRD = re.compile(r"CRD (\d+) by (cik|name)")


def top_level(kind: str | None) -> str | None:
    if kind is None:
        return None
    t = BY_KEY[kind]
    return t.parent or t.key


def label(kind: str) -> str:
    t = BY_KEY[kind]
    return f"{BY_KEY[t.parent].label} > {t.label}" if t.parent else t.label


async def fetch_all(ids: list[int], cache: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(24)
    async with httpx.AsyncClient(timeout=30) as cl:

        async def one(i: int) -> None:
            p = cache / f"{i}.json"
            if p.exists():
                return
            async with sem:
                for _ in range(3):
                    try:
                        r = await cl.get(f"{SITE}/fund/{i}/summary.json")
                    except httpx.HTTPError:
                        await asyncio.sleep(1)
                        continue
                    if r.status_code == 200:
                        p.write_bytes(r.content)
                    return

        await asyncio.gather(*(one(i) for i in ids))


def get_json(cl: httpx.Client, path: str, cache: Path) -> dict:
    p = cache / path.replace("/", "_")
    if not p.exists():
        r = cl.get(f"{SITE}/{path}")
        r.raise_for_status()
        p.write_bytes(r.content)
    return json.loads(p.read_bytes())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--top", type=int, default=2000)
    ap.add_argument("--cache", type=Path, default=Path("data/review_cache"))
    a = ap.parse_args()
    a.cache.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=60) as cl:
        funds = get_json(cl, "funds.json", a.cache)
        secs = get_json(cl, "securities.json", a.cache)
        px = get_json(cl, "latest_prices.json", a.cache)
    sector = dict(zip(secs["stock_id"], secs["sector"]))
    sname = dict(zip(secs["stock_id"], secs["name"]))
    price = {s: p for s, p in zip(px["stock_id"], px["price"]) if p}

    order = sorted(zip(funds["id"], funds["book"]), key=lambda r: -(r[1] or 0))
    ids = [i for i, b in order[: int(a.top * FETCH_FACTOR) + 500] if b and b > 0]
    asyncio.run(fetch_all(ids, a.cache / "summary"))
    snaps = [json.loads(p.read_bytes()) for i in ids if (p := a.cache / "summary" / f"{i}.json").exists()]
    latest = max(s["period_q"] for s in snaps)
    cur = [s for s in snaps if s["period_q"] >= latest - 1 and not s.get("inactive") and (s["book"] or 0) > 0]
    cur.sort(key=lambda s: (-s["book"], s["id"]))
    cur = cur[: a.top]

    famous = load_famous()
    clf = load_classifier(famous)
    fam = {}
    for f in famous:
        fam.setdefault(f.fund_id, f"{f.group} ({f.manager})" if f.manager else f.group)
    with open(HAND_CSV, newline="", encoding="utf-8") as fh:
        hand_name = {int(r["fund_id"]): r.get("name") or "" for r in csv.DictReader(fh)
                     if (r.get("fund_id") or "").strip() and not r["fund_id"].startswith("#")}
    with open(ADV_CSV, newline="", encoding="utf-8") as fh:
        adv = {int(r["fund_id"]): r for r in csv.DictReader(fh)}
    parents = load_parents()

    out = []
    for rank, s in enumerate(cur, 1):
        about = s.get("about") or {}
        sic = about.get("sic")
        h = s["holdings_now"]
        val = {sid: sh * price[sid] for sid, sh in zip(h["stock_id"], h["shares"]) if sid in price and sh}
        total = sum(val.values())
        weights = {sid: v / total for sid, v in val.items()} if total > 0 else {}
        kind, how = clf.type_of(s["id"], s["name"], sic)
        refined = refine_hedge(kind, weights, len(val), sector)
        if refined != kind:
            kind, how = refined, how + "+holdings"
        flags = []
        if kind == "other":
            flags.append("Not classified")
        if how == "name":
            flags.append("Name words only")
        if kind == "hedge.other":
            flags.append("No hedge style")
        a_row = adv.get(s["id"])
        crd = by = None
        if a_row:
            m = CRD.search(a_row["basis"])
            if m:
                crd, by = m.group(1), m.group(2)
            if by == "name" and how.startswith("adv"):
                flags.append("Register matched by name")
            if not how.startswith("adv") and top_level(a_row["type"]) != top_level(kind):
                flags.append(f"Register says {label(a_row['type'])}")
        by_sic = from_sic(sic)
        if by_sic and not how.startswith("sic") and top_level(by_sic) != top_level(kind):
            flags.append(f"Industry code says {label(by_sic)}")
        by_name = from_name(s["name"])
        if by_name and not how.startswith("name") and top_level(by_name) != top_level(kind):
            flags.append(f"Name suggests {label(by_name)}")
        top = sorted(weights.items(), key=lambda kv: -kv[1])[:5]
        out.append({
            "id": s["id"],
            "rank": rank,
            "name": s["name"],
            "book": round(s["book"]),
            "n": s.get("n_holdings"),
            "city": about.get("city"),
            "state": about.get("state"),
            "signer": about.get("signer"),
            "signer_title": about.get("signer_title"),
            "sic": sic,
            "other_managers": (about.get("other_managers") or [])[:6],
            "n_other_managers": len(about.get("other_managers") or []),
            "former": [f["name"] for f in (about.get("former_names") or [])][-3:],
            "type": kind,
            "how": how,
            "adv_type": a_row["type"] if a_row else None,
            "adv_basis": a_row["basis"] if a_row else None,
            "crd": crd,
            "hand_note": hand_name.get(s["id"]),
            "famous": fam.get(s["id"]),
            "parent": parents.get(s["id"]),
            "top": [[sname.get(sid, str(sid)), round(w, 3)] for sid, w in top],
            "flags": flags,
        })
    a.out.mkdir(parents=True, exist_ok=True)
    meta = {"latest_q": latest, "n": len(out), "total": round(sum(s["book"] for s in cur)),
            "types": [{"key": t.key, "label": t.label, "parent": t.parent} for t in TYPES]}
    (a.out / "meta.json").write_text(json.dumps(meta))
    # One record per line: easy to diff and to read in part.
    (a.out / "review.json").write_text("[\n" + ",\n".join(json.dumps(r, separators=(",", ":")) for r in out) + "\n]\n")
    print(f"{len(out)} filers, latest_q {latest}, {sum(bool(r['flags']) for r in out)} flagged")


if __name__ == "__main__":
    main()
