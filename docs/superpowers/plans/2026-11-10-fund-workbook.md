# Per-fund Excel Workbook (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one fund's Excel workbook. It starts from raw 13F holdings, quarterly prices and T-bill rates, rebuilds every fund-page figure with portable Excel formulas, and proves in the file and in CI that those figures equal Orca's. The site's IRR also moves to the XIRR convention.

**Architecture:**
- `run/compute.prepare_fund()` is split out of `compute_fund` so the engine and the workbook read identical inputs.
- `orca/workbook/` turns those inputs (`FundInputs`, saved as private JSON) into an `.xlsx` with xlsxwriter. A single block registry (`layout.py`) drives both the builder and the tests.
- LibreOffice headless recalculates the files in tests. A JSON fixture carries the results to vitest, which checks them against the site's own functions.
- A manual Action builds workbooks for chosen funds into the private bucket.

**Tech Stack:** Python ≥ 3.13, uv, Polars, xlsxwriter 3.3.1, openpyxl 3.1.5 (dev only, to read recalculated files), LibreOffice 24.x headless (tests and CI), React/TypeScript + vitest (site IRR and parity tests), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-10-fund-workbook-design.md`. Read it in full before starting: section numbers below refer to it. Decisions and rejected options: `docs/DECISIONS.md` 2026-11-10.

## Global Constraints

**Formulas:**
- Excel functions allowed, and no others: `IF`, `AND`, `OR`, `SUM`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGE`, `AVERAGEIFS`, `SUMPRODUCT`, `INDEX`, `MATCH`, `MAX`, `MIN`, `ABS`, `EXP`, `LN`, `SQRT`, `STDEV.S`, `COUNT`, `XIRR`, `IFERROR`.
- No `LET`, `LAMBDA`, `XLOOKUP`, `FILTER` and no dynamic arrays.
- Blank (`""`) wherever the site shows "—" (undefined). 0 only where 0 is the true value.
- Guards are explicit, such as `IF(B=0,"",A/B)`. `IFERROR` is used only around `XIRR`.

**File:**
- No cached values. Set `fullCalcOnLoad`.
- Fonts: blue = inputs, black = formulas, green = formulas that read another tab.
- Formats:
  - dollars: thousands separators, 0 dp;
  - shares: 0 dp;
  - prices: 4 dp;
  - returns: % with 2 dp;
  - ratios: 2 dp;
  - dates: `yyyy-mm-dd`.
- Text from data (tickers, names) is always written as a string, never as a formula.
- Tabs, in order: `Model`, `Outputs`, `Summary`.
- Model columns: label columns A–E (name, ticker, company, stock id, units), then years, one gap, Before, quarters `start..bound`, Latest.
- Stock order: peak `PositionQuarter.value` descending, ties by `stock_id`; "All other positions" last.
- Cut: more than `max_positions = 500` positions in the segment → the top 500 get rows and the rest become one "All other positions" row.
- Mid-quarter date = quarter start + ⌊(quarter end − quarter start) / 2⌋ days, in both the workbook and the site.
- File name: `orca-<fund_id>-<name slug>-<price date>.xlsx`.

**Tolerances:** 1e-9 (relative to `MAX(1,|Orca|)` for dollars and shares; absolute for returns and ratios); exact for quarters, counts and text; IRR parity 1e-7.

**Privacy:**
- No CUSIP in any file (reuse the `publish._json_ready` key guard).
- Workbooks and inputs only ever go to the private lake bucket: never GitHub artifacts, never the public site bucket.
- Logs print fund ids, row counts, sizes and timings only.

**Dependencies:**
- `xlsxwriter==3.3.1` (runtime) and `openpyxl==3.1.5` (dev group), both pinned exactly in `pipeline/pyproject.toml` and locked in `uv.lock`.
- No new npm dependencies.

