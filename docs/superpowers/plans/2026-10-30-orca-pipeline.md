# Orca Pipeline (Spec 1, Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly Python pipeline that turns SEC 13F filings and daily prices into per-fund P&L/return files and home-page lists, published as static JSON.

**Architecture:** Fetchers (SEC, OpenFIGI, Tiingo, FRED) write a Parquet lake; a pure-Python engine computes each affected fund's positions, quarters, years and metrics; a publisher writes brotli JSON into a versioned folder that GitHub Actions syncs to Cloudflare R2. Everything except fetchers is offline and unit-tested; a synthetic demo dataset runs the whole pipeline without network.

**Tech Stack:** Python 3.13, uv, Polars (Parquet zstd), httpx, brotli, pytest; GitHub Actions; rclone → Cloudflare R2.

**Spec:** `docs/superpowers/specs/2026-10-30-orca-fund-pnl-design.md` (read it first). Plan B (`2026-10-30-orca-website.md`) consumes this plan's JSON contract (Task 13).

## Global Constraints

- Quarter index: `q = (year − 2013) × 4 + (quarter − 1)`; Q1 2013 = 0. Labels `"Q2 2026"`.
- Money in dollars (float64), shares float64, prices float64 in memory / float32 in `prices_daily`.
- 13F VALUE is in thousands for filings dated before 2023-01-03, dollars from that date.
- SEC requests: ≤ 10 per second, `User-Agent: "Orca research <ORCA_CONTACT>"` (env var).
- OpenFIGI: ≤ 100 jobs per request, ≤ 25 requests per 6 s with key (`OPENFIGI_KEY`), 10 jobs / 25 per minute without.
- CUSIPs never appear in published files.
- Trade price = quarter VWAP of daily typical price `(high + low + close) / 3` weighted by volume.
- Prices are split-adjusted to today's share basis (not dividend-adjusted); 13F share counts are split-adjusted the same way.
- Every published estimate is a 13F estimate; nothing in the pipeline claims real fund returns.
- Thresholds (copy exactly into `orca/config.py`):
  - Top funds: book ≥ $1B, ≥ 12 quarters filed, ≥ 4 positions, ≥ 80% of book priced, not bank/insurer/pension/broker; index giants (≥ 1,000 priced positions) listed separately; periods 1y=4, 3y=12, 5y=20 quarters, max.
  - Concentrated active: 4–60 positions, top-10 weight ≥ 50%, book ≥ $500M.
  - Conviction move: new or add reaching weight ≥ 5%; weight increase ≥ 3 points; exit of a position that was ≥ 5%.
  - Crowded buys: ≥ 3 concentrated active funds buying in the latest quarter.
  - Calls: new/add ≥ 1% of book; stock market cap ≥ $300M and price ≥ $1; windows last quarter / last 4 quarters.
  - Price sanity: reported value ÷ shares more than 10× from our price → flag, use our price.
  - Coverage warning below 80% of book priced.

## Review Focus

1. **Stock split while held** — a 2-for-1 split must not show as a buy; owned by Task 8 (`test_split_does_not_create_trade`).
2. **Amendment that restates an old quarter** — incremental run must equal a full rebuild; owned by Task 14 (`test_incremental_equals_full_rebuild`).
3. **Stock delisted/acquired while held** — trade priced at last known close, 1y-after is `None` when no later price; owned by Tasks 9 and 11 (`test_delisted_exit_uses_last_close`, `test_one_year_after_missing_is_none`).
4. **Fund whose start value is 0 or negative denominator** (first quarter, all positions unpriced) — quarter return is `None`, never inf/NaN; owned by Task 10 (`test_return_none_when_denominator_not_positive`).
5. **Pre-2023 value units on fallback prices** — implied price ×1000 before 2023-01-03; owned by Task 4 (`test_value_units_before_and_after_2023`).

---

## File Structure

```
pipeline/
  pyproject.toml
  orca/
    config.py          constants, thresholds, env
    quarters.py        quarter index helpers
    storage.py         lake paths, Parquet io, manifest
    http.py            rate-limited client with retries
    sec/bulk.py        13F bulk ZIP → raw filings + holdings
    sec/live.py        EDGAR daily index + info-table XML
    holdings.py        report selection, collapse, classify, gap fill
    securities.py      OpenFIGI, name fallback, stock ids, sectors, shares outstanding
    sic_to_sector.csv
    prices.py          Tiingo client, store, split adjustment
    quarter_px.py      VWAP, low/high/close, dividends, monthly VWAP
    rf.py              FRED T-bill
    engine/position.py average-cost P&L per position
    engine/fund.py     fund quarters, bridge, years, contributions
    engine/metrics.py  performance, turnover, hold lengths
    engine/whatif.py   static what-if fields
    home.py            six home lists
    publish.py         JSON contract writers, brotli, versions, health
    run.py             CLI: weekly / rebuild / demo
    demo.py            synthetic inputs for offline runs
  tests/               one test file per module, fixtures/
.github/workflows/pipeline.yml, ci.yml
```

---

### Task 1: Scaffold, config, quarter helpers

