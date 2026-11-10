# Per-fund Excel workbook: design

Last verified: 2026-11-10
Status: design approved section by section in chat (sections 1–5); this written spec awaits the owner's review.
Decisions and rejected options: `docs/DECISIONS.md` 2026-11-10.

## 1. Goal

A paying user downloads one fund's workbook. It starts with the raw data (13F holdings as filed, quarterly prices, T-bill rates). Excel formulas then rebuild every figure on the fund page, in order from raw data to results, and the workbook shows that its figures agree with Orca's.

Two principles from the owner shape every choice:
- **Consistency.** On every tab a stock row is always in the same place in the stock order, and a column always means the same date.
- **Simplicity.** The workbook holds only what is needed to calculate the outputs, on as few tabs as possible.

## 2. Scope

**Phase 1 (this spec):**
- A workbook builder: one fund's input file in, an `.xlsx` out.
- The pipeline writes that input file from exactly what the engine used.
- A manual GitHub Action that builds workbooks for chosen funds into the private bucket.
- Reconciliation inside the workbook, and CI tests that prove it.
- The site's IRR moves to Excel's XIRR convention.
- The 500-position cut for big funds.

**Phase 2 (its own spec, later):**
- The monthly run writes the private input file for every fund.
- Login and payments.
- A Worker checks that the user has paid. A Cloudflare Container then builds the workbook on demand and keeps it until the next monthly run.
- The Download button.

**Not in scope:**
- Daily price bars.
- Positions as of past quarters. The workbook shows the latest quarter at latest prices, the fund page's default view.
- Any public file. Nothing is added to `pipeline/contract.md`.
- Pre-building workbooks.

**Blocker before charging:** a redistribution licence from Tiingo. A paid download that contains prices is commercial redistribution.

## 3. Workbook layout

There are three tabs, in order: **Model → Outputs → Summary** (raw data → calculation → results).

### 3.1 Conventions on every tab

**Label columns**, frozen on the left:
- A: block or row name
- B: ticker
- C: company name
- D: stock id
- E: units

**Time columns** on Model:
- one column per calendar year (first tracked year to the last);
- one empty gap column;
- a **Before** column: the value just before the tracked period starts (the last close before it, and the starting values: 0 shares, 0 cost, index and peak 1);
- one column per quarter, from the segment's first quarter to `bound` (the later of the fund's last held quarter and the deadline quarter);
- a **Latest** column, dated with the latest price date.

Year cells are always formulas over the same row's quarter cells, following the row's year rule (3.3).

**Year columns** cover the calendar years of the tracked quarters (segment start to `end_q`).

**Stock rows** cover every mapped stock (`kind == "SH"`, with a `stock_id`) that the fund filed in its tracked segment, priced or not. A stock that was never priced has rows of zeros. Its filed value counts toward % priced only when it is 0: the engine prices any positive filed value through the reported-value fallback, so a never-priced stock with a positive value cannot occur.

**Stock order** is identical in every block and on every tab: descending by peak quarter-end value (the same ranking the 500 cut uses), with ties broken by `stock_id`. When the fund has been cut, the "All other positions" row comes last.

**Colours** follow the financial-modelling convention: blue font for inputs, black for formulas, green for formulas that read another tab. Input cells are the header rows, the input blocks, the "All other positions" rows, Summary's From/To years and the Orca's-figures cells. Everything else is a formula.

**Formats:**
- dollars: thousands separators, no decimals;
- shares: whole numbers;
- prices: 4 decimals;
- returns: % with 2 decimals;
- ratios: 2 decimals;
- dates: `yyyy-mm-dd`.

**Blank or zero.** A formula shows blank (`""`) wherever the site shows "—": an undefined return, an average exit price when nothing was sold, a ratio whose denominator is zero, an IRR or XIRR with no answer (`#NUM!`). It shows 0 only where 0 is the true value, for example the shares of a stock not held, or the dividends of a quarter with none. Guards are explicit, such as `IF(B=0,"",A/B)`. `IFERROR` is used only around XIRR, so that other errors still show.

