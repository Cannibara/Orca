"""The run step that keeps lake table `fund_about` up to date (`run/about_step.update_fund_about`)."""

from datetime import date

import polars as pl
import pytest

from orca.http import FetchError
from orca.run.about_step import update_fund_about
from orca.run.budget import Budget
from orca.run.state import read_table
from orca.sec.about import SCHEMA, TABLE, About
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake

TODAY = date(2026, 11, 16)
BIG, SMALL, GONE = 1, 2, 3  # CIKs: a big active fund, a small one, an inactive one


def filings(lake: Lake, rows: list[tuple[int, str, date, str]], part: str = "q054") -> None:
    """Store 13F filings (cik, accession, filed, form) in the lake's `filings` table."""
    frame = pl.DataFrame(
        [(acc, cik, 54, filed, form, None, f"FUND {cik}", "bulk") for cik, acc, filed, form in rows],
        schema=FILINGS_SCHEMA,
        orient="row",
    )
    lake.write("filings", frame, part=part)


def funds() -> list[tuple[int, float, bool]]:
    return [(SMALL, 1e8, False), (GONE, 9e9, True), (BIG, 5e9, False)]


class Sec:
    """A fake `fetch`: the CIKs asked, in order; an About per CIK (None: unknown to the SEC)."""

    def __init__(self, answers: dict[int, About | None | Exception]):
        self.answers = answers
        self.asked: list[int] = []

    def __call__(self, cik: int) -> About | None:
        self.asked.append(cik)
        answer = self.answers.get(cik)
        if isinstance(answer, Exception):
            raise answer
        return answer


def about(cik: int, accession: str, filed: date, signer: str = "Ann Lee") -> About:
    return About(name=f"FUND {cik} LP", city="OMAHA", state="NE", signer=signer, accession=accession, filed=filed)


def run_step(lake, sec, flags=None, budget=None, **kw):
    return update_fund_about(
        lake, sec, funds(), [] if flags is None else flags, budget or Budget(60), TODAY, **kw
    )


@pytest.fixture
def lake(tmp_path) -> Lake:
    lake = Lake(tmp_path / "lake")
    filings(
        lake,
        [
            (BIG, "0000000001-26-000002", date(2026, 11, 14), "13F-HR"),
            (BIG, "0000000001-26-000001", date(2026, 8, 14), "13F-HR"),
            (SMALL, "0000000002-26-000001", date(2026, 11, 10), "13F-HR/A"),
            (GONE, "0000000003-19-000001", date(2019, 2, 14), "13F-HR"),
        ],
    )
    return lake


def answers() -> dict[int, About]:
    return {
        BIG: about(BIG, "0000000001-26-000002", date(2026, 11, 14)),
        SMALL: about(SMALL, "0000000002-26-000001", date(2026, 11, 10)),
        GONE: about(GONE, "0000000003-19-000001", date(2019, 2, 14)),
    }


def test_missing_funds_are_asked_active_and_biggest_first(lake):
    sec = Sec(answers())
    stats, changed = run_step(lake, sec)
    assert sec.asked == [BIG, SMALL, GONE]
    table = read_table(lake, TABLE, SCHEMA).sort("cik")
    assert table["cik"].to_list() == [BIG, SMALL, GONE]
    assert table.schema == SCHEMA
    assert table["fetched"].to_list() == [TODAY] * 3
    assert table.filter(pl.col("cik") == BIG)["signer"].item() == "Ann Lee"
    assert sorted(changed) == [BIG, SMALL, GONE]
    assert changed[BIG]["name"] == "FUND 1 LP" and changed[BIG]["city"] == "Omaha"
    assert stats == {"funds": 3, "failed": 0, "owed": 0}


def test_a_fund_is_asked_again_only_once_it_files_a_newer_13f(lake):
    run_step(lake, Sec(answers()))
    sec = Sec(answers())
    assert run_step(lake, sec)[1] == {}
    assert sec.asked == []

    filings(lake, [(SMALL, "0000000002-27-000001", date(2027, 2, 12), "13F-HR")], part="q055")
    sec = Sec({SMALL: about(SMALL, "0000000002-27-000001", date(2027, 2, 12), signer="Bo Chen")})
    stats, changed = run_step(lake, sec)
    assert sec.asked == [SMALL]
    assert changed[SMALL]["signer"] == "Bo Chen" and list(changed) == [SMALL]
    table = read_table(lake, TABLE, SCHEMA)
    assert table.height == 3
    assert table.filter(pl.col("cik") == SMALL)["accession"].item() == "0000000002-27-000001"