**Files:**
- Create: `pipeline/pyproject.toml`, `pipeline/orca/__init__.py`, `pipeline/orca/config.py`, `pipeline/orca/quarters.py`
- Test: `pipeline/tests/test_quarters.py`

**Interfaces:**
- Produces: `q_index(year: int, quarter: int) -> int`, `q_label(q: int) -> str`, `q_of_date(d: date) -> int`, `q_end(q: int) -> date`, `q_start(q: int) -> date`; `config` module constants named as in Global Constraints (e.g. `TOP_MIN_BOOK = 1e9`, `TOP_MIN_QUARTERS = 12`, `TOP_MIN_POSITIONS = 4`, `TOP_MIN_PRICED = 0.80`, `GIANT_MIN_POSITIONS = 1000`, `CONC_MIN_POS = 4`, `CONC_MAX_POS = 60`, `CONC_MIN_TOP10 = 0.50`, `CONC_MIN_BOOK = 5e8`, `CONVICTION_WEIGHT = 0.05`, `CONVICTION_JUMP = 0.03`, `CROWDED_MIN_FUNDS = 3`, `CALLS_MIN_WEIGHT = 0.01`, `CALLS_MIN_MCAP = 3e8`, `CALLS_MIN_PRICE = 1.0`, `PRICE_MISMATCH = 10.0`, `COVERAGE_WARN = 0.80`, `VALUE_DOLLARS_FROM = date(2023, 1, 3)`, `PERIODS = {"1y": 4, "3y": 12, "5y": 20, "max": None}`, `EXCLUDE_NAME_WORDS` = ("BANK", "BANCORP", "TRUST CO", "INSURANCE", "ASSURANCE", "PENSION", "RETIREMENT SYSTEM", "SECURITIES LLC", "BROKERAGE")), `LAKE_DIR`, `OUT_DIR` from env with defaults `data/lake`, `data/out`.

- [ ] **Step 1: Create `pyproject.toml`** (project `orca`, requires-python `>=3.13`, deps `polars`, `httpx`, `brotli`; dev deps `pytest`), then `cd pipeline && uv sync`.
- [ ] **Step 2: Write failing tests**

```python
def test_quarter_index_and_label():
    assert q_index(2013, 1) == 0
    assert q_index(2026, 2) == 53
    assert q_label(53) == "Q2 2026"
    assert q_of_date(date(2026, 8, 13)) == 54
    assert q_end(53) == date(2026, 6, 30)
    assert q_start(54) == date(2026, 7, 1)
```

- [ ] **Step 3: Run** `cd pipeline && uv run pytest tests/test_quarters.py -v` — expect FAIL (import error).
- [ ] **Step 4: Implement `quarters.py` and `config.py`.**
- [ ] **Step 5: Run tests** — expect PASS.
- [ ] **Step 6: Commit** `git add pipeline && git commit -m "feat(pipeline): scaffold, config and quarter helpers"`

### Task 2: Storage and manifest

**Files:**
- Create: `pipeline/orca/storage.py`
- Test: `pipeline/tests/test_storage.py`

**Interfaces:**
- Produces: `class Lake(root: Path)` with `write(table: str, df: pl.DataFrame, part: str | None = None) -> Path` (zstd Parquet at `root/table/part.parquet` or `root/table.parquet`), `read(table: str, part: str | None = None) -> pl.DataFrame` (all parts concatenated when `part is None`; empty frame if missing), `parts(table) -> list[str]`; `class Manifest(path: Path)` with `seen(name: str, checksum: str) -> bool`, `mark(name: str, checksum: str) -> None`, `save() -> None`; `sha256_file(path: Path) -> str`.

- [ ] **Step 1: Write failing tests** — `test_roundtrip_partitioned` (write two parts of `holdings`, `read("holdings")` has rows of both, `parts` == `["q052", "q053"]`); `test_manifest_skips_seen` (mark then reload from disk → `seen` True, different checksum → False); `test_read_missing_table_is_empty`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** using `pl.DataFrame.write_parquet(compression="zstd")`; manifest is JSON `{name: checksum}`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): parquet lake and ingest manifest`

### Task 3: Rate-limited HTTP client

**Files:**
- Create: `pipeline/orca/http.py`
- Test: `pipeline/tests/test_http.py`

**Interfaces:**
- Produces: `class Client(rate_per_sec: float, headers: dict[str, str], transport: httpx.BaseTransport | None = None, max_retries: int = 4)` with `get(url: str, **params) -> httpx.Response` and `post_json(url: str, body: object) -> httpx.Response`; retries on network errors, 429 and 5xx with backoff 2, 4, 8, 16 s (sleep function injectable as `sleep: Callable[[float], None] = time.sleep`); raises `FetchError(url, status)` after the last retry. `sec_client() -> Client` uses 10/s and the User-Agent from `config`.

- [ ] **Step 1: Write failing tests** with `httpx.MockTransport`: `test_retries_then_succeeds` (503, 503, 200 → returns 200, sleeps recorded `[2, 4]`); `test_gives_up_after_max_retries` (always 500 → `FetchError`); `test_sends_user_agent` (request header equals `"Orca research test@example.com"` with `ORCA_CONTACT` monkeypatched); `test_rate_limit_spacing` (11 calls at 10/s → injected clock shows ≥ 1.0 s elapsed).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (token-bucket on an injectable `clock`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): rate-limited http client with retries`

