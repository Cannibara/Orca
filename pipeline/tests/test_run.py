import io
import json
import shutil
import zipfile
from dataclasses import asdict, fields, replace
from datetime import date, timedelta
from functools import partial
from pathlib import Path

import httpx
import polars as pl
import pytest

from orca import demo, prices
from orca.demo import (
    Filing,
    Fixtures,
    Holding,
    bulk_zip,
    fixture_sources,
    listing,
    live_frames,
)
from orca.engine.metrics import Performance
from orca.engine.position import Trade
from orca.home import FundSnapshot
from orca.http import FetchError, FigiClient
from orca.prices import DAILY_SCHEMA, FixtureSource
from orca.publish import FundMeta, read_json
from orca.quarter_px import QuarterPx
from orca.quarters import q_index
from orca.run import (
    CusipLeakError,
    InvariantError,
    _decode,
    _encode,
    _is_cusip,
    _State,
    _update_rf,
    affected_funds,
    copy_published,
    cusip_check_digit,
    deadline_quarter,
    live_watermark,
    main,
    price_flags,
    run_weekly,
    split_suspects,
    strip_query,
    verify,
)
from orca.securities import FIGI_URL
from orca.storage import Lake

WEEK1, WEEK2, WEEK3 = date(2026, 10, 16), date(2026, 10, 23), date(2026, 10, 30)
HALYARD, KELPWOOD = 9100002, 9100001  # Halyard restates Q2 2019 on 2026-10-20
NOT_COMPARED = {"manifest.json", "health.json"}  # build time and run counts differ by design


# --- helpers --------------------------------------------------------------------------------


@pytest.fixture(scope="session")
def fixtures() -> Fixtures:
    return demo.build_fixtures(7)


def run(root: Path, sources, today: date, **kwargs):
    """One run with `root/lake` and `root/out`, then the upload into `root/bucket`."""
    stats = run_weekly(Lake(root / "lake"), root / "out", sources, today, **kwargs)
    copy_published(stats.staging, root / "out", root / "bucket")
    return stats


@pytest.fixture(scope="session")
def base_runs(fixtures, tmp_path_factory) -> dict[date, Path]:
    """A first demo run as of each of WEEK1 and WEEK2, built once and copied by each test."""
    bases = {}
    for day in (WEEK1, WEEK2):
        root = tmp_path_factory.mktemp(f"base{day:%m%d}")
        run(root, fixture_sources(fixtures), day)
        bases[day] = root
    return bases


def from_base(base_runs, day: date, tmp_path: Path) -> Path:
    root = tmp_path / "inc"
    shutil.copytree(base_runs[day], root)
    return root


def bucket_files(root: Path) -> dict[str, bytes]:
    bucket = root / "bucket"
    return {p.relative_to(bucket).as_posix(): p.read_bytes() for p in bucket.rglob("*.json")}


def manifest(root: Path) -> dict[str, str]:
    return read_json(root / "out" / "manifest.json")["files"]


def health(root: Path) -> dict:
    return read_json(root / "bucket" / "health.json")


def business_days(start: date, end: date) -> list[date]:
    days, day = [], start
    while day <= end:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


def flat_prices(
    close: float, start=date(2024, 1, 2), end=date(2024, 12, 31), splits=None
) -> pl.DataFrame:
    splits = splits or {}
    rows = [
        (d, close, close, close, close, 1e6, splits.get(d, 1.0), 0.0)
        for d in business_days(start, end)
    ]
    return pl.DataFrame(rows, schema=DAILY_SCHEMA, orient="row")


WIDGET = "000000AB5"  # a valid check digit
SMALL_FUND = 1001
SMALL_ZIP = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2024q3_form13f.zip"


