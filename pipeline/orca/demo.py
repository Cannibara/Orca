"""Synthetic demo dataset: made-up funds and prices that run the whole pipeline offline.

Twelve fictional funds hold 24 real-looking tickers (and SPY, the benchmark) from 2014 to 2026.
Every fund name, holding, price and rate here is invented; nothing is a real fund's portfolio or
return. The inputs come in the shapes the real sources deliver: bulk ZIPs in the SEC's TSV
layout (read by the real parser), live filings as `fetch_new_filings` returns them, an OpenFIGI
stub behind a real FigiClient, raw (unadjusted) daily bars with splits and dividends, and yearly
T-bill rates. The same seed gives the same bytes.

Built in: two stocks that split while held (one of them twice), a stock delisted while held
(one fund still reports it a quarter later), a split recorded in the open quarter, restatement
and new-holdings amendments (one restating a 2019 quarter, filed in October 2026), a single
missed quarter, a two-quarter gap, a fund gone inactive, a young fund, a late filer, an early
filer of the next quarter, options and a bond, a reported value off by 100x and a position that
triples exactly.
"""

import io
import json
import math
import random
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import polars as pl

from orca.http import FetchError, FigiClient
from orca.prices import DAILY_SCHEMA, FixtureSource
from orca.publish import read_json
from orca.quarters import q_end, q_index, q_of_date
from orca.run import Sources, copy_published, cusip_check_digit, run_weekly
from orca.sec.bulk import raw_holdings
from orca.sec.live import FILINGS_SCHEMA, INFO_SCHEMA
from orca.storage import Lake

DEMO_TODAY = date(2026, 10, 30)  # the demo is built as of this day
PRICES_FROM = date(2013, 1, 2)
PRICES_UNTIL = date(2026, 12, 31)  # beyond DEMO_TODAY, so tests can run later weeks
BULK_UNTIL = date(2026, 6, 30)  # bulk ZIPs hold filings up to here; later ones are read live
BULK_URL = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/{name}"
VALUE_DOLLARS_FROM = date(2023, 1, 3)
SPY = "SPY"
SPY_CUSIP = "78462F103"

# ticker, issuer name, SIC code, shares outstanding today
STOCKS = (
    ("NVDA", "NVIDIA CORP", 3674, 24.4e9),
    ("MSFT", "MICROSOFT CORP", 7372, 7.4e9),
    ("AAPL", "APPLE INC", 3571, 15.0e9),
    ("AVGO", "BROADCOM INC", 3674, 9.4e9),
    ("GOOGL", "ALPHABET INC", 7370, 12.1e9),
    ("META", "META PLATFORMS INC", 7370, 2.5e9),
    ("NFLX", "NETFLIX INC", 4841, 0.43e9),
    ("AMZN", "AMAZON COM INC", 5961, 10.6e9),
    ("HD", "HOME DEPOT INC", 5211, 0.99e9),
    ("CMG", "CHIPOTLE MEXICAN GRILL INC", 5812, 1.35e9),
    ("COST", "COSTCO WHSL CORP NEW", 5411, 0.44e9),
    ("UNH", "UNITEDHEALTH GROUP INC", 8011, 0.91e9),
    ("LLY", "LILLY ELI & CO", 2834, 0.9e9),
    ("JPM", "JPMORGAN CHASE & CO", 6021, 2.8e9),
    ("V", "VISA INC", 7389, 1.9e9),
    ("BAC", "BANK AMER CORP", 6021, 7.6e9),
    ("XOM", "EXXON MOBIL CORP", 2911, 4.3e9),
    ("BTU", "PEABODY ENERGY CORP", 1221, 0.12e9),
    ("CAT", "CATERPILLAR INC", 3531, 0.48e9),
    ("GE", "GENERAL ELECTRIC CO", 3724, 1.07e9),
    ("FCX", "FREEPORT-MCMORAN INC", 1000, 1.44e9),
    ("NEE", "NEXTERA ENERGY INC", 4911, 2.06e9),
    ("PLD", "PROLOGIS INC", 6798, 0.93e9),
    ("TSLA", "TESLA INC", 3711, 3.2e9),
)
SPLITS = {
    "NVDA": ((date(2021, 7, 20), 4.0), (date(2024, 6, 10), 10.0)),
    "TSLA": ((date(2020, 8, 31), 5.0), (date(2022, 8, 25), 3.0)),
    "CMG": ((date(2026, 10, 21), 2.0),),  # in the open quarter: tests record it late
}
# Stocks only some funds may hold (each of them holds it from its first quarter).
NICHE = {"CMG": ("Kelpwood Capital LP", "Orcinus Lane Capital")}
# A stock a fund holds from its first quarter, untouched by the random walk, until it delists.
KEEP = {"Brinestone Value Partners": "BTU"}
DELISTED = {"BTU": date(2019, 8, 15)}  # last trading day
TBILL = {
    2013: 0.0006, 2014: 0.0003, 2015: 0.0005, 2016: 0.0032, 2017: 0.0093, 2018: 0.0194,
    2019: 0.0206, 2020: 0.0036, 2021: 0.0005, 2022: 0.0202, 2023: 0.0507, 2024: 0.0497,
    2025: 0.0420, 2026: 0.0385,
}  # fmt: skip