### Task 4: SEC 13F bulk parser

**Files:**
- Create: `pipeline/orca/sec/__init__.py`, `pipeline/orca/sec/bulk.py`
- Test: `pipeline/tests/test_bulk.py` (builds a tiny ZIP in a tmp dir)

**Interfaces:**
- Produces: `parse_bulk_zip(path: Path) -> tuple[pl.DataFrame, pl.DataFrame]` returning `filings` (accession, cik:int, period:int16 quarter, filed:date, form, amendment_type: "restatement" | "new_holdings" | None, manager_name, source="bulk") and `raw_holdings` (accession, cusip, issuer, title, shares:float, sh_type: "SH" | "PRN", put_call: "PUT" | "CALL" | None, value_usd: float); `value_to_usd(value: float, filed: date) -> float`; `COLUMNS` dict mapping our names to SEC TSV headers. `list_bulk_zips(client) -> list[str]` (file URLs from the SEC data-sets page).

- [ ] **Step 1: Write failing tests**

```python
def test_value_units_before_and_after_2023():
    assert value_to_usd(5, date(2022, 11, 14)) == 5000
    assert value_to_usd(5, date(2023, 1, 3)) == 5

def test_parse_bulk_zip(tmp_path):
    z = make_zip(tmp_path)   # SUBMISSION, COVERPAGE, INFOTABLE TSVs: 1 original, 1 restatement, 1 13F-NT
    filings, rows = parse_bulk_zip(z)
    assert set(filings["form"]) == {"13F-HR", "13F-HR/A"}          # 13F-NT dropped
    assert filings.filter(pl.col("form") == "13F-HR/A")["amendment_type"][0] == "restatement"
    assert rows["value_usd"].to_list() == [1_500_000.0, 2_000_000.0, 7.0]   # 1500 and 2000 (thousands, 2022 filing), 7 (dollars, 2024 filing)
    assert rows.filter(pl.col("put_call") == "CALL").height == 1
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Headers from memory: SUBMISSION (ACCESSION_NUMBER, FILING_DATE, SUBMISSIONTYPE, CIK, PERIODOFREPORT), COVERPAGE (ACCESSION_NUMBER, ISAMENDMENT, AMENDMENTTYPE, FILINGMANAGER_NAME), INFOTABLE (ACCESSION_NUMBER, NAMEOFISSUER, TITLEOFCLASS, CUSIP, VALUE, SSHPRNAMT, SSHPRNAMTTYPE, PUTCALL). Keep them only in `COLUMNS`. Dates in the TSVs are `DD-MON-YYYY`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Verify headers against a real file** (needs `www.sec.gov` allowed): download the latest ZIP, compare headers with `COLUMNS`, fix any mismatch and the fixture, re-run tests. If the host is still blocked, record "unverified" in the commit message.
- [ ] **Step 6: Commit** `feat(pipeline): parse SEC 13F bulk data sets`

### Task 5: Live filings (EDGAR daily index + info-table XML)

**Files:**
- Create: `pipeline/orca/sec/live.py`
- Test: `pipeline/tests/test_live.py`, `pipeline/tests/fixtures/form.idx`, `pipeline/tests/fixtures/infotable.xml`

**Interfaces:**
- Consumes: `Client`, `value_to_usd`.
- Produces: `parse_daily_index(text: str) -> list[IndexEntry]` (`IndexEntry(form, cik, company, filed: date, path)`; keeps `13F-HR` and `13F-HR/A` only); `parse_infotable_xml(xml: bytes, accession: str, filed: date) -> pl.DataFrame` (same columns as `raw_holdings`; namespace-agnostic); `fetch_new_filings(client, since: date, until: date) -> tuple[pl.DataFrame, pl.DataFrame]` (same shapes as `parse_bulk_zip`, `source="live"`; amendment type and period read from the filing's primary document).

- [ ] **Step 1: Write failing tests** — `test_parse_daily_index_keeps_13f_only` (fixture with 13F-HR, 13F-HR/A, 10-K, 13F-NT → 2 entries); `test_parse_infotable_xml` (fixture with 2 rows, one PUT; values in dollars for a 2024 filing; `ns1:` prefixed tags parse the same as unprefixed).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `xml.etree.ElementTree`, matching tags by local name.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): read new 13F filings from EDGAR daily index`

### Task 6: Holdings — report selection, collapse, classify, gaps

**Files:**
- Create: `pipeline/orca/holdings.py`
- Test: `pipeline/tests/test_holdings.py`

**Interfaces:**
- Consumes: `filings`, `raw_holdings` frames (Tasks 4–5).
- Produces: `select_reports(filings: pl.DataFrame) -> pl.DataFrame` (one chosen set of accessions per (cik, period)); `build_holdings(filings, raw_holdings) -> pl.DataFrame` with columns (cik, q, cusip, kind: "SH" | "PRN" | "PUT" | "CALL", shares, value_usd, filed); `fill_gaps(holdings: pl.DataFrame, last_q: int) -> tuple[pl.DataFrame, pl.DataFrame]` returning filled holdings (+ `carried: bool`) and `fund_status` (cik, first_q, last_filed_q, inactive: bool, segments: list[(start_q, end_q)]).