def small_fixtures(
    rows_by_q: dict[int, list[Holding]], close: float = 40.0, name="Test Fund LP", splits=None
) -> Fixtures:
    """One fund, one stock (WIDG at a flat price), a bulk ZIP with the given quarters."""
    filings = [
        Filing(
            f"0000001001-24-{i:06d}",
            SMALL_FUND,
            name,
            q,
            date(2024, 5, 10) + timedelta(days=91 * i),
            rows,
        )
        for i, (q, rows) in enumerate(sorted(rows_by_q.items()))
    ]
    live_f, live_h = live_frames([])
    return Fixtures(
        zips={SMALL_ZIP: bulk_zip(filings)},
        live_filings=live_f,
        live_holdings=live_h,
        figi={WIDGET: listing("BBG0TEST0001", "WIDG", "WIDGET CORP")},
        sec_tickers=pl.DataFrame(
            [("WIDG", 5001, "WIDGET CORP")],
            schema={"ticker": pl.String, "cik": pl.Int64, "title": pl.String},
            orient="row",
        ),
        sic={5001: 3571},
        shares_out={5001: 1e9},
        prices={"WIDG": flat_prices(close, splits=splits)},
        tbill={2024: 0.05},
    )


Q1_24, Q2_24 = q_index(2024, 1), q_index(2024, 2)
SMALL_TODAY = date(2024, 10, 1)  # the deadline quarter is Q2 2024


# --- the brief's tests -----------------------------------------------------------------------


def test_incremental_equals_full_rebuild(fixtures, base_runs, tmp_path):
    # Week 2: a restatement of Q2 2019 arrives, and the vendor publishes CMG's split day of
    # 2026-10-21 without its split factor. Week 3: the vendor corrects the split factor.
    late_split = {
        **fixtures.prices,
        "CMG": fixtures.prices["CMG"].with_columns(
            split_factor=pl.when(pl.col("date") == date(2026, 10, 21))
            .then(1.0)
            .otherwise(pl.col("split_factor"))
        ),
    }
    week2_sources = replace(fixture_sources(fixtures), prices=FixtureSource(late_split))
    inc = from_base(base_runs, WEEK1, tmp_path)

    week2 = run(inc, week2_sources, WEEK2)
    week3 = run(inc, fixture_sources(fixtures), WEEK3)
    fresh = run(tmp_path / "fresh", fixture_sources(fixtures), WEEK3, full=True)

    # Both later weeks recomputed only some funds: the restating fund, then CMG's holders.
    assert f"fund/{HALYARD}/summary.json" in week2.changed
    assert 0 < week2.funds_recomputed < 12
    assert week3.funds_recomputed == len(demo.NICHE["CMG"])
    assert any(p.startswith("fund/") for p in week3.changed)
    assert fresh.funds_recomputed == 12

    incremental, rebuilt = bucket_files(inc), bucket_files(tmp_path / "fresh")
    fund_paths = sorted(p for p in rebuilt if p.startswith("fund/"))
    assert len(fund_paths) == 12 * 4
    assert sorted(p for p in incremental if p.startswith("fund/")) == fund_paths
    for path in sorted(set(rebuilt) - NOT_COMPARED):
        assert incremental.get(path) == rebuilt[path], path
    # The manifest lists exactly what is in the bucket, with the same checksums as the rebuild.
    assert set(manifest(inc)) == set(incremental) - {"manifest.json"}
    assert {p: s for p, s in manifest(inc).items() if p not in NOT_COMPARED} == {
        p: s for p, s in manifest(tmp_path / "fresh").items() if p not in NOT_COMPARED
    }
    assert sorted(p.name for p in (inc / "out" / "staging").iterdir()) == ["20261023", "20261030"]


def test_unchanged_week_publishes_only_prices(fixtures, base_runs, tmp_path):
    inc = from_base(base_runs, WEEK2, tmp_path)
    before = manifest(inc)

    stats = run(inc, fixture_sources(fixtures), WEEK3)

    prices = Lake(inc / "lake").read("prices_daily")
    touched = sorted(set(prices.filter(pl.col("date") > WEEK2)["stock_id"].to_list()))
    assert touched  # the held stocks got the new week
    expected = {"latest_prices.json", "manifest.json", "health.json"} | {
        f"stock/{sid}/weekly.json" for sid in touched
    }
    assert stats.changed == sorted(expected)
    assert stats.funds_recomputed == 0
    staged = sorted(
        p.relative_to(stats.staging).as_posix() for p in stats.staging.rglob("*") if p.is_file()
    )
    assert staged == sorted(expected - {"manifest.json"})
    after = manifest(inc)
    assert {p: s for p, s in after.items() if p.startswith(("fund/", "home/"))} == {
        p: s for p, s in before.items() if p.startswith(("fund/", "home/"))
    }


