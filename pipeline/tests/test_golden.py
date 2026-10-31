"""Golden test: the pipeline on real filings, prices and rates for two funds, against snapshots.

The network test needs ORCA_NETWORK=1 and the services' keys (ORCA_CONTACT, OPENFIGI_KEY,
TIINGO_KEY, FRED_KEY): `ORCA_NETWORK=1 uv run pytest tests/test_golden.py`; `pytest -m "not
network"` leaves it out. It runs Berkshire Hathaway and Pershing Square (a concentrated fund) over
the 8 quarters up to GOLDEN_TODAY's deadline quarter, checks the AUM bridge, and compares each
fund's summary.json and positions.json with the files in tests/golden/<cik>/.

A snapshot is only worth anything once a person has checked it against the filings. When one is
missing the test writes it and FAILS, so a snapshot is never accepted unseen. Hand-check, for each
fund, the share counts of two holdings and one quarter's total value against the 13F on EDGAR,
note the numbers in the commit message, then commit the files. To refresh a snapshot after a
deliberate change, delete it and run again. Share counts and prices are on today's share basis,
so a later split of a held stock changes positions.json: delete the snapshots and hand-check
again. The other tests here run offline and cover the helpers that narrow a real run down to
two funds.
"""

import json
import logging
import math
import os
import re
import zipfile
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import polars as pl
import pytest

from orca.demo import (
    Filing,
    Fixtures,
    Holding,
    bulk_zip,
    fixture_sources,
    listing,
    live_frames,
)
from orca.prices import DAILY_SCHEMA
from orca.quarters import q_end, q_index, q_of_date
from orca.run import Sources, deadline_quarter, production_sources, run_weekly
from orca.sec.bulk import parse_bulk_zip
from orca.sec.live import FILINGS_SCHEMA
from orca.storage import Lake

BERKSHIRE, PERSHING = 1067983, 1336528  # Pershing Square Capital Management: 8-15 positions
GOLDEN_FUNDS = {BERKSHIRE: "BERKSHIRE", PERSHING: "PERSHING"}  # CIK -> a word of the filer's name
GOLDEN_TODAY = date(2026, 10, 31)  # fixed, so later quarters never change the snapshot
LAST_Q = deadline_quarter(GOLDEN_TODAY)
FIRST_Q = LAST_Q - 7  # the latest 8 quarters
SNAPSHOTS = Path(__file__).parent / "golden"
SNAPSHOT_FILES = ("summary.json", "positions.json")
CONCENTRATED_BELOW = 20  # positions
FLOAT_REL_TOL = 1e-9
FAILURE_FLAGS = {  # a run that tolerated one of these has fetched less than it should
    "bulk_list_failed",
    "no_bulk_zips",
    "fetch_failed",
    "bulk_unreadable",
    "live_failed",
    "cusip_mapping_failed",
    "security_lookup_failed",
    "tbill_failed",
}
ZIP_DIR = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/"

# --- the golden test --------------------------------------------------------------------------


@pytest.fixture
def quiet_httpx():
    """httpx logs each request's URL at INFO, and a FRED URL carries the API key."""
    log = logging.getLogger("httpx")
    before = log.level
    log.setLevel(logging.WARNING)
    yield
    log.setLevel(before)


@pytest.mark.network
@pytest.mark.skipif(
    os.environ.get("ORCA_NETWORK") != "1",
    reason="needs the real SEC, OpenFIGI, Tiingo and FRED: set ORCA_NETWORK=1 and the keys",
)
def test_golden_funds(tmp_path, quiet_httpx):
    stats = run_weekly(
        Lake(tmp_path / "lake"),
        tmp_path / "out",
        golden_sources(production_sources()),
        GOLDEN_TODAY,
        compress=False,
    )

    check_golden(stats, SNAPSHOTS)