@dataclass(frozen=True)
class _Profile:
    name: str
    start_q: int
    end_q: int  # last quarter filed
    book: float  # dollars at the start
    n_init: int
    max_pos: int
    skip: tuple[int, ...] = ()  # quarters not filed


FUND_CIK0 = 9100001
FUNDS = (
    _Profile("Kelpwood Capital LP", q_index(2014, 1), q_index(2026, 2), 3.0e9, 7, 10),
    _Profile("Halyard Point Partners", q_index(2014, 1), q_index(2026, 2), 1.6e9, 6, 9),
    _Profile("Lanternfish Capital Management", q_index(2015, 1), q_index(2026, 2), 6.0e9, 12, 18),
    _Profile(
        "Tern Harbor Equity", q_index(2016, 1), q_index(2026, 2), 1.1e9, 6, 9, (q_index(2018, 3),)
    ),
    _Profile("Saltglass Advisors", q_index(2014, 3), q_index(2026, 1), 5.5e8, 5, 8),
    _Profile("Brinestone Value Partners", q_index(2014, 1), q_index(2026, 2), 1.4e9, 7, 10),
    _Profile("Driftwood Capital", q_index(2024, 1), q_index(2026, 2), 1.2e9, 6, 9),
    _Profile(
        "Gullwing Investors",
        q_index(2014, 1),
        q_index(2026, 2),
        1.3e9,
        6,
        9,
        (q_index(2017, 2), q_index(2017, 3)),
    ),
    _Profile("Seastack Asset Management", q_index(2014, 1), q_index(2026, 2), 1.2e10, 18, 24),
    _Profile("Cobblereef Holdings", q_index(2014, 1), q_index(2023, 4), 9.0e8, 6, 9),
    _Profile("Orcinus Lane Capital", q_index(2015, 3), q_index(2026, 3), 2.2e9, 6, 9),
    _Profile("Undertow Partners", q_index(2014, 2), q_index(2026, 2), 2.5e9, 7, 10),
)
LAST_Q = q_index(2026, 2)  # the deadline quarter as of DEMO_TODAY
CROWDED = (
    "Kelpwood Capital LP",
    "Halyard Point Partners",
    "Tern Harbor Equity",
    "Undertow Partners",
)


# --- filings in the SEC's shapes ------------------------------------------------------------


@dataclass(frozen=True)
class Holding:
    """One information-table row. `value_usd` is in dollars; the TSV / parser units follow the
    filing date."""

    issuer: str
    cusip: str
    value_usd: float
    shares: float
    sh_type: str = "SH"
    put_call: str = ""


@dataclass
class Filing:
    accession: str
    cik: int
    manager: str
    period: int  # quarter index
    filed: date
    rows: list[Holding] = field(default_factory=list)
    form: str = "13F-HR"
    amendment: str = ""  # "" | "RESTATEMENT" | "NEW HOLDINGS"


