import httpx
import pytest

from orca.home import top_funds
from orca.famous import Famous
from orca.http import Client
from orca.storage import Lake
from orca.wiki import BATCH, famous_views, fetch_pageviews
from test_home import perf, snap


def client(handler) -> Client:
    return Client(1000.0, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None)


def test_fetch_pageviews_follows_redirects_continuation_and_batches():
    asked = []

    def handler(request: httpx.Request) -> httpx.Response:
        titles = request.url.params["titles"].split("|")
        asked.append(len(titles))
        if "Coatue" in titles and "pvipcontinue" not in request.url.params:
            # first answer: a redirect and part of the views
            return httpx.Response(200, json={
                "continue": {"pvipcontinue": "x", "continue": "||"},
                "query": {
                    "redirects": [{"from": "Coatue", "to": "Coatue Management"}],
                    "pages": [
                        {"title": "Coatue Management", "pageviews": {"2026-10-01": 100, "2026-10-02": None}},
                    ],
                },
            })
        if "Coatue" in titles:
            return httpx.Response(200, json={"query": {
                "redirects": [{"from": "Coatue", "to": "Coatue Management"}],
                "pages": [{"title": "Coatue Management", "pageviews": {"2026-10-03": 20}}],
            }})
        pages = [
            {"title": t, "missing": True} if t == "No Such Page" else {"title": t, "pageviews": {"d": 60}}
            for t in titles
        ]
        return httpx.Response(200, json={"query": {"pages": pages}})

    titles = ["Coatue", "No Such Page"] + [f"Fund {i:03d}" for i in range(BATCH)]
    views = fetch_pageviews(client(handler), titles)
    assert views["Coatue"] == 60  # 120 over 60 days, scaled to 30
    assert views["No Such Page"] == 0
    assert views["Fund 049"] == 30  # the second batch
    assert sorted(asked) == [2, 50, 50]  # 52 titles: two batches, the first answered in two parts


def test_famous_views_keeps_the_last_good_views_when_fetching_fails(tmp_path):
    lake = Lake(tmp_path)
    assert famous_views(lake, ["A"], None) == {}
    assert famous_views(lake, ["A", "B"], lambda titles: {"A": 5, "B": 0}) == {"A": 5, "B": 0}

    def broken(titles):
        raise RuntimeError("wikipedia is down")

    assert famous_views(lake, ["A", "B"], broken) == {"A": 5, "B": 0}
    assert famous_views(lake, ["A", "B"], None) == {"A": 5, "B": 0}  # a home-only run


def test_most_searched_views_count_one_filer_per_set_of_titles():
    old = snap(1, "SEQUOIA OLD FUND", book=1e8, excluded=True, period_q=40)
    big = snap(2, "SEQUOIA GROWTH", book=5e9)
    small = snap(3, "SEQUOIA SMALL", book=1e9)
    lone = snap(4, "SCION ASSET", perf={"3y": perf(ann_return=0.5)})
    quiet = snap(5, "QUIET CAPITAL")
    seq = ("Sequoia Capital",)
    famous = [
        Famous(1, "SEQUOIA", "", "Venture capital", seq),
        Famous(2, "SEQUOIA", "", "Venture capital", seq),
        Famous(3, "SEQUOIA", "", "Venture capital", seq),
        Famous(4, "SCION", "Michael Burry", "Value", ("Scion Asset Management", "Michael Burry")),
        Famous(4, "SCION", "Michael Burry", "Big companies", ("Scion Asset Management", "Michael Burry")),
        Famous(5, "QUIET", "", "Value", ("Quiet Capital",)),  # no views: no place in the list
    ]
    views = {"Sequoia Capital": 900, "Scion Asset Management": 100, "Michael Burry": 50_000}
    rows = top_funds([old, big, small, lone, quiet], "3y", famous, views)["famous"]
    got = {(r["fund_id"], r["group"]): r["views"] for r in rows}
    assert got == {
        (1, "Venture capital"): None,  # stopped filing: the active filer with the biggest book counts
        (2, "Venture capital"): 900,
        (3, "Venture capital"): None,
        (4, "Value"): 50_100,  # a fund in two lists has its views on both rows
        (4, "Big companies"): 50_100,
        (5, "Value"): None,
    }
    assert all(r["views"] is None for r in top_funds([big, lone], "3y", famous)["famous"])


def test_famous_csv_wiki_titles_are_canonical_looking():
    from orca.famous import load_famous

    for f in load_famous():
        for t in f.wiki:
            assert t == t.strip() and "_" not in t and t[:1].isupper(), (f.fund_id, t)
