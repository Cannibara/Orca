"""Hand-built funds for the workbook's edge-case tests: a handful of quarters and one to four
stocks, each stock with price bars of its own (or none), run through the real pipeline (ingest,
lake, engine) and turned into FundInputs, so the workbook is checked on exactly what the engine
used. `edge_case_inputs` is the one list of them (the site-parity fixture reads it too)."""

import math
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import polars as pl
from conftest import DemoRun, demo_batch

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
from orca.quarters import BASE_YEAR, q_end, q_index, q_start
from orca.run import cusip_check_digit, run_weekly
from orca.run.compute import FundResult, Prepared
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.storage import Lake
from orca.workbook.inputs import (
    FundInputs,
    OrcaFund,
    OrcaStock,
    StockInputs,
    build_inputs,
)

FUND = 1001
ZIP_URL = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2024q3_form13f.zip"
TODAY = date(2024, 10, 1)  # the deadline quarter is Q2 2024 (q 45)
LATEST_DAY = date(2024, 9, 27)  # a stock's "latest" bar, after the deadline quarter
TICKERS = ("ALFA", "BRAV", "CHAR", "DELT")
TBILL = {2013 + i: 0.005 * (i + 1) for i in range(14)}  # 0.5% in 2013 .. 7% in 2026

# the quarters the cases use: Q1 2020, then Q1 and Q2 2024
Q1_20, Q1_24, Q2_24 = q_index(2020, 1), q_index(2024, 1), q_index(2024, 2)


def issuer(ticker: str) -> str:
    return f"{ticker} CORP"


def cusip_of(ticker: str) -> str:
    """A made-up CUSIP with a valid check digit, one per ticker of TICKERS."""
    base = f"90{TICKERS.index(ticker) + 1:04d}10"
    return base + cusip_check_digit(base)


def held(ticker: str, shares: float, value: float) -> Holding:
    """One information-table row: `shares` of `ticker` worth `value` dollars as filed."""
    return Holding(issuer(ticker), cusip_of(ticker), value, shares)


def stock_prices(
    close: dict[int, float],
    *,
    vwap: dict[int, float] | None = None,
    div: dict[int, float] | None = None,
    split: dict[int, float] | None = None,
    latest: float | None = None,
) -> pl.DataFrame:
    """Raw daily bars as the vendor serves them, two a quarter: on the 15th day a bar whose
    typical price is the quarter's VWAP (its volume is the only one, so VWAP = that price;
    default the close) and that pays the quarter's dividend, and on the last day a bar with no
    volume closing at the quarter's close. `latest` adds a bar on LATEST_DAY (after the deadline
    quarter) closing there.

    `close`, `vwap` and `div` are on today's share basis. `split` {q: factor} splits the stock
    on the 15th day of quarter q: earlier bars carry pre-split dollars (prices and dividends
    times the factor, volume divided by it) and that day's bar carries the factor."""
    vwap, div, split = vwap or {}, div or {}, split or {}
    split_day = {q: q_start(q) + timedelta(days=14) for q in split}

    def before(day: date) -> float:
        """The product of the splits after `day`: today's price x it = the price that day."""
        return math.prod(split[q] for q in split if split_day[q] > day)

    rows = []
    for q in sorted(close):
        day = q_start(q) + timedelta(days=14)
        k = before(day)
        mid = vwap.get(q, close[q]) * k
        rows.append((day, mid, mid, mid, mid, 1e6 / k, split.get(q, 1.0), div.get(q, 0.0) * k))
        end = close[q] * before(q_end(q))
        rows.append((q_end(q), end, end, end, end, 0.0, 1.0, 0.0))
    if latest is not None:
        last = latest * before(LATEST_DAY)
        rows.append((LATEST_DAY, last, last, last, last, 0.0, 1.0, 0.0))
    return pl.DataFrame(rows, schema=DAILY_SCHEMA, orient="row")


def multi_stock_fixtures(
    stocks: dict[str, pl.DataFrame | None],
    rows_by_q: dict[int, list[Holding]],
    *,
    name: str = "Test Fund LP",
    tbill: dict[int, float] | None = None,
) -> Fixtures:
    """`small_fixtures` for several stocks: one fund (FUND) filing `rows_by_q` (quarter -> its
    information-table rows, built with `held`), every ticker of `stocks` mapped to a security
    with the price frame given (`stock_prices`; None or empty: the vendor has no prices) and
    the T-bill table `tbill` (default TBILL). Splits and dividends are in the frames."""
    filings = [
        Filing(f"0000001001-24-{i:06d}", FUND, name, q, q_end(q) + timedelta(days=30), rows)
        for i, (q, rows) in enumerate(sorted(rows_by_q.items()))
    ]
    live_f, live_h = live_frames([])
    return Fixtures(
        zips={ZIP_URL: bulk_zip(filings)},
        live_filings=live_f,
        live_holdings=live_h,
        figi={
            cusip_of(t): listing(f"BBG0TEST{TICKERS.index(t):04d}", t, issuer(t)) for t in stocks
        },
        sec_tickers=pl.DataFrame(
            [(t, 5000 + TICKERS.index(t), issuer(t)) for t in stocks],
            schema={"ticker": pl.String, "cik": pl.Int64, "title": pl.String},
            orient="row",
        ),
        sic={5000 + TICKERS.index(t): 3571 for t in stocks},
        shares_out={5000 + TICKERS.index(t): 1e9 for t in stocks},
        prices={t: frame for t, frame in stocks.items() if frame is not None},
        tbill=TBILL if tbill is None else tbill,
    )