def _sec_date(d: date) -> str:
    return d.strftime("%d-%b-%Y").upper()


def _reported_value(value_usd: float, filed: date) -> str:
    """VALUE as the filing states it: thousands of dollars before 2023-01-03, dollars after."""
    return str(round(value_usd if filed >= VALUE_DOLLARS_FROM else value_usd / 1000))


def _tsv(header: list[str], rows: list[list[str]]) -> str:
    return "\n".join("\t".join(r) for r in [header, *rows]) + "\n"


# The SEC's column order in each TSV, including columns the parser never reads.
SUBMISSION_COLUMNS = ("ACCESSION_NUMBER", "FILING_DATE", "SUBMISSIONTYPE", "CIK", "PERIODOFREPORT")
COVERPAGE_COLUMNS = (
    "ACCESSION_NUMBER", "REPORTCALENDARORQUARTER", "ISAMENDMENT", "AMENDMENTTYPE",
    "FILINGMANAGER_NAME", "REPORTTYPE",
)  # fmt: skip
INFOTABLE_COLUMNS = (
    "ACCESSION_NUMBER", "INFOTABLE_SK", "NAMEOFISSUER", "TITLEOFCLASS", "CUSIP", "FIGI", "VALUE",
    "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL", "INVESTMENTDISCRETION", "OTHERMANAGER",
    "VOTING_AUTH_SOLE", "VOTING_AUTH_SHARED", "VOTING_AUTH_NONE",
)  # fmt: skip


def bulk_zip(filings: list[Filing]) -> bytes:
    """A bulk data-set ZIP holding `filings`, laid out like the SEC's."""
    submission, cover, info = [], [], []
    for f in filings:
        period = _sec_date(q_end(f.period))
        submission.append([f.accession, _sec_date(f.filed), f.form, f"{f.cik:010d}", period])
        amended = "Y" if f.amendment else "N"
        cover.append([f.accession, period, amended, f.amendment, f.manager, "13F HOLDINGS REPORT"])
        for i, h in enumerate(f.rows, start=1):
            shares = str(round(h.shares))
            title = "COM" if h.sh_type == "SH" else "NOTE"
            value = _reported_value(h.value_usd, f.filed)
            info.append(
                [f.accession, str(i), h.issuer, title, h.cusip, "", value, shares, h.sh_type]
                + [h.put_call, "SOLE", "", shares, "0", "0"]
            )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for name, header, rows in (
            ("SUBMISSION.tsv", SUBMISSION_COLUMNS, submission),
            ("COVERPAGE.tsv", COVERPAGE_COLUMNS, cover),
            ("INFOTABLE.tsv", INFOTABLE_COLUMNS, info),
        ):
            member = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # fixed: same bytes
            z.writestr(member, _tsv(list(header), rows))
    return buffer.getvalue()


def live_frames(filings: list[Filing]) -> tuple[pl.DataFrame, pl.DataFrame]:
    """`filings` as `fetch_new_filings` returns them: (filings, raw holdings), source "live"."""
    amendment = {"RESTATEMENT": "restatement", "NEW HOLDINGS": "new_holdings"}
    meta = pl.DataFrame(
        [
            (
                f.accession,
                f.cik,
                f.period,
                f.filed,
                f.form,
                amendment.get(f.amendment),
                f.manager,
                "live",
            )
            for f in filings
        ],
        schema=FILINGS_SCHEMA,
        orient="row",
    )
    info = pl.DataFrame(
        [
            (
                f.accession, h.issuer, "COM", h.cusip, _reported_value(h.value_usd, f.filed),
                str(round(h.shares)), h.sh_type, h.put_call or None,
            )
            for f in filings
            for h in f.rows
        ],
        schema=INFO_SCHEMA,
        orient="row",
    )  # fmt: skip
    holdings, _ = raw_holdings(info, meta.select("accession", "filed"), [])
    return meta, holdings


# --- the fixture sources --------------------------------------------------------------------


