"""The pre-2013 history end to end: legacy filings read by `run_backfill`, joined to the XML era's,
computed and published with negative quarter indexes; companies gone since; older prices."""

import json
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

import httpx
import polars as pl

from orca import prices
from orca.demo import Filing, Fixtures, Holding, bulk_zip, fixture_sources, listing, live_frames
from orca.holdings import select_reports
from orca.http import FetchError, FigiClient
from orca.prices import DAILY_SCHEMA, HISTORY_START, FixtureSource
from orca.publish import read_json
from orca.quarters import q_index
from orca.run import run_backfill, run_weekly
from orca.run.budget import Budget
from orca.run.market import backfill_price_heads, held_spans, update_rf
from orca.run.state import State
from orca.sec.legacy import CHECKS_SCHEMA, RAW_COLUMNS, index_quarters
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake

FUND = 1001
WIDGET, GONE = "000000AB5", "24702R101"  # GONE: a company that has died since (valid CUSIPs)
TODAY = date(2013, 11, 20)  # the deadline quarter is Q3 2013 (q 2)
ZIP = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2013q3_form13f.zip"


def business_days(start: date, end: date) -> list[date]:
    days, day = [], start
    while day <= end:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


def flat(close: float, start: date, end: date) -> pl.DataFrame:
    rows = [(d, close, close, close, close, 1e6, 1.0, 0.0) for d in business_days(start, end)]
    return pl.DataFrame(rows, schema=DAILY_SCHEMA, orient="row")


def filing(accession: str, q: int, filed: date, rows: list[Holding]) -> Filing:
    return Filing(accession, FUND, "Test Fund LP", q, filed, rows)


# Q3 2012 to Q1 2013 from the text era (GONE sold in Q1 2013), Q2 and Q3 2013 from the bulk sets.
LEGACY = {
    "2012Q4": filing("0000001001-12-000001", q_index(2012, 3), date(2012, 11, 14), [
        Holding("WIDGET CORP COM", WIDGET, 4_000.0, 100.0),
        Holding("DEADCO INC COM", GONE, 1_000.0, 50.0),
    ]),
    "2013Q1": filing("0000001001-13-000001", q_index(2012, 4), date(2013, 2, 14), [
        Holding("WIDGET CORP COM", WIDGET, 4_000.0, 100.0),
        Holding("DEADCO INC COM", GONE, 1_100.0, 50.0),
    ]),
    "2013Q2": filing("0000001001-13-000002", q_index(2013, 1), date(2013, 5, 14), [
        Holding("WIDGET CORP COM", WIDGET, 4_000.0, 100.0),
    ]),
}
BULK = [
    filing("0000001001-13-000003", q_index(2013, 2), date(2013, 8, 14), [Holding("WIDGET CORP", WIDGET, 4_000.0, 100.0)]),
    filing("0000001001-13-000004", q_index(2013, 3), date(2013, 11, 14), [Holding("WIDGET CORP", WIDGET, 6_000.0, 150.0)]),
]


def legacy_quarter(asked: list):
    """A `Sources.legacy_quarter` serving LEGACY, as `sec.legacy.fetch_quarter` returns it."""

    def fetch(key: str, skip: set[str], stats: dict):
        asked.append(key)
        found = [f for k, f in LEGACY.items() if k == key and f.accession not in skip]
        stats.update(entries=len(found), skipped=0)
        filings = pl.DataFrame(
            [
                {"accession": f.accession, "cik": f.cik, "period": f.period, "filed": f.filed,
                 "form": f.form, "amendment_type": None, "manager_name": f.manager, "source": "legacy"}
                for f in found
            ],
            schema=FILINGS_SCHEMA,
        )
        raw = pl.DataFrame(
            [
                {"accession": f.accession, "cusip": h.cusip, "issuer": h.issuer, "title": None,
                 "shares": h.shares, "sh_type": "SH", "put_call": None, "value_usd": h.value_usd}
                for f in found
                for h in f.rows
            ],
            schema=RAW_COLUMNS,
        )
        checks = pl.DataFrame(
            [
                {"accession": f.accession, "cik": f.cik, "period": f.period, "filed": f.filed,
                 "form": f.form, "status": "ok", "rows": len(f.rows), "invalid_rows": 0}
                for f in found
            ],
            schema=CHECKS_SCHEMA,
        )
        return filings, raw, checks

    return fetch


