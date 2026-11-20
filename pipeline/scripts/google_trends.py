"""Refresh pipeline/orca/famous_search.csv: Google Trends interest in each famous fund's search
keyword (famous.csv `search`), worldwide over the last 12 months, on one scale (Warren Buffett = 100).

Google has no Trends API, so this runs by hand, not in the pipeline:

    cd pipeline && uv run --with pytrends==4.9.2 python scripts/google_trends.py

pytrends is unmaintained and Google blocks bursts of requests (the script waits and retries, so a
run takes 30-60 minutes). Each keyword is compared as a Google topic (column `topic`: a /m/ or /g/
id, so "Michael Burry" means the investor and not a namesake). A new keyword gets the first topic
Google suggests whose type fits (an investor for a person, a company or fund for an institution);
with none it is left out until someone fills `topic` in by hand (a name with no namesakes can
go there in double quotes, "Gavin Baker": an exact phrase, since the bare words also count searches
holding them apart, "nick jr train" for Nick Train). Scores chain through anchors: every batch of 4
keywords holds an anchor, so all land on one scale; keywords too small to read against the first anchor are
measured again against a smaller one. The saved file is what the site shows: commit it. The owner's
order in famous_rank.csv comes first and is not touched by a refresh; the scores order the rest."""

import csv
import re
import sys
import time
from datetime import date
from pathlib import Path

from pytrends.exceptions import ResponseError, TooManyRequestsError
from pytrends.request import TrendReq

HERE = Path(__file__).resolve().parent.parent / "orca"
FAMOUS, OUT = HERE / "famous.csv", HERE / "famous_search.csv"
SCALE = "Warren Buffett"  # = 100
ANCHOR = "Bill Ackman"  # mid-level: big and small names both read well against it
TIMEFRAME = "today 12-m"
PERSON = re.compile(r"investor|business|fund|financ|hedge|entrepreneur|billionaire|executive|banker|economist|philanthrop|venture|capitalist|manager|trader|ceo|founder", re.I)
INSTITUTION = re.compile(r"company|firm|fund|invest|bank|venture|pension|corporation|agency|organi|capital|asset|holding|partner|foundation|retirement|sovereign|financ", re.I)
STAFF = {"Venture capital"}  # keyword is the firm, not a person

trends = TrendReq(hl="en-US", tz=0, timeout=(10, 30))


def call(fn, *args, **kwargs):
    for i in range(12):
        try:
            return fn(*args, **kwargs)
        except (TooManyRequestsError, ResponseError) as e:
            wait = min(600, 60 * (i + 1))
            print(f"  Google blocked us ({e.__class__.__name__}); waiting {wait}s", flush=True)
            time.sleep(wait)
    sys.exit("Google kept blocking: try again later; nothing was saved")


def topic_for(keyword: str, institution: bool) -> tuple[str, str]:
    kind = INSTITUTION if institution else PERSON
    words = set(re.findall(r"\w+", keyword.lower()))
    for s in call(trends.suggestions, keyword):
        if kind.search(s.get("type", "")) and words & set(re.findall(r"\w+", s["title"].lower())):
            return s["mid"], f'{s["title"]} ({s["type"]})'
    return "", ""


def interest(topics: list[str]) -> dict[str, float]:
    call(trends.build_payload, topics, timeframe=TIMEFRAME, geo="")
    frame = call(trends.interest_over_time)
    time.sleep(8)
    return {t: float(frame[t].mean()) if t in frame else 0.0 for t in topics}


def main() -> None:
    rows = list(csv.DictReader(open(FAMOUS, newline="", encoding="utf-8")))
    wanted: dict[str, bool] = {}  # keyword -> is an institution
    for r in rows:
        if r["search"]:
            wanted[r["search"]] = wanted.get(r["search"], False) or r["group"] in STAFF
    wanted.setdefault(SCALE, False)
    known = {}
    if OUT.exists():
        known = {r["keyword"]: r for r in csv.DictReader(open(OUT, newline="", encoding="utf-8"))}
    topic = {k: (known[k]["topic"], known[k]["topic_name"]) for k in wanted if k in known}
    for k, institution in sorted(wanted.items()):
        if k not in topic:
            topic[k] = topic_for(k, institution)
            print(f"topic {k!r}: {topic[k][1] or 'none found'}", flush=True)
            time.sleep(4)
    if not topic.get(ANCHOR, ("",))[0] or not topic.get(SCALE, ("",))[0]:
        sys.exit(f"{ANCHOR} and {SCALE} need topics")
    tid = {k: t for k, (t, _) in topic.items() if t}
    ratio = {ANCHOR: 1.0}  # interest relative to the anchor
    low = []
    names = [k for k in sorted(tid) if k != ANCHOR]
    for i in range(0, len(names), 4):
        group = names[i : i + 4]
        got = interest([tid[ANCHOR]] + [tid[k] for k in group])
        a = got[tid[ANCHOR]]
        for k in group:
            ratio[k] = got[tid[k]] / a if a > 0 else 0.0
            if got[tid[k]] < 2 or a < 2:
                low.append(k)
        print(f"batch {i // 4 + 1}: " + ", ".join(f"{k} {ratio[k]:.3f}" for k in group), flush=True)
    # A keyword under 2 on the 0-100 scale of its batch reads coarsely: measure it again against a
    # smaller anchor, itself measured well against the first.
    small = sorted((r, k) for k, r in ratio.items() if 0.05 <= r <= 0.2 and k not in low)
    redo = [k for k in low if k != SCALE]
    if redo and small:
        anchor2 = small[len(small) // 2][1]
        for i in range(0, len(redo), 4):
            group = [k for k in redo[i : i + 4] if k != anchor2]
            got = interest([tid[anchor2]] + [tid[k] for k in group])
            b = got[tid[anchor2]]
            for k in group:
                if b > 0:
                    ratio[k] = got[tid[k]] / b * ratio[anchor2]
    scale = ratio[SCALE]
    today = date.today().isoformat()
    with open(OUT, "w", newline="", encoding="utf-8") as fh:
        out = csv.writer(fh, lineterminator="\n")
        out.writerow(["keyword", "topic", "topic_name", "score", "asof"])
        for k in sorted(wanted):
            t, name = topic[k]
            score = f"{100 * ratio[k] / scale:.2f}" if t and k in ratio else ""
            out.writerow([k, t, name, score, today if score else ""])
    print(f"wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