**Functions allowed** (portable to Excel 2016+, LibreOffice and Google Sheets): `IF`, `AND`, `OR`, `SUM`, `SUMIF(S)`, `COUNTIF(S)`, `AVERAGE`, `AVERAGEIFS`, `SUMPRODUCT`, `INDEX`, `MATCH`, `MAX`, `MIN`, `ABS`, `EXP`, `SQRT`, `STDEV.S`, `COUNT`, `XIRR`, `IFERROR`. Functions only in Excel 365 (`LET`, `LAMBDA`, `XLOOKUP`, `FILTER`, dynamic arrays) are not used. The first quarter of something (for example the first in book) comes from `MATCH(1,row,0)`. The last quarter of something (for example the last trade) comes from `SUMPRODUCT(MAX((condition)×(Quarter row+1)))−1`, which gives −1 for "none" and is shown blank.

**Recalculation.** The workbook sets `fullCalcOnLoad`. It stores **no cached values**; Excel, LibreOffice, Google Sheets and Numbers compute everything on open. See section 11 for why this changes the earlier plan.

**File name:** `orca-<fund_id>-<name slug>-<price date>.xlsx`.

### 3.2 Model tab

The tab runs from top to bottom. At the top is a short notes block, then the frozen header rows, and just below them (not above: an index above the freeze would fill a laptop screen with frozen rows) a block index with links to each block. Then come the fund inputs, the stock input blocks, the stock calculation blocks, the fund rows, and finally the Orca's-figures section that the checks use. Each block starts with a header row naming the block, followed by one row per stock.

**Notes (top):**
- fund name, fund id and CIK;
- the data date;
- "Estimates from SEC 13F filings, not the fund's real returns. Not investment advice.";
- how to read the tab: inputs in blue, years on the left, quarters on the right;
- what the cut removed, if anything;
- a link to `https://www.orcaetf.com/how-it-works`.

**Header rows** (quarter and Latest columns; inputs written by the builder):

| Row | Content |
|---|---|
| Quarter | contract quarter index `q` |
| Label | `Q2 2026` |
| Year | calendar year of the quarter (the key for year roll-ups) |
| Quarter end | date |
| Mid-quarter | quarter start + ⌊(quarter end − quarter start) / 2⌋ days. This is the trade date for XIRR. The Latest column holds the latest price date. |
| First tracked quarter | 1 in the segment's first quarter, else 0 |
| Held through | 1 up to the fund's last held quarter (`end_q`), 0 after it. Informational: calculation cells after `end_q` are simply not written. |

The year columns carry the year number in the Year row.

**Fund input rows:**

| Row | Content | Year rule |
|---|---|---|
| Carried quarter | 1 when the fund filed nothing that quarter and Orca carried the previous filing forward (`holdings.fill_gaps`), else 0 | sum |
| T-bill yearly average | FRED DTB3 yearly average as a decimal, repeated in each quarter of the year; blank for a year without one | year-end |
| SPY close | SPY's quarter close (today's share basis) | year-end |
| SPY VWAP | SPY's quarter VWAP | blank |
| Total reported value | the fund's whole reported value in the quarter: every row, including options, bonds and unmapped securities (for % priced) | year-end |

When the fund has been cut, the cut adds these inputs (section 6): Other positions buys, Other positions sells, Other positions count, Other positions held now.

**Stock input blocks** (rows = stocks; blank where the stock has no data):

| # | Block | Content | Year rule |
|---|---|---|---|
| I1 | Shares filed | shares as filed, share classes of one stock summed, before the split adjustment | year-end |
| I2 | Value filed ($) | reported value in dollars (filings before 2023-01-03 reported in thousands, already converted) | year-end |
| I3 | Split factor | multiplier from the filing's share basis to today's: the product of every later split (`prices.split_factors_by_quarter`) | year-end |
| I4 | Close | last close of the quarter, today's share basis. Before = the last close before the segment. Latest = the latest close (`run/market.latest_closes`, the same values as `latest_prices.json`). | year-end |
| I5 | VWAP | the quarter's volume-weighted average of the daily typical price (high + low + close) ÷ 3, today's basis (`quarter_px`) | blank |
| I6 | Dividends per share | dividends per share paid in the quarter, today's basis; 0 when none | sum |