**Conventions:**
- Commits: `area: what changed`, with a body explaining why, ending with the session's attribution lines.
- Absolute paths in shell commands (the cloud shell's cwd drifts).
- Pipeline tests: `cd /home/user/Orca/pipeline && uv run pytest -m "not network"`. Web tests: `cd /home/user/Orca/web && npm test`.
- LibreOffice tests carry `@pytest.mark.libreoffice`. They skip when `soffice` is missing, unless `ORCA_REQUIRE_LIBREOFFICE=1`, in which case they fail.

## Review Focus

1. **Inactive fund** (bound > `end_q`, e.g. demo 9100010 Cobblereef, last filed Q4 2023):
   - calculation and fund cells after `end_q` are blank;
   - year columns stop at `end_q`'s year;
   - the Close block still runs to `bound`, so what-if one-year figures exist.
   - Test in Task 6.
2. **Carried last quarter** (`end_q = period_q + 1`, demo 9100005 Saltglass, last filed Q1 2026):
   - Last change compares `period_q` with `period_q − 1`;
   - Shares now and Cost now read `end_q`;
   - the header's latest quarter filed is `period_q`.
   - Test in Task 7.
3. **A stock filed but never priced:**
   - it has a row of zeros;
   - its filed value counts in % priced;
   - it does not count in positions ever.
   - Test in Task 8.
4. **IRR edge cases:**
   - a sold-out position (Latest flow 0);
   - a holding with no latest price (blank);
   - an IRR above 1,000% on a short hold (blank, as on the site);
   - leading zero flows.
   - Tests in Task 7 (workbook) and Task 9 (parity).
5. **A stock name that looks like a formula** (`=CMD()`, `+1`, `@x`) stays text in every tab. Test in Task 6.

---

### Task 1: Split `prepare_fund` out of `compute_fund`

**Files:**
- Modify: `pipeline/orca/run/compute.py` (`compute_fund`, around lines 262–397)
- Test: `pipeline/tests/test_compute_prepare.py`, and a session fixture in `pipeline/tests/conftest.py`

**Interfaces:**
- Produces, in `orca.run.compute`:
  - `@dataclass(frozen=True) class Prepared` with fields:
    - `cik: int`, `status: dict`, `start: int`, `end_q: int`, `bound: int`;
    - `rows: pl.DataFrame` (filled holdings of the segment, every kind, with `carried`);
    - `reports: pl.DataFrame`;
    - `filed: dict[int, dict[int, tuple[float, float]]]`: stock → q → (shares as filed with share classes summed, value_usd);
    - `adjusted: dict[int, dict[int, tuple[float, float]]]` (as `_share_series` returns);
    - `implied: dict[int, dict[int, float]]`;
    - `px: dict[int, dict[int, QuarterPx]]` (bounded);
    - `spy_px: dict[int, QuarterPx]`.
  - `prepare_fund(ctx: Context, status: dict, rows: pl.DataFrame, reports: pl.DataFrame) -> Prepared`
  - `compute_prepared(ctx: Context, p: Prepared) -> FundResult`
  - `prepare_batch(ctx: Context, holdings: pl.DataFrame, reports: pl.DataFrame) -> Iterator[tuple[Prepared, FundResult]]`. It mirrors `compute_batch` and also yields the inputs.
  - `compute_fund(...)` keeps its signature and returns `compute_prepared(ctx, prepare_fund(...))`.
- Produces, in `pipeline/tests/conftest.py`: the session fixture `demo_run(tmp_path_factory) -> DemoRun`, where `DemoRun(root: Path, lake: Lake, last_q: int)`. It is one `run_weekly(..., full=True)` on `demo.build_sources(7)` as of `demo.DEMO_TODAY`, as in `demo.write_demo`.
- Produces, in `pipeline/tests/conftest.py`: `demo_batch(demo_run, ciks: list[int]) -> list[tuple[Prepared, FundResult]]`. It reads filings, raw holdings and reports for `ciks` the way `run/weekly.verify` does and runs `prepare_batch`. Later tasks reuse it.

- [ ] **Step 1: Write the failing tests**
  - `test_compute_prepared_equals_compute_fund`: for every demo fund 9100001–9100012, `publish_fund` bytes from `compute_prepared(ctx, prepare_fund(...))` equal those from `compute_fund(...)`.
  - `test_prepared_filed_times_factor_is_adjusted`: for every stock and quarter, `filed[s][q][0] * ctx.share_factors[s].of(q) == adjusted[s][q][0]` exactly, and the values are equal.
  - `test_prepared_bound_for_inactive_fund`: for 9100010, `end_q == q_index(2023, 4)` and `bound == demo.LAST_Q`.
- [ ] **Step 2: Run them**
  `cd /home/user/Orca/pipeline && uv run pytest tests/test_compute_prepare.py -v`. Expected: FAIL (`prepare_fund` not defined).
- [ ] **Step 3: Implement**
  Move lines 269–303 (segment, rows filter, `shares_rows`, `ctx.load`, `_share_series`, implied, bounded px) into `prepare_fund`. Keep `_share_series` returning the summed frame, so `filed` comes from it before the factor is applied. Make no change to any arithmetic.
- [ ] **Step 4: Run all pipeline tests**
  `uv run pytest -m "not network"`. Expected: all pass, including `test_verify_rebuilds_funds_and_finds_differences` and `test_incremental_equals_full_rebuild`.
- [ ] **Step 5: Commit**
  `pipeline: split prepare_fund out of compute_fund`. Body: the workbook must read exactly the engine's inputs.

### Task 2: Site IRR on the XIRR convention

**Files:**
- Modify:
  - `web/src/lib/live.ts`: `tradeT` → `tradeYears`; `positionFlows`, `heldFlows`
  - `web/src/data/api.ts`: `yearsSince2013` → 365-day basis
  - `web/src/fund/positions.ts`: `tEnd`
  - `web/src/fund/whatif.ts`: `nowT`
  - `web/src/pages/Position.tsx` (around line 205)
  - `web/src/fund/StockPanel.tsx` (around line 86)
  - `web/src/pages/Method.tsx`: the IRR sentence
- Test: `web/tests/live.test.ts`, `web/tests/fund-positions.test.ts`, `web/tests/fund-whatif.test.ts`, `web/tests/position.test.tsx` (update any expected IRR)

**Interfaces:**
- Produces, in `web/src/lib/live.ts`:
  - `export const midQuarterMs = (q: number): number`: UTC ms of quarter start + ⌊(quarter end − quarter start)/2⌋ days.
  - `export const tradeYears = (q: number): number => (midQuarterMs(q) − Date.UTC(2013,0,1)) / (365 × 86_400_000)`.
- Produces, in `web/src/data/api.ts`: `yearsSince2013(iso)` divides by `365 × 86_400_000`.
- `positions.tEnd` uses the same 365-day basis for past quarter ends.
- `StockPanel` places trade markers at `midQuarterMs(t.q)`. They move by under a day.

- [ ] **Step 1: Write the failing tests** (in `web/tests/live.test.ts`)

```ts
it("mid-quarter dates follow the workbook's rule", () => {
  const iso = (q: number) => new Date(midQuarterMs(q)).toISOString().slice(0, 10);
  expect([iso(4), iso(5), iso(6), iso(7), iso(12)]).toEqual(["2014-02-14", "2014-05-16", "2014-08-15", "2014-11-15", "2016-02-15"]);
});
it("IRR counts days ÷ 365 like XIRR", () => {
  // buy 100 on 2014-02-14 (q=4), worth 110 on 2015-02-14: exactly 365 days
  const t1 = (Date.UTC(2015, 1, 14) - Date.UTC(2013, 0, 1)) / (365 * 86_400_000);
  expect(irr([[tradeYears(4), -100], [t1, 110]])).toBeCloseTo(0.1, 12);
});
```

- [ ] **Step 2: Run them**
  `cd /home/user/Orca/web && npx vitest run tests/live.test.ts`. Expected: FAIL (`midQuarterMs` not exported).
- [ ] **Step 3: Implement** as in Interfaces. Remove `tradeT`. Update every caller (grep `tradeT\|yearsSince2013\|365.25`).
- [ ] **Step 4: Update the expected IRRs** in existing tests. Recompute each one from its own flows on the new basis; do not loosen tolerances.
- [ ] **Step 5: Update `Method.tsx`.** IRR: "trades dated mid-quarter, years of 365 days, as Excel's XIRR".
- [ ] **Step 6: Run everything**
  `npm test && npm run typecheck && PW_CHROMIUM=/opt/pw-browsers/chromium npx playwright test --trace off`. Expected: all pass.
- [ ] **Step 7: Commit**
  `web: IRR on the XIRR convention (mid-quarter dates, days ÷ 365)`. Body: the measured change (median 0.011–0.015 pp; DECISIONS 2026-11-10) and why (the workbook reproduces it with plain XIRR).

### Task 3: `FundInputs`, built from the engine's inputs

**Files:**
- Create: `pipeline/orca/workbook/__init__.py`, `pipeline/orca/workbook/inputs.py`
- Test: `pipeline/tests/test_workbook_inputs.py`

**Interfaces:**
- Consumes (Task 1): `Prepared`, `FundResult`, `prepare_batch`, `demo_batch`; also `orca.run.market.latest_closes(lake) -> dict[int, tuple[date, float]]`, `Context.share_factors`, `quarter_px.last_close_before`, and the `securities` table (ticker, name).
- Produces, in `orca.workbook.inputs` (all frozen dataclasses):
  - `StockInputs(stock_id: int, ticker: str, name: str, shares_filed, value_filed, split_factor, close, vwap: list[float | None], div_ps: list[float], close_before: float | None, close_latest: float | None)`. The lists have one entry per quarter column `start..bound`.
  - `OrcaStock(...)`: the `positions.json` and `exits.json` fields of spec 3.4 ("Orca's columns"), plus `points: dict[int, float]` and `pnl: dict[int, float]` keyed by calendar year. Engine values, unrounded.
  - `OrcaFund(quarters: dict[str, list[float | None]], years: dict[str, list[float | None]], metrics: dict, exits_summary: dict, book: float, n_holdings: int, priced_pct: float)`.
  - `FundInputs(fund_id, name, cik, period_q, filed: date, start, end_q, bound, latest_date: date, quarters: list[int], years: list[int], carried: list[int], tbill: list[float | None], spy_close, spy_vwap: list[float | None], total_reported: list[float], stocks: list[StockInputs], orca_stocks: list[OrcaStock], orca: OrcaFund, other: "OtherInputs | None")`.
  - `build_inputs(ctx: Context, p: Prepared, r: FundResult, latest: dict[int, tuple[date, float]], securities: pl.DataFrame, max_positions: int = 500) -> FundInputs`. Before Task 4 it requires `max_positions ≥` the number of positions and always sets `other=None`.
  - `to_json(fi: FundInputs) -> bytes` (brotli JSON); `from_json(data: bytes) -> FundInputs`; `validate(fi: FundInputs) -> None`, which raises `ValueError` with the fund id and the field.

- [ ] **Step 1: Write the failing tests** (demo funds via `demo_batch`)
  - `test_stock_order_is_peak_value_then_id`: the order equals `sorted(positions, key=(-max(pq.value), stock_id))`. Stocks filed but never priced come after, by `stock_id`.
  - `test_inputs_match_prepared`: for each stock and quarter:
    - `shares_filed`/`value_filed` equal `Prepared.filed`;
    - `split_factor` equals `ctx.share_factors[s].of(q)`;
    - `close`/`vwap`/`div_ps` equal `Prepared.px[s][q]`, with None/None/0.0 when the quarter is absent;
    - `close_before` equals `last_close_before(px, start)`;
    - `close_latest` equals `latest[s][1]`;
    - `latest_date` equals the max date in `latest`.
  - `test_carried_and_total_reported`:
    - `carried[i] == 1` exactly for the quarters whose rows have `carried=True` (9100004 has Q3 2018);
    - `total_reported[i]` equals `rows.filter(q == quarters[i]).value_usd.sum()` (every kind).
  - `test_tbill_and_spy`: `tbill` holds `ctx.rf[year]` per quarter or None; `spy_close`/`spy_vwap` come from `Prepared.spy_px`.
  - `test_orca_figures_are_the_engines`: `orca.quarters["ret"]` equals the `FundQuarter.ret` list; `orca_stocks[i].avg_cost` equals `PositionResult.avg_cost` (not rounded to 4 dp).
  - `test_round_trip`: `from_json(to_json(fi)) == fi` for all 12 demo funds.
  - `test_validate_rejects_non_finite_and_cusip`: `validate` raises on a NaN close, on lists of unequal length, and on a dict key `cusip`.
- [ ] **Step 2: Run them**
  `uv run pytest tests/test_workbook_inputs.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `inputs.py`. Use `publish._json_ready` semantics for the JSON (it refuses CUSIP keys and turns non-finite values into None). `validate` refuses non-finite values instead.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**
  `pipeline: workbook inputs from the engine's own inputs`.

### Task 4: The 500-position cut

**Files:**
- Create: `pipeline/orca/workbook/cut.py`
- Modify: `pipeline/orca/workbook/inputs.py` (`build_inputs` calls the cut)
- Test: `pipeline/tests/test_workbook_cut.py`

**Interfaces:**
- Produces, in `orca.workbook.cut`:
  - `OtherInputs`:
    - per-quarter lists: `value_filed`, `value`, `buys`, `sells`, `market_move`, `trade_gain`, `dividends`;
    - counts and sums: `count`, `held_now`, `in_book_count`, `value_now`, `before_value_now`, `profitable`, `computable`, `hold_sum_all`, `hold_n_all`, `hold_sum_sold`, `hold_n_sold`, `buys_1y_sum`, `buys_1y_n`, `sells_1y_sum`, `sells_1y_n`, `beat_pairs`, `beat_n`, `missed_early`, `missed_dodged`.
    - Each is computed from `PositionResult`, latest prices and `whatif._return_after`, as spec section 4 lists.
  - `split_top(positions: list[PositionResult], max_positions: int) -> tuple[list[PositionResult], list[PositionResult]]`
  - `other_inputs(rest: list[PositionResult], p: Prepared, latest: dict, period_q: int) -> OtherInputs`

- [ ] **Step 1: Write the failing tests** (`build_inputs(..., max_positions=3)` on 9100009 Seastack)
  - `test_top_rows_plus_other_equal_fund_totals`: for every quarter, the sum over the top 3 of `PositionQuarter.value` plus `other.value[i]` equals `FundQuarter.end` to 1e-9 relative. The same holds for buys, sells, market move, trade gains and dividends.
  - `test_other_counts`:
    - `other.count == len(positions) − 3`;
    - `other.held_now` = rest with `shares_now > 0`;
    - `other.hold_sum_all` = the sum over the rest of `((to_q or end_q) − from_q + 1) / 4`.
  - `test_ties_break_by_stock_id`: two positions with equal peak value keep `stock_id` order.
  - `test_no_cut_when_small`: `max_positions=500` gives `other is None` for every demo fund.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `cut.py`. Wire it into `build_inputs`. Never-priced stocks are not positions, so they stay as zero rows and are never cut.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**
  `pipeline: top-500 cut with an "All other positions" line`.

### Task 5: The block registry and column map

**Files:**
- Create: `pipeline/orca/workbook/layout.py`
- Test: `pipeline/tests/test_workbook_layout.py`

**Interfaces:**
- Produces, in `orca.workbook.layout`:
  - `mid_quarter(q: int) -> date`: the spec rule.
  - `Columns(years: list[int], quarters: list[int])` with:
    - `.year(y) -> str` and `.quarter(q) -> str` (column letters), `.before`, `.latest`, `.gap`;
    - `.first_q` and `.last_q`.
    - A–E are labels, then the years, the gap, Before, the quarters, Latest.
  - `Block(id: str, name: str, kind: Literal["input", "calc", "fund", "fund_input", "year_only"], units: str, year_rule: Literal["sum", "year_end", "first_start", "chained", "product", "min", "blank", "none"], number_format: str, formula: Callable[[Ref], str] | None)`.
  - `Ref` gives a formula template what it needs: `this(block)`, `prev(block)`, `ahead(block, k)`, `col_header(row_id)`, `fund(row_id)`, each returning an A1 reference.
  - `BLOCKS: tuple[Block, ...]`: I1–I6, C1–C20, the fund rows and the year-only rows of spec 3.2, in that order. Each formula is exactly the spec's.
  - `ALLOWED_FUNCTIONS: frozenset[str]`: the Global Constraints list.

- [ ] **Step 1: Write the failing tests**
  - `test_mid_quarter`: `[mid_quarter(q) for q in (4, 5, 6, 7, 12)] == [date(2014,2,14), date(2014,5,16), date(2014,8,15), date(2014,11,15), date(2016,2,15)]`.
  - `test_columns`: with years 2014–2015 and quarters 4–11, the year columns are F and G, the gap H, Before I, Q1 2014 = J, Latest = R.
  - `test_every_block_complete`: every `calc`/`fund` block has a formula and a year rule other than `none`; every `input` block has none.
  - `test_formulas_use_allowed_functions_only`: render every formula with a dummy `Ref`, take each `[A-Z][A-Z0-9.]*\(` token, and require it to be in `ALLOWED_FUNCTIONS`.
  - `test_c8_trade_price_order`: the rendered C8 formula, with a stub `Ref`, equals the spec string's structure: close if first report, VWAP, last close before, implied, valuation price.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `layout.py`. Formula strings use English function names and commas. xlsxwriter writes the `_xlfn.` prefix for `STDEV.S` itself (check `use_future_functions`).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**
  `pipeline: workbook block registry and column map`.

### Task 6: Builder, Model tab

**Files:**
- Create: `pipeline/orca/workbook/build.py`, `pipeline/tests/lo.py` (LibreOffice helper)
- Modify: `pipeline/pyproject.toml` (`xlsxwriter==3.3.1`; dev `openpyxl==3.1.5`; pytest marker `libreoffice`), `pipeline/uv.lock`
- Test: `pipeline/tests/test_workbook_model.py`

**Interfaces:**
- Consumes: `FundInputs` (Tasks 3–4), `BLOCKS`, `Columns`, `mid_quarter` (Task 5).
- Produces, in `orca.workbook.build`:
  - `build_workbook(fi: FundInputs, path: Path) -> BuildInfo`, where `BuildInfo(rows: int, cols: int, bytes: int, seconds: float)`. It writes Model fully, and Outputs and Summary as empty tabs (filled in Task 7).
  - `file_name(fi: FundInputs) -> str`
  - `cell_of(fi: FundInputs, tab: str, block_id: str, stock_id: int | None, column: int | str) -> str`. The test helper uses it to find any cell.
- Produces, in `pipeline/tests/lo.py`:
  - `recalc(path: Path, out_dir: Path) -> Path`: runs `soffice --headless --calc --convert-to xlsx --outdir`, with a 120 s timeout and a fresh `-env:UserInstallation=file://<tmp>` profile.
  - `values(path: Path) -> dict[tuple[str, str], object]`: openpyxl with `data_only=True`.
  - `require_libreoffice()`: skip, or fail when `ORCA_REQUIRE_LIBREOFFICE=1`.

- [ ] **Step 1: Add the dependencies**
  `cd /home/user/Orca/pipeline && uv add "xlsxwriter==3.3.1" && uv add --dev "openpyxl==3.1.5"`, then add the marker. Run `uv sync --locked`. Expected: OK.
- [ ] **Step 2: Write the failing tests** (`@pytest.mark.libreoffice`; all 12 demo funds; recalculated with `lo.recalc`)
  - `test_model_stock_cells_equal_engine`: for every position, quarter and engine field, the recalculated cell matches to 1e-9:
    - C5 = `shares`, C7 = `delta`;
    - C8 = `trade_px` (blank when None);
    - C14 = `cost`, C15 = `realised`, C10 = `market_move`, C11 = `trade_gain`, C12 = `dividends`, C16 = `value`;
    - C9 = `net_buying`.
    - Quarters the engine skipped (flat) show C6 = 0.
  - `test_model_fund_rows_equal_engine`:
    - Start, End, Buys, Sells, Net buying, Market move, Trade gains and Dividends equal `FundQuarter`;
    - Return equals `ret` (blank ⇔ None);
    - Bridge OK = 1 in every quarter.
  - `test_model_year_columns`:
    - the year Return equals `FundYear.ret`;
    - Start/End/Gains/Inflows/Dividends/Approx. return equal `FundYear`;
    - Full year equals the membership of `full_years`;
    - Turnover equals the per-year terms of `metrics.turnover`;
    - Points equal `contributions` (blank where the stock had no quarter in the year).
  - `test_inactive_fund_blank_after_end_q` (Review Focus 1): 9100010.
  - `test_formula_like_names_stay_text` (Review Focus 5): change a stock name to `=CMD()` in `FundInputs`. The cell is a string `=CMD()`, and its xlsxwriter cell type is a string.
  - `test_no_cached_values_and_full_calc`: the unzipped `xl/workbook.xml` has `fullCalcOnLoad="1"`, and no `<v>` element follows any `<f>` in the sheet XML.
  - `test_file_name_and_styles`:
    - `file_name(fi)` for 9100001 is `orca-9100001-kelpwood-capital-lp-2026-10-30.xlsx` (assuming the demo's latest price date is 2026-10-30; take it from `fi.latest_date`);
    - via openpyxl: input cells have font colour `FF0000FF`, formula cells on the same tab black, and cells reading another tab `FF008000`;
    - Model's freeze pane is at column F below the header rows.
- [ ] **Step 3: Run them**
  `uv run pytest tests/test_workbook_model.py -v`. Expected: FAIL (`build_workbook` missing).
- [ ] **Step 4: Implement**
  - `build.py` with `constant_memory=True`. Write rows top to bottom in the spec 3.2 order.
  - Freeze panes at F plus the header rows.
  - Put a block index with internal hyperlinks at the top.
  - Add the notes block text from spec 3.2, verbatim.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit**
  `pipeline: workbook Model tab (raw inputs to fund quarters and years)`.

### Task 7: Outputs, Summary and the checks

**Files:**
- Modify: `pipeline/orca/workbook/build.py`, `pipeline/orca/workbook/layout.py` (output columns, check rows)
- Test: `pipeline/tests/test_workbook_outputs.py`

**Interfaces:**
- Consumes: Tasks 3–6.
- Produces:
  - In `layout.py`: `OUTPUT_COLUMNS: tuple[Column, ...]` (spec 3.4 order, with formulas) and `CHECKS: tuple[Check, ...]`, where `Check(measure, kind: Literal["money", "ratio", "exact"], excel_cells, orca_cells)`.
  - Difference cells as in spec 3.4.
  - Summary cells: the Range inputs `From year` / `To year` as defined names `FromYear` / `ToYear`.

- [ ] **Step 1: Write the failing tests** (`libreoffice`; all 12 demo funds)
  - `test_all_checks_pass`: every Result cell in the checks table is `PASS`, and Summary's overall cell is `PASS`.
  - `test_outputs_equal_published_fields`: avg cost, avg exit, invested, realised, dividends, shares now, cost now, from/to quarter, last trade (q, type, %, $), sold shares, sold $, last sale quarter, one-year and SPY one-year equal the engine's `PositionResult` / `ExitRow` values.
  - `test_summary_metrics_equal_engine`: `ann_return`, `sharpe`, `sortino`, `vol`, `max_dd`, `calmar`, `quarters_pos_pct`, best and worst year (label and return), `years_pos`, `years_total`, `turnover`, `hold_all`, `hold_sold`, `buys_12m`, `sells_12m`, `beat_spy_pct`, `book`, `n_holdings` and `priced_pct` all equal `build_metrics(...)` and the meta. Blank ⇔ None.
  - `test_carried_last_quarter` (Review Focus 2): 9100005.
    - Summary's latest quarter filed = `period_q`;
    - Last change uses `period_q` vs `period_q − 1`;
    - Shares now = C5 at `end_q`.
  - `test_irr_blank_cases` (Review Focus 4), with hand-edited `FundInputs`:
    - a held stock with `close_latest=None` → IRR blank;
    - a stock bought and sold within two quarters at prices giving more than 1,000% → IRR blank;
    - a sold-out stock → IRR numeric.
  - `test_range_tiles_follow_from_to`: set `FromYear`/`ToYear` to 2016/2019 in the file before recalculating. Annualised return and volatility equal `spanKpi` maths on those years' quarterly returns, computed in the test from `FundQuarter.ret`.
  - `test_a_broken_formula_fails_a_check`: corrupt one Orca input cell (+1%) and recalculate. That measure's Result is `FAIL`, and overall is `FAIL`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** spec 3.2 (last part) and 3.4–3.5:
  - the Orca's-figures section at the bottom of Model (quarter rows, year rows, the Orca points and P&L blocks);
  - the Outputs columns and Orca columns;
  - every difference cell;
  - the checks table;
  - Summary.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit**
  `pipeline: workbook Outputs, Summary and in-file reconciliation`.

### Task 8: Edge-case funds, the cut end to end, size

**Files:**
- Test: `pipeline/tests/test_workbook_edges.py`, with helpers in `pipeline/tests/workbook_fixtures.py`

**Interfaces:**
- Consumes: `small_fixtures`-style builders (see `tests/test_run.py` `small_fixtures`, `flat_prices`), extended to several stocks, `run_weekly`, `prepare_batch`, `build_inputs`, `build_workbook`, `lo`.
- Produces: `multi_stock_fixtures(stocks: dict[str, pl.DataFrame], rows_by_q: dict[int, list[Holding]], ...) -> Fixtures` in `workbook_fixtures.py`.

- [ ] **Step 1: Write the failing tests.** Each builds one small fund, runs the pipeline, builds the workbook, recalculates it and requires all checks `PASS`. It then also asserts the case's own cell.
  - `test_reported_value_fallback`: a stock with no prices at all but a reported value. C4 = value ÷ adjusted shares; trade price = implied.
  - `test_never_priced_stock` (Review Focus 3): a stock with neither prices nor value.
    - its rows are zeros;
    - % priced includes its value;
    - positions ever excludes it.
  - `test_priced_later_enters_at_close`: no prices in its first two held quarters. It enters the book in the third quarter at that quarter's close (C8 = I4).
  - `test_delisted_uses_last_close`: prices stop mid-history. C4 = the last close afterwards; the exit trades at the last close before.
  - `test_exit_and_reentry`: held, gone for a quarter, held again. The second "new" trade is not a first report, so it trades at the VWAP.
  - `test_dividends_on_shares_at_start`: dividends 0.5/share in Q2. C12 = prior quarter's shares × 0.5.
  - `test_fewer_than_four_returns`: three quarters only. The metric tiles are blank and their checks `PASS` (blank = None).
  - `test_cut_end_to_end`: Seastack with `max_positions=3`. All checks `PASS`; Outputs has 3 stock rows + "All other positions".
  - `test_size_and_time`: a synthetic fund with 500 stocks × 54 quarters (generated `FundInputs`). `build_workbook` takes under 60 s and the file is under 15 MB. Recalculation is not needed.
- [ ] **Step 2: Run them.** Expected: FAIL (or a real mismatch). Fix the formulas in `layout.py`, never the expectations, unless the engine is shown to be wrong, in which case stop and report.
- [ ] **Step 3: Run the tests.** Expected: PASS.
- [ ] **Step 4: Commit**
  `pipeline: workbook edge-case and cut tests`.

### Task 9: Site vs Excel parity

**Files:**
- Create: `pipeline/orca/workbook/parity.py` (writes the fixture), `web/tests/fixtures/workbook-cases.json` (generated, committed), `web/tests/workbook-parity.test.ts`
- Test: `pipeline/tests/test_workbook_parity.py`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces, in `orca.workbook.parity`: `parity_cases(cases: list[tuple[FundInputs, dict]]) -> dict`. Its JSON shape, per case:
  - `positions`: `PositionRow`[] with unrounded trade prices;
  - `prices`: `{stock_id: price}`;
  - `asof`;
  - `summary`: `period_q`, `tracked_since_q`, `quarters`, `years`;
  - `contrib`;
  - `exits`;
  - `from_year`, `to_year`;
  - `expected`: LibreOffice's values for IRR, value now, unrealised, total, return, weight, dw, tag, since sale, missed, IRR if held (per stock); % profitable; the range tiles (ann, vol, mdd, years positive, quarters positive); the AUM parts per year.

- [ ] **Step 1: Write the failing tests**
  - pytest `test_parity_fixture_is_fresh`: regenerating from the 12 demo funds plus the Task 8 edge cases gives exactly the committed file's bytes. The failure message says how to regenerate.
  - vitest `workbook-parity.test.ts`: for each case, `buildRows` (newest quarter), `buildSaleRows`, `profitablePct`, `spanKpi(buildSeries(...), from, to)` and `aumParts` equal `expected`: 1e-9 relative for money and ratios, IRR 1e-7, tags exact.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `parity.py` and a CLI `uv run python -m orca.workbook.parity --out ../web/tests/fixtures/workbook-cases.json` (it needs LibreOffice). Generate and commit the fixture.
- [ ] **Step 4: Run both suites**
  `cd /home/user/Orca/pipeline && uv run pytest -m "not network"`, then `cd /home/user/Orca/web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit**
  `workbook: site vs Excel parity fixture and test`.

### Task 10: CLI, manual Action, CI, docs

**Files:**
- Create: `pipeline/orca/run/workbook.py`, `.github/workflows/workbook.yml`
- Modify:
  - `pipeline/orca/run/cli.py`: subcommand `workbook`
  - `.github/workflows/ci.yml`: install LibreOffice and set `ORCA_REQUIRE_LIBREOFFICE=1`
  - `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/DECISIONS.md` (R10 superseded note), `docs/WORKLOG.md`, `CLAUDE.md` (commands, repo map)
- Test: `pipeline/tests/test_workbook_cli.py`

**Interfaces:**
- Produces, in `orca.run.workbook`:
  - `build_workbooks(lake: Lake, fund_ids: list[int], out: Path, max_positions: int = 500) -> list[WorkbookResult]`
  - `WorkbookResult(fund_id: int, path: Path | None, inputs: Path | None, info: BuildInfo | None, skipped: str | None)`
  - It reads the filings the way `verify` does, then for each fund writes `out/inputs/<id>.json` (brotli) and `out/<file_name>`.
- CLI: `python -m orca.run workbook --fund ID [--fund ID …] [--out DIR] [--max-positions N]`.
  - Exit 0 when every fund built or was skipped with a reason.
  - Exit 1 when an id is unknown or validation failed.
  - Prints one line per fund: id, rows, MB, seconds, or the skip reason.

- [ ] **Step 1: Write the failing tests**
  - `test_cli_builds_two_demo_funds`: `main(["workbook", "--fund", "9100001", "--fund", "9100005", "--out", tmp])` returns 0. It writes 2 `.xlsx` files named `orca-9100001-…-2026-10-30.xlsx` and 2 `inputs/*.json` files that `from_json` reads.
  - `test_cli_unknown_fund_exits_1`: fund 123 → returns 1 and prints `fund 123: not found`.
  - `test_cli_skips_fund_without_priced_positions`: prints `fund …: skipped: no priced positions` and returns 0.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `run/workbook.py` and the CLI subcommand.
- [ ] **Step 4: Write `.github/workflows/workbook.yml`**
  - `workflow_dispatch` input `fund_ids` (string, at most 20 ids; checked in a step);
  - `environment: production`; `concurrency: pipeline`;
  - reuse `./.github/actions/setup-rclone` and `./.github/actions/restore-r2` exactly as `pipeline.yml` does;
  - `uv run python -m orca.run workbook --fund …`;
  - `rclone copy` of `out/` to `${R2_LAKE_BUCKET}/workbooks/manual/$(date -u +%F)/`;
  - no save step, no `upload-artifact`, `permissions: contents: read`.
- [ ] **Step 5: Edit `ci.yml`**
  Before the tests, add a step `sudo apt-get update && sudo apt-get install -y --no-install-recommends libreoffice-calc`, and set env `ORCA_REQUIRE_LIBREOFFICE: "1"` on the test step. Raise `timeout-minutes` to 45.
- [ ] **Step 6: Run actionlint**
  `actionlint .github/workflows/workbook.yml .github/workflows/ci.yml` (if installed; otherwise note it in the report). Expected: no errors.
- [ ] **Step 7: Update the docs** per spec section 9:
  - ARCHITECTURE: a workbook section (module, CLI, Action, private paths);
  - PRODUCT: features row "Paid per-fund workbook (phase 1: owner-only)" and the IRR definition;
  - DECISIONS: R10 superseded by 2026-11-10;
  - CLAUDE.md: commands and repo map;
  - WORKLOG: a top entry;
  - `Last verified:` dates.
- [ ] **Step 8: Run everything**
  pipeline `uv run pytest -m "not network"`; web `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 9: Commit**
  `workbook: CLI, manual Action, LibreOffice in CI, docs`.
