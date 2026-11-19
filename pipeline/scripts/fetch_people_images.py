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
--wikidata also tries each missing person's Wikidata image (slow: one request each).
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
BORN = re.compile(r"\((?:born |c\. )?\d{4}")  # "(born 1930)", "(1923–2023)": a person, not a firm
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


def wikidata_image(qid: str) -> str | None:
    d = get("https://www.wikidata.org/w/api.php", action="wbgetclaims", entity=qid, property="P18", format="json").json()
    for c in d.get("claims", {}).get("P18", []):
        v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
        if v:
            return v
    return None


def commons_info(files: list[str]) -> dict[str, dict]:
    """file name -> licence and thumbnail, only for files that are on Commons with a usable licence."""
    out: dict[str, dict] = {}
    for chunk in batches(files):
        d = api(
            "commons.wikimedia.org",
            titles="|".join("File:" + f for f in chunk),
            prop="imageinfo",
            iiprop="url|extmetadata",
            iiurlwidth=900,
        )["query"]
        alias = {m["from"]: m["to"] for m in d.get("normalized", [])}
        for p in d["pages"]:
            info = (p.get("imageinfo") or [None])[0]
            if not info:
                continue
            md = info.get("extmetadata", {})
            val = lambda k: html.unescape(re.sub(r"<[^>]+>", "", md.get(k, {}).get("value", ""))).strip()
            licence = val("LicenseShortName")
            if not licence or not OK_LICENCE.search(licence) or BAD_LICENCE.search(licence):
                continue
            if md.get("NonFree", {}).get("value", "").lower() in ("true", "1"):
                continue
            out[p["title"].removeprefix("File:")] = dict(
                thumb=info["thumburl"],
                page=info["descriptionurl"],
                author=val("Artist") or val("Credit") or "Wikimedia Commons contributor",
                licence=licence,
                licence_url=val("LicenseUrl"),
            )
    return out


def face_box(im: Image.Image):
    """The biggest frontal face in the picture as (x, y, w, h), or None when there is none.
    Raises ImportError without OpenCV."""
    import cv2
    import numpy as np

    grey = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2GRAY)
    det = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = det.detectMultiScale(grey, scaleFactor=1.1, minNeighbors=6, minSize=(40, 40))
    return max(faces, key=lambda f: f[2] * f[3]) if len(faces) else None


def square(raw: bytes) -> bytes | None:
    """A square around the face, SIZE px (toward the top of the picture when OpenCV is not installed).
    None when no face is found, or it is too small in the picture to stay sharp."""
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    try:
        f = face_box(im)
        if f is None:
            return None  # a guess would crop to clothing or a wall: no photo beats a wrong crop
    except ImportError:
        f = None  # no OpenCV: crop toward the top of the picture instead
    if f is not None:
        x, y, fw, fh = (int(v) for v in f)
        side = min(int(fw * 2.4), w, h)
        if side < 130:
            return None
        x0 = min(max(x + fw // 2 - side // 2, 0), w - side)
        y0 = min(max(y + fh // 2 - int(side * 0.45), 0), h - side)
    else:
        side = min(w, h)
        x0, y0 = (w - side) // 2, int((h - side) * 0.15)
    im = im.crop((x0, y0, x0 + side, y0 + side)).resize((SIZE, SIZE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=84, optimize=True, progressive=True)
    return buf.getvalue()


def save(credits: dict) -> None:
    """Write credits.json and people.json from the photos now in the folder."""
    managers = sorted({r["manager"].strip() for r in csv.DictReader(FAMOUS.open(encoding="utf-8")) if r["manager"].strip()})
    mapping = {m: slugify(person_of(m)) for m in managers if (OUT / f"{slugify(person_of(m))}.jpg").exists()}
    (OUT / "people.json").write_text(json.dumps(dict(sorted(mapping.items())), indent=1, ensure_ascii=False) + "\n")
    (OUT / "credits.json").write_text(json.dumps(dict(sorted(credits.items())), indent=1, ensure_ascii=False) + "\n")


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
    people = {n: p for n, p in pages.items() if JOB.search(p["desc"]) and BORN.search(p["desc"]) and not NOT_PERSON.search(p["desc"])}
    rejected = sorted(n for n in pages if n not in people)
    want = {n: p["file"] for n, p in people.items() if p["file"]}
    info = commons_info(sorted(set(want.values())))
    # no usable lead image (non-free on Wikipedia, or none): try the Wikidata image instead
    # (one slow request per person, so only with --wikidata)
    retry = {}
    if "--wikidata" in sys.argv:
        retry = {n: wikidata_image(p["qid"]) for n, p in people.items() if p["qid"] and want.get(n) not in info}
        retry = {n: f for n, f in retry.items() if f}
    info.update(commons_info(sorted({f.replace(" ", "_") for f in retry.values()} | {f for f in retry.values()})))
    for n, f in retry.items():
        want[n] = f

    got, miss = [], []
    for n in todo:
        f = want.get(n)
        i = info.get(f) or info.get((f or "").replace(" ", "_")) or info.get((f or "").replace("_", " "))
        if not i:
            miss.append(n)
            continue
        slug = slugify(n)
        jpg = square(get(i["thumb"]).content)
        if jpg is None:
            miss.append(n)
            continue
        (OUT / f"{slug}.jpg").write_bytes(jpg)
        credits[slug] = dict(
            name=n,
            author=i["author"][:200],
            licence=i["licence"],
            licence_url=i["licence_url"],
            source=i["page"],
        )
        got.append(n)
        print("ok  ", n, "|", i["licence"], flush=True)
        save(credits)  # after every photo: a stopped run keeps what it fetched

    save(credits)
    print(f"\n{len(got)} photos saved, {len(miss)} people without a free photo or page")
    print("NOT A PERSON / OFF-TOPIC PAGE (check; add to TITLE if it is the wrong page):", ", ".join(rejected))
    print("NO FREE PHOTO:", ", ".join(m for m in miss if m not in rejected))


if __name__ == "__main__":
    main()
