"""Refresh pipeline/orca/investor_types_adv.csv: each 13F filer that is an SEC-registered (or exempt reporting)
investment adviser, typed from the SEC's monthly adviser register (Form ADV Part 1A, "Information about
Registered Investment Advisers and Exempt Reporting Advisers"). Runs by hand, not in the pipeline:

    cd pipeline && ORCA_CONTACT=you@example.com uv run python scripts/investor_types.py [--funds funds.json]

It reads the site's fund index (funds.json: every 13F filer's CIK and name; the published one by default),
downloads the latest register (two zips, ~6 MB), matches filers to advisers by CIK (the register lists an
adviser's CIK numbers) and else by exact name (legal or business, suffixes like LLC and punctuation
aside, only when one adviser has it), then types each adviser by where its money comes from (Item 5.D,
regulatory assets by client type) and the private funds it runs (Item 7.B):

- half or more in pooled vehicles: a hedge fund when it reports at least half as many hedge funds as private
  equity and venture funds together, else venture capital or private equity, whichever it has more of; with
  no private funds at all, a mutual fund firm (foreign funds are pooled vehicles to the SEC);
- half or more for individuals and wealthy people: a wealth manager;
- half or more in mutual funds (and BDCs): a mutual fund firm;
- half or more for institutions (pensions, charities, governments, insurers, banks, companies, other
  advisers): an institutional manager;
- else the largest of those four; an exempt reporting adviser (no Item 5) by its private funds alone.

The basis column says why, for whoever checks a row. investor_types.csv (by hand) overrides any row, and
famous.csv's style lists refine "hedge fund" into a style (orca/investors.py). Commit the saved file."""

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent / "orca"
OUT = HERE / "investor_types_adv.csv"
FUNDS_URL = "https://data.orcaetf.com/funds.json"
PAGE = "https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers"
SEC = "https://www.sec.gov"

# Item 5.D(3): regulatory assets by client type, grouped.
RETAIL = ("a", "b")  # individuals, high net worth individuals
FUNDS = ("d", "e")  # investment companies, business development companies
POOLED = ("f",)  # pooled investment vehicles (private funds)
INSTITUTIONS = ("c", "g", "h", "i", "j", "k", "l", "m", "n")
SUFFIX = re.compile(
    r"\b(LLC|L L C|LP|L P|LLP|LLLP|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|AG|NV|GMBH"
    r"|LIMITED PARTNERSHIP|THE)\b"
)