def figi(listed: dict[str, dict], unlisted: dict[str, dict], jobs: list) -> FigiClient:
    """OpenFIGI: `listed` answers every job, `unlisted` only jobs that include delisted ones."""

    def handler(request: httpx.Request) -> httpx.Response:
        asked = json.loads(request.content)
        jobs.extend(asked)
        body = []
        for job in asked:
            found = listed.get(job["idValue"])
            if found is None and job.get("includeUnlistedEquities"):
                found = unlisted.get(job["idValue"])
            body.append({"data": [found]} if found else {"warning": "No identifier found."})
        return httpx.Response(200, json=body)

    return FigiClient(1e6, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None, jobs_per_request=100)


def sources(asked: list, jobs: list, unlisted_ticker: str = "DEADQ"):
    live_f, live_h = live_frames([])
    fx = Fixtures(
        zips={ZIP: bulk_zip(BULK)},
        live_filings=live_f,
        live_holdings=live_h,
        figi={},
        # Today's namesake of the dead company: a name match would merge the two.
        sec_tickers=pl.DataFrame(
            [("WIDG", 5001, "WIDGET CORP"), ("DEAD", 5002, "DEADCO INC")],
            schema={"ticker": pl.String, "cik": pl.Int64, "title": pl.String},
            orient="row",
        ),
        sic={5001: 3571, 5002: 7372},
        shares_out={5001: 1e9, 5002: 1e8},
        prices={"WIDG": flat(40.0, date(2012, 1, 3), date(2013, 11, 19)), "DEAD": flat(7.0, date(2013, 1, 2), date(2013, 11, 19))},
        tbill={y: 0.01 for y in range(1999, 2014)},
    )
    gone = listing("BBG0GONE0001", unlisted_ticker, "DEADCO INC")
    return replace(
        fixture_sources(fx),
        figi=figi({WIDGET: listing("BBG0TEST0001", "WIDG", "WIDGET CORP")}, {GONE: gone}, jobs),
        legacy_quarter=legacy_quarter(asked),
    )


def test_backfill_then_a_run_publishes_the_history_before_2013(tmp_path):
    asked, jobs = [], []
    src = sources(asked, jobs)
    lake = Lake(tmp_path / "lake")

    done, flags = run_backfill(lake, src, TODAY)

    assert asked == index_quarters()  # every quarter once, oldest first
    state = State.load(lake)
    assert state.legacy_done == set(index_quarters()) and FUND in state.pending_funds
    assert done["quarters"] == len(index_quarters()) and done["stored"] == 3
    assert done["left"] == {"quarters": 0, "price_histories": 0}
    checks = lake.read("legacy_checks")
    assert checks.height == 3 and set(checks["status"]) == {"ok"}
    stored = lake.read("filings", part=f"q{q_index(2012, 3):03d}")
    assert stored["source"].to_list() == ["legacy"]

    # A second backfill has nothing left to read.
    again, _ = run_backfill(lake, src, TODAY)
    assert again.get("quarters") is None and len(asked) == len(index_quarters())
    assert again["left"] == {"quarters": 0, "price_histories": 0}

    stats = run_weekly(lake, tmp_path / "out", src, TODAY)
    summary = read_json(stats.staging / "fund" / str(FUND) / "summary.json")
    assert summary["quarters"]["q"] == [-2, -1, 0, 1, 2]  # Q3 2012 .. Q3 2013, one segment
    assert summary["tracked_since_q"] == -2
    assert summary["quarters"]["ret"][0] is None and all(r is not None for r in summary["quarters"]["ret"][1:])

    # The dead company keeps its own security (not today's namesake), found with delisted ones.
    cusip_map = dict(lake.read("cusip_map").select("cusip", "method").iter_rows())
    assert cusip_map[GONE] == "unlisted"
    securities = lake.read("securities")
    gone = securities.filter(pl.col("figi") == "BBG0GONE0001").row(0, named=True)
    assert gone["ticker"] == "DEADQ" and gone["cik"] is None  # no lookups under today's holder
    assert any(j.get("includeUnlistedEquities") and j["idValue"] == GONE for j in jobs)
    assert not any(j.get("includeUnlistedEquities") and j["idValue"] == WIDGET for j in jobs)
    positions = read_json(stats.staging / "fund" / str(FUND) / "positions.json")
    row = positions["stock_id"].index(gone["stock_id"])  # valued at the reported value per share
    assert (positions["from_q"][row], positions["to_q"][row]) == (-2, 0)


def test_a_dead_companys_vendor_code_is_not_kept_as_a_ticker(tmp_path):
    src = sources([], [], unlisted_ticker="8181760Q")
    lake = Lake(tmp_path / "lake")
    run_backfill(lake, src, TODAY)
    gone = lake.read("securities").filter(pl.col("figi") == "BBG0GONE0001").row(0, named=True)
    assert gone["ticker"] is None


