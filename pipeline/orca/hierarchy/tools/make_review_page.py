"""Build the review page (one HTML file) from the data `build_hierarchy.py` wrote.

Run from `pipeline/`:
  uv run python orca/hierarchy/tools/make_review_page.py hierarchy.json --out review.html

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

# Shown at the top of the Hierarchy tab. Replace it each round with what changed since the last one.
CHANGES = [
    '"Industry vertical" is now the name of the third level.',
    "Oil: every producer is labelled Production. Exploration is removed (no stock was left in it).",
    "Alphabet carries all five labels: Search & Advertising (main); Cloud Infrastructure Provider, Consumer Services and Entertainment under Software; and Communication › Entertainment › Streaming & Studios, which compares YouTube with Netflix.",
    "Consumer and Industrials rebuilt around your examples: Clothing › Sportswear, Household goods › Appliances, Manufacturing › Shipbuilding and Automotive. Every industry in those two sectors has a one-line description.",
    "Automotive is an umbrella label: carmakers and auto parts keep separate main labels, and every one also carries Automotive. Decided: no fourth level.",
    "Autos moved from Consumer into Industrials › Manufacturing. RVs, boats and motorcycles moved into Consumer › Leisure. Shipping operators (Kirby, Matson) are Transportation & Logistics; Shipbuilding has only Huntington Ingalls and General Dynamics, as extra labels, because their main label is Defence.",
    "Apparel & Footwear became Clothing. Appliances, furniture, housewares, cleaning products and consumer electronics are Household goods. Beauty and personal care is its own industry.",
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
        dict(id="R8", q="Stocks outside Damodaran's list (delisted, small, new) get the label most common for their SEC SIC code.",
             rec='Yes, tagged "inferred", and reviewed only when a fund holds a lot of one.',
             ev=f"His file gives {len(stocks):,} US exchange-listed stocks; Orca prices about 22,800 since 2013."),
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data", type=Path, help="hierarchy.json from build_hierarchy.py")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.data.read_text())
    data.update(L3=LEVEL3, L3p=LEVEL3_PLURAL, rules=rules(data), changes=CHANGES)
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")  # safe inside <script>
    args.out.write_text(TEMPLATE.read_text().replace("__DATA__", payload))
    print(f"wrote {args.out} ({args.out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
