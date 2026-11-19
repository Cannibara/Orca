"""Fetch a free-licensed photo of the person behind each famous fund into web/src/assets/people/.

Run by hand (not in the pipeline), from the repo root or pipeline/:

    cd pipeline && uv run --with pillow --with opencv-python-headless==4.10.0.84 python scripts/fetch_people_images.py            # new people only
    cd pipeline && uv run --with pillow --with opencv-python-headless==4.10.0.84 python scripts/fetch_people_images.py --refresh  # re-fetch all

Source: the photo on the person's Wikipedia page (or their Wikidata image) when it lives on Wikimedia
Commons under Public domain, CC0, CC BY or CC BY-SA. Fair-use and non-commercial files are skipped.
It writes into web/src/assets/people/:
  <slug>.jpg      a 192 px square around the face (OpenCV finds it), one per person
  people.json     the manager text shown under a fund name -> slug (a person with several filers shares one)
  credits.json    slug -> photographer, licence and the Commons page (the site's Photo credits page)
A person who already has a <slug>.jpg is skipped (so a photo you swapped in by hand survives), unless
--refresh. A person with no free photo is listed at the end and simply shows no picture on the site.
Wikimedia rate-limits (HTTP 429): the script waits and retries, so a full run takes a few minutes."""

import csv
import html
import io
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
FAMOUS = ROOT / "pipeline" / "orca" / "famous.csv"
OUT = ROOT / "web" / "src" / "assets" / "people"
UA = "OrcaPeopleImages/1.0 (https://www.orcaetf.com; one-off image sourcing script)"
SIZE = 192

# The text under a fund name -> the person to look up, where taking the first name in it is not enough.
PERSON = {
    "Felix & Julian Baker": "Julian Baker",
    "Bill Gates (Cascade)": "Bill Gates",
    "Neil Shen (founder of HongShan / Sequoia China)": "Neil Shen",
    "Thrive Capital (Josh Kushner)": "Josh Kushner",
    "8VC (Joe Lonsdale)": "Joe Lonsdale",
    "Social Capital (Chamath Palihapitiya)": "Chamath Palihapitiya",
    "DST Global (Yuri Milner)": "Yuri Milner",
    "DST Global (Yuri Milner), early entity": "Yuri Milner",
    "DST Global / Yuri Milner trust vehicle": "Yuri Milner",
    "BOND (Mary Meeker)": "Mary Meeker",
    "Phil Town (Rule #1)": "Phil Town",
}
# A Wikipedia page title where the plain name is another person or a disambiguation page.
TITLE = {}
OK_LICENCE = re.compile(r"^(public domain|pd\b|pd-|cc0|cc[- ]by\b|cc[- ]by-sa|no restrictions|attribution)", re.I)
BAD_LICENCE = re.compile(r"\b(nc|nd|fair use|non-free|gfdl)\b", re.I)
JOB = re.compile(
    r"investor|businessman|businesswoman|business magnate|financier|entrepreneur|billionaire|economist|"
    r"trader|banker|philanthropist|executive|manager|venture capitalist|capitalist|mathematician|"
    r"analyst|speculator|chairman|activist|hedge fund|private equity|professor|programmer|computer scientist",
    re.I,
)
NOT_PERSON = re.compile(r"\b(firm|company|corporation|conglomerate|sovereign|pension|organi[sz]ation)\b", re.I)


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def person_of(manager: str) -> str:
    """The one person to look up for a manager text ("Paul Black / Mike Trigg" -> "Paul Black")."""
    if manager in PERSON:
        return PERSON[manager]
    s = re.sub(r"\s*\(.*?\)", "", manager)
    s = re.split(r"\s*(?:/|&| and )\s*", s)[0]
    return s.strip()


client = httpx.Client(headers={"User-Agent": UA}, timeout=60, follow_redirects=True)


def get(url: str, **params) -> httpx.Response:
    """GET, waiting out Wikimedia's rate limit (429): a shared network can be blocked for minutes."""
    for attempt in range(30):
        r = client.get(url, params=params)
        if r.status_code in (429, 503):
            wait = min(120, max(10, int(r.headers.get("retry-after", 5))) + attempt * 10)
            print(f"  {r.status_code} from {url.split('/')[2]}, waiting {wait}s", flush=True)
            time.sleep(wait)
            continue
        r.raise_for_status()
        time.sleep(1.5)
        return r
    raise RuntimeError(f"gave up on {url}")