def test_a_throttled_backfill_keeps_what_it_read_and_goes_on_next_time(tmp_path):
    asked: list = []
    fetch = legacy_quarter(asked)

    def throttled(key, skip, stats):
        if key == "2013Q1" and asked.count("2013Q1") == 0:
            asked.append(key)
            raise FetchError("https://www.sec.gov/Archives/x", 429)
        return fetch(key, skip, stats)

    src = replace(sources([], []), legacy_quarter=throttled)
    lake = Lake(tmp_path / "lake")
    done, flags = run_backfill(lake, src, TODAY)
    state = State.load(lake)
    assert "2012Q4" in state.legacy_done and "2013Q1" not in state.legacy_done
    assert any(f["type"] == "legacy_failed" and f["quarter"] == "2013Q1" for f in flags)

    run_backfill(lake, src, TODAY)
    assert State.load(lake).legacy_done == set(index_quarters())


def test_the_budget_reserve_stops_the_backfill_between_quarters(tmp_path):
    asked: list = []
    src = replace(sources([], []), legacy_quarter=legacy_quarter(asked))
    lake = Lake(tmp_path / "lake")
    done, flags = run_backfill(lake, src, TODAY, budget=Budget(10.0))  # under the reserve
    assert asked == [] and State.load(lake).legacy_done == set()
    assert any(f["type"] == "time_budget" and "legacy" in f["stages"] for f in flags)


def test_bulk_beats_live_and_live_beats_legacy_for_one_accession():
    base = {"accession": "A", "cik": 1, "period": 0, "filed": date(2013, 5, 1), "form": "13F-HR",
            "amendment_type": None, "manager_name": "X"}
    filings = pl.DataFrame(
        [{**base, "source": s} for s in ("legacy", "live", "bulk")], schema=FILINGS_SCHEMA
    )
    assert select_reports(filings)["source"].to_list() == ["bulk"]
    assert select_reports(filings.filter(pl.col("source") != "bulk"))["source"].to_list() == ["live"]


# --- older prices -------------------------------------------------------------------------


def lake_with_2013_history(tmp_path: Path) -> Lake:
    """A fund holding WIDGET since Q3 2012, its prices stored from 2013 (the old start)."""
    asked: list = []
    lake = Lake(tmp_path / "lake")
    src = sources(asked, [])
    run_backfill(lake, src, TODAY)
    stocks = dict(lake.read("cusip_map").select("cusip", "stock_id").iter_rows())
    widget = stocks[WIDGET]
    prices.update_prices(
        lake, FixtureSource({"WIDG": flat(40.0, date(2013, 1, 2), date(2013, 11, 19))}), {widget: "WIDG"}, TODAY
    )
    lake.write("vendor_tickers", pl.DataFrame({"stock_id": [widget], "ticker": ["WIDG"], "end": [TODAY]},
                                              schema={"stock_id": pl.Int32, "ticker": pl.String, "end": pl.Date}))
    return lake


class Asking(FixtureSource):
    def __init__(self, frames):
        super().__init__(frames)
        self.asked: list = []

    def daily(self, ticker, start, end):
        self.asked.append((ticker, start, end))
        return super().daily(ticker, start, end)


def test_older_prices_are_fetched_once_for_the_missing_years_only(tmp_path):
    lake = lake_with_2013_history(tmp_path)
    widget = dict(lake.read("cusip_map").select("cusip", "stock_id").iter_rows())[WIDGET]
    source = Asking({"WIDG": flat(40.0, date(2010, 1, 4), date(2013, 11, 19))})
    src = replace(sources([], []), prices=source)
    state = State.load(lake)
    state.pending_stocks.clear()

    got = backfill_price_heads(lake, src, state, "20131120", [], Budget(270.0))

    assert source.asked == [("WIDG", HISTORY_START, date(2013, 1, 1))]  # nothing stored is asked again
    assert got == {"owed": 1, "fetched": 1, "empty": 0, "failed": 0}
    assert prices.first_dates(lake)[widget] == date(2010, 1, 4)
    assert widget in state.pending_stocks and widget in state.pending_weekly
    assert widget in State.load(lake).price_backfilled
    assert backfill_price_heads(lake, src, state, "20131121", [], Budget(270.0)) is None
    assert len(source.asked) == 1