def test_bridge_failure_aborts_before_manifest(fixtures, base_runs, tmp_path, monkeypatch):
    inc = from_base(base_runs, WEEK2, tmp_path)
    manifest_bytes = (inc / "out" / "manifest.json").read_bytes()
    state = (inc / "lake" / "state.json").read_text()
    monkeypatch.setattr("orca.run.check_bridge", lambda fq: False)

    with pytest.raises(InvariantError, match="bridge"):
        run_weekly(Lake(inc / "lake"), inc / "out", fixture_sources(fixtures), WEEK3, full=True)

    assert (inc / "out" / "manifest.json").read_bytes() == manifest_bytes
    assert (
        json.loads((inc / "lake" / "state.json").read_text())["last_q"]
        == json.loads(state)["last_q"]
    )


def test_failed_zip_download_keeps_last_good(fixtures, base_runs, tmp_path):
    inc = from_base(base_runs, WEEK2, tmp_path)
    before = manifest(inc)
    bucket_before = bucket_files(inc)
    url = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2026q3_form13f.zip"
    spy = Holding("SPDR S&P 500 ETF TR", demo.SPY_CUSIP, 1_000 * 600.0, 1_000)
    amendment = Filing(
        "0009100001-26-999999", KELPWOOD, "Kelpwood Capital LP", q_index(2026, 2),
        date(2026, 10, 27), [spy], "13F-HR/A", "NEW HOLDINGS",
    )  # fmt: skip
    failing = replace(fixtures, zips={**fixtures.zips, url + "?download=1": None})

    stats = run(inc, fixture_sources(failing), WEEK3)

    assert {"type": "fetch_failed", "url": url, "status": 503} in health(inc)["flags"]
    assert not any(p.startswith("fund/") for p in stats.changed)
    assert {p: s for p, s in manifest(inc).items() if p.startswith("fund/")} == {
        p: s for p, s in before.items() if p.startswith("fund/")
    }
    assert {p: b for p, b in bucket_files(inc).items() if p.startswith("fund/")} == {
        p: b for p, b in bucket_before.items() if p.startswith("fund/")
    }
    assert "2026q3_form13f.zip" not in json.loads((inc / "lake" / "ingested.json").read_text())

    # Next week the download works: the ZIP is read and its fund recomputed.
    working = replace(fixtures, zips={**fixtures.zips, url + "?download=1": bulk_zip([amendment])})
    retry = run(inc, fixture_sources(working), WEEK3 + timedelta(days=7))
    assert f"fund/{KELPWOOD}/positions.json" in retry.changed
    assert "2026q3_form13f.zip" in json.loads((inc / "lake" / "ingested.json").read_text())


def test_price_mismatch_flagged(tmp_path):
    rows = pl.DataFrame(
        {"cik": [1], "q": [45], "stock_id": [7], "shares": [10.0], "value_usd": [5_000.0]}
    )
    px = {7: {45: QuarterPx(40.0, 39.0, 41.0, 40.0, 0.0, (40.0, 40.0, 40.0))}}

    assert price_flags(rows, px, 45) == [
        {
            "type": "price_mismatch",
            "fund_id": 1,
            "stock_id": 7,
            "q": 45,
            "reported": 500.0,
            "ours": 40.0,
        }
    ]
    assert (
        price_flags(rows.with_columns(value_usd=pl.lit(4_000.0)), px, 45) == []
    )  # 400: within 10x
    assert price_flags(rows, px, 44) == []

    # Through a run: the flag reaches health.json and the P&L values the position at $40.
    widget = Holding("WIDGET CORP", WIDGET, 5_000.0, 10)
    run(tmp_path, fixture_sources(small_fixtures({Q1_24: [widget], Q2_24: [widget]})), SMALL_TODAY)
    flags = health(tmp_path)["flags"]
    assert {
        "type": "price_mismatch",
        "fund_id": SMALL_FUND,
        "stock_id": 1,
        "q": Q2_24,
        "reported": 500.0,
        "ours": 40.0,
    } in flags
    summary = read_json(tmp_path / "bucket" / f"fund/{SMALL_FUND}/summary.json")
    assert summary["quarters"]["end"] == [400.0, 400.0]
    positions = read_json(tmp_path / "bucket" / f"fund/{SMALL_FUND}/positions.json")
    assert positions["trades"] == [[[Q1_24, 10.0, 40.0, 40.0, 40.0, 10.0]]]