@dataclass(frozen=True)
class Built:
    """One hand-built fund after the pipeline: its inputs, and what the engine used and made."""

    fi: FundInputs
    p: Prepared
    r: FundResult


def run_fund(root: Path, fx: Fixtures, today: date = TODAY, max_positions: int = 500) -> Built:
    """Run the weekly pipeline on `fx` as of `today` in `root`, then the engine's inputs and
    results of the fund and its FundInputs (cut to `max_positions`)."""
    lake = Lake(root / "lake")
    stats = run_weekly(lake, root / "out", fixture_sources(fx), today)
    ctx, batch = demo_batch(DemoRun(root, lake, stats.last_q), [FUND])
    ((p, r),) = batch
    securities = read_table(lake, "securities", SECURITIES_SCHEMA)
    fi = build_inputs(ctx, p, r, latest_closes(lake), securities, max_positions)
    return Built(fi, p, r)


# --- the hand-built funds ---------------------------------------------------------------------
# Quarters used below: 42-45 are Q3 2023 .. Q2 2024 (45 is the deadline quarter of TODAY). A
# stock's `stock_prices` has a bar only in the quarters given; ALFA is the anchor that is priced
# throughout, so a fund always has a book and a latest price date.

Q4_23, Q3_23 = Q1_24 - 1, Q1_24 - 2  # 43, 42


def _anchor(quarters: range, shares: float = 1000) -> tuple[pl.DataFrame, dict[int, list[Holding]]]:
    """ALFA at 10, 11, 12 ... a share, `shares` held in each of `quarters`."""
    closes = {q: 10.0 + (q - quarters[0]) for q in quarters}
    rows = {q: [held("ALFA", shares, shares * px)] for q, px in closes.items()}
    return stock_prices(closes, latest=closes[quarters[-1]] + 1), rows


def reported_value() -> Fixtures:
    """BRAV has no prices at all, only the fund's reported values: 50, 55 and 60 a share."""
    alfa, rows = _anchor(range(Q4_23, Q2_24 + 1))
    for q, (shares, value) in zip((43, 44, 45), ((100, 5_000), (100, 5_500), (200, 12_000))):
        rows[q].append(held("BRAV", shares, value))
    return multi_stock_fixtures({"ALFA": alfa, "BRAV": None}, rows)


def never_priced() -> Fixtures:
    """CHAR is filed with shares but no value and has no prices: nothing to value it at. A bond
    makes the fund's reported value larger than its shares'."""
    alfa, rows = _anchor(range(Q4_23, Q2_24 + 1))
    bond = Holding("ORCA DEMO FDG CORP 4.25% 2031", "91DEMO2B7", 3_000, 3_000, "PRN")
    for q in rows:
        rows[q] += [held("CHAR", 500, 0), bond]
    return multi_stock_fixtures({"ALFA": alfa, "CHAR": None}, rows)


def priced_later() -> Fixtures:
    """BRAV is held (1,000 shares, no reported value) from Q3 2023 but has prices only from
    Q1 2024, where its VWAP (18) is below its close (20)."""
    alfa, rows = _anchor(range(Q3_23, Q2_24 + 1))
    brav = stock_prices({44: 20.0, 45: 22.0}, vwap={44: 18.0, 45: 21.0}, latest=23.0)
    for q, value in ((42, 0), (43, 0), (44, 20_000), (45, 22_000)):
        rows[q].append(held("BRAV", 1000, value))
    return multi_stock_fixtures({"ALFA": alfa, "BRAV": brav}, rows)


def delisted() -> Fixtures:
    """CHAR trades until the end of Q4 2023 (last close 25), is still filed in Q1 2024 (at a
    reported 20 a share, not 25) and gone in Q2 2024."""
    alfa, rows = _anchor(range(Q3_23, Q2_24 + 1))
    char = stock_prices({42: 30.0, 43: 25.0}, vwap={42: 29.0, 43: 26.0})
    for q, value in ((42, 3_000), (43, 2_500), (44, 2_000)):
        rows[q].append(held("CHAR", 100, value))
    return multi_stock_fixtures({"ALFA": alfa, "CHAR": char}, rows)