**Stock calculation blocks.** In each formula below, *this* means this stock's cell in this quarter's column, *prev* means the same stock's cell one column to the left (for the first tracked quarter, that is the Before column), and *+4* means four columns to the right. Each block mirrors `engine/position.compute_position` line by line.

| # | Block | Formula (per stock, per quarter) | Year rule |
|---|---|---|---|
| C1 | Adjusted shares | `IF(I1="",0,I1×I3)` | year-end |
| C2 | Last close | `IF(I4<>"",I4,prev C2)`. Before = I4 Before. This is the latest close up to this quarter. | year-end |
| C3 | Implied price | `IF(AND(C1>0,I2>0),I2/C1,"")` (reported value per share, the last fallback) | blank |
| C4 | Valuation price | `IF(AND(C1=0,prev C5=0),"", IF(I4<>"",I4, IF(prev C2<>"",prev C2, IF(C3<>"",C3, IF(prev C5>0,prev C4,"")))))` | year-end |
| C5 | Shares held | `IF(C4="",0,C1)`. A held stock that cannot be valued yet stays out of the book. | year-end |
| C6 | In book | `IF(OR(C5>0,prev C5>0),1,0)` | sum (quarters in book) |
| C7 | Shares traded | `C5 − prev C5` | sum |
| C8 | Trade price | `IF(C7=0,"", IF(AND(prev C5=0,OR(First tracked quarter=1,prev C1>0),I4<>""),I4, IF(I5<>"",I5, IF(prev C2<>"",prev C2, IF(C3<>"",C3,C4)))))`. A first report trades at the close; otherwise at the VWAP, then the last close before, then the reported value per share, then the valuation price. | blank |
| C9 | Trade $ | `IF(C7=0,0,C7×C8)` (buys positive, sales negative) | sum |
| C10 | Market move | `IF(prev C5>0,prev C5×(C4−prev C4),0)` | sum |
| C11 | Trade gain | `IF(C7=0,0,C7×(C4−C8))` | sum |
| C12 | Dividends $ | `IF(prev C5>0,prev C5×I6,0)` | sum |
| C13 | P&L | `C10+C11+C12` | sum |
| C14 | Cost | `IF(C7>0,prev C14+C9, IF(C7<0,IF(C5=0,0,prev C14+C7×prev C14/prev C5),prev C14))`. Before = 0. This is the running average-cost basis. | year-end |
| C15 | Realised | `IF(C7<0,−C7×(C8−prev C14/prev C5),0)` | sum |
| C16 | Value | `IF(C5=0,0,C5×C4)` | year-end |
| C17 | Cash flow | `−C9`. Latest = shares now × I4 Latest; 0 when nothing is held. These are the site's IRR flows: dividends left out, trades at the mid-quarter date, the holding valued at the latest date. | sum |
| C18 | Cash flow if held | `IF(C7>0,−C9,0)`. Latest = (sum of positive C7) × I4 Latest. These are the what-if flows, as if the fund had never sold. | sum |
| C19 | 1-year-after return | `IF(C7=0,"",IF(+4 I4<>"",+4 I4/C8−1,""))`: the stock's close four quarters later over the trade price. It feeds "buys vs sells next 12 months". | blank |
| C20 | Points | year columns only: `IF(year C6=0,"",IF(year Start+year Net buying/2>0, year C13/(year Start+year Net buying/2)×100,""))`. This is "What drove". | (year-only) |

Calculation cells after `end_q` are not written, so they are blank by construction ("Held through" stays as an informational row), with one exception: the two cash-flow rows (C17, C18) hold the number 0 there up to Latest, because those flows are truly 0 and Excel's behaviour with empty cells inside an XIRR range is unverified. The Close row runs to `bound`, because the what-if figures read closes four quarters after a sale.

**Fund rows** (quarter columns, bottom of Model):