def test_missing_funds_go_before_out_of_date_ones(lake):
    run_step(lake, Sec({BIG: answers()[BIG]}), max_calls=2)
    filings(lake, [(BIG, "0000000001-27-000001", date(2027, 2, 12), "13F-HR")], part="q055")
    sec = Sec(answers())
    run_step(lake, sec)
    assert sec.asked == [SMALL, GONE, BIG]


def test_the_sec_ahead_of_the_lake_is_not_out_of_date(lake):
    # The record lists a 13F filed after this run's ingest: the lake catches up next run, and the row
    # is not asked for again then.
    ahead = {**answers(), BIG: about(BIG, "0000000001-26-000003", date(2026, 11, 16))}
    run_step(lake, Sec(ahead))
    filings(lake, [(BIG, "0000000001-26-000003", date(2026, 11, 16), "13F-HR")], part="q055")
    sec = Sec(answers())
    run_step(lake, sec)
    assert sec.asked == []


def test_two_13fs_filed_the_same_day_are_both_the_latest(lake):
    filings(lake, [(BIG, "0000000001-26-000009", date(2026, 11, 14), "13F-HR/A")], part="q055")
    run_step(lake, Sec(answers()))  # the record names the other one of the two
    sec = Sec(answers())
    run_step(lake, sec)
    assert sec.asked == []


def test_a_cik_the_sec_does_not_know_keeps_the_lakes_13f(lake):
    # No record (404) or no 13F in it: the row holds the lake's newest 13F, so the fund is not asked
    # again every run, and publishes no about.
    answers_ = {**answers(), BIG: None, SMALL: About(name="FUND 2 LP")}
    stats, changed = run_step(lake, Sec(answers_))
    table = read_table(lake, TABLE, SCHEMA).sort("cik")
    rows = {r["cik"]: r for r in table.iter_rows(named=True)}
    assert (rows[BIG]["accession"], rows[BIG]["filed"]) == ("0000000001-26-000002", date(2026, 11, 14))
    assert rows[BIG]["name"] is None
    assert (rows[SMALL]["accession"], rows[SMALL]["filed"]) == ("0000000002-26-000001", date(2026, 11, 10))
    assert BIG not in changed and changed[SMALL]["name"] == "FUND 2 LP"
    sec = Sec(answers())
    run_step(lake, sec)
    assert sec.asked == []


def test_the_call_cap_bounds_a_run_at_two_calls_a_fund(lake):
    sec = Sec(answers())
    stats, _ = run_step(lake, sec, max_calls=5)
    assert sec.asked == [BIG, SMALL]
    assert stats == {"funds": 2, "failed": 0, "owed": 1}
    sec = Sec(answers())
    run_step(lake, sec, max_calls=5)
    assert sec.asked == [GONE]


def test_a_failure_is_flagged_and_never_stops_the_step(lake):
    flags: list = []
    run_step(lake, Sec(answers()), max_calls=2)
    failing = {**answers(), BIG: FetchError("https://data.sec.gov/x", 503), SMALL: ValueError("not JSON")}
    filings(lake, [(BIG, "0000000001-27-000001", date(2027, 2, 12), "13F-HR")], part="q055")
    sec = Sec(failing)
    stats, changed = run_step(lake, sec, flags=flags)
    assert sec.asked == [SMALL, GONE, BIG]
    assert flags == [{"type": "about_failed", "count": 2}]
    assert stats == {"funds": 1, "failed": 2, "owed": 0}
    table = read_table(lake, TABLE, SCHEMA)
    assert sorted(table["cik"].to_list()) == [BIG, GONE]  # BIG keeps its old row, SMALL has none
    assert table.filter(pl.col("cik") == BIG)["accession"].item() == "0000000001-26-000002"
    assert list(changed) == [GONE]


def test_the_step_stops_with_the_budgets_reserve_left(lake):
    clock = [0.0]
    budget = Budget(40, clock=lambda: clock[0])
    sec = Sec(answers())

    def slow(cik):
        clock[0] += 6 * 60  # six minutes a fund
        return sec(cik)

    stats, _ = run_step(lake, slow, budget=budget, reserve=30)
    assert sec.asked == [BIG, SMALL]  # 40 → 34 → 28 minutes left: stop
    assert stats["owed"] == 1


def test_nothing_published_changes_when_only_the_lookup_is_repeated(lake):
    run_step(lake, Sec(answers()))
    filings(lake, [(BIG, "0000000001-27-000001", date(2027, 2, 12), "13F-HR")], part="q055")
    same = {BIG: about(BIG, "0000000001-27-000001", date(2027, 2, 12))}
    stats, changed = run_step(lake, Sec(same))
    assert stats["funds"] == 1 and changed == {}