def test_split_suspect_flagged(tmp_path):
    rows = pl.DataFrame(
        {"cik": [1, 1], "q": [44, 45], "stock_id": [7, 7], "shares": [100.0, 300.0]}
    )
    no_splits = pl.DataFrame(
        schema={"stock_id": pl.Int32, "date": pl.Date, "split_factor": pl.Float64}
    )
    vendor_split = pl.DataFrame(
        {"stock_id": [7], "date": [date(2024, 5, 1)], "split_factor": [3.0]}
    )

    assert split_suspects(rows, no_splits) == [
        {"type": "split_suspect", "fund_id": 1, "stock_id": 7, "q": 45, "ratio": 3.0}
    ]
    assert split_suspects(rows, vendor_split) == []
    assert split_suspects(rows.with_columns(shares=pl.Series([100.0, 250.0])), no_splits) == []

    # Through a run: 100 -> 300 shares with no split in the prices is flagged in health.json.
    small = small_fixtures(
        {
            Q1_24: [Holding("WIDGET CORP", WIDGET, 4_000.0, 100)],
            Q2_24: [Holding("WIDGET CORP", WIDGET, 12_000.0, 300)],
        }
    )
    run(tmp_path, fixture_sources(small), SMALL_TODAY)
    assert {
        "type": "split_suspect",
        "fund_id": SMALL_FUND,
        "stock_id": 1,
        "q": Q2_24,
        "ratio": 3.0,
    } in health(tmp_path)["flags"]


# --- more of the run ------------------------------------------------------------------------


def test_deadline_quarter():
    assert deadline_quarter(date(2026, 10, 30)) == q_index(2026, 2)
    assert deadline_quarter(date(2026, 11, 13)) == q_index(2026, 2)
    assert deadline_quarter(date(2026, 11, 14)) == q_index(2026, 3)  # Sep 30 + 45 days
    assert deadline_quarter(date(2026, 2, 14)) == q_index(2025, 4)


def test_live_watermark_holds_back_recent_days_without_an_index():
    since, until = date(2026, 10, 19), date(2026, 10, 30)  # Monday .. Friday a week later
    assert live_watermark(since, until, []) == until
    assert (
        live_watermark(since, until, [date(2026, 10, 24), date(2026, 10, 25)]) == until
    )  # a weekend
    assert live_watermark(since, until, [date(2026, 10, 30)]) == date(2026, 10, 29)
    assert live_watermark(since, until, [date(2026, 10, 28), date(2026, 10, 30)]) == date(
        2026, 10, 27
    )
    assert live_watermark(since, until, [date(2026, 10, 27)]) == until  # four business days back
    sunday = date(2026, 11, 1)  # the three business days are Wed..Fri
    assert live_watermark(since, sunday, [date(2026, 10, 28), sunday]) == date(2026, 10, 27)


def test_affected_funds():
    new = pl.DataFrame({"cik": [1, 1]})
    holdings = pl.DataFrame({"cik": [2, 3, 4], "stock_id": [7, 8, 7]})

    assert affected_funds(new, [7], holdings) == {1, 2, 4}
    assert affected_funds(new, [], holdings) == {1}
    assert affected_funds(pl.DataFrame({"cik": []}, schema={"cik": pl.Int64}), [8], holdings) == {3}


def test_strip_query():
    assert strip_query(
        "https://api.stlouisfed.org/fred/series/observations?api_key=SECRET&x=1"
    ) == ("https://api.stlouisfed.org/fred/series/observations")