def check_golden(stats, snapshots: Path) -> None:
    """The golden test's checks on a run's result, against (or into) the snapshot folder."""
    assert stats.last_q == LAST_Q
    assert [f for f in stats.flags if incomplete(f)] == []  # a partial fetch is no snapshot
    written = []
    for cik, word in GOLDEN_FUNDS.items():
        docs = {
            name: json.loads((stats.staging / "fund" / str(cik) / name).read_text())
            for name in SNAPSHOT_FILES
        }
        summary = docs["summary.json"]
        assert word in summary["name"].upper(), f"CIK {cik} is {summary['name']!r}"
        assert summary["quarters"]["q"] == list(range(FIRST_Q, LAST_Q + 1))
        assert broken_bridges(summary["quarters"]) == []
        if cik == PERSHING:
            assert summary["n_holdings"] < CONCENTRATED_BELOW

        for name, doc in docs.items():
            snapshot = snapshots / str(cik) / name
            if not snapshot.exists():
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                snapshot.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
                written.append(f"{cik}/{name}")
            else:
                diff = first_difference(doc, json.loads(snapshot.read_text()))
                assert diff is None, f"CIK {cik} {name} differs from its snapshot at {diff}"

    if written:
        pytest.fail(
            f"snapshots written to tests/golden, not accepted: {', '.join(written)}. Hand-check "
            "each fund against its 13F on EDGAR (share counts of two holdings, one quarter's "
            "total value), note the numbers in the commit message, commit the files and run again."
        )


# --- narrowing a real run to two funds (offline) ------------------------------------------------


def _url(name: str) -> str:
    return ZIP_DIR + name


def test_bulk_zip_end_from_both_naming_schemes():
    assert zip_end(_url("01jun2024-31aug2024_form13f.zip")) == date(2024, 8, 31)
    assert zip_end(_url("2023q4_form13f.zip")) == date(2023, 12, 31)
    assert zip_end(_url("something_else.zip")) is None


def test_zips_ending_before_the_first_quarter_ends_are_not_wanted():
    assert q_end(FIRST_Q) == date(2024, 9, 30)  # the filings of FIRST_Q come after this day
    assert not wanted_zip(_url("01jun2024-31aug2024_form13f.zip"))
    assert not wanted_zip(_url("2024q2_form13f.zip"))
    assert wanted_zip(_url("01jul2024-30sep2024_form13f.zip"))
    assert wanted_zip(_url("01sep2026-30nov2026_form13f.zip"))
    assert wanted_zip(_url("unknown_name.zip"))  # a name we cannot read is downloaded, not lost


def _holdings(cusip: str) -> list[Holding]:
    return [Holding("ISSUER", cusip, 5_000_000.0, 100)]


def _filings() -> list[Filing]:
    other = 999
    return [
        Filing("0000000001-24-000001", BERKSHIRE, "BERKSHIRE HATHAWAY INC", FIRST_Q - 1,
               date(2024, 8, 14), _holdings("037833100")),  # before the window
        Filing("0000000001-24-000002", BERKSHIRE, "BERKSHIRE HATHAWAY INC", FIRST_Q,
               date(2024, 11, 14), _holdings("037833100")),
        Filing("0000000001-25-000003", BERKSHIRE, "BERKSHIRE HATHAWAY INC", FIRST_Q + 1,
               date(2025, 2, 14), _holdings("037833100")),
        Filing("0000000002-24-000004", PERSHING, "PERSHING SQUARE CAPITAL", FIRST_Q,
               date(2024, 11, 14), _holdings("78462F103")),
        Filing("0000000003-24-000005", other, "SOME OTHER FUND LP", FIRST_Q,
               date(2024, 11, 14), _holdings("594918104")),
    ]  # fmt: skip


def test_keep_funds_keeps_the_two_funds_in_the_window(tmp_path):
    path = tmp_path / "x_form13f.zip"
    path.write_bytes(bulk_zip(_filings()))

    keep_funds(path, set(GOLDEN_FUNDS), FIRST_Q, LAST_Q)

    filings, holdings = parse_bulk_zip(path)
    assert sorted(zip(filings["cik"].to_list(), filings["period"].to_list())) == [
        (BERKSHIRE, FIRST_Q),
        (BERKSHIRE, FIRST_Q + 1),
        (PERSHING, FIRST_Q),
    ]
    assert sorted(holdings["cusip"].to_list()) == ["037833100", "037833100", "78462F103"]
    with zipfile.ZipFile(path) as z:  # only the three tables the parser reads
        assert sorted(z.namelist()) == ["COVERPAGE.tsv", "INFOTABLE.tsv", "SUBMISSION.tsv"]