Rules: per (cik, period) take the latest original 13F-HR; if any restatement exists take the latest restatement instead; then append rows of every new-holdings amendment filed after the chosen base. Drop rows with shares ≤ 0 (counted for `health.json`). Collapse by (cik, q, cusip, kind) summing shares and value. A single missing quarter is filled from the previous quarter (`carried=True`). A gap of two or more quarters ends a tracking segment; a later filing starts a new segment (first-report rule applies again). `inactive` = no filing in the latest two quarters.

- [ ] **Step 1: Write failing tests** — `test_restatement_replaces_original_and_new_holdings_append` (original A 3 rows, restatement B 2 rows, new-holdings C 1 row → 3 rows: B's 2 + C's 1); `test_latest_original_wins_when_refiled`; `test_collapse_keeps_put_call_separate` (same CUSIP as SH and CALL → 2 rows); `test_nonpositive_shares_dropped` (rows with 0 and −5 shares removed, drop count returned); `test_single_gap_carried_forward` (filed q10, q12 → q11 rows equal q10, `carried=True`); `test_two_quarter_gap_starts_new_segment` (filed q10, q13 → segments `[(10, 10), (13, 13)]`, no rows for q11–q12).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in Polars.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): choose one report per fund-quarter and fill gaps`

### Task 7: Security master — CUSIP mapping, ids, sectors, shares outstanding

**Files:**
- Create: `pipeline/orca/securities.py`, `pipeline/orca/sic_to_sector.csv`
- Test: `pipeline/tests/test_securities.py`

**Interfaces:**
- Consumes: `Client`, `Lake`.
- Produces: `map_cusips(cusips: list[str], issuer_names: dict[str, str], figi: Client, sec_tickers: pl.DataFrame) -> pl.DataFrame` (cusip, figi, ticker, name, method: "openfigi" | "name" | "unmapped"); `assign_stock_ids(mapped: pl.DataFrame, existing: pl.DataFrame) -> pl.DataFrame` (existing ids never change; new ones are `max + 1`; key is FIGI, else ticker); `sector_for_sic(sic: int | None, is_etf: bool) -> str`; `load_sec_tickers(client) -> pl.DataFrame` (ticker, cik, title from `company_tickers.json`); `fetch_sic(client, cik: int) -> int | None` (submissions API); `fetch_shares_outstanding(client, cik: int) -> float | None` (latest `dei:EntityCommonStockSharesOutstanding` from company facts).

`sic_to_sector.csv` columns `sic_from,sic_to,sector` covering the 11 sectors in spec §4.1 step 9; unmatched → "Other"; ETFs → "ETF/Fund". Name fallback: normalise issuer names (upper case, strip punctuation and suffixes INC, CORP, CO, LTD, PLC, CL A/B, COM) and require an exact normalised match with one SEC ticker row.

- [ ] **Step 1: Write failing tests** — `test_openfigi_batches_of_100` (250 CUSIPs → 3 POSTs via MockTransport, jobs `{"idType": "ID_CUSIP", "idValue": ...}`); `test_name_fallback_exact_normalised_match` ("APPLE INC" ↔ "Apple Inc." maps; "APPLE HOSPITALITY" does not); `test_unmapped_marked`; `test_stock_ids_are_stable` (re-run with one new security keeps old ids, new id = max+1); `test_sector_for_sic` (`1221` → "Energy", `2834` → "Health care", `7372` → "Tech", `6798` → "Real estate", `None` → "Other", ETF → "ETF/Fund").
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): security master with FIGI mapping and sectors`

### Task 8: Prices — vendor client, store, split adjustment

**Files:**
- Create: `pipeline/orca/prices.py`
- Test: `pipeline/tests/test_prices.py`