def batches(items: list, n: int = 40):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def api(host: str, **params) -> dict:
    base = dict(action="query", format="json", formatversion="2")
    base.update(params)
    return get(f"https://{host}/w/api.php", **base).json()


def lead_images(names: list[str]) -> dict[str, dict]:
    """name -> {file, qid, desc} from each name's English Wikipedia page (redirects followed)."""
    found: dict[str, dict] = {}
    for chunk in batches(names):
        titles = [TITLE.get(n, n) for n in chunk]
        d = api(
            "en.wikipedia.org",
            titles="|".join(titles),
            redirects=1,
            prop="pageimages|pageprops|description",
            piprop="name",
            ppprop="wikibase_item|disambiguation",
        )["query"]
        alias = {}
        for key in ("normalized", "redirects"):
            for m in d.get(key, []):
                alias[m["from"]] = m["to"]
        pages = {p["title"]: p for p in d["pages"]}
        for n, t in zip(chunk, titles):
            seen = t
            while seen in alias:
                seen = alias[seen]
            p = pages.get(seen)
            if not p or p.get("missing") or "disambiguation" in p.get("pageprops", {}):
                continue
            found[n] = dict(
                file=p.get("pageimage"),
                qid=p.get("pageprops", {}).get("wikibase_item"),
                desc=p.get("description", ""),
                page=p["title"],
            )
    return found


def claims_of(qid: str) -> dict:
    d = get("https://www.wikidata.org/w/api.php", action="wbgetentities", ids=qid, props="claims", format="json").json()
    return d.get("entities", {}).get(qid, {}).get("claims", {})


def values(claims: dict, prop: str) -> list:
    out = []
    for c in claims.get(prop, []):
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v:
            out.append(v)
    return out


def parse_info(p: dict) -> dict | None:
    """A Commons page's photo, licence and credit, or None when it is not a photo we may use."""
    info = (p.get("imageinfo") or [None])[0]
    if not info or info.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
        return None
    md = info.get("extmetadata", {})
    val = lambda k: html.unescape(re.sub(r"<[^>]+>", "", md.get(k, {}).get("value", ""))).strip()
    licence = val("LicenseShortName")
    if not licence or not OK_LICENCE.search(licence) or BAD_LICENCE.search(licence):
        return None
    if md.get("NonFree", {}).get("value", "").lower() in ("true", "1"):
        return None
    return dict(
        file=p["title"].removeprefix("File:").replace(" ", "_"),
        thumb=info["thumburl"],
        page=info["descriptionurl"],
        author=val("Artist") or val("Credit") or "Wikimedia Commons contributor",
        licence=licence,
        licence_url=val("LicenseUrl"),
    )


INFO = dict(prop="imageinfo", iiprop="url|mime|extmetadata", iiurlwidth=900)


def commons_info(files: list[str]) -> dict[str, dict]:
    """file name -> photo info, only for files on Commons with a usable licence."""
    out: dict[str, dict] = {}
    for chunk in batches(files):
        d = api("commons.wikimedia.org", titles="|".join("File:" + f for f in chunk), **INFO)["query"]
        for p in d["pages"]:
            i = parse_info(p)
            if i:
                out[i["file"]] = i
    return out


def category_files(cat: str) -> list[dict]:
    """Usable photos in a Commons category (a person's own category holds photos of them)."""
    try:
        d = api(
            "commons.wikimedia.org",
            generator="categorymembers",
            gcmtitle="Category:" + cat,
            gcmtype="file",
            gcmlimit=40,
            **INFO,
        ).get("query", {})
    except httpx.HTTPError:
        return []
    return [i for i in map(parse_info, d.get("pages", [])) if i]


def faces(im: Image.Image) -> list:
    """Frontal faces in the picture as (x, y, w, h), biggest first. Raises ImportError without OpenCV."""
    import cv2
    import numpy as np

    grey = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2GRAY)
    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    found = det.detectMultiScale(grey, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40))
    return sorted((tuple(int(v) for v in f) for f in found), key=lambda f: -f[2] * f[3])