def test_golden_sources_narrow_the_real_ones(tmp_path):
    zips = {
        _url("01jun2024-31aug2024_form13f.zip"): bulk_zip(_filings()),  # ends before FIRST_Q does
        _url("01sep2024-30nov2024_form13f.zip"): bulk_zip(_filings()),
    }

    def download(url: str, dest: Path) -> None:
        dest.write_bytes(zips[url])

    def boom(*args, **kwargs):
        raise AssertionError("the golden run reads no live filings and no other service")

    real = Sources(
        list_bulk_zips=lambda: list(zips),
        download_bulk_zip=download,
        live_filings=boom,
        figi=None,
        sec_tickers=boom,
        sic=boom,
        shares_outstanding=boom,
        prices=None,
        tbill=boom,
    )

    sources = golden_sources(real)

    assert sources.list_bulk_zips() == [_url("01sep2024-30nov2024_form13f.zip")]
    dest = tmp_path / "z.zip"
    sources.download_bulk_zip(_url("01sep2024-30nov2024_form13f.zip"), dest)
    assert set(parse_bulk_zip(dest)[0]["cik"].to_list()) == set(GOLDEN_FUNDS)
    filings, holdings = sources.live_filings(date(2024, 12, 1), date(2024, 12, 8), {})
    assert filings.schema == FILINGS_SCHEMA
    assert filings.is_empty() and holdings.is_empty()
    assert sources.tbill is real.tbill and sources.prices is real.prices


def _synthetic_fixtures() -> Fixtures:
    """The golden funds (CIKs and names as on EDGAR) holding one flat-priced stock for the 8
    quarters: what the golden run would see, without the network."""
    rows = [Holding("WIDGET CORP", "000000AB5", 400.0, 10)]
    filings = [
        Filing(f"{cik:010d}-{q:02d}-000001", cik, name, q, q_end(q) + timedelta(days=40), rows)
        for q in range(FIRST_Q, LAST_Q + 1)
        for cik, name in ((BERKSHIRE, "BERKSHIRE HATHAWAY INC"), (PERSHING, "PERSHING SQUARE LP"))
    ]
    days = [d for i in range(1000) if (d := date(2024, 1, 2) + timedelta(days=i)).weekday() < 5]
    bars = pl.DataFrame(
        [(d, 40.0, 40.0, 40.0, 40.0, 1e6, 1.0, 0.0) for d in days if d <= GOLDEN_TODAY],
        schema=DAILY_SCHEMA,
        orient="row",
    )
    live_f, live_h = live_frames([])
    return Fixtures(
        zips={_url("2026q4_form13f.zip"): bulk_zip(filings)},
        live_filings=live_f,
        live_holdings=live_h,
        figi={"000000AB5": listing("BBG0TEST0001", "WIDG", "WIDGET CORP")},
        sec_tickers=pl.DataFrame(
            [("WIDG", 5001, "WIDGET CORP")],
            schema={"ticker": pl.String, "cik": pl.Int64, "title": pl.String},
            orient="row",
        ),
        sic={5001: 3571},
        shares_out={5001: 1e9},
        prices={"WIDG": bars},
        tbill={2024: 0.05, 2025: 0.04, 2026: 0.04},
    )


def test_golden_checks_write_then_compare_snapshots(tmp_path):
    stats = run_weekly(
        Lake(tmp_path / "lake"),
        tmp_path / "out",
        golden_sources(fixture_sources(_synthetic_fixtures())),
        GOLDEN_TODAY,
        compress=False,
    )
    snapshots = tmp_path / "golden"

    with pytest.raises(pytest.fail.Exception, match="snapshots written to tests/golden, not acc"):
        check_golden(stats, snapshots)  # no snapshots yet: written, and the test fails
    written = sorted(p.relative_to(snapshots).as_posix() for p in snapshots.rglob("*.json"))
    assert written == [
        f"{BERKSHIRE}/positions.json",
        f"{BERKSHIRE}/summary.json",
        f"{PERSHING}/positions.json",
        f"{PERSHING}/summary.json",
    ]

    check_golden(stats, snapshots)  # the same run matches what it wrote

    path = snapshots / str(PERSHING) / "positions.json"
    doc = json.loads(path.read_text())
    doc["avg_cost"][0] += 1
    path.write_text(json.dumps(doc))
    with pytest.raises(AssertionError, match=r"positions.json differs .* at \$\.avg_cost\[0\]"):
        check_golden(stats, snapshots)