@dataclass
class Fixtures:
    """Everything a run fetches, prepared in memory. `zips` maps url -> ZIP bytes (None: the
    download fails); live filings are served by filing date."""

    zips: dict[str, bytes | None]
    live_filings: pl.DataFrame
    live_holdings: pl.DataFrame
    figi: dict[str, dict]  # cusip -> OpenFIGI listing
    sec_tickers: pl.DataFrame
    sic: dict[int, int]
    shares_out: dict[int, float]
    prices: dict[str, pl.DataFrame]
    tbill: dict[int, float]


def listing(figi: str, ticker: str, name: str, etf: bool = False) -> dict:
    """An OpenFIGI mapping result for one US listing."""
    return {
        "figi": figi,
        "compositeFIGI": figi,
        "ticker": ticker,
        "name": name,
        "exchCode": "US",
        "securityType": "ETP" if etf else "Common Stock",
    }


def figi_stub(results: dict[str, dict]) -> FigiClient:
    """A real FigiClient over a mock transport answering mapping jobs from `results`."""

    def handler(request: httpx.Request) -> httpx.Response:
        jobs = json.loads(request.content)
        body = [
            {"data": [results[job["idValue"]]]}
            if job["idValue"] in results
            else {"warning": "No identifier found."}
            for job in jobs
        ]
        return httpx.Response(200, json=body)

    return FigiClient(
        1e6, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None, jobs_per_request=100
    )


def _no_index_days(since: date, until: date) -> list[date]:
    days, day = [], since
    while day <= until:
        if day.weekday() >= 5:
            days.append(day)
        day += timedelta(days=1)
    return days


def fixture_sources(fx: Fixtures) -> Sources:
    def download(url: str, dest: Path) -> None:
        body = fx.zips.get(url)
        if body is None:
            raise FetchError(url, 503)
        Path(dest).write_bytes(body)

    def live(since: date, until: date, stats: dict) -> tuple[pl.DataFrame, pl.DataFrame]:
        filings = fx.live_filings.filter(pl.col("filed").is_between(since, until))
        holdings = fx.live_holdings.filter(
            pl.col("accession").is_in(filings["accession"].to_list())
        )
        stats.update(
            dropped_filings=0,
            dropped_holdings=0,
            failed_filings=0,
            failed_days=[],
            no_index_days=_no_index_days(since, until),
        )
        return filings, holdings

    return Sources(
        list_bulk_zips=lambda: list(fx.zips),
        download_bulk_zip=download,
        live_filings=live,
        figi=figi_stub(fx.figi),
        sec_tickers=lambda: fx.sec_tickers,
        sic=lambda cik: fx.sic.get(cik),
        shares_outstanding=lambda cik: fx.shares_out.get(cik),
        prices=FixtureSource(fx.prices),
        tbill=lambda: dict(fx.tbill),
    )


# --- synthetic prices -----------------------------------------------------------------------


def _trading_days() -> list[date]:
    days, day = [], PRICES_FROM
    while day <= PRICES_UNTIL:
        if day.weekday() < 5 and (day.month, day.day) not in ((1, 1), (7, 4), (12, 25)):
            days.append(day)
        day += timedelta(days=1)
    return days


