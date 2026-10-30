# Orca — Spec 1: 13F data backend + fund P&L site

Date: 2026-10-30
Status: approved in brainstorming, awaiting written-spec review
Mockup: `docs/superpowers/specs/2026-10-30-orca-mockups.html` (also published as a private artifact). Every fund name and number in it is made up.

## 1. Goal

Orca turns SEC 13F filings into an answer to "how did this fund actually do, and on which stocks?" — estimated returns, per-stock P&L, entry/exit prices, gains vs inflows, and whether the fund's sells were smart. WhaleWisdom and GuruFocus show what funds own; Orca shows how well they did it.

- Audience: amateur investors.
- Business model: free at launch; a $10/person/month top tier later.
- Precision target: hobbyist. Shortcuts are fine as long as every estimate is labelled as one.
- Constraint: fast and cheap. No always-on server, no database server.
- Constraint: data comes from the SEC and a licensed price vendor only. No WhaleWisdom, GuruFocus, sec-api.io or other 13F competitors as data sources.

### In scope (this spec)

1. Data backend: SEC 13F ingest, security master, prices, incremental weekly updates.
2. Fund P&L engine: trade-price estimates, average-cost P&L, quarterly/annual returns, AUM bridge, contributions, performance metrics, "what if they'd kept it".
3. Static website: Home, Fund page, Position detail, Methodology.

### Out of scope (later specs)

- Spec 2: skill scores (sector-peer benchmarks, Fama-French alpha, DGTW, copier/lag cost, analyst knowledge graph).
- Spec 3: sector rotation.
- Optional later: market flows (institutional share of volume, FINRA retail proxy), Form ADV true investor flows, 13D/G and Form 4 between-quarter updates, stock pages ("who holds X"), login, the $10 tier, email alerts, pre-2013 history.

## 2. Data sources

| Need | Source | Cost | Notes |
|---|---|---|---|
| 13F holdings | SEC Form 13F data sets (quarterly ZIPs of TSVs, Jul 2013 →) | $0 | Public, free to redistribute |
| New 13F filings between bulk releases | EDGAR daily index + each filing's information-table XML | $0 | Powers "Just filed"; ≤ 10 requests/sec with a contact User-Agent |
| Company ID, SIC code, ticker list | data.sec.gov submissions API, `company_tickers.json` | $0 | |
| Shares outstanding (market cap) | data.sec.gov XBRL company facts (`EntityCommonStockSharesOutstanding`) | $0 | |
| CUSIP → ticker/FIGI | OpenFIGI mapping API (free key: 25 requests / 6 s, 100 jobs per request) | $0 | Fallback: issuer-name match against SEC ticker list |
| Daily prices (OHLC, volume, splits, dividends), incl. delisted | Tiingo (redistribution plan, $250/mo startup) | ~$3k/yr | Fallback vendor: Massive (ex-Polygon) business plan. Development uses a personal plan / Alpha Vantage, never shown publicly |
| Risk-free rate | FRED 3-month T-bill (DTB3) | $0 | For Sharpe/Sortino |
| Benchmark | SPY total-return prices from the price vendor | included | Avoids licensing S&P index data |

CUSIPs are used only as an internal join key. They are never shown in the UI or in published files; every stock gets an Orca `stock_id` keyed to its FIGI/ticker.

## 3. Architecture

```
GitHub Actions (weekly cron + manual "run now")
  └─ Python pipeline (DuckDB + Polars)
       ├─ ingest:   SEC bulk ZIPs, EDGAR daily index, OpenFIGI, price vendor, FRED
       ├─ store:    Parquet (zstd), partitioned by quarter / year   ← internal "lake"
       ├─ compute:  only funds/stocks touched by new data
       └─ publish:  brotli-compressed JSON per fund + home lists → Cloudflare R2/Pages
Static React site (Cloudflare Pages)
  └─ loads a fund's JSON from the CDN, draws charts in the browser,
     multiplies holdings by latest_prices.json for current values
```