def test_incomplete_flags():
    assert incomplete({"type": "tbill_failed", "url": "u", "status": 500})
    assert incomplete({"type": "prices", "failed_count": 2, "stopped": None})
    assert incomplete({"type": "prices", "failed_count": 0, "stopped": "rate limit"})
    assert not incomplete({"type": "prices", "failed_count": 0, "stopped": None})
    assert not incomplete({"type": "price_mismatch"})


def test_broken_bridges():
    good = {"q": [1, 2], "start": [0.0, 100.0], "end": [100.0, 130.0],
            "market_move": [0.0, 20.0], "net_buying": [100.0, 5.0],
            "trade_gains": [0.0, 5.0]}  # fmt: skip
    assert broken_bridges(good) == []
    bad = {**good, "end": [100.0, 140.0]}
    assert broken_bridges(bad) == [2]


def test_first_difference_names_the_path():
    assert first_difference({"a": [1, {"b": 2.5}]}, {"a": [1, {"b": 2.5}]}) is None
    nested = first_difference({"a": [1, {"b": 2.5}]}, {"a": [1, {"b": 2.6}]})
    assert nested == "$.a[1].b: 2.5 != 2.6"
    assert first_difference({"a": [1]}, {"a": [1, 2]}) == "$.a: 1 items != 2"
    assert first_difference({"a": 1}, {"b": 1}) == "$: keys differ: ['a'] vs ['b']"
    assert first_difference({"a": None}, {"a": 0}) == "$.a: None != 0"


def test_first_difference_tolerates_float_noise_only():
    assert first_difference({"a": [1.0, 2.0e9]}, {"a": [1.0 + 1e-12, 2.0e9 * (1 + 1e-12)]}) is None
    assert first_difference({"a": 1}, {"a": 1.0}) is None
    assert first_difference({"a": 100.0}, {"a": 100.0 * (1 + 1e-6)}) == (
        f"$.a: 100.0 != {100.0 * (1 + 1e-6)!r}"
    )
    assert first_difference({"a": True}, {"a": 1}) == "$.a: True != 1"  # a flag is not a number


# --- helpers ------------------------------------------------------------------------------------

_MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
_RANGE_NAME = re.compile(r"\d{2}[a-z]{3}\d{4}-(\d{2})([a-z]{3})(\d{4})_form13f\.zip")
_QUARTER_NAME = re.compile(r"(\d{4})q([1-4])_form13f\.zip")
_SEC_DATE = "%d-%b-%Y"  # 30-JUN-2026, as in the data sets' tables


def zip_end(url: str) -> date | None:
    """The last filing day a bulk ZIP covers, read from its name ("01jun2024-31aug2024_form13f.zip"
    or "2023q4_form13f.zip"); None when the name is neither."""
    name = PurePosixPath(urlsplit(url).path).name.lower()
    try:
        if match := _RANGE_NAME.fullmatch(name):
            return date(int(match[3]), _MONTHS[match[2]], int(match[1]))
        if match := _QUARTER_NAME.fullmatch(name):
            return q_end(q_index(int(match[1]), int(match[2])))
    except (KeyError, ValueError):  # a month or day that does not exist
        pass
    return None


def wanted_zip(url: str) -> bool:
    """Whether a bulk ZIP can hold filings for the window: not one that ended before the window's
    first quarter did (a name we cannot read is wanted)."""
    end = zip_end(url)
    return end is None or end >= q_end(FIRST_Q)


def _fields(line: bytes) -> list[str]:
    return line.decode("utf-8-sig", "replace").rstrip("\r\n").split("\t")


def _wanted_accessions(rows, ciks: set[int], first_q: int, last_q: int) -> set[str]:
    header = _fields(next(rows))
    names = ("ACCESSION_NUMBER", "CIK", "PERIODOFREPORT")
    accession, cik, period = (header.index(name) for name in names)
    wanted = set()
    for line in rows:
        fields = _fields(line)
        try:
            q = q_of_date(datetime.strptime(fields[period], _SEC_DATE).date())
            wanted_fund = int(fields[cik]) in ciks
        except (ValueError, IndexError):
            continue
        if wanted_fund and first_q <= q <= last_q:
            wanted.add(fields[accession])
    return wanted


