"""Build the review page (one HTML file) from the data `build_hierarchy.py` wrote.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/make_review_page.py hierarchy.json --out review.html
  uv run python orca/hierarchy/tools/make_review_page.py hierarchy.json --out review.html \
      --final final.json --universe universe.json --funds top_max.json     # also the stocks top funds held

Publish the file as a Claude artifact with the `db` capability: the page saves the owner's calls and
comments in the collection `review`, and the session reads them back. The file embeds Nasdaq market
caps and Damodaran-derived defaults, so keep it private: do not commit or publish it.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

LEVEL3 = "Industry vertical"  # the owner's name for the third level (chat, 2026-11-16)
LEVEL3_PLURAL = "Industry verticals"
TEMPLATE = Path(__file__).with_name("review_page.html")
US_EXCHANGES = {"NYSE", "NasdaqGS", "NasdaqGM", "NasdaqCM", "NYSEAM", "NYSEArca"}
PERIODS = {"1y": "by 1-year return", "3y": "by 3-year return", "5y": "by 5-year return", "10y": "by 10-year return", "15y": "by 15-year return", "max": "by return since start"}

# Shown at the top of the Hierarchy tab. Replace it each round with what changed since the last one.
CHANGES = [
    "New: the stocks the 100 best funds (by return since start) ever held, 7,702 securities. 5,361 now carry a label and cover 92% of the dollars those funds bought; the Not labelled tab holds the rest (ETFs, funds, SPACs, bonds).",
    "Browse stocks has two new columns, the dollars the top funds bought and how many of the 100 held the stock, and sorts by them first. Use Sort to go back to market cap.",
    "Where each label came from: solid blue = placed by name (yours and mine), dashed blue = Damodaran's group default, not checked, dotted orange = a model's first pass from the company name. Confidence is in the hover text.",
    "Check on the group defaults: a model labelled 840 default-labelled stocks blind and agreed with the default on only 73% of verticals (88% of industries, 94% of sectors), against 97% for labels placed by name. Where it knew the company it replaced the default (224 stocks, shown as \"group default was ...\"). Tankers were under Pipelines, Qorvo under Other Semiconductors, battery makers under Automation.",
    "1,282 small default-labelled stocks (under 1% of the dollars) have not been checked yet.",
    "Rule R8 changed (a model's first pass instead of SEC SIC) and R12 is new (ETFs).",
]


def rules(data: dict) -> list[dict[str, str]]:
    """The rules and open questions shown on the Rules tab, with evidence computed from the data."""
    sub, stocks = data["sub"], data["st"]
    total, big, top = Counter(), Counter(), {}
    for s in stocks:
        for k in [s[6], *s[7]]:
            total[k] += s[2]
            big[k] += s[2] >= 1
            if k not in top or s[2] > top[k][1]:
                top[k] = (s[0], s[2])
    thin = sum(1 for k in range(len(sub)) if big[k] < 10)
    dominated = sorted(((total[k], k) for k in range(len(sub)) if total[k] >= 200 and top[k][1] / total[k] >= 0.5), reverse=True)[:8]
    dominated_text = "; ".join(f"{sub[k][1]}: {top[k][0]} {round(100 * top[k][1] / total[k])}%" for _, k in dominated)
    n_industries = len(data["ind"])
    listed = sum(1 for x in stocks if len(x) < 12 or x[11] == 0)
    by_model = sum(1 for x in stocks if len(x) > 11 and x[11] == 2)
    etfs = [x for x in data.get("nl", []) if x[5] == "etf"]
    classes = data.get("etf", {})
    etf_text = ("Classified so far (biggest 400, by dollars): " + "; ".join(f"{k} {n} (${round(m / 1000):,}bn)" for k, (n, m) in sorted(classes.items(), key=lambda kv: -kv[1][1])) + ".") if classes else "They are not classified yet."
    return [
        dict(id="R2", q="Every stock has one main label (used for scoring) and any number of extra labels (used for comparisons).",
             rec="Yes. A fund's sector and industry weights must add to 100%, so each stock needs exactly one main label. Extra labels never change a score. They let you choose the peer set for one holding: Micron against all Semiconductors or just Memory; Vistra against Nuclear Power Producers, Natural Gas Power Producers, or both.",
             ev="Try it on the Find a stock tab: MU, VST, GOOGL, CVS."),
        dict(id="R3", q="The main label is the business that earns most of the operating profit.",
             rec="Yes. Amazon: Cloud Infrastructure Provider (AWS). Alphabet: Search & Advertising. Microsoft: Enterprise Applications. Cigna: Pharmacy Benefit Managers (Express Scripts). CVS: Pharmacies, with Health Insurers and Pharmacy Benefit Managers as extras. Visa, Mastercard, Amex and Uber are technology.",
             ev="Close calls I decided: Disney (Streaming & Studios over Theme Parks), RTX and Boeing (Aerospace main, Defence Primes extra), BWX (Naval Systems main, Nuclear extra)."),
        dict(id="R4", q="A comparison needs at least 10 peers above $1bn. If the chosen node has fewer, widen to its industry.",
             rec="Yes. Labels can stay as fine as you like, but a Memory benchmark of three stocks is not a benchmark. The page shows peer counts at all three levels so you can see when one is thin.",
             ev=f"{thin} of {len(sub)} industry verticals have fewer than 10 stocks above $1bn (counting main and extra labels), shown in orange on the Hierarchy tab."),
        dict(id="R5", q="Mega-caps would dominate a cap-weighted peer index. How should the index weight stocks?",
             rec="Cap each stock at 10% of a peer index and weight the rest by market cap. Equal weight is the alternative. Not needed to finish this review.",
             ev=f"Industry verticals where one stock is at least half of the value: {dominated_text}."),
        dict(id="R6", q="Conglomerates (BRK.A, MMM, HON, IEP, BBUC, CODI) get no sector call.",
             rec='Yes. They are scored against the whole market, so "sector pick" is not claimed for them. Forcing Berkshire into insurance would make it meaningless.',
             ev="Alternative: classify Berkshire by its largest profit segment."),
        dict(id="R7", q="Use today's labels for every year, not the label at the time.",
             rec="Yes. Simple and consistent. It only matters for firms that changed business, and most stay inside one industry (Nvidia gaming → AI is still Semiconductors).",
             ev=""),
        dict(id="R8", q="Stocks outside Damodaran's US list (ADRs, foreign, delisted, small, new) get a first-pass label from a model reading the company name.",
             rec="Yes, for now: tagged, with a confidence, and open to your review. It replaces my earlier plan (the label most common for the stock's SEC SIC code), which needs a company id Orca does not hold and is too coarse for verticals. The model agrees with your hand placements 97% of the time on a blind test.",
             ev=f"His file gives {listed:,} stocks on this page; {by_model:,} came from the model's first pass. Orca prices about 22,800 stocks since 2013."),
        dict(id="R12", q="ETFs the funds hold: leave them unlabelled, or count a single-sector ETF as a bet on its sector?",
             rec="Count single-sector and single-industry ETFs (SOXX, XLF, XLK, XBI) as a bet on that sector or industry for allocation, because a fund that buys SOXX is making a semiconductor call. Leave broad-market, international, bond, commodity and mixed ETFs unlabelled. An ETF never counts as a stock pick. The Not labelled tab already shows what a model made of each big ETF.",
             ev=f"{len(etfs):,} ETFs, ${round(sum(x[3] for x in etfs) / 1000):,}bn of the dollars the top funds bought. " + etf_text),
        dict(id="R9", q='Which level counts as "sector picking"?',
             rec=f"Allocation between industries ({n_industries} buckets), with a toggle to sector ({len(data['sec'])}) or industry vertical. Stock picking is scored against the peer set you choose, widened to the industry when the vertical has fewer than 10 peers.",
             ev="Your fund A (GPU) vs fund B (memory) example is an industry-vertical toggle inside Semiconductors."),
        dict(id="R10", q="Damodaran's file comes from S&P Capital IQ and Bloomberg with no formal licence. Publish only our own final list, and email him before launch.",
             rec="Yes. His file stays a private starting point; the site publishes ticker → labels as our own work.",
             ev=""),
        dict(id="R11", q="Automotive is an umbrella label: carmakers and auto parts keep separate main labels, and both carry Automotive as an extra.",
             rec="Decided by the owner (chat, 2026-11-16): the umbrella is fine, no fourth level. Main labels stay specific so allocation can tell carmakers from parts; the umbrella lets you compare a Tesla pick with all of automotive or just carmakers.",
             ev="Shipbuilding works the same way: Huntington Ingalls and General Dynamics carry it as an extra, and their main label is Defence."),
    ]


def add_top(data: dict, final: list[dict], universe: dict, funds: dict) -> None:
    """Add the stocks that the top funds held (labelled by `merge_batches.py`) to the page's data.

    Every row of data["st"] gains six fields: [9] dollars the top funds bought, in millions, [10] how many of them
    held it, [11] source (0 Damodaran's US list, 1 matched to a company listed elsewhere, 2 a model's first pass),
    [12] confidence 0-3, [13] other Orca names for the same company, [14] the group default a model replaced. A labelled stock whose company is not in
    data["st"] is appended with a market cap of 0. Stocks with no label go to data["nl"].
    """
    nodes = {}
    for k, (ii, name, *_rest) in enumerate(data["sub"]):
        sector, industry = data["sec"][data["ind"][ii][0]], data["ind"][ii][1]
        nodes[f"{sector} > {industry} > {name}"] = k
    by_ticker = {row[0]: i for i, row in enumerate(data["st"])}
    for row in data["st"]:
        row.extend([0, 0, 0, 3, "", ""])
    held: dict[int, set[int]] = {}
    taken = {row[0].upper() for row in data["st"]}
    nl = []
    etf_stats: dict[str, list] = {}
    for r in final:
        u = universe[r["stock_id"]]
        millions = u["invested"] / 1e6
        if r["main"] is None:
            nl.append([r["stock_id"], r["ticker"], r["name"], round(millions, 1), u["n_funds"], r["kind"], r["conf"] or 0, etf_note(r.get("etf")) or r["note"]])
            if r.get("etf"):
                counts = etf_stats.setdefault(r["etf"]["label"], [0, 0.0])
                counts[0] += 1
                counts[1] = round(counts[1] + millions, 1)
            continue
        ref = r.get("ref")
        listed = ref and ref["exchange"] in US_EXCHANGES and (r["src"] == "hierarchy" or "was" in r)
        at = by_ticker.get(ref["ticker"]) if listed else None
        was = " › ".join(r["was"].split(" > ")[1:]) if "was" in r else ""
        if at is None:  # a company the Damodaran US list does not hold: ADRs, cross-listings, delisted names
            key = r["ticker"] if r["ticker"].upper() not in taken else f"{r['ticker']}~{r['stock_id']}"
            taken.add(key.upper())
            model = r["src"] == "model"
            group = data["groups"].index(ref["group"]) if ref and not model and ref["group"] in data["groups"] else -1
            how = 3 if model else {"default": 0, "rule": 1, "placed": 2}[r["how"]]
            data["st"].append([key, r["name"], 0, group, "", "", nodes[r["main"]], [nodes[x] for x in r["extras"] if x in nodes], how,
                               0, 0, 2 if model else 1, r["conf"] if model else 3, "", was])  # fmt: skip
            at = len(data["st"]) - 1
            by_ticker[key] = at
        row = data["st"][at]
        if was and row[14] == "":  # a model replaced this listed stock's group default
            row[6], row[7], row[8], row[12], row[14] = nodes[r["main"]], [nodes[x] for x in r["extras"] if x in nodes], 3, r["conf"], was
        row[9] = round(row[9] + millions, 1)
        held.setdefault(at, set()).update(u["funds"])
        if r["ticker"] != row[0] and r["ticker"] not in row[13]:
            row[13] = (row[13] + ", " if row[13] else "") + r["ticker"]
    for at, ids in held.items():
        data["st"][at][10] = len(ids)
    nl.sort(key=lambda x: -x[3])
    data["nl"] = nl
    data["etf"] = etf_stats
    data["top"] = {
        "funds": [[f["fund_id"], f["name"], f["ann_return"], f["book"], f["n_positions"]] for f in funds["eligible"][: len(universe_funds(universe))]],
        "period": PERIODS.get(funds["period"], funds["period"]),
    }


def etf_note(etf: dict | None) -> str:
    """What a model made of an ETF, in a few words: "sector ETF → Technology › Semiconductors (industry), 3x"."""
    if not etf:
        return ""
    text = etf["label"]
    if etf["k"] == "sector":
        text += f" → {' › '.join(etf['path'].split(' > '))} ({etf['lv']})"
    if etf.get("lev"):
        text += f", {etf['lev']}"
    return text


def universe_funds(universe: dict) -> set[int]:
    return {f for u in universe.values() for f in u["funds"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data", type=Path, help="hierarchy.json from build_hierarchy.py")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--final", type=Path, help="final.json from merge_batches.py")
    parser.add_argument("--universe", type=Path, help="the universe file with funds and dollars per stock")
    parser.add_argument("--funds", type=Path, help="home/top_<period>.json the universe was built from")
    args = parser.parse_args()
    data = json.loads(args.data.read_text())
    if args.final:
        uni = json.loads(args.universe.read_text())
        add_top(data, json.loads(args.final.read_text()), {r["stock_id"]: r for r in uni["rows"]}, json.loads(args.funds.read_text()))
    data.update(L3=LEVEL3, L3p=LEVEL3_PLURAL, rules=rules(data), changes=CHANGES)
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")  # safe inside <script>
    args.out.write_text(TEMPLATE.read_text().replace("__DATA__", payload))
    print(f"wrote {args.out} ({args.out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