- Nothing of ours runs when a visitor loads a page. Hosting is ~$0–5/mo.
- Fund pages are pre-rendered as basic HTML (name, headline numbers) so search engines can index them; the app hydrates on top.
- The pipeline's state (Parquet lake, manifests) lives in an R2 bucket so each Actions run starts from the last good state.
- Publishing is atomic: a run writes to a new version folder, uploads only changed files, then swaps `manifest.json` to point at it. A failed run leaves the site on the last good version.

## 4. Data pipeline

### 4.1 Steps

1. **Download** SEC 13F bulk ZIPs not yet in `manifest.ingested` (keyed by file name + checksum). Use the SUBMISSION, COVERPAGE and INFOTABLE tables.
2. **Live filings:** read the EDGAR daily index since the last run; fetch new 13F-HR and 13F-HR/A filings and parse their information-table XML into the same shape. When the quarter's bulk ZIP later arrives, its rows replace the live-parsed rows for those accession numbers.
3. **One report per fund per quarter:** keep 13F-HR (skip 13F-NT notices). A restatement amendment replaces the original; a new-holdings amendment appends rows.
4. **Collapse duplicates:** sum shares for the same fund, quarter, CUSIP and type.
5. **Map CUSIPs:** look up only CUSIPs not already in `cusip_map` via OpenFIGI; fallback to issuer-name match; otherwise mark `unpriced`.
6. **Classify:** common stock and ETFs are priced. Options (PUT/CALL) and principal-amount rows (bonds) are kept for display but excluded from P&L.
7. **Prices:** fetch only days since the last run, only for tickers held in the latest quarter (delisted tickers are fetched once). Store daily open/high/low/close, volume, split factor, dividend.
8. **Split-adjust** 13F share counts so splits never look like buys or sells.
9. **Sector:** ticker → CIK → SIC → one of 11 sectors via `sic_to_sector.csv` (Tech, Communication, Consumer discretionary, Consumer staples, Health care, Financials, Real estate, Energy, Industrials, Materials, Utilities), plus "ETF/Fund" and "Other".
10. **Compute** derived tables for affected funds (section 5) and **publish** (section 6).

### 4.2 Incremental updates

- **Weekly run:** new price days only → append one small Parquet file; monthly compaction into yearly files. Regenerate `latest_prices.json`. Fund files are not rewritten for price moves; the browser computes current value and unrealised P&L from `latest_prices.json`.
- **Quarter-average prices** are frozen once a quarter closes; the open quarter is computed once at close.
- **New/amended filings:** holdings are stored one Parquet file per quarter, so a new quarter is a new file and an amendment rewrites only its quarter's file. Only funds with new or amended filings are recomputed (each fund's full history recomputes in milliseconds).
- **Vendor split/price corrections:** recompute only funds holding that stock.
- **Upload:** only files whose checksum changed.
- **Full rebuild:** manual trigger, used only when a formula changes.

### 4.3 Internal tables (Parquet, zstd, integer keys)

| Table | Key columns | Main fields |
|---|---|---|
| `filers` | fund_id (int32) | cik, name, latest_book, n_holdings, flags (bank/insurer/pension/broker, index giant) |
| `filings` | accession | fund_id, period (quarter int16), filed_date, form, amendment_type, source (bulk/live) |
| `securities` | stock_id (int32) | figi, ticker, name, cik, sic, sector, kind (stock/etf/option/bond) |
| `cusip_map` | cusip | stock_id, method (openfigi/name/unmapped) — internal only |
| `holdings` | fund_id, quarter, stock_id, kind, put_call | shares_raw, shares_adj, value_reported |
| `prices_daily` | stock_id, date | open, high, low, close (float32), volume, split_factor, dividend |
| `quarter_px` | stock_id, quarter | vwap, low, high, close, monthly_vwap[3] |
| `position_quarter` | fund_id, stock_id, quarter | shares, delta, trade_type, trade_px, cost, realised, price_pnl, trade_pnl, dividends |
| `fund_quarter` | fund_id, quarter | start_value, end_value, net_buying, buys, sells, pnl, dividends, return |