def test_pending_recompute_survives_a_crash(fixtures, base_runs, tmp_path, monkeypatch):
    # The run that ingests Halyard's restatement dies before publishing anything ...
    inc = from_base(base_runs, WEEK1, tmp_path)

    def crash(*args, **kwargs):
        raise RuntimeError("killed")

    monkeypatch.setattr("orca.run.publish_fund", crash)
    with pytest.raises(RuntimeError, match="killed"):
        run_weekly(Lake(inc / "lake"), inc / "out", fixture_sources(fixtures), WEEK2)
    monkeypatch.undo()

    # ... and the next run, which finds no new filing, still recomputes the fund.
    stats = run(inc, fixture_sources(fixtures), WEEK2)
    assert stats.filings_parsed == 0
    assert f"fund/{HALYARD}/summary.json" in stats.changed


def test_new_deadline_quarter_recomputes_every_fund(fixtures, base_runs, tmp_path):
    inc = from_base(base_runs, WEEK2, tmp_path)

    stats = run(inc, fixture_sources(fixtures), date(2026, 11, 16))

    assert stats.last_q == q_index(2026, 3)
    assert stats.funds_recomputed == 12
    home = read_json(inc / "bucket" / "home" / "conviction.json")
    assert home["latest_q"] == q_index(2026, 3)


def test_published_files_hold_no_cusip(base_runs, fixtures):
    cusips = set(fixtures.live_holdings["cusip"].to_list())
    for body in fixtures.zips.values():
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            rows = z.read("INFOTABLE.tsv").decode().splitlines()
        column = rows[0].split("\t").index("CUSIP")
        cusips |= {row.split("\t")[column] for row in rows[1:]}
    assert {"91DEMO2B7", demo.SPY_CUSIP} <= cusips  # the bond and the benchmark are among them
    assert set(fixtures.figi) <= cusips

    root = base_runs[WEEK2]
    for path in bucket_files(root):
        text = json.dumps(read_json(root / "bucket" / path))
        assert not [c for c in cusips if c in text], path


def test_cusip_in_a_published_file_aborts_before_manifest(tmp_path):
    widget = Holding("WIDGET CORP", WIDGET, 400.0, 10)
    leaky = small_fixtures({Q1_24: [widget], Q2_24: [widget]}, name=f"Fund {WIDGET} LP")

    with pytest.raises(CusipLeakError, match=r"funds\.json \(offset \d+\)") as err:
        run_weekly(Lake(tmp_path / "lake"), tmp_path / "out", fixture_sources(leaky), SMALL_TODAY)

    assert WIDGET not in str(err.value)  # the error names where, not what
    assert not (tmp_path / "out" / "manifest.json").exists()


def test_junk_cusip_does_not_abort_the_run(tmp_path):
    # A 13F "CUSIP" without a valid check digit is no security's identifier: free text that
    # happens to contain it is published.
    junk = "999999999"
    rows = [Holding("WIDGET CORP", WIDGET, 400.0, 10), Holding("UNKNOWN", junk, 400.0, 10)]
    small = small_fixtures({Q1_24: rows, Q2_24: rows}, name=f"Fund {junk} LP")

    run(tmp_path, fixture_sources(small), SMALL_TODAY)

    assert junk in Lake(tmp_path / "lake").read("cusip_map")["cusip"].to_list()
    assert read_json(tmp_path / "bucket" / "funds.json")["name"] == [f"Fund {junk} LP"]


def test_cusip_check_digit():
    assert cusip_check_digit("78462F10") == "3"  # SPY
    assert cusip_check_digit("03783310") == "0"  # Apple
    assert cusip_check_digit("000000AB") == "5"


def test_verify_rebuilds_funds_and_finds_differences(base_runs, tmp_path):
    inc = from_base(base_runs, WEEK2, tmp_path)
    lake = Lake(inc / "lake")

    assert verify(lake, inc / "out", sample=12, seed=1) == []

    published = json.loads((inc / "lake" / "published.json").read_text())
    published[f"fund/{KELPWOOD}/exits.json"] = "0" * 64
    (inc / "lake" / "published.json").write_text(json.dumps(published))
    assert verify(lake, inc / "out", sample=12, seed=1) == [f"fund/{KELPWOOD}/exits.json"]


