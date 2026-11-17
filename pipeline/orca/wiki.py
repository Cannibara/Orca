"""Wikipedia page views: how often people look up a famous fund and its manager, the stand-in for
"most searched" (Google Trends has no API; Wikipedia's is free, documented and stable).
https://www.mediawiki.org/wiki/Extension:PageViewInfo — `prop=pageviews` gives daily views of
up to 50 titles a request for the last `pvipdays` days (at most 60)."""

import logging
import os

import polars as pl

from orca.http import Client
from orca.storage import Lake

API = "https://en.wikipedia.org/w/api.php"
DAYS = 60  # the most the API gives; views are averaged to a 30-day month
BATCH = 50  # titles a request (the API's limit)
WIKI_RATE_PER_SEC = 1.0  # polite: a run makes about ten requests
VIEWS_TABLE = "famous_views"
VIEWS_SCHEMA = pl.Schema({"title": pl.String, "views": pl.Int64})

log = logging.getLogger(__name__)


def wiki_client() -> Client:
    """Client for Wikipedia's API. Wikimedia asks for a User-Agent with a contact
    (ORCA_CONTACT, as for the SEC); without one it throttles requests."""
    contact = os.environ.get("ORCA_CONTACT", "").strip() or "no contact set"
    return Client(WIKI_RATE_PER_SEC, {"User-Agent": f"Orca research ({contact})"})


def fetch_pageviews(client: Client, titles: list[str]) -> dict[str, int]:
    """Monthly page views (the last DAYS days, scaled to 30) of each title, keyed by the title as
    asked. A redirect counts its target's views; a missing page counts 0."""
    out: dict[str, int] = {}
    unique = sorted(set(titles))
    for i in range(0, len(unique), BATCH):
        batch = unique[i : i + BATCH]
        totals: dict[str, int] = {}
        params = {
            "action": "query",
            "titles": "|".join(batch),
            "redirects": 1,
            "prop": "pageviews",
            "pvipdays": DAYS,
            "format": "json",
            "formatversion": 2,
        }
        while True:  # the API may split the views of a batch over several answers
            body = client.get(API, **params).json()
            query = body.get("query", {})
            for page in query.get("pages", []):
                views = page.get("pageviews") or {}
                seen = sum(v or 0 for v in views.values())
                totals[page["title"]] = totals.get(page["title"], 0) + seen
            more = body.get("continue")
            if not more:
                break
            params.update(more)
        hops = {x["from"]: x["to"] for x in query.get("normalized", [])}
        hops.update({x["from"]: x["to"] for x in query.get("redirects", [])})
        for title in batch:
            target = title
            for _ in range(3):  # normalised, then redirected
                target = hops.get(target, target)
            out[title] = round(totals.get(target, 0) * 30 / DAYS)
    return out


def famous_views(lake: Lake, titles: list[str], fetch) -> dict[str, int]:
    """Page views of `titles` from `fetch` (None: no fetching, as in a home-only run), kept in
    the lake; when fetching fails or is not asked for, the views the last run kept, so a
    Wikipedia outage leaves the Most searched list as it was rather than empty."""
    if fetch is not None and titles:
        try:
            views = fetch(titles)
            frame = pl.DataFrame(list(views.items()), schema=VIEWS_SCHEMA, orient="row")
            lake.write(VIEWS_TABLE, frame)
            return views
        except Exception as e:  # noqa: BLE001 — any failure falls back to the stored views
            log.warning("wikipedia page views: %s; using the last run's", e)
    from orca.run.state import read_table

    return dict(read_table(lake, VIEWS_TABLE, VIEWS_SCHEMA).iter_rows())