def exit_and_reentry() -> Fixtures:
    """DELT: bought (a first report), held, gone in Q1 2024, bought again in Q2 2024."""
    alfa, rows = _anchor(range(Q3_23, Q2_24 + 1))
    closes = {42: 50.0, 43: 55.0, 44: 60.0, 45: 65.0}
    delt = stock_prices(closes, vwap={q: px + 1 for q, px in closes.items()}, latest=67.0)
    for q, shares in ((42, 200), (43, 200), (45, 150)):
        rows[q].append(held("DELT", shares, shares * closes[q]))
    return multi_stock_fixtures({"ALFA": alfa, "DELT": delt}, rows)


def dividends() -> Fixtures:
    """ALFA alone: 100 shares, then 150 (dividend 0.5 a share in that quarter), then 60
    (dividend 0.25 in that quarter)."""
    closes = {43: 20.0, 44: 22.0, 45: 24.0}
    alfa = stock_prices(
        closes, vwap={44: 21.0, 45: 23.0}, div={44: 0.5, 45: 0.25}, latest=25.0
    )
    rows = {q: [held("ALFA", shares, shares * closes[q])] for q, shares in
            ((43, 100), (44, 150), (45, 60))}  # fmt: skip
    return multi_stock_fixtures({"ALFA": alfa}, rows)


def split() -> Fixtures:
    """ALFA splits 2 for 1 on the 15th day of Q1 2024. The fund files 100 shares at 20 a share
    for Q4 2023 (before the split) and 200 at 11 and 12 after it: today's basis is 10, 11, 12."""
    alfa = stock_prices({43: 10.0, 44: 11.0, 45: 12.0}, split={44: 2.0}, latest=13.0)
    rows = {q: [held("ALFA", shares, value)] for q, shares, value in
            ((43, 100, 2_000), (44, 200, 2_200), (45, 200, 2_400))}  # fmt: skip
    return multi_stock_fixtures({"ALFA": alfa}, rows)


def few_returns(quarters: int) -> Fixtures:
    """ALFA alone for `quarters` quarters ending in Q2 2024: `quarters` - 1 returns."""
    alfa, rows = _anchor(range(Q2_24 + 1 - quarters, Q2_24 + 1))
    return multi_stock_fixtures({"ALFA": alfa}, rows)