def test_demo_cli_writes_twelve_funds(tmp_path, fixtures):
    out = tmp_path / "demo-data"
    (out / "fund" / "1").mkdir(parents=True)  # an earlier demo, which is replaced
    (out / "fund" / "1" / "summary.json").write_text("{}")
    (out / "manifest.json").write_text(json.dumps({"files": {"fund/1/summary.json": "x"}}))

    assert main(["demo", "--plain", "--out", str(out)]) == 0

    funds = json.loads((out / "funds.json").read_text())
    assert len(funds["id"]) == 12
    assert not (out / "fund" / "1").exists()
    listed = json.loads((out / "manifest.json").read_text())["files"]
    assert sorted(listed) == sorted(
        p.relative_to(out).as_posix() for p in out.rglob("*.json") if p.name != "manifest.json"
    )
    assert demo.build_fixtures(7).zips == fixtures.zips  # seeded: the same inputs every time

    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "notes.txt").write_text("keep me")
    with pytest.raises(ValueError, match="not empty"):
        main(["demo", "--plain", "--out", str(tmp_path / "other")])
    assert (tmp_path / "other" / "notes.txt").read_text() == "keep me"


def test_fund_and_home_files_do_not_move_with_a_later_weeks_prices(fixtures, base_runs, tmp_path):
    # A full rebuild a week later, with only new price days in the open quarter, rewrites every
    # fund and home file to the same bytes.
    inc = from_base(base_runs, WEEK2, tmp_path)

    stats = run(inc, fixture_sources(fixtures), WEEK3, full=True)

    assert stats.funds_recomputed == 12
    assert not [p for p in stats.changed if p.startswith(("fund/", "home/", "funds.json"))]


def test_benchmark_revision_recomputes_every_fund(fixtures, base_runs, tmp_path):
    # Every fund's what-if figures use SPY, so a revised SPY bar is an input of every fund.
    inc = from_base(base_runs, WEEK2, tmp_path)
    revised = fixtures.prices["SPY"].with_columns(
        close=pl.when(pl.col("date") == date(2026, 10, 21))
        .then(pl.col("close") * 1.01)
        .otherwise(pl.col("close"))
    )
    sources = replace(
        fixture_sources(fixtures), prices=FixtureSource({**fixtures.prices, "SPY": revised})
    )

    stats = run(inc, sources, WEEK3)

    assert stats.funds_recomputed == 12


def test_live_reads_again_a_recent_day_that_had_no_index(tmp_path):
    widget = Holding("WIDGET CORP", WIDGET, 400.0, 10)
    small = small_fixtures({Q1_24: [widget], Q2_24: [widget]})
    calls = []

    def live(since, until, stats):
        calls.append((since, until))
        stats["no_index_days"] = [until]  # today's index is not out yet
        return live_frames([])

    sources = replace(fixture_sources(small), live_filings=live)
    friday = date(2024, 10, 4)
    run(tmp_path, sources, friday)
    run(tmp_path, sources, friday + timedelta(days=7))

    assert calls[1] == (friday, friday + timedelta(days=7))


def test_tbill_change_survives_an_aborted_run(fixtures, base_runs, tmp_path, monkeypatch):
    inc = from_base(base_runs, WEEK2, tmp_path)
    fred = "https://api.stlouisfed.org/fred/series/observations?api_key=SECRET"

    def fred_down():
        raise FetchError(fred, 500)

    # A rebuild while FRED is down: it completes, and the T-bill table is marked stale.
    down = replace(fixture_sources(fixtures), tbill=fred_down)
    run(inc, down, WEEK3, full=True)
    assert {"type": "tbill_failed", "url": fred.split("?")[0], "status": 500} in health(inc)[
        "flags"
    ]

    # The next run gets new rates but dies before publishing ...
    new_rates = replace(fixture_sources(fixtures), tbill=lambda: {**fixtures.tbill, 2026: 0.03})
    monkeypatch.setattr("orca.run.check_bridge", lambda fq: False)
    with pytest.raises(InvariantError):
        run_weekly(Lake(inc / "lake"), inc / "out", new_rates, WEEK3)
    monkeypatch.undo()

    # ... so the run after it still owes every fund a recompute with the new rates.
    stats = run(inc, new_rates, WEEK3)
    assert stats.funds_recomputed == 12