Estimated size for 2013 → now: 300–600 MB of Parquet (raw SEC ZIPs ~4 GB).

## 5. Calculations

All results are estimates from quarter-end snapshots of long US stock positions; they are not the fund's real returns.

### 5.1 Trade price

```
typical price = (high + low + close) / 3            (daily)
quarter VWAP  = Σ(typical price × volume) / Σ volume  (over the whole quarter)
```

All of a quarter's share changes are assumed to trade at that quarter's VWAP. The quarter's low and high are stored and shown as a range. Monthly VWAPs are stored for future use with dated filings (13D/G, Form 4).

### 5.2 Per-position P&L (average cost)

```
delta      = shares(q) − shares(q−1)          (split-adjusted)
buy:  cost += delta × VWAP
sell: realised += |delta| × (VWAP − cost/shares);  cost −= |delta| × cost/shares
dividends  = Σ shares(q−1) × dividends paid in q
unrealised = shares now × latest price − cost
total      = realised + unrealised + dividends
return %   = total / Σ $ bought
avg cost   = Σ $ bought / Σ shares bought      (shown as "Avg cost"; same as average entry)
avg exit   = Σ $ sold / Σ shares sold
IRR        = cash flows at mid-quarter dates (buys −, sells +), terminal value = shares now × latest price
last change % = delta / shares before (of the most recent trade); "New" / "Sold all" for opens/exits
last change $ = delta × VWAP
```

### 5.3 Fund returns and AUM bridge

```
start value = Σ shares(q−1) × close(q−1)
end value   = Σ shares(q) × close(q)
net buying  = Σ delta × VWAP
quarter return = (end − start − net buying + dividends) / (start + ½ × net buying)
annual return  = four quarterly returns chained
```

Bridge (adds up exactly every quarter; checked on every run):

```
end = start
    + market move on stocks already held   Σ shares(q−1) × (close(q) − close(q−1))
    + net buying                           Σ delta × VWAP
    + gain/loss on this quarter's trades   Σ delta × (close(q) − VWAP)
```

"Investment gains" on the Gains-vs-inflows chart = market move + trade gains. "Net inflows" = net buying (a proxy, not investor money).

### 5.4 Year contributions

Per stock per year: Σ quarterly P&L (market move + trade gains + dividends) ÷ (start value of year + ½ × net buying in year), in percentage points. Contributions sum to a simple-Dietz annual return, which differs slightly from the chained return; the page shows both.

### 5.5 Fund metrics (top of fund page)

Computed over the fund's full calendar years (and over 1y/3y/5y/since-start windows for the home leaderboard):

- Return per year: chained quarterly returns, annualised.
- Sharpe ratio: (mean quarterly return − 3-month T-bill/4) × 4 ÷ (stdev of quarterly excess returns × 2).
- Sortino ratio: same numerator ÷ annualised downside deviation of excess returns.
- Volatility: stdev of quarterly returns × 2.
- Max drawdown: worst peak-to-trough of the quarterly return index.
- Calmar ratio: return per year ÷ |max drawdown|.
- Best / worst year; years positive; % of quarters positive.
- Portfolio turnover per year: per year, min(Σ buys, Σ sells) ÷ average book value; averaged over years.
- Average position hold length (all positions, and sold positions only).
- % of positions profitable.

The page states that quarter-end data understates volatility and drawdown.

### 5.6 What if they'd kept it

For every position with a sell or trim:

- Return since sale: latest price ÷ avg exit − 1.
- 1y after: price 4 quarters after the last sale ÷ that sale's VWAP − 1; SPY over the same window.
- $ missed (positive) or dodged (negative): Σ shares sold × (latest price − sale VWAP).
- IRR actual vs IRR if held (same buys, no sells, all bought shares valued at the latest price).