def _adjusted_bars(
    rng: random.Random, days: list[date], p0: float, mu: float, sigma: float, yld: float
):
    """Bars on today's share basis: (day, open, high, low, close, volume, dividend)."""
    bars, close = [], p0
    daily_mu, daily_sigma = mu / 252, sigma / math.sqrt(252)
    paid = set()
    for day in days:
        prev = close
        close = prev * math.exp(daily_mu - daily_sigma**2 / 2 + daily_sigma * rng.gauss(0, 1))
        open_ = prev * math.exp(daily_sigma * 0.3 * rng.gauss(0, 1))
        high = max(open_, close) * (1 + abs(rng.gauss(0, 1)) * daily_sigma * 0.5)
        low = min(open_, close) * (1 - abs(rng.gauss(0, 1)) * daily_sigma * 0.5)
        volume = 2e6 * math.exp(0.4 * rng.gauss(0, 1))
        dividend = 0.0
        quarter = (day.year, (day.month - 1) // 3)
        if yld and day.month % 3 == 2 and day.day >= 15 and quarter not in paid:
            paid.add(quarter)
            dividend = close * yld / 4
        bars.append((day, open_, high, low, close, volume, dividend))
    return bars


def _raw_frame(bars, splits: tuple[tuple[date, float], ...]) -> pl.DataFrame:
    """Adjusted bars as the vendor serves them: prices before a split in pre-split dollars."""
    rows = []
    for day, open_, high, low, close, volume, dividend in bars:
        later = math.prod(f for d, f in splits if d > day)
        factor = next((f for d, f in splits if d == day), 1.0)
        rows.append(
            (
                day,
                open_ * later,
                high * later,
                low * later,
                close * later,
                volume / later,
                factor,
                dividend * later,
            )
        )
    return pl.DataFrame(rows, schema=DAILY_SCHEMA, orient="row")


def _prices(seed: int) -> tuple[dict[str, pl.DataFrame], dict[str, dict[int, float]]]:
    """Raw daily frames per ticker, and each stock's adjusted quarter-end close."""
    days = _trading_days()
    frames, quarter_close = {}, {}
    for ticker in [t for t, *_ in STOCKS] + [SPY]:
        rng = random.Random(f"{seed}-prices-{ticker}")
        if ticker == SPY:
            p0, mu, sigma, yld = 145.0, 0.11, 0.15, 0.017
        else:
            p0, mu, sigma = rng.uniform(15, 260), rng.uniform(-0.04, 0.24), rng.uniform(0.18, 0.42)
            yld = rng.choice((0.0, 0.0, 0.01, 0.02, 0.03))
        last_day = DELISTED.get(ticker, PRICES_UNTIL)
        bars = _adjusted_bars(rng, [d for d in days if d <= last_day], p0, mu, sigma, yld)
        frames[ticker] = _raw_frame(bars, SPLITS.get(ticker, ()))
        closes: dict[int, float] = {}
        for day, *_, close, _volume, _dividend in bars:
            closes[(day.year - 2013) * 4 + (day.month - 1) // 3] = close
        quarter_close[ticker] = closes
    return frames, quarter_close


# --- synthetic holdings ---------------------------------------------------------------------


def _cusip(i: int) -> str:
    """A made-up CUSIP with a valid check digit."""
    base = f"{910000 + 37 * i:06d}10"
    return base + cusip_check_digit(base)


def _unit(ticker: str) -> float:
    """Shares are held in multiples of the product of the stock's splits, so the reported
    (pre-split) count of every quarter is a whole number."""
    return math.prod(f for _, f in SPLITS.get(ticker, ()))


def _later_splits(ticker: str, q: int) -> float:
    return math.prod(f for d, f in SPLITS.get(ticker, ()) if d > q_end(q))


def _tradable(ticker: str, q: int) -> bool:
    return ticker not in DELISTED or q_end(q) < DELISTED[ticker]


def _simulate(
    seed: int, index: int, fund: _Profile, closes: dict[str, dict[int, float]]
) -> dict[int, dict[str, float]]:
    """Each quarter's holdings (ticker -> shares on today's basis) from the fund's first quarter
    to its last, a random walk of opens, adds, trims and exits plus the scripted events."""
    rng = random.Random(f"{seed}-fund-{index}")
    broad = fund.max_pos > 12
    universe = [t for t, *_ in STOCKS if fund.name in NICHE.get(t, (fund.name,))]
    held: dict[str, float] = {}
    history: dict[int, dict[str, float]] = {}

    def shares_for(ticker: str, dollars: float, q: int) -> float:
        unit = _unit(ticker)
        return max(1, round(dollars / closes[ticker][q] / unit)) * unit

    for q in range(fund.start_q, fund.end_q + 1):
        price = {t: _close_at(closes, t, q) for t in universe + [SPY]}
        book = sum(s * price[t] for t, s in held.items()) if held else fund.book
        if q == fund.start_q:
            picks = rng.sample([t for t in universe if _tradable(t, q + 1)], fund.n_init)
            picks += [t for t in NICHE if t in universe and t not in picks]
            picks += [t for t in (KEEP.get(fund.name),) if t and t not in picks]
            weights = [rng.random() ** (1.0 if broad else 2.0) + 0.15 for _ in picks]
            for t, w in zip(picks, weights):
                held[t] = shares_for(t, fund.book * 0.95 * w / sum(weights), q)
            if fund.name.startswith("Seastack"):
                held[SPY] = shares_for(SPY, fund.book * 0.05, q)
        else:
            for t in sorted(held):
                if t == SPY:
                    continue
                if not _tradable(t, q):  # delisted: gone (Brinestone reports it a quarter more)
                    if not (fund.name.startswith("Brinestone") and q == q_of_date(DELISTED[t])):
                        del held[t]
                    continue
                if KEEP.get(fund.name) == t:
                    continue
                x = rng.random()
                if x < 0.07 and len(held) > max(4, fund.n_init // 2):
                    del held[t]
                elif x < 0.25:
                    held[t] = max(
                        _unit(t),
                        held[t] - shares_for(t, held[t] * price[t] * rng.uniform(0.15, 0.45), q),
                    )
                elif x < 0.47:
                    held[t] += shares_for(t, held[t] * price[t] * rng.uniform(0.15, 0.6), q)
            if len(held) < fund.max_pos and rng.random() < 0.35:
                options = [t for t in universe if t not in held and _tradable(t, q + 1)]
                if options:
                    t = rng.choice(options)
                    held[t] = shares_for(t, book * rng.uniform(0.03, 0.12), q)
        if q > fund.start_q:
            _steer(rng, fund, q, held, price, shares_for, universe)
        if q == LAST_Q and fund.name in CROWDED:  # crowded buy of the latest quarter
            held["AVGO"] = held.get("AVGO", 0.0) + shares_for("AVGO", book * 0.07, q)
        if q == LAST_Q and fund.name.startswith("Seastack"):  # an outsized new bet: a conviction move
            bet = next(
                t
                for t in sorted(universe)
                if t not in held
                and t not in history[q - 1]
                and t != "AVGO"
                and _tradable(t, q + 1)
            )
            held[bet] = shares_for(bet, book * 0.25, q)
        if q == LAST_Q and fund.name.startswith("Driftwood"):  # triples exactly: a split suspect
            target = next(t for t in sorted(history[q - 1]) if t not in SPLITS and _tradable(t, q))
            held[target] = history[q - 1][target] * 3
        history[q] = dict(held)
    return history


def _steer(
    rng,
    fund: _Profile,
    q: int,
    held: dict[str, float],
    price: dict[str, float],
    shares_for,
    universe,
) -> None:
    """Keep the book near its path (the market plus inflows of 0.4% a quarter): buy when it is
    well below, trim the largest position when it is far above."""
    target = fund.book * price[SPY] / _SPY_START[fund.start_q] * 1.004 ** (q - fund.start_q)
    for _ in range(3):
        gap = target - sum(s * price[t] for t, s in held.items())
        if gap < -0.15 * target:
            largest = max((t for t in held if t != SPY), key=lambda t: held[t] * price[t])
            held[largest] = max(
                0.0,
                held[largest]
                - shares_for(largest, min(-gap, 0.5 * held[largest] * price[largest]), q),
            )
            if held[largest] <= 0:
                del held[largest]
            continue
        if gap <= 0.04 * target:
            return
        options = [t for t in universe if t not in held and _tradable(t, q + 1)]
        if options and len(held) < fund.max_pos and rng.random() < 0.5:
            t = rng.choice(options)
            held[t] = shares_for(t, min(gap, target * rng.uniform(0.05, 0.15)), q)
        else:
            t = rng.choice(sorted(t for t in held if t != SPY and _tradable(t, q)))
            held[t] += shares_for(t, min(gap, held[t] * price[t] * rng.uniform(0.2, 0.6)), q)


_SPY_START: dict[int, float] = {}  # SPY's quarter-end closes, filled by build_fixtures


def _close_at(closes: dict[str, dict[int, float]], ticker: str, q: int) -> float:
    """The stock's close at the end of quarter `q`, or its last close before (delisted)."""
    series = closes[ticker]
    return series[q] if q in series else series[max(k for k in series if k <= q)]


def _filed_on(rng: random.Random, q: int) -> date:
    day = q_end(q) + timedelta(days=rng.randint(28, 44))
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


@dataclass(frozen=True)
class _Stock:
    ticker: str
    issuer: str
    cusip: str


def build_fixtures(seed: int = 7) -> Fixtures:
    frames, closes = _prices(seed)
    _SPY_START.clear()
    _SPY_START.update(closes[SPY])
    stocks = {t: _Stock(t, issuer, _cusip(i)) for i, (t, issuer, *_rest) in enumerate(STOCKS)}
    stocks[SPY] = _Stock(SPY, "SPDR S&P 500 ETF TR", SPY_CUSIP)

    filings: list[Filing] = []
    for index, fund in enumerate(FUNDS):
        cik = FUND_CIK0 + index
        rng = random.Random(f"{seed}-filings-{index}")
        history = _simulate(seed, index, fund, closes)
        seq = 0

        def accession(filed: date) -> str:
            nonlocal seq
            seq += 1
            return f"{cik:010d}-{filed.year % 100:02d}-{seq:06d}"

        def rows(q: int, holdings: dict[str, float]) -> list[Holding]:
            out = []
            for t in sorted(holdings):
                close = _close_at(closes, t, q)
                raw = holdings[t] / _later_splits(t, q)
                out.append(Holding(stocks[t].issuer, stocks[t].cusip, holdings[t] * close, raw))
            return out

        for q in range(fund.start_q, fund.end_q + 1):
            if q in fund.skip:
                continue
            filed = date(2026, 10, 14) if q == q_index(2026, 3) else _filed_on(rng, q)
            filing = Filing(accession(filed), cik, fund.name, q, filed, rows(q, history[q]))
            filings.append(filing)
            if fund.name.startswith("Seastack"):
                book = sum(h.value_usd for h in filing.rows)
                spy_px = closes[SPY][q]
                put_shares = round(book * 0.01 / spy_px)
                filing.rows.append(
                    Holding(
                        stocks[SPY].issuer,
                        SPY_CUSIP,
                        put_shares * spy_px,
                        put_shares,
                        put_call="Put",
                    )
                )
                filing.rows.append(
                    Holding(
                        "ORCA DEMO FDG CORP 4.25% 2031",
                        "91DEMO2B7",
                        book * 0.005,
                        round(book * 0.005),
                        "PRN",
                    )
                )
            if fund.name.startswith("Brinestone") and q == LAST_Q:  # VALUE 100x too high on one row
                first = filing.rows[0]
                filing.rows[0] = Holding(
                    first.issuer, first.cusip, first.value_usd * 100, first.shares
                )
            _amend(filings, filing, fund, q, accession)
    bulk = [f for f in filings if f.filed <= BULK_UNTIL]
    live = [f for f in filings if f.filed > BULK_UNTIL]
    zips: dict[str, bytes | None] = {}
    by_quarter: dict[tuple[int, int], list[Filing]] = {}
    for f in sorted(bulk, key=lambda f: (f.filed, f.accession)):
        by_quarter.setdefault((f.filed.year, (f.filed.month - 1) // 3 + 1), []).append(f)
    for (year, quarter), group in sorted(by_quarter.items()):
        zips[BULK_URL.format(name=f"{year}q{quarter}_form13f.zip")] = bulk_zip(group)
    live_f, live_h = live_frames(sorted(live, key=lambda f: (f.filed, f.accession)))

    tickers = [(t, 7100001 + i, issuer) for i, (t, issuer, *_rest) in enumerate(STOCKS)]
    tickers.append((SPY, 7100099, "SPDR S&P 500 ETF TRUST"))
    return Fixtures(
        zips=zips,
        live_filings=live_f,
        live_holdings=live_h,
        figi={
            s.cusip: listing(f"BBG0DMX{i + 1:05d}", s.ticker, s.issuer, etf=s.ticker == SPY)
            for i, s in enumerate(stocks.values())
        },
        sec_tickers=pl.DataFrame(
            tickers, schema={"ticker": pl.String, "cik": pl.Int64, "title": pl.String}, orient="row"
        ),
        sic={7100001 + i: sic for i, (_, _, sic, _) in enumerate(STOCKS)},
        shares_out={7100001 + i: shares for i, (*_, shares) in enumerate(STOCKS)},
        prices=frames,
        tbill=dict(TBILL),
    )


def _amend(filings: list[Filing], original: Filing, fund: _Profile, q: int, accession) -> None:
    """The scripted amendments of a fund's quarter `q`."""
    restated_rows = None
    if fund.name.startswith("Undertow") and q == q_index(2020, 3):
        # The original under-reported one position; the restatement corrects it.
        restated_rows = list(original.rows)
        first = original.rows[0]
        original.rows[0] = Holding(
            first.issuer, first.cusip, first.value_usd * 0.8, round(first.shares * 0.8)
        )
        filed = date(2021, 2, 10)
    elif fund.name.startswith("Undertow") and q == q_index(2022, 1):
        # The original left one position out; a new-holdings amendment adds it.
        omitted = original.rows.pop()
        filed = date(2022, 6, 1)
        filings.append(
            Filing(
                accession(filed),
                original.cik,
                fund.name,
                q,
                filed,
                [omitted],
                "13F-HR/A",
                "NEW HOLDINGS",
            )
        )
    elif fund.name.startswith("Lanternfish") and q == LAST_Q:
        restated_rows = list(original.rows)
        first = original.rows[0]
        original.rows[0] = Holding(
            first.issuer, first.cusip, first.value_usd * 1.1, round(first.shares * 1.1)
        )
        filed = date(2026, 9, 15)
    elif fund.name.startswith("Halyard") and q == q_index(2019, 2):
        # Restated years later (filed in October 2026): one position half as big again.
        first = original.rows[0]
        restated_rows = [
            Holding(first.issuer, first.cusip, first.value_usd * 1.5, first.shares * 1.5),
            *original.rows[1:],
        ]
        filed = date(2026, 10, 20)
    if restated_rows is not None:
        filings.append(
            Filing(
                accession(filed),
                original.cik,
                fund.name,
                q,
                filed,
                restated_rows,
                "13F-HR/A",
                "RESTATEMENT",
            )
        )


def build_sources(seed: int = 7) -> Sources:
    """Fixture sources of the demo dataset: no network."""
    return fixture_sources(build_fixtures(seed))


# --- writing the demo ---------------------------------------------------------------------------


def write_demo(out: Path, seed: int = 7, compress: bool = True) -> int:
    """Run the pipeline on the demo dataset as of DEMO_TODAY and write the published files to
    `out` (replacing an earlier demo there); returns the number of files. `out` must be empty or
    hold an earlier demo (its manifest.json says which files to replace)."""
    out = Path(out)
    with tempfile.TemporaryDirectory() as tmp:
        lake, out_root = Lake(Path(tmp) / "lake"), Path(tmp) / "out"
        built = datetime(DEMO_TODAY.year, DEMO_TODAY.month, DEMO_TODAY.day, tzinfo=UTC)
        stats = run_weekly(
            lake,
            out_root,
            build_sources(seed),
            DEMO_TODAY,
            full=True,
            compress=compress,
            built=built,
        )
        _clear_demo(out)
        copy_published(stats.staging, out_root, out)
    return sum(1 for _ in out.rglob("*.json"))


def _clear_demo(out: Path) -> None:
    if not out.exists():
        return
    manifest = out / "manifest.json"
    if not manifest.exists():
        if any(out.iterdir()):
            raise ValueError(f"{out} is not empty and holds no demo manifest; not overwriting it")
        return
    try:
        listed = read_json(manifest)["files"]
    except Exception:
        listed = read_json(manifest, compressed=False)["files"]
    for rel in [*listed, "manifest.json"]:
        (out / rel).unlink(missing_ok=True)
    for folder in sorted((p for p in out.rglob("*") if p.is_dir()), reverse=True):
        if not any(folder.iterdir()):
            folder.rmdir()