| Row | Formula | Year rule |
|---|---|---|
| Start | prev End (0 in the first tracked quarter) | first quarter's Start |
| End | `SUM` of C16 down the column | year-end |
| Buys | `SUMIF(C9 column,">0")` (+ Other positions buys) | sum |
| Sells | `−SUMIF(C9 column,"<0")` (+ Other positions sells) | sum |
| Net buying | Buys − Sells | sum |
| Market move | `SUM` of C10 | sum |
| Trade gains | `SUM` of C11 | sum |
| Dividends | `SUM` of C12 | sum |
| Bridge gap | End − (Start + Market move + Net buying + Trade gains) | sum |
| Bridge OK | `ABS(gap) <= 1e-6×MAX(1,ABS(End),ABS(Start),Buys+Sells)` (1/0) | min |
| Return | `IF(AND(First tracked quarter=0,Start>0,Start+Net buying/2>0),(End−Start−Net buying+Dividends)/(Start+Net buying/2),"")` | chained: `IF(year count=0,"",Year-to-date growth at the year's last quarter−1)` |
| Growth | `IF(Return="",1,1+Return)` | product |
| Has return | `IF(Return="",0,1)` | sum (quarters with a return) |
| Risk-free used | `IF(T-bill<>"",T-bill,prev Risk-free used)`; 0 when no earlier rate exists (`metrics._quarterly_rf`) | year-end |
| Excess return | `IF(Return="","",Return−Risk-free used/4)` | blank |
| Downside² | `IF(Excess return="","",MIN(0,Excess return)^2)` | blank |
| Index | prev Index × Growth (Before = 1) | year-end |
| Peak | `MAX(prev Peak, Index)` (Before = 1) | year-end |
| Drawdown | Index ÷ Peak − 1 | min |
| In range | 1 when the quarter's year is between Summary's From and To years, else 0 | — |
| Return in range | `IF(AND(In range=1,Return<>""),Return,"")` | blank |
| Range index, Range peak, Range drawdown | as Index, Peak and Drawdown, but restarting at 1 outside the range | blank |

The cut also adds an "All other positions" row with input values (End, Market move, Trade gains, Dividends) to the summed blocks (section 6).

**Year-only fund rows** (year columns):

| Row | Formula |
|---|---|
| Full year | `IF(Has return year total=4,1,0)`, the same set of years as `engine.fund.full_years` |
| Return if full year | `IF(Full year=1,year Return,"")` |
| Gains | Market move + Trade gains |
| Inflows | Net buying |
| Approx. return | `IF(Start+Inflows/2>0,(Gains+Dividends)/(Start+Inflows/2),"")` |
| Mean book | `IF(Full year=1,AVERAGE(Start, the year's four quarter Ends),"")` |
| Turnover | `IF(AND(Full year=1,Mean book>0),MIN(Buys,Sells)/Mean book,"")` |
| AUM: carried over, net inflows, gains, losses, outflows | the AUM chart's stack (`web/src/fund/aum.ts` `aumParts`): losses and outflows come off gains first, then off inflows, and the first year with a start ≤ $100k is one block |

**Orca's figures (for the checks; inputs, bottom of Model):**
- quarter rows: start, end, market move, net buying, trade gains, dividends, return;
- year rows: return, start, end, gains, inflows, dividends, approx. return;
- two stock blocks in the year columns: Orca points and Orca P&L (`contrib.json`).
- All values are the engine's own, unrounded.

### 3.3 Year rules

| Rule | Year cell |
|---|---|
| sum | `SUM` over the year's contiguous quarter cells, referenced directly |
| year-end | the row's cell in the year's last tracked quarter, referenced directly |
| first quarter's Start | the row's cell in the year's first tracked quarter, referenced directly |
| chained / product | the year's running-growth cell (the "Year-to-date growth" fund row, a running product of Growth reset at each year's first tracked quarter) at the year's last quarter, minus 1; no `LN` anywhere, because `LN` gives `#NUM!` for a quarterly return of −100% or less where the engine still returns a number |
| min | `MIN` over the year's contiguous quarter cells |
| blank | empty |

### 3.4 Outputs tab

**Stock table** (rows = stocks, same order; columns = measures). These are the positions at the latest quarter at latest prices, followed by the what-if columns.