**Interfaces:**
- Consumes: `Client`, `Lake`.
- Produces: `class PriceSource(Protocol)` with `daily(ticker: str, start: date, end: date) -> pl.DataFrame` (date, open, high, low, close, volume, split_factor, dividend — raw, unadjusted); `TiingoSource(client)` (key from `TIINGO_KEY`); `FixtureSource(frames: dict[str, pl.DataFrame])`; `update_prices(lake, source, tickers: dict[int, str], today: date) -> list[int]` (fetch only after each stock's last stored date; append one Parquet part per run; returns stock_ids whose history changed, including split/price corrections detected by re-fetching the last 5 stored days); `compact_prices(lake) -> None` (merge run parts into yearly parts); `split_adjust_prices(df) -> pl.DataFrame` (OHLC ÷ cumulative product of split factors after each date, volume × the same); `split_adjust_shares(shares: float, q: int, splits: pl.DataFrame) -> float` (× product of split factors dated after `q_end(q)`).

- [ ] **Step 1: Write failing tests**

```python
def test_split_does_not_create_trade():
    splits = pl.DataFrame({"date": [date(2024, 5, 10)], "split_factor": [2.0]})
    assert split_adjust_shares(100, q_index(2024, 1), splits) == 200
    assert split_adjust_shares(210, q_index(2024, 2), splits) == 210   # delta = +10, not +110

def test_update_fetches_only_new_days(tmp_path): ...   # second run requests start = last stored date − 5 days
def test_split_adjust_prices(): ...                       # close 100 before a 2:1 split → 50; volume doubles
def test_compaction_keeps_rows(tmp_path): ...
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): incremental daily prices and split adjustment`

### Task 9: Quarter prices and risk-free rate

**Files:**
- Create: `pipeline/orca/quarter_px.py`, `pipeline/orca/rf.py`
- Test: `pipeline/tests/test_quarter_px.py`, `pipeline/tests/test_rf.py`

**Interfaces:**
- Consumes: split-adjusted daily prices.
- Produces: `@dataclass(frozen=True) QuarterPx(vwap: float | None, low: float | None, high: float | None, close: float | None, div_ps: float, monthly_vwap: tuple[float | None, float | None, float | None])`; `quarter_px(daily: pl.DataFrame) -> dict[int, QuarterPx]` (per stock); `close_on(daily, d: date) -> float | None` (last close on or before `d`); `last_close_before(px: dict[int, QuarterPx], q: int) -> float | None`; `fetch_tbill(client) -> dict[int, float]` (FRED DTB3 yearly average, as a decimal, keyed by year; key from `FRED_KEY`).

- [ ] **Step 1: Write failing tests**

```python
def test_vwap_from_typical_price():
    d = days([(11, 9, 10, 100), (13, 11, 12, 300)])        # (high, low, close, volume) in one quarter
    p = quarter_px(d)[q]
    assert p.vwap == 11.5 and p.low == 9 and p.high == 13 and p.close == 12

def test_quarter_without_data_is_absent(): ...
def test_delisted_exit_uses_last_close():                 # no rows in q → last_close_before(px, q) == last close of q−1
    ...
def test_dividends_summed_per_quarter(): ...
def test_tbill_yearly_average(): ...                      # FRED fixture 4.0 and 5.0 (percent) in 2023 → {2023: 0.045}
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): quarter VWAP, ranges, dividends and T-bill rate`

### Task 10: Engine — position P&L and fund quarters

**Files:**
- Create: `pipeline/orca/engine/__init__.py`, `pipeline/orca/engine/position.py`, `pipeline/orca/engine/fund.py`
- Test: `pipeline/tests/test_position.py`, `pipeline/tests/test_fund.py`

**Interfaces:**
- Consumes: `QuarterPx`, `last_close_before`.
- Produces (`position.py`): `Trade(q: int, type: str, delta: float, px: float, low: float | None, high: float | None, shares_after: float)` with type in `"new" | "add" | "trim" | "exit"`; `PositionQuarter(q, shares, delta, trade_px: float | None, cost, realised, market_move, trade_gain, dividends, value, net_buying)`; `PositionResult(stock_id, from_q, to_q: int | None, quarters: list[PositionQuarter], trades: list[Trade], invested, realised, dividends, shares_now, cost_now, avg_cost, avg_exit: float | None, sold_shares, sold_usd)`; `compute_position(stock_id: int, shares_by_q: dict[int, float], px: dict[int, QuarterPx], segment_start_q: int, last_q: int, implied_px: dict[int, float]) -> PositionResult | None` (None when the stock never has a usable price).
- Produces (`fund.py`): `FundQuarter(q, start, end, net_buying, buys, sells, market_move, trade_gains, dividends, ret: float | None)`; `aggregate_fund(positions: list[PositionResult], segment_start_q: int, last_q: int) -> list[FundQuarter]`; `check_bridge(fq: FundQuarter) -> bool` (`abs(end − (start + market_move + net_buying + trade_gains)) ≤ 1e-6 × max(1, end)`).

Trade price for quarter q: close(q) if q == segment_start_q (first-report rule); else VWAP(q); else `last_close_before(q)`; else `implied_px[q]`. Close used for valuation: close(q), else last close before q. Market move = shares(q−1) × (close(q) − close(q−1)); trade gain = delta × (close(q) − trade price); dividends = shares(q−1) × div_ps(q); net buying = delta × trade price. Avg cost and realised exactly as spec §5.2. Fund return = (end − start − net buying + dividends) ÷ (start + ½ net buying); `None` for the segment's first quarter or when the denominator ≤ 0.

- [ ] **Step 1: Write failing tests** (hand-worked example; segment starts at q9 so q10 is a normal trade)

```python
# shares: q10 100, q11 150, q12 60, q13 0
# px: q10 vwap 10 close 12; q11 vwap 14 close 15 div 0.5; q12 vwap 16 close 13 div 0.5; q13 vwap 20 close 21
def test_average_cost_example():
    r = compute_position(1, shares, px, segment_start_q=9, last_q=13, implied_px={})
    assert [t.type for t in r.trades] == ["new", "add", "trim", "exit"]
    assert r.invested == 1700 and r.realised == pytest.approx(940)
    assert r.avg_cost == pytest.approx(1700 / 150) and r.avg_exit == pytest.approx(17.6)
    assert r.dividends == 125 and r.cost_now == 0 and r.to_q == 13
    assert sum(pq.market_move + pq.trade_gain for pq in r.quarters) == pytest.approx(940)

def test_first_report_bought_at_close(): ...                 # segment_start_q == q10 → trade px 12
def test_return_none_when_denominator_not_positive(): ...    # all positions unpriced in q → ret is None
def test_fund_return_and_bridge():
    # start 1000, end 1300, net buying 100, dividends 10, market move 150, trade gains 50
    assert fq.ret == pytest.approx(0.2) and check_bridge(fq)
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): average-cost positions and fund quarters`

### Task 11: Engine — years, contributions, metrics, what-if

**Files:**
- Create: `pipeline/orca/engine/metrics.py`, `pipeline/orca/engine/whatif.py`; Modify: `pipeline/orca/engine/fund.py`
- Test: `pipeline/tests/test_metrics.py`, `pipeline/tests/test_whatif.py`, `pipeline/tests/test_fund.py`

**Interfaces:**
- Consumes: Task 10 types, `fetch_tbill` output.
- Produces (`fund.py`): `FundYear(label: str, qs: list[int], ret: float | None, start, end, gains, inflows, dividends, approx_ret: float | None)` (label `"2026 H1"`-style when fewer than 4 quarters; `gains` = market move + trade gains; `inflows` = net buying); `fund_years(quarters) -> list[FundYear]`; `contributions(positions, years) -> dict[str, list[tuple[int, float, float]]]` (label → (stock_id, points, pnl)).
- Produces (`metrics.py`): `Performance(ann_return, sharpe, sortino, vol, max_dd, calmar, quarters_pos_pct)` (fields `float | None`); `performance(rets: list[tuple[int, float]], rf_by_year: dict[int, float]) -> Performance | None` (None when fewer than 4 returns); `turnover(years, quarters) -> float | None`; `hold_lengths(positions, last_q) -> tuple[float, float | None]` (all, sold only, in years); `priced_pct(latest_holdings: pl.DataFrame, priced_cusips: set[str]) -> float` (reported value of priced SH rows ÷ total reported value of the latest quarter). "% of positions profitable" depends on the latest price, so the browser computes it (Plan B).
- Produces (`whatif.py`): `ExitRow(stock_id, status: "trimmed" | "sold_all", sold_shares, sold_usd, avg_exit, last_sale_q, one_y: float | None, spy_one_y: float | None)`; `exit_rows(positions, px_by_stock, spy_px) -> list[ExitRow]`; `buys_vs_sells(positions, px_by_stock) -> tuple[float | None, float | None]`; `beat_spy_pct(rows) -> float | None`.

Formulas exactly as spec §5.4–5.6: contribution points = stock P&L in year (market move + trade gain + dividends) ÷ (year start + ½ year net buying) × 100; Sharpe = mean excess quarterly × 4 ÷ (sample stdev of excess × 2); Sortino uses √(mean of min(0, excess)²) × 2; vol = sample stdev × 2; max drawdown on the chained index; Calmar = ann_return ÷ |max_dd|; turnover = mean over full years of min(Σ buys, Σ sells) ÷ mean(start, 4 quarter ends). One-year-after = close(last_sale_q + 4) ÷ that sale's trade price − 1.

- [ ] **Step 1: Write failing tests**

```python
def test_chain_year():           # quarterly 0.10, −0.05, 0.20, 0.00 → 0.254
def test_performance_example():  # same returns, rf 0
    p = performance(list(zip(range(4), [0.10, -0.05, 0.20, 0.0])), {})
    assert p.ann_return == pytest.approx(0.254)
    assert p.vol == pytest.approx(0.221736, rel=1e-4)
    assert p.sharpe == pytest.approx(1.12746, rel=1e-4)
    assert p.sortino == pytest.approx(5.0)
    assert p.max_dd == pytest.approx(-0.05) and p.calmar == pytest.approx(5.08)
    assert p.quarters_pos_pct == 0.5
def test_contribution_points():  # year start 1000, net buying 200, stock pnl 110 → 10.0
def test_turnover():             # buys 300, sells 200, mean book 1000 → 0.2
def test_one_year_after_missing_is_none(): ...   # last sale in the latest quarter → one_y None
def test_partial_year_label():   # quarters 52, 53 only → label "2026 H1"
def test_priced_pct():           # reported values 600 priced, 300 unmapped, 100 PUT → 0.6
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(engine): years, contributions, performance and what-if`

### Task 12: Home lists

**Files:**
- Create: `pipeline/orca/home.py`
- Test: `pipeline/tests/test_home.py`

**Interfaces:**
- Consumes: per-fund results.
- Produces: `FundSnapshot(fund_id, name, book, n_priced, priced_pct, quarters_filed, excluded: bool, weights_now: dict[int, float], weights_prev: dict[int, float], trades_latest: list[Trade], pnl_latest: dict[int, float], buys_recent: list[tuple[int, int, float, float, date]] (stock_id, q, px, weight_after, filed), perf: dict[str, Performance | None], filed: date, period_q: int)`; `top_funds(snaps, period: str) -> dict` (`{"eligible": rows, "giants": rows}`, rows sorted by return per year); `conviction_moves(snaps) -> list[dict]`; `wins_losses(snaps, n: int = 25) -> dict`; `just_filed(snaps, n: int = 50) -> list[dict]` (headline = largest absolute weight change); `crowded_buys(snaps) -> list[dict]`; `calls(snaps, mcap: dict[int, float], latest_px: dict[int, float], px_on_filed: Callable[[int, date], float | None], window: "q" | "y") -> list[dict]` (rows carry est buy price and filing-date price; browser computes % since).

- [ ] **Step 1: Write failing tests** — one per list using 5 small snapshots built in the test: `test_top_funds_rules` ($900M book excluded; 11 quarters excluded; 3 positions excluded; 79% priced excluded; "FIRST BANK" excluded; 1,000-position fund appears only in `giants`); `test_conviction_rules` (new at 5% counts, add 4%→6.5% counts, add 1%→3.5% does not, exit of 5% counts, exit of 4% does not; fund with 61 positions excluded); `test_crowded_needs_three_funds`; `test_calls_filters` (mcap $299M excluded, price $0.90 excluded, buy weight 0.9% excluded); `test_just_filed_headline`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): home page lists`

### Task 13: Publisher — JSON contract, brotli, versions, health

**Files:**
- Create: `pipeline/orca/publish.py`, `pipeline/contract.md` (the JSON contract below, copied as the source of truth for Plan B)
- Test: `pipeline/tests/test_publish.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `write_json(path: Path, obj: object, compress: bool = True) -> str` (minified; brotli quality 11 unless `compress=False`; returns sha256 of the bytes written); `publish_fund(out: Path, fund: FundOutput) -> dict[str, str]` (path → checksum); `publish_shared(out, ...)`; `new_version(out_root: Path, run_id: str) -> Path`; `changed_files(new: dict[str, str], previous: dict[str, str]) -> list[str]`; `write_manifest(out_root, version, files: dict[str, str]) -> None` (written last); `write_health(out_root, stats: dict) -> None`. `FundOutput` bundles one fund's summary, positions, contributions and exit rows.