def get(url: str, contact: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": f"Orca research {contact}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def norm(name: str) -> str:
    s = re.sub(r"[^A-Z0-9 ]", " ", name.upper().replace("&", " AND "))
    return " ".join(SUFFIX.sub(" ", s).split())


def money(s: str) -> float:
    s = (s or "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def count(s: str) -> int:
    return int(money(s))


def register_rows(contact: str) -> list[dict]:
    """The latest registered and exempt advisers' rows, each with `_kind` ("registered" or "exempt")."""
    page = get(PAGE, contact).decode("utf-8", "replace")
    # the newest month is listed first; its folder's name says "exempt" too, so only the file name counts
    links = [u for u in re.findall(r'href="([^"]+\.zip)"', page) if "/information-about-" in u]
    registered = next(u for u in links if "exempt" not in u.rsplit("/", 1)[-1])
    exempt = next(u for u in links if "exempt" in u.rsplit("/", 1)[-1])
    rows = []
    for kind, link in (("registered", registered), ("exempt", exempt)):
        blob = get(link if link.startswith("http") else SEC + link, contact)
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            name = next(n for n in z.namelist() if n.upper().endswith(".CSV"))
            text = z.read(name).decode("latin-1")
        csv.field_size_limit(10**9)
        for r in csv.DictReader(io.StringIO(text)):
            r["_kind"] = kind
            rows.append(r)
        print(f"{kind}: {link.rsplit('/', 1)[-1]}", file=sys.stderr)
    return rows


def private_funds(r: dict) -> str | None:
    """The type the adviser's private funds say (hedge, venture, private equity), None with none."""
    hedge = count(r.get("Total number of Hedge funds", ""))
    pe = count(r.get("Total number of PE funds", ""))
    vc = count(r.get("Total number of VC funds", ""))
    if hedge == pe == vc == 0:
        return None
    # hedge funds run a few vehicles each (master, feeders), private equity firms one per deal year: a
    # hedge fund with sidecars (Viking, Coatue) reports a few PE funds, a PE firm few hedge funds
    if 2 * hedge >= pe + vc:
        return "hedge.other"
    return "pevc.vc" if vc > pe else "pevc.pe"


def adviser_type(r: dict) -> tuple[str, str] | None:
    """(type, basis) of one adviser, None when its filing says too little."""
    funds = private_funds(r)
    nums = f"{count(r.get('Total number of Hedge funds', ''))} hedge, {count(r.get('Total number of PE funds', ''))} PE, {count(r.get('Total number of VC funds', ''))} VC funds"
    if r["_kind"] == "exempt":
        return (funds, f"exempt adviser; {nums}") if funds else None
    raum = {k: money(r.get(f"5D({k})(3)", "")) for k in "abcdefghijklmn"}
    total = sum(raum.values())
    if total <= 0:
        return (funds, f"no assets by client; {nums}") if funds else None
    share = {
        "pooled": sum(raum[k] for k in POOLED) / total,
        "retail": sum(raum[k] for k in RETAIL) / total,
        "funds": sum(raum[k] for k in FUNDS) / total,
        "inst": sum(raum[k] for k in INSTITUTIONS) / total,
    }
    top = max(share, key=lambda k: share[k])
    basis = f"pooled {share['pooled']:.0%}, individuals {share['retail']:.0%}, mutual funds {share['funds']:.0%}, institutions {share['inst']:.0%}; {nums}"
    if top == "pooled":
        # pooled vehicles that are no private funds: foreign mutual funds (Mackenzie, Nomura)
        return funds or "am.mutual", basis
    return {"retail": "am.wealth", "funds": "am.mutual", "inst": "am.inst"}[top], basis


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--funds", help="a funds.json to read instead of the published one")
    args = ap.parse_args()
    contact = os.environ.get("ORCA_CONTACT")
    if not contact:
        sys.exit("ORCA_CONTACT is not set: SEC requires a contact in the User-Agent")
    funds = json.loads(Path(args.funds).read_text() if args.funds else get(FUNDS_URL, contact))
    rows = register_rows(contact)
    by_cik: dict[int, dict] = {}
    by_name: dict[str, dict[str, dict]] = {}
    for r in rows:
        for c in re.split(r"[,; ]+", r.get("CIK#", "")):
            if c.isdigit():
                by_cik.setdefault(int(c), r)
        for col in ("Primary Business Name", "Legal Name"):
            if r.get(col):
                by_name.setdefault(norm(r[col]), {})[r["Organization CRD#"]] = r
    out, how = [], {"cik": 0, "name": 0, "untyped": 0}
    for fund_id, name in zip(funds["id"], funds["name"]):
        r, via = by_cik.get(fund_id), "cik"
        if r is None:
            named = by_name.get(norm(name), {})
            r, via = (next(iter(named.values())), "name") if len(named) == 1 else (None, "")
        if r is None:
            continue
        typed = adviser_type(r)
        if typed is None:
            how["untyped"] += 1
            continue
        how[via] += 1
        kind, basis = typed
        out.append({"fund_id": fund_id, "type": kind, "basis": f"CRD {r['Organization CRD#']} by {via}: {basis}", "name": name})
    out.sort(key=lambda o: o["fund_id"])
    with open(OUT, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["fund_id", "type", "basis", "name"], lineterminator="\n")
        w.writeheader()
        w.writerows(out)
    print(f"{len(out)} filers typed ({how}); wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