def keep_funds(path: Path, ciks: set[int], first_q: int, last_q: int) -> None:
    """Rewrite the bulk ZIP at `path` with only the filings of `ciks` for report quarters
    first_q..last_q, and only the three tables the parser reads. The info table is read line by
    line: a quarter's holds millions of rows."""
    partial = path.with_name(path.name + ".part")
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as dst:
        members = {PurePosixPath(n).name.upper(): n for n in src.namelist()}
        with src.open(members["SUBMISSION.TSV"]) as rows:
            keep = _wanted_accessions(rows, ciks, first_q, last_q)
        for table in ("SUBMISSION", "COVERPAGE", "INFOTABLE"):
            name = members[f"{table}.TSV"]
            with src.open(name) as rows, dst.open(name, "w") as out:
                header = next(rows)
                out.write(header)
                column = _fields(header).index("ACCESSION_NUMBER")
                for line in rows:
                    value = line.split(b"\t", column + 1)[column].rstrip(b"\r\n")
                    if value.decode("utf-8", "replace") in keep:
                        out.write(line)
    partial.replace(path)


def golden_sources(real: Sources) -> Sources:
    """`real` narrowed to the golden funds: only the bulk ZIPs that can hold the window's filings,
    each cut down to the golden funds as it is downloaded, and no live reading (the snapshot comes
    from the bulk data sets alone, so a late amendment cannot move it)."""

    def download(url: str, dest: Path) -> None:
        real.download_bulk_zip(url, dest)
        keep_funds(dest, set(GOLDEN_FUNDS), FIRST_Q, LAST_Q)

    return replace(
        real,
        list_bulk_zips=lambda: [url for url in real.list_bulk_zips() if wanted_zip(url)],
        download_bulk_zip=download,
        live_filings=lambda since, until, stats: live_frames([]),
    )


def incomplete(flag: dict) -> bool:
    """Whether a run flag says the run fetched less than it should have."""
    if flag["type"] == "prices":
        return bool(flag["failed_count"] or flag["stopped"])
    return flag["type"] in FAILURE_FLAGS


def broken_bridges(quarters: dict) -> list[int]:
    """The quarters of a published summary whose end is not start + market move + net buying +
    trade gains, to one part in a million of the largest amount."""
    columns = ("q", "start", "end", "market_move", "net_buying", "trade_gains")
    rows = zip(*(quarters[column] for column in columns))
    broken = []
    for q, start, end, move, net, gains in rows:
        scale = max(1.0, abs(start), abs(end), abs(move), abs(net), abs(gains))
        if abs(end - (start + move + net + gains)) > 1e-6 * scale:
            broken.append(q)
    return broken


def _is_number(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def first_difference(actual, expected, path: str = "$") -> str | None:
    """Where two JSON documents first differ, as "$.key[3].key: actual != expected"; None when
    they are equal. Numbers are equal within FLOAT_REL_TOL, so summation noise is no change."""
    if isinstance(actual, dict) and isinstance(expected, dict):
        if actual.keys() != expected.keys():
            return f"{path}: keys differ: {sorted(actual)} vs {sorted(expected)}"
        pairs = [(f"{path}.{key}", actual[key], expected[key]) for key in sorted(actual)]
    elif isinstance(actual, list) and isinstance(expected, list):
        if len(actual) != len(expected):
            return f"{path}: {len(actual)} items != {len(expected)}"
        pairs = [(f"{path}[{i}]", a, e) for i, (a, e) in enumerate(zip(actual, expected))]
    elif _is_number(actual) and _is_number(expected):
        same = math.isclose(actual, expected, rel_tol=FLOAT_REL_TOL)
        return None if same else f"{path}: {actual!r} != {expected!r}"
    else:
        same = type(actual) is type(expected) and actual == expected  # True is not 1
        return None if same else f"{path}: {actual!r} != {expected!r}"
    return next((d for p, a, e in pairs if (d := first_difference(a, e, p))), None)