def year_ties() -> tuple[Fixtures, date]:
    """ALFA alone, 1,000 shares for 20 quarters (2020-2024). Its price doubles in the first
    quarter of 2021 and of 2023 and is flat otherwise (powers of two, so every return is exact):
    the full years 2021 and 2023 tie for the best year (1.0), 2022 and 2024 for the worst (0.0).
    The deadline quarter is Q4 2024."""
    by_year = {2020: 64.0, 2021: 128.0, 2022: 128.0, 2023: 256.0, 2024: 256.0}
    closes = {q: by_year[2020 + (q - Q1_20) // 4] for q in range(Q1_20, Q1_20 + 20)}
    rows = {q: [held("ALFA", 1000, 1000 * px)] for q, px in closes.items()}
    return multi_stock_fixtures({"ALFA": stock_prices(closes)}, rows), date(2025, 3, 3)


def edge_cases(tmp: Path) -> dict[str, Built]:
    """Every hand-built fund through the pipeline, each in a folder of `tmp`."""
    cases: dict[str, tuple[Fixtures, date]] = {
        "reported_value": (reported_value(), TODAY),
        "never_priced": (never_priced(), TODAY),
        "priced_later": (priced_later(), TODAY),
        "delisted": (delisted(), TODAY),
        "exit_and_reentry": (exit_and_reentry(), TODAY),
        "dividends": (dividends(), TODAY),
        "split": (split(), TODAY),
        "returns_2": (few_returns(3), TODAY),
        "returns_3": (few_returns(4), TODAY),
        "year_ties": year_ties(),
    }
    return {name: run_fund(tmp / name, fx, today) for name, (fx, today) in cases.items()}


def edge_case_inputs(tmp: Path) -> dict[str, FundInputs]:
    """The FundInputs of every hand-built fund (`edge_cases`), by name."""
    return {name: built.fi for name, built in edge_cases(tmp).items()}


# --- a fund of 500 stocks over 54 quarters ----------------------------------------------------


def synthetic_inputs(n_stocks: int = 500, n_quarters: int = 54, seed: int = 7) -> FundInputs:
    """A made-up fund for the size and time test, built straight from the dataclasses (no
    pipeline, and Orca's figures are random numbers: the file is never recalculated). Prices are
    the worst case for the file: every stock has a close and a VWAP (full float precision) in
    every quarter and dividends in some; each stock is held in one run of quarters."""
    rng = random.Random(seed)
    n = n_quarters
    quarters = list(range(n))  # from Q1 2013 (Q2 2026 is the 54th)
    years = sorted({BASE_YEAR + q // 4 for q in quarters})
    stocks, orca_stocks = [], []
    for sid in range(1, n_stocks + 1):
        price, close, vwap = rng.uniform(10, 300), [], []
        for _ in quarters:
            price *= rng.uniform(0.85, 1.2)
            close.append(price)
            vwap.append(price * rng.uniform(0.97, 1.03))
        first = rng.randrange(0, n - 4)
        last = rng.randrange(first + 2, n)
        shares: list[float | None] = [None] * n
        value: list[float | None] = [None] * n
        count = rng.randrange(1, 100) * 1000
        for q in range(first, last + 1):
            count = max(1000, count + rng.randrange(-5, 6) * 1000)
            shares[q], value[q] = float(count), float(round(count * close[q]))
        stocks.append(
            StockInputs(
                stock_id=sid,
                ticker=f"S{sid:03d}",
                name=f"Synthetic stock {sid} Corp",
                shares_filed=shares,
                value_filed=value,
                split_factor=[1.0] * n,
                close=close,
                vwap=vwap,
                div_ps=[_dividend(rng) for _ in quarters],
                close_before=close[0] * 0.95,
                close_latest=close[-1] * 1.01,
            )
        )
        orca_stocks.append(_synthetic_orca_stock(rng, sid, years, first, last, n))
    reported = [sum(st.value_filed[q] or 0.0 for st in stocks) * 1.1 for q in quarters]
    return FundInputs(
        fund_id=1,
        name="Synthetic Fund LP",
        cik=1,
        period_q=n - 1,
        filed=date(2026, 8, 14),
        start=0,
        end_q=n - 1,
        bound=n - 1,
        latest_date=date(2026, 10, 30),
        quarters=quarters,
        years=years,
        carried=[0] * n,
        tbill=[0.03] * n,
        spy_close=[100.0 + q for q in quarters],
        spy_vwap=[99.0 + q for q in quarters],
        total_reported=reported,
        stocks=stocks,
        orca_stocks=orca_stocks,
        orca=_synthetic_orca_fund(rng, n, len(years), n_stocks),
    )


def _dividend(rng: random.Random) -> float:
    return round(rng.uniform(0, 0.5), 4) if rng.random() < 0.3 else 0.0


def _synthetic_orca_stock(
    rng: random.Random, sid: int, years: list[int], first: int, last: int, n: int
) -> OrcaStock:
    return OrcaStock(
        stock_id=sid,
        avg_cost=rng.uniform(10, 300),
        avg_exit=rng.uniform(10, 300),
        invested=rng.uniform(1e5, 1e8),
        realised=rng.uniform(-1e6, 1e6),
        dividends=rng.uniform(0, 1e5),
        shares_now=float(rng.randrange(0, 1000) * 100),
        cost_now=rng.uniform(1e5, 1e8),
        from_q=first,
        to_q=last if last < n - 1 else None,
        last_q=last,
        last_type="add",
        last_pct=rng.uniform(-0.5, 0.5),
        last_usd=rng.uniform(-1e6, 1e6),
        sold_shares=float(rng.randrange(0, 1000) * 100),
        sold_usd=rng.uniform(1e5, 1e7),
        last_sale_q=last,
        one_y=rng.uniform(-0.5, 0.5),
        spy_one_y=rng.uniform(-0.2, 0.3),
        points={y: rng.uniform(-5, 5) for y in years},
        pnl={y: rng.uniform(-1e6, 1e6) for y in years},
    )


def _synthetic_orca_fund(rng: random.Random, n: int, n_years: int, n_stocks: int) -> OrcaFund:
    quarter_fields = ("start", "end", "market_move", "net_buying", "trade_gains", "dividends")
    quarter_fields += ("ret",)
    year_fields = ("ret", "start", "end", "gains", "inflows", "dividends", "approx_ret")
    names = ("ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "quarters_pos_pct",
             "years_pos", "years_total", "turnover", "hold_all", "hold_sold")  # fmt: skip
    year = {"label": "2020", "ret": 0.1}
    return OrcaFund(
        quarters={f: [rng.uniform(-1e8, 1e8) for _ in range(n)] for f in quarter_fields},
        years={f: [rng.uniform(-1e8, 1e8) for _ in range(n_years)] for f in year_fields},
        metrics={**{k: rng.uniform(0, 1) for k in names}, "best_year": year, "worst_year": year},
        exits_summary={"buys_12m": 0.1, "sells_12m": 0.05, "beat_spy_pct": 0.5},
        book=1e9,
        n_holdings=n_stocks // 2,
        priced_pct=0.9,
    )