def test_a_stock_held_since_2013_counts_from_2013_for_its_ticker(tmp_path):
    lake = Lake(tmp_path / "lake")
    run_backfill(lake, sources([], []), TODAY)
    run_weekly(lake, tmp_path / "out", sources([], []), TODAY)
    stocks = dict(lake.read("cusip_map").select("cusip", "stock_id").iter_rows())
    spans = held_spans(lake, stocks)
    assert spans[stocks[WIDGET]][0] == date(2013, 1, 1)  # held in 2012 too, but also since 2013
    assert spans[stocks[GONE]] == (date(2012, 7, 1), date(2012, 12, 31))  # only before 2013


def test_a_tbill_table_starting_after_1999_is_fetched_again(tmp_path):
    lake = Lake(tmp_path / "lake")
    lake.write("rf", pl.DataFrame({"year": [2013], "rate": [0.01]}, schema={"year": pl.Int32, "rate": pl.Float64}))
    state = State(last_q=2)
    src = sources([], [])
    update_rf(lake, src, state, 2, False, [])
    assert sorted(lake.read("rf")["year"].to_list()) == list(range(1999, 2014))
    assert state.pending_all


def test_state_keeps_the_backfill_sets(tmp_path):
    lake = Lake(tmp_path)
    State(price_backfilled={3, 1}, legacy_done={"1999Q1"}).save(lake)
    loaded = State.load(lake)
    assert loaded.price_backfilled == {1, 3} and loaded.legacy_done == {"1999Q1"}


def test_a_failed_download_is_tried_once_more_by_the_next_backfill(tmp_path):
    asked: list = []
    fetch = legacy_quarter(asked)
    failing = LEGACY["2013Q1"].accession

    def flaky(key, skip, stats):
        filings, raw, checks = fetch(key, skip, stats)
        if key == "2013Q1" and asked.count("2013Q1") == 1:  # the first read: its download failed
            failed = checks.filter(pl.col("accession") == failing).with_columns(
                status=pl.lit("download_failed")
            )
            return filings.clear(), raw.clear(), failed
        return filings, raw, checks

    src = replace(sources([], []), legacy_quarter=flaky)
    lake = Lake(tmp_path / "lake")
    done, _ = run_backfill(lake, src, TODAY)
    assert State.load(lake).legacy_retry == {"2013Q1"}
    assert done["left"]["quarters"] == 1

    done, _ = run_backfill(lake, src, TODAY)
    state = State.load(lake)
    assert state.legacy_retry == set() and done["left"]["quarters"] == 0
    checks = lake.read("legacy_checks", part="2013Q1")
    assert checks["status"].to_list() == ["ok"]
    assert lake.read("filings", part=f"q{q_index(2012, 4):03d}")["accession"].to_list() == [failing]


def test_an_unreadable_filing_does_not_cut_the_funds_history(tmp_path):
    asked: list = []
    fetch = legacy_quarter(asked)

    def two_unreadable(key, skip, stats):  # Q4 2012 and Q1 2013: filed, not readable
        filings, raw, checks = fetch(key, skip, stats)
        if key in ("2013Q1", "2013Q2"):
            return filings.clear(), raw.clear(), checks.with_columns(status=pl.lit("mismatch"))
        return filings, raw, checks

    src = replace(sources([], []), legacy_quarter=two_unreadable)
    lake = Lake(tmp_path / "lake")
    run_backfill(lake, src, TODAY)
    assert lake.read("filings", part=f"q{q_index(2012, 4):03d}").is_empty()
    stats = run_weekly(lake, tmp_path / "out", src, TODAY)
    summary = read_json(stats.staging / "fund" / str(FUND) / "summary.json")
    # Two missing quarters in a row would start a new history in Q2 2013; filed but unreadable,
    # they are carried from Q3 2012.
    assert summary["tracked_since_q"] == -2
    assert summary["quarters"]["q"] == [-2, -1, 0, 1, 2]


def test_an_unmarked_amendment_next_to_an_unreadable_original_is_not_the_book(tmp_path):
    from orca.run.ingest import _mark_unmarked, _originals

    checks = pl.DataFrame(
        [{"accession": "A", "cik": 1, "period": -5, "filed": date(2012, 2, 1), "form": "13F-HR", "status": "mismatch"}],
        schema=CHECKS_SCHEMA,
    )
    base = {"cik": 1, "filed": date(2012, 3, 1), "form": "13F-HR/A", "amendment_type": None,
            "manager_name": None, "source": "legacy"}
    filings = pl.DataFrame(
        [{**base, "accession": "B", "period": -5}, {**base, "accession": "C", "period": -4}],
        schema=FILINGS_SCHEMA,
    )
    marked = dict(_mark_unmarked(filings, _originals(checks)).select("accession", "amendment_type").iter_rows())
    assert marked == {"B": "unmarked", "C": None}  # C: no original that quarter, it is the report