Contract (all keys snake_case; arrays are column-oriented `{"col": [...]}`; money in dollars; `null` for missing):
- `funds.json`: `{"v": 1, "id": [], "name": [], "book": [], "n": []}`
- `securities.json`: `{"stock_id": [], "ticker": [], "name": [], "sector": []}`
- `latest_prices.json`: `{"asof": "YYYY-MM-DD", "stock_id": [], "price": []}`
- `fund/{id}/summary.json`: `{"id", "name", "cik", "period_q", "filed", "book", "n_holdings", "priced_pct", "tracked_since_q", "inactive", "metrics": {"ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "best_year": {"label", "ret"}, "worst_year": {"label", "ret"}, "years_pos", "years_total", "quarters_pos_pct", "turnover", "hold_all", "hold_sold", "first_year", "last_year"}, "years": {"label": [], "ret": [], "start": [], "end": [], "gains": [], "inflows": [], "dividends": [], "approx_ret": []}, "quarters": {"q": [], "ret": [], "start": [], "end": [], "market_move": [], "net_buying": [], "trade_gains": [], "dividends": []}, "holdings_now": {"stock_id": [], "shares": [], "cost": []}}`
- `fund/{id}/positions.json`: `{"stock_id": [], "from_q": [], "to_q": [], "avg_cost": [], "avg_exit": [], "invested": [], "realised": [], "dividends": [], "shares_now": [], "cost_now": [], "last_q": [], "last_type": [], "last_pct": [], "last_usd": [], "trades": [[[q, delta, px, low, high, shares_after], ...], ...]}`
- `fund/{id}/contrib.json`: `{"years": [label...], "by_year": {label: {"stock_id": [], "points": [], "pnl": []}}}`
- `fund/{id}/exits.json`: `{"rows": {"stock_id": [], "status": [], "sold_shares": [], "sold_usd": [], "avg_exit": [], "last_sale_q": [], "one_y": [], "spy_one_y": []}, "summary": {"buys_12m": , "sells_12m": , "beat_spy_pct": }}`
- `stock/{stock_id}/weekly.json`: `{"start": "YYYY-MM-DD", "close": []}` (weekly Friday closes, split-adjusted)
- `home/top_{1y|3y|5y|max}.json`, `home/conviction.json`, `home/wins_losses.json`, `home/just_filed.json`, `home/crowded.json`, `home/calls_q.json`, `home/calls_y.json` — rows as returned by Task 12.
- `manifest.json` at the bucket root: `{"version": "...", "built": "...", "files": {path: sha256}}`; `health.json`: `{"filings_parsed", "unmapped_cusips", "coverage_median", "funds_recomputed", "flags": [...]}`.