Fund summary: total $ sold too early, total $ dodged, % of sales whose stock beat SPY over the next year, and average 12-month return of buys vs sells.

### 5.7 Shortcuts for messy cases

- First report of a fund: holdings treated as bought at that quarter's closing price; tracking starts there.
- One missed quarter: holdings assumed unchanged. Two or more: fund marked inactive, positions frozen.
- A stock that disappears (merger, delisting): treated as sold at its last known price.
- 13F dollar values are ignored for valuation (value = shares × our price), which sidesteps the thousands-vs-dollars change of 3 Jan 2023. They are used only as a fallback price for unpriced or delisted stocks (×1000 for filings before 3 Jan 2023).
- Unpriced stocks, options and bonds are excluded from P&L; each fund shows "% of book priced".

## 6. Published files (brotli JSON, columnar arrays)

| File | Contents |
|---|---|
| `funds.json` | search index: fund_id, name, book, holdings count (~150 KB) |
| `latest_prices.json` | stock_id → latest close + date |
| `fund/{fund_id}/summary.json` | header, performance + style metrics, yearly returns, AUM bridge per year/quarter |
| `fund/{fund_id}/positions.json` | one row per stock ever held: held from/to, avg cost, avg exit, return, IRR, last change %/$, $ in, realised, shares now, cost |
| `fund/{fund_id}/contrib/{year}.json` | per-stock contribution for one year |
| `fund/{fund_id}/exits.json` | what-if rows and summary |
| `fund/{fund_id}/trades/{stock_id}.json` | trades by quarter: delta, VWAP, low, high, shares after |
| `stock/{stock_id}/weekly.json` | weekly closes for position charts (shared across funds) |
| `home/*.json` | the six home lists (section 7.1) |

Typical fund total: 20–60 KB; the largest filers (~16k positions) ~2 MB, loaded in parts.

## 7. Website

React static site, light chart code (SVG), virtual scrolling for large tables, works at phone width, light and dark themes. Every estimate is labelled. The mockup is the visual reference.

### 7.1 Home

Search box (fund name) plus six tabs, each stating its rules:

1. **Top funds** — 13F book ≥ $1B, ≥ 12 quarters filed, ≥ 4 positions, ≥ 80% of book priced, no banks/insurers/pensions/brokers; index giants in a separate list. Columns: fund, 13F book, positions, return per year, worst drop, Sharpe. Periods: 1y, 3y, 5y, since start. No SPY column.
2. **Conviction moves** — concentrated active funds (4–60 positions, top 10 ≥ 50% of book, book ≥ $500M). A move counts if it is a new position or add reaching ≥ 5% of the book, a weight increase ≥ 3 points, or the exit of a ≥ 5% position. Columns: fund, stock, move, weight now, change, est. price, % since.
3. **Big wins & losses** — largest single-position quarterly P&L among Top-funds-eligible funds.
4. **Just filed** — newest 13F filings with each one's largest weight change.
5. **Crowded buys** — stocks bought by ≥ 3 concentrated active funds in the latest quarter: funds buying, total $ bought, average weight after.
6. **Best & worst calls** — new positions or adds ≥ 1% of the book by Top-funds or conviction funds; stocks ≥ $300M market cap and ≥ $1/share. Windows: last quarter's buys, last 4 quarters' buys. Columns: stock, fund, quarter bought, est. buy price, price now, % since fund's buy, % since the 13F was filed.

### 7.2 Fund page (top to bottom)