| Column | Formula |
|---|---|
| From quarter | first quarter with C6 = 1 |
| To quarter | the quarter of the last exit when shares now = 0, else blank |
| Shares now | C5 at `end_q` |
| Cost now | C14 at `end_q` |
| Invested | `SUMIF(C9 row,">0")` |
| Shares bought | `SUMIF(C7 row,">0")` |
| Avg cost | Invested ÷ Shares bought |
| Shares sold, $ sold | `−SUMIF(C7 row,"<0")`, `−SUMIF(C9 row,"<0")` |
| Avg exit | `IF(Shares sold>0,$ sold/Shares sold,"")` |
| Realised | `SUM(C15 row)` |
| Dividends | `SUM(C12 row)` |
| Latest price | I4 Latest |
| Value now | `IF(Shares now=0,0,IF(Latest price="","",Shares now×Latest price))` |
| Unrealised | `IF(Shares now=0,0,IF(Value now="","",Value now−Cost now))` |
| Total P&L | `IF(Unrealised="","",Realised+Unrealised+Dividends)` |
| Return | `IF(AND(Invested>0,Total P&L<>""),Total P&L/Invested,"")` |
| IRR | `IF(AND(Shares now>0,Latest price=""),"",IFERROR(XIRR(C17 row from the position's first trade quarter to Latest, Mid-quarter row over the same columns),""))`, blank outside −99%…1,000% (the site's search range). The range starts at the first trade, not at the first quarter column: after years of leading zero flows LibreOffice's XIRR stopped at a spurious root (14,220% against the site's −28%), and the IRR does not depend on where the dates start |
| Weight | Value now ÷ total Value now (including Other positions held now) |
| Last change | the site's newest quarter is `period_q` (the latest filed quarter; `end_q` may be the carried copy after it). Shares at `period_q` (a) against `period_q − 1` (b), both at latest prices: A = a×price, B = b×price, vb = Σ B (+ Other). dw = (A/(vb−B+A) − B/vb)×100 when the denominators are positive. Tag New/Add/Trim/Exit as in `positions.buildRows`. |
| Last trade: quarter, type, %, $ | the position's last nonzero C7, as `publish._last_change` (% = delta ÷ shares before, for an add or trim only) |
| What-if: status | blank when never sold; "Sold all" when Shares now = 0, else "Trimmed" |
| Last sale quarter, last sale price | the last quarter with C7 < 0, and its C8 |
| 1 year later | that sale's close four quarters on, else blank |
| One-year return | 1 year later ÷ last sale price − 1 |
| SPY one-year | SPY close four quarters on ÷ SPY VWAP in the sale quarter − 1 |
| Beat SPY | 1/0 when both exist |
| Since sale | `IF(AND(Avg exit>0,Latest price<>""),Latest price/Avg exit−1,"")` |
| Missed | `IF(Latest price="","",Shares sold×Latest price−$ sold)` (plus = sold too early) |
| IRR if held | `IF(Latest price="","",IFERROR(XIRR(C18 row from the first trade quarter to Latest, Mid-quarter row over the same columns),""))`, for sold stocks, blank outside −99%…1,000% |
| Hold length (years) | ((To quarter or `end_q`) − From quarter + 1) ÷ 4 |

**Orca's columns** follow, as inputs, from `positions.json` and `exits.json` (engine values, unrounded): avg_cost, avg_exit, invested, realised, dividends, shares_now, cost_now, from_q, to_q, last_q, last_type, last_pct, last_usd, sold_shares, sold_usd, last_sale_q, one_y, spy_one_y.

**Difference cells.** Each Orca value, on Model (rows) and on Outputs (columns), has a difference cell beside it:
- 0 when both are blank;
- 1E+300 when only one of them is blank;
- otherwise, for dollars and shares, `ABS(Excel−Orca)/MAX(1,ABS(Orca),scale)`; for returns and ratios, `ABS(Excel−Orca)/MAX(1,ABS(Orca))`; for quarters, counts and text, `IF(Excel=Orca,0,1)`. The scale is computed in Excel on the same tab: a fund quarter's `MAX(ABS(Start),ABS(End),Buys+Sells)`, a fund year's maximum of that over its quarters, a stock's `MAX` of its |Value|, |Cost| and Invested. Reason: sums of large cancelling terms differ by about 1E−16 × terms between LibreOffice (compensated summation) and the engine (plain addition). The Summary book uses `MAX(1,ABS(Orca))`.

**Checks table** (one row per measure):

| Column | Content |
|---|---|
| Measure | name |
| Compared | count of cells compared |
| Max difference | `MAX` of the measure's difference cells |
| Tolerance | 1e-9 for dollars, shares, returns and ratios (each difference is already scaled as above); 0 for quarters, counts and text |
| Result | PASS/FAIL |

What is compared:
- each quarter: start, end, market move, net buying, trade gains, dividends, bridge, return;
- each year: return, start, end, gains, inflows, dividends, approx. return;
- whole-period metrics: ann. return, Sharpe, Sortino, vol, max drawdown, Calmar, % quarters positive, best and worst year, years positive / total, turnover, hold (all), hold (sold);
- What drove: points and P&L per stock-year;
- every Orca stock column;
- exits summary: buys 12m, sells 12m, beat SPY %;
- header: book, holdings now, % priced.

Figures only the site computes (IRR, the latest-price P&L columns, weight, last change, % profitable, since sale, missed, IRR if held, the range tiles, the AUM parts) have no Orca number in the file. CI proves them against the site's own code (section 9).

### 3.5 Summary tab

**Header:** fund name, fund id, CIK, latest quarter filed (`period_q`), filed date, book (End at `end_q`), holdings now (stocks with shares now > 0, plus Other positions held now), positions ever (stocks with at least one quarter in book, plus Other positions count), % priced (the sum of I2 at `end_q`, plus Other positions, ÷ Total reported value at `end_q`).

**Range inputs** (blue): From year and To year. The default is the first and last year with a return. Typing the years of the site's bracket reproduces its first row of tiles.

**Tiles, row 1 (over the range):**
- annualised return: `MAX(growth,0)^(4/n)−1`, blank when n < 4 (n = `COUNT` of Return in range), plus growth of $1;
- years positive: full years in range with return > 0 / full years in range, plus % of quarters positive;
- max drawdown: `MIN(Range drawdown)`;
- volatility: `STDEV.S(Return in range)×2`, blank when n < 4.

**Tiles, row 2 (whole period, as `metrics.performance` and the summary):**
- Sharpe: `AVERAGE(Excess)×4/(STDEV.S(Excess)×2)`;
- Sortino: `AVERAGE(Excess)×4/(SQRT(SUM(Downside²)/n)×2)`;
- Calmar: ann. return ÷ |max drawdown|;
- each is blank when n < 4 or its denominator is 0;
- turnover: `AVERAGE(Turnover row)`;
- average hold: hold (all) and hold (sold);
- positions profitable: `COUNTIF(Total P&L,">0")/COUNT(Total P&L)` (+ Other positions' counts).

**Whole-period values** of the same figures, and best and worst year (the earliest year on ties, via `MATCH`).

**Checks:** number of FAILs, overall PASS/FAIL, and a link to the checks table.

## 4. The 500-position cut

The cut applies when the fund has more than 500 positions in its tracked segment.
- Positions are ranked by peak value: the maximum of `PositionQuarter.value` over the segment, ties broken by `stock_id`.
- The top 500 get full stock rows.
- The rest become **one "All other positions" row** in each summed block (End/Value, Market move, Trade gains, Dividends, P&L, Value filed), plus fund input rows for their buys and sells per quarter. All of these come from Orca's own sums over those positions and are labelled as Orca inputs.
- The Outputs tab gets an "All other positions" block (a labelled input block below the Total row, not a row of the stock table, because the counts and sums do not fit the stock columns) with Orca's counts and sums: positions, held now, value now at latest prices (for weight), shares before × latest price (for last change), profitable count and computable count, hold-length sum and count (all and sold), buys and sells 1-year-after return sums and counts, beat-SPY pairs, missed (too early and dodged).
- So fund-level figures stay exact. Only the stock-by-stock rebuild stops at 500.
- Measured: Vanguard's top 500 cover 81.5% of value in 22,438 stock-quarter rows.

## 5. Data flow and code (phase 1)

```
lake (private) ── run/compute.prepare_fund() ──┬─> engine (compute_fund) ──> FundOutput (Orca's figures)
                                               └─> workbook.inputs.FundInputs (+ FundOutput) ──> inputs JSON (private)
                                                                                              └─> workbook.build ──> .xlsx
```

**`run/compute.prepare_fund(ctx, status, rows, reports) -> Prepared`.** This is split out of `compute_fund` without changing behaviour: segment, `end_q`, `bound`, the share series (filed and adjusted), implied prices, bounded quarter prices per stock, SPY prices and the rate table. `compute_fund` calls it. The existing tests must stay green, and `verify` (sha256 of rebuilt funds) must match.

**`orca/workbook/`:**
- `inputs.py`:
  - `FundInputs`: everything in the input blocks and header rows, per stock in the final order, plus Orca's figures for the checks.
  - Built from `Prepared` + `FundOutput` + `split_factors_by_quarter` + `latest_closes`.
  - `to_json`/`from_json` round-trips exactly (floats as written by Python's `json`).
  - Checked on build: finite numbers, consistent lengths, no CUSIP key (the same guard as `publish._json_ready`).
- `cut.py`: the ranking and the "All other positions" sums.
- `layout.py`: the block registry. Each block has an id, a name, input or calculation, units, a year rule, a formula template and a number format. It is one table, so the builder and the tests read the same definitions.
- `build.py`: `FundInputs` → `.xlsx` with xlsxwriter (`constant_memory`), and no cached values.

**CLI:** `python -m orca.run workbook --fund ID [--fund ID …] [--out DIR]` builds the workbooks from a restored lake. For each fund it writes `inputs/<id>.json` (brotli) and `<file name>.xlsx`. A fund with no priced positions is skipped with a message. Bad inputs stop that fund with a clear error, and the command exits non-zero.

**Workflow `.github/workflows/workbook.yml`** (manual):
- input: `fund_ids` (space-separated, at most 20);
- environment: `production`; concurrency group `pipeline`, so it never reads a lake that is half saved;
- steps: restore the lake read-only; run the CLI; `rclone copy` to `R2_LAKE_BUCKET/workbooks/manual/<UTC date>/`;
- no save step, and nothing uploaded as a GitHub artifact (the repo is public);
- logs print fund ids, row counts, sizes and timings only.

**Dependency:** `xlsxwriter` pinned exactly in `pipeline/pyproject.toml` and `uv.lock`. It is pure Python under a BSD licence, with no dependencies of its own.

## 6. Site change: IRR moves to the XIRR convention

- New helper `midQuarterMs(q)`: quarter start + ⌊(quarter end − quarter start) / 2⌋ days, the same rule as the workbook's Mid-quarter row.
- IRR time becomes days ÷ 365 since 2013-01-01:
  - trades at `midQuarterMs(q)`;
  - the holding valued at the latest price date (`asof`), or at the quarter end for a past period (`positions.tEnd`).
  - This touches `live.ts` (`tradeT`, `positionFlows`, `heldFlows`), `positions.ts` (`tEnd`), `whatif.ts` (`nowT`), `Position.tsx`, and `api.ts` `yearsSince2013` (renamed, or kept with the 365-day basis).
- The solver is unchanged (bisection on −0.99…10, 200 iterations).
- `StockPanel.tsx` places chart markers with `tradeT × 365.25`. It switches to `midQuarterMs`, so the chart does not move.
- The Method page sentence on IRR is updated, and DECISIONS ruling R10 is noted as superseded.
- Measured effect: median change of 0.011–0.015 percentage points; 95% of positions under 0.18 pp; up to 11.8 pp on very short holds.

## 7. Reconciliation and tests

1. **Engine vs Excel** (pytest, marker `libreoffice`):
   - Build workbooks for the 12 demo funds and for hand-made edge-case funds: first report at the close; a stock priced for the first time (entering the book); the reported-value price fallback; a delisted stock (last-close fallback); a carried quarter; a split; an exit then re-entry; dividends; quarters with no return (first quarter, non-positive start); part years; fewer than four returns; the 500 cut with an "All other positions" row.
   - LibreOffice headless opens each file and computes it (there are no cached values), then saves it to a computed copy.
   - The test reads every checks row: all must PASS. Every Excel figure must also equal the engine's within the stated tolerances.
2. **Site vs Excel** (vitest):
   - The pytest run writes `web/tests/fixtures/workbook-cases.json`: for each demo and edge-case fund, the inputs in the site's shapes plus LibreOffice's results for the site-only figures.
   - vitest runs the site's own functions on those inputs (`live.ts`, `positions.ts`, `whatif.ts`, `series.ts`, `aum.ts`, `drive.ts`). They must match: 1e-9, IRR 1e-7.
   - A pytest check fails when the committed fixture differs from a fresh build (stale fixture).
3. **CI:** `ci.yml` installs LibreOffice (`apt-get install -y libreoffice-calc`, about 1–2 min) for the `libreoffice` tests. `web.yml` runs vitest as today.
4. **Unit tests:**
   - every block has a formula and a year rule;
   - formulas use only the allowed functions (a scan of the formula text);
   - the cut's sums add up;
   - `FundInputs` round-trips;
   - mid-quarter dates are right;
   - XIRR handles leading zero flows and blank Latest cells in Excel's and LibreOffice's sense (a spike test);
   - file name, colours, frozen panes.
5. **Size and time check:** a synthetic fund with 500 positions × 54 quarters must build in under 60 s on the CI runner and stay under 15 MB.
6. **Independent golden case** (owner, after phase 1 works): hand-check one real fund (Berkshire, `1067983`) against EDGAR and record it (ROADMAP D1).

**Known gap.** The site rounds trade prices to 4 decimals in `positions.json` before its own position maths, while the workbook uses the engine's unrounded prices. The tests feed both sides the same inputs, so they test the formulas, not the rounding. Phase 1 measures the effect on real funds with the manual Action; any fix is decided then.

## 8. Operations, errors, privacy

- **Size:** the biggest capped file is about 12,500 rows × about 75 columns. Measured on a similar sheet: about 3 MB and about 20 s to build. Most funds take under 1 s and a few hundred KB.
- **Errors:** blank, never `#DIV/0!` or `#NUM!`, for undefined figures. A build that fails validation stops with the fund id and the reason. A fund with no priced positions gets no workbook.
- **Privacy and licence:**
  - workbooks and inputs stay in the private lake bucket;
  - never public, never GitHub artifacts, never written to the public site bucket;
  - no CUSIP anywhere (the same guard as the public files);
  - no sharing outside the owner until the Tiingo licence is settled.

## 9. Docs to update with the build

- `docs/ARCHITECTURE.md`: a workbook section (module, CLI, Action, private paths).
- `docs/PRODUCT.md`: a features row, "Paid per-fund workbook (phase 1: owner-only)", and the IRR definition (days ÷ 365, mid-quarter dates).
- The Method page text.
- `docs/WORKLOG.md`.
- `CLAUDE.md`: commands table (`orca.run workbook`), repo map (`pipeline/orca/workbook/`).
- `pipeline/contract.md` is unchanged (no public file).

## 10. Risks and open items

| Item | Handling |
|---|---|
| Tiingo licence | blocker for phase 2 (charging); phase 1 is owner-only |
| LibreOffice vs Excel differences in edge functions (XIRR with zero flows, `STDEV.S` with text cells) | spike tests in item 7.4; only the portable functions are used |
| A formula block is wrong but matches Orca by coincidence | every block is covered by an edge case, and every check compares against the engine's own intermediate where one exists (`PositionQuarter` fields) |
| A big fund is slow to open in Excel | the 500 cut; size test in item 7.5 |
| The 4-decimal price rounding gap | measured in phase 1 (section 7, known gap) |

## 11. Change from the chat design

Section 5 in chat said "stored values are Orca's figures, so previews still show numbers". The spec instead stores **no cached values**. To store a cached value in every formula cell, the builder would have to compute every intermediate a second time in Python, which is the bloat the owner asked to avoid. And with no cached values, the tests exercise the exact file a user gets. The cost: preview apps that do not calculate (for example Quick Look) show empty cells. Excel, LibreOffice, Google Sheets and Numbers are unaffected.