- [ ] **Step 1: Write failing tests** — `test_brotli_roundtrip`; `test_no_cusip_in_output` (publish a fund whose holdings came from CUSIP `037833100`; no file under the version folder contains that string after decompression); `test_changed_files_only` (same content twice → empty list); `test_manifest_written_last` (manifest mtime ≥ every other file).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(pipeline): publish JSON contract with versions and health`

### Task 14: Orchestrator, incremental runs, demo dataset

**Files:**
- Create: `pipeline/orca/run.py`, `pipeline/orca/demo.py`
- Test: `pipeline/tests/test_run.py`

**Interfaces:**
- Consumes: all modules.
- Produces: CLI `uv run python -m orca.run weekly | rebuild | verify [--sample N] | demo [--out DIR]` (`verify` rebuilds N random funds from scratch in a temp dir and exits non-zero if any file differs from the published one); `price_flags(holdings, px, q) -> list[dict]` (reported value ÷ shares more than `PRICE_MISMATCH`× from our close); `split_suspects(holdings, splits) -> list[dict]` (a fund's share count changes by exactly 2, 3, 4, 5, 10, 1/2, 1/3, 1/4, 1/5 or 1/10× in a quarter with no vendor split); `run_weekly(lake, out_root, sources: Sources, today: date, full: bool = False) -> RunStats`; `affected_funds(new_filings: pl.DataFrame, changed_stocks: list[int], holdings: pl.DataFrame) -> set[int]`; `Sources` dataclass holding the SEC, FIGI, price and FRED fetchers (fixtures in tests); `demo.build_sources(seed: int = 7) -> Sources` producing synthetic bulk ZIPs, prices and T-bill data for 12 funds × 24 stocks over 2014–2026 (pattern of the mockup engine).

Weekly flow: ingest unseen bulk ZIPs → live filings since last run → holdings → map new CUSIPs → update prices (only held tickers) → affected funds → recompute those funds → home lists → publish changed files → invariant checks (bridge on every recomputed fund-quarter, no negative shares) → health. A failed invariant aborts before `write_manifest`.

- [ ] **Step 1: Write failing tests** — `test_incremental_equals_full_rebuild` (run demo weekly over 3 simulated weeks including a restatement of an old quarter and a vendor split correction; a fresh `full=True` run produces byte-identical fund files); `test_unchanged_week_publishes_only_prices` (second run with no new filings → changed files are `latest_prices.json`, `manifest.json`, `health.json` and the touched `stock/*/weekly.json`); `test_bridge_failure_aborts_before_manifest`; `test_failed_zip_download_keeps_last_good` (bulk fetch raises `FetchError` → run completes on the remaining inputs, previous fund files untouched, `health.json` flags the URL); `test_price_mismatch_flagged` (value $5,000 for 10 shares vs close $40 → flagged, P&L uses $40); `test_split_suspect_flagged` (100 → 300 shares with no split → flagged).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `run.py` and `demo.py`.
- [ ] **Step 4: Run** — PASS, then `uv run python -m orca.run demo --plain --out ../web/public/demo-data` (`--plain` = uncompressed JSON so Vite's dev server can serve it) and check `funds.json` lists 12 funds.
- [ ] **Step 5: Commit** `feat(pipeline): weekly orchestrator, incremental recompute and demo data` (commit the generated `web/public/demo-data` too; Plan B uses it).

### Task 15: Real-data golden test and workflows

**Files:**
- Create: `pipeline/tests/test_golden.py`, `pipeline/tests/golden/`, `.github/workflows/pipeline.yml`, `.github/workflows/ci.yml`
- Modify: `pipeline/pyproject.toml` (pytest marker `network`)

**Interfaces:**
- Consumes: `run_weekly` with real `Sources`.

- [ ] **Step 1: Golden test** marked `@pytest.mark.network` (skipped unless `ORCA_NETWORK=1`): run the pipeline for Berkshire Hathaway (CIK 1067983) and one concentrated fund with < 20 positions over the latest 8 quarters; assert the bridge holds and compare `summary.json` and `positions.json` with snapshots in `tests/golden/`.
- [ ] **Step 2: Create snapshots** (needs `www.sec.gov`, `data.sec.gov`, `api.openfigi.com`, the price vendor and `api.stlouisfed.org` allowed, plus `TIINGO_KEY`, `OPENFIGI_KEY`, `FRED_KEY`). Hand-check three numbers per fund against the filings (share counts for 2 holdings, one quarter's total value) and note them in the commit message. If hosts or keys are missing, leave the test skipped and say so in the commit.
- [ ] **Step 3: `ci.yml`** — on push/PR: `uv sync`, `uv run pytest -m "not network"`.
- [ ] **Step 4: `pipeline.yml`** — `schedule: cron "23 6 * * 0"` (Sundays 06:23 UTC) and `workflow_dispatch` with input `full` (bool); steps: restore lake from R2 with rclone, `uv run python -m orca.run weekly` (`rebuild` when `full`), `rclone copy` the new version folder with `--header-upload "Content-Encoding: br" --header-upload "Content-Type: application/json"`, upload `manifest.json` last, sync lake back. A second job on `cron "41 7 1 * *"` (1st of each month) runs `uv run python -m orca.run verify --sample 50`. Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `TIINGO_KEY`, `OPENFIGI_KEY`, `FRED_KEY`, `ORCA_CONTACT`. Failure emails come from GitHub's default notifications.
- [ ] **Step 5: Validate workflows** with `actionlint` if available (`uvx actionlint` or the docker image); otherwise `python -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))"` on each file.
- [ ] **Step 6: Commit** `ci: pipeline schedule, CI and golden test`