1. Header: name, filing period and date, 13F book, live value, holdings, % of book priced, tracked since.
2. Performance tiles: return per year, Sharpe, Sortino, volatility, max drawdown, Calmar, best/worst year, years positive (+ % quarters positive).
3. How-they-trade tiles: turnover per year, average hold length, % positions profitable.
4. Gains vs inflows: stacked columns per year (investment gains, net inflows) with end value labels; table toggle.
5. Annual returns: single-series columns (no SPY); click a year (or year chip) to select it; table toggle.
6. What drove {year}: horizontal bar chart of every stock's contribution, zero axis in the middle, negatives left, positives right, sorted by contribution, ticker labels; tooltip shows name and $ P&L; caption shows the sum vs the chained return.
7. Every stock they've owned: stat tiles (profitable %, realised, unrealised, avg winner/loser, $ won per $ lost, best, worst); filter All / Still held / Sold; sortable table: stock, held, avg cost, current price, avg exit, return, IRR, last change, last change $, $ in, realised, unrealised, total P&L. Rows open Position detail.
8. What if they'd kept it: tiles (sold too early, losses dodged, % of sales that beat SPY next year, buys vs sells next 12 months); table: stock, status, shares sold, avg cost, current price, avg exit, return, IRR actual, IRR if held, last change, last change $, since sale, 1y after, SPY 1y after, $ missed/dodged.

### 7.3 Position detail

Header (ticker, name, sector, held from–to, latest price); tiles (shares now, avg cost, $ in, total P&L, IRR); weekly price chart with buy/sell dots at the quarter VWAP and the quarter low–high band; shares-held step chart; trades table (quarter, move, shares, est. price, range, $ value, shares after).

### 7.4 Methodology

What a 13F covers and doesn't, the trade-price, P&L and return formulas, the what-if method, and "not investment advice".

## 8. Errors

- SEC/vendor download failure: retry with backoff; still failing → skip that input, keep last good data, record in the run log.
- Unknown CUSIP → `unpriced`, reflected in "% of book priced".
- Reported value ÷ shares more than 10× away from our price → flag; use our price.
- Zero or negative shares → drop row, log.
- Amendment conflicts → restatement wins, logged.
- No vendor price for a delisted stock → 13F implied price; if absent → unpriced.
- Share count jumps by an exact split ratio with no vendor split → flag for review.
- Each run writes `health.json` (filings parsed, unmapped CUSIPs, coverage, funds recomputed, flags). A failed Actions run emails the owner.
- Website: unknown fund → not-found page; coverage < 80% → warning badge.

## 9. Testing

- Unit tests (pytest) with hand-worked examples: VWAP from typical price, average-cost P&L, quarterly return, AUM bridge, IRR, contributions, turnover, Sharpe/Sortino/volatility/drawdown/Calmar, what-if figures.
- Invariant checks on every run: AUM bridge exact for every fund-quarter; no negative shares; weights sum to ~100%.
- End-to-end golden test: Berkshire Hathaway and one small concentrated fund over several quarters, checked by hand against their filings; outputs snapshotted.
- Monthly: full rebuild of a sample of funds must equal the incremental results.
- Website smoke test (Playwright): home, a fund page and a position page load without console errors at desktop and phone widths, with no horizontal overflow.
- CI on GitHub Actions for all of the above.

## 10. Costs

- Hosting: ~$0–5/mo (Cloudflare free tier, GitHub Actions free minutes).
- Prices: personal plan during development (~$0–30/mo), Tiingo redistribution (~$250/mo) from public launch.
- One-off legal review before charging money: est. $5–20k.
- At $10/mo the lean setup breaks even at roughly 37–80 paying users.

## 11. Prerequisites (owner actions)

- Allow in the cloud environment's network settings: `www.sec.gov`, `data.sec.gov`, `api.openfigi.com`, the price vendor's API host, `api.stlouisfed.org`, Cloudflare API hosts.
- Get Tiingo's written confirmation: display rights for a free + $10/mo product, delisted-ticker coverage, startup-plan eligibility.
- Before charging money: legal check on CUSIP use as an internal key, FINRA and Ken French data terms (for later specs), and the "not investment advice" wording.