def test_aborted_rebuild_is_finished_by_the_next_run(fixtures, base_runs, tmp_path, monkeypatch):
    inc = from_base(base_runs, WEEK2, tmp_path)
    monkeypatch.setattr("orca.run.check_bridge", lambda fq: False)
    with pytest.raises(InvariantError):
        run_weekly(Lake(inc / "lake"), inc / "out", fixture_sources(fixtures), WEEK3, full=True)
    monkeypatch.undo()

    stats = run(inc, fixture_sources(fixtures), WEEK3)

    assert stats.funds_recomputed == 12


class _KilledAfter(FixtureSource):
    """Serves bars until `ticker` has been served, then dies like a killed process."""

    def __init__(self, frames, ticker):
        super().__init__(frames)
        self._ticker, self._served = ticker, False

    def daily(self, ticker, start, end):
        if self._served:
            raise KeyboardInterrupt("killed")
        self._served = ticker == self._ticker
        return super().daily(ticker, start, end)


def test_changed_prices_survive_a_run_killed_during_the_price_update(
    fixtures, base_runs, tmp_path, monkeypatch
):
    # Week 2 stores CMG's split day without its split factor.
    late_split = {
        **fixtures.prices,
        "CMG": fixtures.prices["CMG"].with_columns(
            split_factor=pl.when(pl.col("date") == date(2026, 10, 21))
            .then(1.0)
            .otherwise(pl.col("split_factor"))
        ),
    }
    inc = from_base(base_runs, WEEK1, tmp_path)
    run(inc, replace(fixture_sources(fixtures), prices=FixtureSource(late_split)), WEEK2)

    # Week 3's run stores the corrected bar (flushed after each ticker), then is killed.
    monkeypatch.setattr("orca.run.update_prices", partial(prices.update_prices, flush_every=1))
    killed = replace(fixture_sources(fixtures), prices=_KilledAfter(fixtures.prices, "CMG"))
    with pytest.raises(KeyboardInterrupt):
        run_weekly(Lake(inc / "lake"), inc / "out", killed, WEEK3)
    monkeypatch.undo()

    # The next run finds the bar already stored, yet still recomputes CMG's holders.
    stats = run(inc, fixture_sources(fixtures), WEEK3)
    holders = [
        cik for cik in range(demo.FUND_CIK0, demo.FUND_CIK0 + 12)
        if demo.FUNDS[cik - demo.FUND_CIK0].name in demo.NICHE["CMG"]
    ]  # fmt: skip
    for cik in holders:
        assert f"fund/{cik}/positions.json" in stats.changed


def test_stored_fund_state_round_trips_every_field():
    trade = Trade(q=53, type="add", delta=10.0, px=12.5, low=None, high=13.0, shares_after=30.0)
    perf = Performance(0.1, 1.2, None, 0.2, -0.3, 0.33, 0.6)
    snap = FundSnapshot(
        fund_id=1,
        name="Test Fund LP",
        book=1e9,
        n_priced=2,
        priced_pct=0.9,
        quarters_filed=12,
        excluded=False,
        weights_now={7: 0.6, 8: 0.4},
        weights_prev={7: 1.0},
        trades_latest=[(7, trade)],
        pnl_latest={7: -5.5, 8: 2.0},
        buys_recent=[(7, 53, 12.5, 0.6, date(2026, 8, 1))],
        perf={"1y": perf, "3y": None},
        filed=date(2026, 8, 1),
        period_q=53,
    )
    meta = FundMeta(1, "Test Fund LP", 1, 53, date(2026, 8, 1), 1e9, 2, 0.9, 40, False)
    assert {f.name for f in fields(snap)} == set(asdict(snap))  # every field is set above

    assert _decode(json.loads(json.dumps(_encode(snap)))) == snap
    assert _decode(json.loads(json.dumps(_encode(meta)))) == meta