def square(raw: bytes) -> tuple[bytes | None, str]:
    """(JPEG, "") of a SIZE px square around the one face in the picture, or (None, why not).
    Without OpenCV: a crop toward the top of the picture."""
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    try:
        found = faces(im)
    except ImportError:
        found = None
    if found is None:
        side = min(w, h)
        x0, y0 = (w - side) // 2, int((h - side) * 0.15)
    else:
        if not found:
            return None, "no face found"  # a guess would crop to clothing or a wall
        x, y, fw, fh = found[0]
        if len(found) > 1 and found[1][2] * found[1][3] * 2.5 > fw * fh:
            return None, "several faces (a group)"
        side = min(int(fw * 2.4), w, h)
        if side < 130:
            return None, "face too small"
        x0 = min(max(x + fw // 2 - side // 2, 0), w - side)
        y0 = min(max(y + fh // 2 - int(side * 0.45), 0), h - side)
    im = im.crop((x0, y0, x0 + side, y0 + side)).resize((SIZE, SIZE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=84, optimize=True, progressive=True)
    return buf.getvalue(), ""


def candidates(n: str, page: dict, claims: dict):
    """Photos to try for a person, best first: Wikipedia's lead image, Wikidata's image, then their Commons category."""
    seen = set()
    first = [f for f in [page.get("file")] + [v for v in values(claims, "P18")] if f]
    files = [f.replace(" ", "_") for f in first]
    for i in commons_info(files).values():
        seen.add(i["file"])
        yield i
    surname = n.split()[-1].lower()
    for cat in values(claims, "P373"):
        # Only files named after them: a category also holds crowd shots and other people, and a
        # wrong face is worse than none.
        yield from (i for i in category_files(cat) if i["file"] not in seen and surname in i["file"].lower())


def save(credits: dict) -> None:
    """Write credits.json and people.json from the photos now in the folder."""
    managers = sorted({r["manager"].strip() for r in csv.DictReader(FAMOUS.open(encoding="utf-8")) if r["manager"].strip()})
    mapping = {m: slugify(person_of(m)) for m in managers if (OUT / f"{slugify(person_of(m))}.jpg").exists()}
    (OUT / "people.json").write_text(json.dumps(dict(sorted(mapping.items())), indent=1, ensure_ascii=False) + "\n")
    (OUT / "credits.json").write_text(json.dumps(dict(sorted(credits.items())), indent=1, ensure_ascii=False) + "\n")


MAX_TRIES = 8  # downloads per person before giving up


def main() -> None:
    refresh = "--refresh" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    managers = sorted({r["manager"].strip() for r in csv.DictReader(FAMOUS.open(encoding="utf-8")) if r["manager"].strip()})
    who = {m: person_of(m) for m in managers}
    names = sorted(set(who.values()))
    credits_path = OUT / "credits.json"
    credits = json.loads(credits_path.read_text()) if credits_path.exists() else {}
    todo = [n for n in names if refresh or not (OUT / f"{slugify(n)}.jpg").exists()]
    print(f"{len(managers)} manager texts, {len(names)} people, {len(todo)} to look up", flush=True)

    pages = lead_images(todo)
    why: dict[str, str] = {}
    got = 0
    for n in todo:
        p = pages.get(n)
        if not p:
            why[n] = "no Wikipedia page (or a disambiguation page)"
            continue
        if not p["qid"]:
            why[n] = "page has no Wikidata item"
            continue
        claims = claims_of(p["qid"])
        if not any(v.get("id") == "Q5" for v in values(claims, "P31")):
            why[n] = f"not a person on Wikidata ({p['desc']})"
            continue
        if not JOB.search(p["desc"]) or NOT_PERSON.search(p["desc"]):
            why[n] = f"description does not look like an investor ({p['desc']})"
            continue
        tried, reasons = 0, []
        for i in candidates(n, p, claims):
            if tried >= MAX_TRIES:
                break
            tried += 1
            jpg, no = square(get(i["thumb"]).content)
            if jpg is None:
                reasons.append(no)
                continue
            slug = slugify(n)
            (OUT / f"{slug}.jpg").write_bytes(jpg)
            credits[slug] = dict(
                name=n,
                author=i["author"][:200],
                licence=i["licence"],
                licence_url=i["licence_url"],
                source=i["page"],
            )
            got += 1
            print("ok  ", n, "|", i["licence"], "|", i["file"], flush=True)
            save(credits)  # after every photo: a stopped run keeps what it fetched
            break
        if not (OUT / f"{slugify(n)}.jpg").exists():
            why[n] = f"no usable photo (tried {tried}: {', '.join(sorted(set(reasons))) or 'none with a free licence'})"

    save(credits)
    print(f"\n{got} photos saved, {len(why)} people without one")
    for n, w in sorted(why.items()):
        print("WHY ", n, "-", w)


if __name__ == "__main__":
    main()
