from orca.famous import FAMOUS_GROUPS, Famous, load_famous, load_search
from orca.home import top_funds
from test_home import perf, snap


def test_most_searched_scores_count_one_filer_per_keyword():
    old = snap(1, "SEQUOIA OLD FUND", book=1e8, excluded=True, period_q=40)
    big = snap(2, "SEQUOIA GROWTH", book=5e9)
    small = snap(3, "SEQUOIA SMALL", book=1e9)
    lone = snap(4, "SCION ASSET", perf={"3y": perf(ann_return=0.5)})
    quiet = snap(5, "QUIET CAPITAL")
    famous = [
        Famous(1, "SEQUOIA", "", "Venture capital", "Sequoia Capital"),
        Famous(2, "SEQUOIA", "", "Venture capital", "Sequoia Capital"),
        Famous(3, "SEQUOIA", "", "Venture capital", "Sequoia Capital"),
        Famous(4, "SCION", "Michael Burry", "Value", "Michael Burry"),
        Famous(4, "SCION", "Michael Burry", "Big companies", "Michael Burry"),
        Famous(5, "QUIET", "", "Value", "Nobody Searched"),  # no score: no place in the list
    ]
    scores = {"Sequoia Capital": 9.5, "Michael Burry": 27.25}
    rows = top_funds([old, big, small, lone, quiet], "3y", famous, scores)["famous"]
    got = {(r["fund_id"], r["group"]): r["search"] for r in rows}
    assert got == {
        (1, "Venture capital"): None,  # stopped filing: the active filer with the biggest book counts
        (2, "Venture capital"): 9.5,
        (3, "Venture capital"): None,
        (4, "Value"): 27.25,  # a fund in two lists has its score on both rows
        (4, "Big companies"): 27.25,
        (5, "Value"): None,
    }
    # `fame` is the keyword's score on every row of it, for ordering each list by popularity
    assert {(r["fund_id"], r["group"]): r["fame"] for r in rows} == {
        (1, "Venture capital"): 9.5,
        (2, "Venture capital"): 9.5,
        (3, "Venture capital"): 9.5,
        (4, "Value"): 27.25,
        (4, "Big companies"): 27.25,
        (5, "Value"): None,
    }
    assert all(r["search"] is None and r["fame"] is None for r in top_funds([big, lone], "3y", famous)["famous"])


def test_load_search_reads_scores_and_the_snapshot_date(tmp_path):
    path = tmp_path / "famous_search.csv"
    assert load_search(path).scores == {} and load_search(path).asof is None  # no file yet
    path.write_text(
        "keyword,topic,topic_name,score,asof\n"
        "Warren Buffett,/m/01d_z,Warren Buffett (Investor),100.00,2026-11-17\n"
        "Bill Nygren,,,,\n"
        "Michael Burry,/m/0bvvzh,Michael Burry (Investor),27.25,2026-11-17\n"
    )
    got = load_search(path)
    assert got.asof == "2026-11-17"
    assert got.scores == {"Warren Buffett": 100.0, "Michael Burry": 27.25}


def test_famous_csv_search_keywords():
    famous = load_famous()
    assert set(FAMOUS_GROUPS) == {f.group for f in famous}
    assert sum(bool(f.search) for f in famous) >= 150
    # company names are searched for the company, not its investing: Big companies are not ranked
    assert not any(f.search for f in famous if f.group == "Big companies")
    # nor state funds: members check their pensions, markets watch central banks
    assert not any(f.search for f in famous if f.group == "Sovereign & pension funds")
    for f in famous:
        assert f.search == f.search.strip()
