"""Share-count history from the SEC cover-page concept (`orca/shares_hist.py`)."""

from datetime import date

import polars as pl

from orca import shares_hist


def fact(val, end, filed, accn="a", form="10-Q", fp="Q1"):
    return {"val": val, "end": end, "filed": filed, "accn": accn, "form": form, "fp": fp}


def test_each_period_end_takes_the_newest_filing_and_sums_share_classes():
    body = {"units": {"shares": [
        fact(100, "2020-03-31", "2020-05-01", "a1"),
        fact(30, "2020-03-31", "2020-05-01", "a1", fp="Q1"),  # a second share class in the same filing
        fact(30, "2020-03-31", "2020-05-01", "a1", fp="Q1"),  # an exact repeat of it
        fact(90, "2020-06-30", "2020-08-01", "a2"),
        fact(95, "2020-06-30", "2020-09-01", "a3"),  # an amendment filed later wins
        {"val": None, "end": "2020-09-30", "filed": "2020-11-01"},
    ]}}  # fmt: skip
    assert shares_hist.history(body) == [(date(2020, 3, 31), date(2020, 5, 1), 130.0), (date(2020, 6, 30), date(2020, 9, 1), 95.0)]


def test_no_concept_or_an_unknown_company_gives_no_history():
    assert shares_hist.history(None) == [] and shares_hist.history({"units": {}}) == []


def test_the_count_on_a_date_is_the_latest_one_filed_by_then():
    table = pl.DataFrame(
        {"stock_id": [1, 1, 2], "end": [date(2020, 3, 31), date(2020, 6, 30), date(2020, 3, 31)],
         "filed": [date(2020, 5, 1), date(2020, 8, 1), date(2020, 5, 1)], "shares": [100.0, 90.0, 50.0]},
        schema=shares_hist.SCHEMA,
    )  # fmt: skip
    asof = shares_hist.shares_asof(table, [date(2020, 4, 30), date(2020, 6, 30), date(2020, 9, 30)])
    got = {(r["stock_id"], r["asof"]): r["shares"] for r in asof.iter_rows(named=True)}
    assert got == {(1, date(2020, 6, 30)): 100.0, (1, date(2020, 9, 30)): 90.0, (2, date(2020, 6, 30)): 50.0, (2, date(2020, 9, 30)): 50.0}
    # nothing was filed by 2020-04-30, so that date has no count


def test_an_adr_ratio_turns_ordinary_shares_into_adrs():
    ratios = shares_hist.load_overrides()
    assert ratios["TSM"] == 5.0  # one ADR is five ordinary shares
    assert shares_hist.adr_shares(500.0, "TSM", ratios) == 100.0
    assert shares_hist.adr_shares(500.0, "AAPL", ratios) == 500.0


def test_null_rows_mark_a_company_with_no_count_and_are_skipped_on_lookup():
    table = pl.DataFrame({"stock_id": [3], "end": [date(2020, 1, 1)], "filed": [date(2020, 1, 1)], "shares": [None]}, schema=shares_hist.SCHEMA)
    assert shares_hist.shares_asof(table, [date(2021, 1, 1)]).height == 0


def test_the_fetch_step_asks_once_per_company_missing_ones_first_and_stops_at_its_cap(tmp_path):
    from orca.http import FetchError
    from orca.run.budget import Budget
    from orca.run.sectors_step import update_share_history
    from orca.storage import Lake

    lake = Lake(tmp_path / "lake")
    securities = pl.DataFrame({"stock_id": [1, 2, 3, 4, 5], "cik": [10, 10, 20, 30, None], "sector": ["Tech", "Tech", "Tech", "ETF/Fund", "Tech"]})
    asked = []

    def fetch(cik):
        asked.append(cik)
        if cik == 20:
            raise FetchError("u", 500)
        return [(date(2020, 3, 31), date(2020, 5, 1), 100.0)]

    flags: list = []
    stats = update_share_history(lake, fetch, securities, flags, Budget(60), today=date(2020, 6, 1), max_calls=10)
    assert asked == [10, 20]  # one call for both classes of company 10; no ETF, no CIK
    table = lake.read("shares_hist")
    assert sorted(table["stock_id"].to_list()) == [1, 2] and stats["companies"] == 1
    assert flags == [{"type": "shares_lookup_failed", "count": 1}]

    asked.clear()
    update_share_history(lake, fetch, securities, [], Budget(60), today=date(2020, 6, 2), max_calls=1)
    assert asked == [20]  # company 10 is fresh; the failed one is retried