def test_failed_cusip_mapping_is_flagged_and_retried(tmp_path):
    widget = Holding("WIDGET CORP", WIDGET, 400.0, 10)
    small = small_fixtures({Q1_24: [widget], Q2_24: [widget]})
    down = FigiClient(
        1e6,
        {},
        transport=httpx.MockTransport(lambda request: httpx.Response(503)),
        sleep=lambda s: None,
        jobs_per_request=100,
    )

    run(tmp_path, replace(fixture_sources(small), figi=down), SMALL_TODAY)

    flag = {"type": "cusip_mapping_failed", "count": 2, "url": FIGI_URL, "status": 503}
    assert flag in health(tmp_path)["flags"]
    stats = run(tmp_path, fixture_sources(small), SMALL_TODAY)
    assert f"fund/{SMALL_FUND}/positions.json" in stats.changed
    positions = read_json(tmp_path / "bucket" / f"fund/{SMALL_FUND}/positions.json")
    assert positions["stock_id"] == [1]


def test_unreadable_zip_is_flagged_by_its_name(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("SUBMISSION.tsv", "ACCESSION_NUMBER\n")  # no COVERPAGE / INFOTABLE
    small = replace(small_fixtures({}), zips={SMALL_ZIP: buffer.getvalue()})

    run(tmp_path, fixture_sources(small), SMALL_TODAY)

    [flag] = [f for f in health(tmp_path)["flags"] if f["type"] == "bulk_unreadable"]
    assert flag["url"] == SMALL_ZIP
    assert flag["detail"].startswith("2024q3_form13f.zip: SUBMISSION.tsv has no column(s)")
    assert str(tmp_path) not in flag["detail"] and "/tmp" not in flag["detail"]


def test_rf_stays_stale_until_the_table_is_written(tmp_path, monkeypatch):
    lake = Lake(tmp_path / "lake")
    sources = replace(fixture_sources(small_fixtures({})), tbill=lambda: {2024: 0.05})
    state = _State(rf_stale=True)  # an earlier fetch failed

    def disk_full(table, df, part=None):
        raise OSError("disk full")

    monkeypatch.setattr(lake, "write", disk_full)
    with pytest.raises(OSError, match="disk full"):
        _update_rf(lake, sources, state, Q2_24, False, [])

    # The new rates are not stored, so the next run must fetch them again.
    saved = _State.load(lake)
    assert saved.rf_stale and saved.pending_all
    monkeypatch.undo()

    _update_rf(lake, sources, state, Q2_24, False, [])

    assert not state.rf_stale
    assert dict(lake.read("rf").iter_rows()) == {2024: 0.05}


def test_stale_flag_clears_when_the_fetched_rates_are_the_stored_ones(tmp_path):
    lake = Lake(tmp_path / "lake")
    sources = replace(fixture_sources(small_fixtures({})), tbill=lambda: {2024: 0.05})
    _update_rf(lake, sources, _State(), Q2_24, False, [])
    state = _State(last_q=Q2_24, rf_stale=True)

    _update_rf(lake, sources, state, Q2_24, False, [])

    assert not state.rf_stale
    assert not state.pending_all


@pytest.mark.parametrize("lead", ["É", "²", "٣", "Ａ"])  # non-ASCII letter, digits, full-width
def test_non_ascii_text_is_never_a_cusip(lead):
    text = lead + "2345678"
    assert len(text) == 8
    assert not _is_cusip(text + cusip_check_digit("A2345678"))  # a check digit that fits "A..."
    assert not _is_cusip(text + cusip_check_digit("32345678"))  # ... or "3..."


def test_non_ascii_cusip_does_not_crash_the_leak_scan(tmp_path):
    odd = "ÉBCDEFGH5"
    rows = [Holding("WIDGET CORP", WIDGET, 400.0, 10), Holding("ODD", odd, 400.0, 10)]
    small = small_fixtures({Q1_24: rows, Q2_24: rows})

    run(tmp_path, fixture_sources(small), SMALL_TODAY)

    assert odd in Lake(tmp_path / "lake").read("cusip_map")["cusip"].to_list()
