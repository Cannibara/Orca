# Product

Last verified: 2026-11-22 (the Analysis tab's sector panels from the code)

Tags: (chat) session conversation, (code) checked in code, (git) commit history, (spec) `docs/superpowers/specs/2026-10-30-orca-fund-pnl-design.md`.

## Problem
WhaleWisdom and GuruFocus show what big funds own. Orca shows how well they did it. It turns SEC 13F filings into estimated returns, per-stock P&L, entry/exit prices, gains vs inflows, and whether sells were smart (spec §1). The working name in Claude Code is "Whale Wisdom 13F Analytics Platform", and early branches were `claude/whale-wisdom-13f-clone-*` (git). The product name is Orca, live at https://www.orcaetf.com (chat). The name: orcas hunt whales, and WhaleWisdom is the main 13F site (owner, chat).

## Users and use cases
- Audience: amateur investors. Precision target is hobbyist, with every estimate labelled as one (spec). Many don't know fund names, so the home page leads with lists, not just search (owner, chat).
- Owner's priority order: fund P&L, then skill scores, then sector rotation; market flows optional (chat).
- Business model: free at launch. A paid tier ($10/month) is planned, not built. A gated Excel export idea is parked (spec)(chat).
- Use cases: find a fund by name; see its yearly returns, risk and what drove them; inspect its positions at any past quarter; see a stock's trades with buy/sell markers; spot big conviction moves, crowded buys and best/worst calls across funds; check what selling cost the fund (what-if).

## Data cadence
- Holdings are quarterly. Funds file a 13F within 45 days of each quarter end, and the 16th-of-the-month run after each deadline (Feb, May, Aug, Nov) brings a quarter in at once. Later monthly runs pick up late filings and amendments (code `pipeline.yml`, `weekly.deadline_quarter`)(chat).
- Prices are daily bars. Each monthly run fetches every day since the last stored one. It covers stocks held in the latest quarter, SPY, stocks sold within the last 6 quarters, and stocks never fetched (code `orca/run/market.py` `refresh_prices`, `orca/prices.py`).
- The site's "latest price" is the newest stored close, so it can be up to about a month old. `latest_prices.json` dates each close (code)(contract).

## Features
| Status | Feature | Where |
|---|---|---|
| Shipped | Home: fund search (`/` focuses it) and 6 tabs (Famous funds, the tab it opens on (owner, 2026-11-20: one list per style, 10 a page each, the period shared with Top funds), Top funds 1y/3y/5y/10y/15y/since start + Index giants, Conviction moves, Big wins & losses, Crowded buys, Best & worst calls) | `web/src/pages/Home.tsx` (code) |
| Shipped | Fund page panels (below), in three tabs since 2026-11-19: Holdings, Analysis, About | `web/src/pages/Fund.tsx`, `web/src/fund/*` (code); spec `docs/superpowers/specs/2026-11-19-fund-tabs-design.md` |
| Shipped | Position page `/fund/:id/stock/:stockId` (tiles, price chart with trade markers and quarter ranges, shares-held step chart, trades table) | `web/src/pages/Position.tsx` (code) |
| Shipped | Not found page (the How it works page was removed 2026-11-11: users need no 13F education) | `web/src/pages/NotFound.tsx` (chat)(code) |
| Shipped | Site-wide footer on every page: "Estimates from SEC 13F filings. Not investment advice." | `web/src/App.tsx` (code) |
| Shipped | Pre-rendered fund pages for the largest 15,000 funds: keyword title and description, a heading and summary, and for the largest 500 the ten largest positions and links to neighbouring funds | `web/scripts/prerender.mjs` (code) |
| Shipped | Background loading (first 50 rows, fill to 200, Show 100 more; all weekly prices prefetched) | `web/src/fund/loading.ts`, `prefetch.ts` (code) |
| Shipped (PR #3, a2a1554) | HSTS, noindex on pages.dev, sitemap/robots/canonical | (git 006b9d8, a2a1554) |
| Shipped (2026-11-14) | Logo "Lune" in the header, favicon/touch icons, link-preview card (`og-default.png`) | `docs/brand/`, `web/src/App.tsx`, `web/public/` (chat)(code) |
| File only | Just filed list: `home/just_filed.json` is still published; its tab was removed 2026-11-06 | `pipeline/orca/home.py` `just_filed` (code) |
| Proposed, unanswered | Conviction: drop funds with ≥ 30% of book in ETFs; common stock only (no convertibles/preferreds); name filters for wealth managers and charities | (chat) |
| Proposed, declined | Best & worst calls from every qualifying buy, re-cut live (owner kept the 50 + 50 file) | (chat) |
| Backlog | Per-fund quarter-end price file (fewer requests); since 2026-11-19 each stock's `weekly.json` carries its quarter-end closes (`q0`, `qclose`) | (chat)(spec) |
| Phase 1 built (owner-only) | Paid per-fund workbook (phase 1: owner-only): an Excel file per fund with the raw quarterly data and formulas for every fund-page metric, reconciled to Orca's figures; built by hand with Actions > Workbook into the private bucket; not for sale until the Tiingo licence is settled; login, payment and on-demand build are phase 2 | `pipeline/orca/workbook/`, `docs/superpowers/specs/2026-11-10-fund-workbook-design.md` (code)(chat) |
| Backlog | Gated paid tier, login | (spec)(chat) |
| Backlog (F1) | Paid per-fund workbook, the phase 2 of the row above | `docs/ROADMAP.md` (proposal until the owner approves) |
| Backlog (F2) | Column choices and saved views (may need accounts) | `docs/ROADMAP.md` (proposal) |
| Backlog (F3) | Weekly popularity list | `docs/ROADMAP.md` (proposal) |
| Backlog (F4) | Sector momentum and volume | `docs/ROADMAP.md` (proposal) |
| Backlog (F5) | Manager rankings, with benchmarks | `docs/ROADMAP.md` (proposal) |
| Backlog | Spec 2 skill scores, spec 3 sector rotation, stock pages "who holds X", alerts | (spec) |

## Home list rules
Thresholds in `pipeline/orca/config.py`, applied in `pipeline/orca/home.py` (code).

| List | Who and what qualifies |
|---|---|
| Top funds (1y/3y/5y/10y/15y/max) | book ≥ $1B, ≥ 12 quarters filed, ≥ 4 positions (owner lowered it from 10), ≥ 80% of book priced; names starting a word with BANK, BANCORP, TRUST CO, INSURANCE, ASSURANCE, SECURITIES LLC or BROKERAGE excluded; ≥ 1,000 priced positions → Index giants tab. Pensions and retirement systems count (owner, 2026-11-04) |
| Famous funds | the 458 rows of `pipeline/orca/famous.csv` (every 13F filer on Wikipedia's List of hedge funds added 2026-11-20) in 15 style lists after a first list, Most searched (owner, 2026-11-17: the 50 most searched funds by Google Trends interest in the manager or founder, or the firm for venture firms, worldwide over 12 months, Warren Buffett = 100; since 2026-11-20 the owner's order in `pipeline/orca/famous_rank.csv` comes first (a famous.csv `search` keyword, or a CIK for a fund with none, and the owner's `score`: higher first, ties in file order, no score = not ranked; seeded from the Trends scores; a run with `home_only` publishes an edit) and the "Search interest" column is gone (owner: users need the right funds, not the score); Big companies and Sovereign & pension funds are not ranked (exceptions, owner: the Gates trust and Markel), as their names are searched for other reasons (owner's rule of manager or founder names; members look up their pensions); the scores are a snapshot in `famous_search.csv` refreshed by `pipeline/scripts/google_trends.py`). Style lists in this order: Buffett inspired, Moat investing, Value, Tiger cubs, Fundamental long/short, Healthcare specialists, Tech & growth, Venture capital, Activists, Macro, Credit & event-driven (owner, 2026-11-20), Family offices, Quant & multi-strategy, Big companies, Sovereign & pension funds (owner, 2026-11-15/16; no "Other" list). Shown whatever their size, age or position count, and also after they stopped filing (owner): then the periods end at the last 13F and the row says "filed until Qn YYYY". A fund can be in two lists. Ackman and Hohn are under Moat investing, Berkshire under Buffett inspired (owner). A row needs a performance for the period, ≥ 80% of book priced, and a filer name holding the row's match word (or one of its `|` alternatives, for a renamed filer). The manager's name shows under the fund name, with a round photo of them before it when one is in `web/src/assets/people/` (owner, 2026-11-19; rows are 68 px tall; credits at `/photo-credits`). Every list opens with its most popular fund first (owner, 2026-11-18): by the owner's rank, then Google Trends score (a manager's filers share it), then by AUM, so funds with no score and the Big companies follow by size. The Fund heading steps through A–Z, Z–A and most popular, and shows "most popular" beside it in that order; from any other column it starts at A–Z. Data appears after the next pipeline run; funds that stopped filing need one `full` rebuild |
| Conviction moves | quarter filed with the one before, end AUM ≥ $500M, AUM change within ½–2×, < 1,000 positions, largest holding at the start 0–33%; move ≥ 3% of AUM, ≥ 2× the usual move (floor 1%), ≥ ½ the largest holding; ETFs neither listed nor counted; 200 rows per view; ranked by a hidden score |
| Best & worst calls | top funds (not giants) or concentrated funds (4–60 positions, ≥ $500M); new or add ≥ 1% of book; market cap ≥ $300M; price ≥ $1; 50 best + 50 worst cut at build time, re-ranked live (R7) |
| Crowded buys | new or add by ≥ 3 distinct concentrated active funds (4–60 positions, ≥ $500M) in the latest quarter |

Holdings go back to Q1 1999 (the SEC's pre-2013 text filings, read since 2026-11-17), so the 15y and Since start tabs cover funds with a long unbroken record. Until the first backfill runs, the 15y tab lists only funds with back-filed reports (spec `docs/superpowers/specs/2026-11-17-pre-2013-13f-design.md`).

## Views
The fund page is a header and three tabs (spec `docs/superpowers/specs/2026-11-19-fund-tabs-design.md`). The URL hash picks the tab (`#holdings`, `#analysis`, `#about`; none = Holdings) and a tab click replaces it, so Back leaves the page rather than stepping through tabs. Only the open tab's panels are mounted; the page keeps the shared state (the year picked, the bracket, the Holdings period and the weekly price files loaded) across tabs. The source note sits at the foot of every tab.

| View | Shows |
|---|---|
| Fund header | Name (the `<h1>` text equals the fund name, which e2e checks), "$X reported book", "N holdings now, M positions ever", "Updated <filed date> · Qn filing", a priced-% badge below 80%, an inactive note, and the Holdings (with the holdings-now count) / Analysis / About tabs: WAI-ARIA tabs, one Tab stop, arrows, Home and End (code `FundHeader.tsx`, `Fund.tsx`) |
| **Holdings tab** | Four key-figure tiles (annualised return, max drawdown, turnover per year, average hold length), the Holdings panel, Annual returns, then Positions; one period picker (in the Holdings panel) drives the tree map and Positions (code `HoldingsTab.tsx`, `Fund.tsx`) |
| Holdings (tree map) | Period picker: Quarter / Year; Year adds a Q1–Q4 "years end in" control and its pills are the quarter ends with that Q, four quarters apart, each a 12-month period (qs = qe − 3, "12 months to 30 Sep 2025"); wheel (only from rest), arrows, list, jiggle at the ends. A squarified tree map of the holdings at the period end (440px, 340px under 600px wide): area = value from the Positions table's model (so the tiles equal the table; an older quarter sums to the published book), holdings under 1% grouped as one hatched "Other stocks" tile, colour = the fund's return on the holding over the period (below) on a red (loss) ← grey → green (gain) scale clamped at ±25% (quarter) or ±50% (12 months), hollow dashed tile = no return; labels only where they fit, every labelled tile showing its dollar value (the newest quarter at today's prices, an older one at the quarter-end close) and, beside it, the fund's return on the holding over the period, the same figure as the colour and the tooltip: second row `12.3% · $80.2B · +4.1%`, then `$80.2B · +4.1%`, `$80.2B`, `12.3%` as the room allows (the value first, then the return, then the weight); at the right end of the ticker's row on a tile under 39px tall; no return (hollow tile, Other stocks) leaves the row as `12.3% · $80.2B`, with no dash; a tile too small for any text has the tooltip. The return: shares held before the period are measured from the price at the start of the period (the previous quarter's last close) to the price at its end; shares bought in the period from the quarter's VWAP (the trade price) to the price at its end; the end price is today's for the newest quarter, the quarter's last close for an older one; shares sold in the period count start/VWAP to the sale's VWAP; dividends received in the period are added (as in the table's Total P&L); a 12-month period does the same over four quarters. This is not the Positions table's Return column, which covers the whole life of a position; the two are the same figure for a position that began in the period; shared tooltip; legend and caption; motion is the Analysis bars' (600ms, the same curve): on landing the boxes grow from their centres, on a period change they move; colours are never animated (a tile has its final red or green from its first frame, and nothing is drawn until every tile's prices are in, under a "Loading prices…" note); words that change fade out in 70ms and are fully in by 250ms (the boxes are then ~89% of the way), words that do not change stay (none of this under reduced motion); one Tab stop, the arrows move by position, Home/End (code `HoldingsPanel.tsx`, `treemap.ts`, `treemapView.ts`, `PeriodPicker.tsx`) |
| Positions | 12 columns (Stock, Held, Weight, Return, IRR, Value, Avg cost, Price, Avg exit, Realised, Unrealised, Total P&L), all as of the period the Holdings picker chose; money as the site prints it ("$2.97B", "+$469M"); click a row to see its price chart and trades (code `PositionsPanel.tsx`, `PositionsTable.tsx`, `StockPanel.tsx`) |
| **Analysis tab** | What kind of investor? (when the fund has a sector file), four key-figure tiles (years positive, volatility, risk-adjusted return, positions profitable), Annual return stacked graph, Sector mix over time, Which decisions made the gap (those three also only with a sector file), Assets under management, Return constituents, What if they'd kept it, in that order. Its window, selected year and bracket are the ones picked on Holdings' Annual returns (page state); Return constituents also has its own strip and stepper |
| Sector choice vs stock choice (4 panels, since 2026-11-22) | From `fund/{id}/skill.json` (the fund's real trades replayed in its stocks, in its labels' indices and in the whole market; `engine/skill.py`): sector choice = labels − market, stock choice = fund − labels, in percentage points a year. A Sector / Industry / Sub-industry switch in the map's header (default Industry, R9) drives the map, the stacked graph and the decisions; readers never see "vertical". **What kind of investor?**: a map, stock choice across and sector choice up, a grey "too close to call" cross (±0.8 pts), this fund among the funds of its famous lists (≥ 3 eligible peers; else the 12 eligible funds nearest in book), a sentence naming its corner, an optional 3-year path; eligible = 12+ quarters, 20+ picks, 80% of its buying scored, else "Too early to tell". **Annual return stacked graph**: a twin of Assets under management, each calendar year split into whole market, sector choice and stock choice (solid bar ends at the fund's return; a part that pushed the other way is a dashed box beyond it; blue added, orange took away), three IRR figures, Stacked ↔ Lines (value of the money they put in: their stocks, their sectors, whole market, S&P 500 for reference only). **Sector mix over time**: 100% stacked areas by sector, industry or sub-industry, chips to pick a sector out, the big switches numbered (≥ 15% of the book moved in four quarters, at most 5). **Which decisions made the gap**: the 30 biggest picks vs their label's index, or each label bought vs the market (tier 1 lists every sector), with share of money, a dumbbell of returns, beat by and Adds (≈ share × beat by). Every panel has a Table view and a units line. Without the file the tab is as before. Spec `docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md` (code `fund/SkillPanels.tsx`, `SkillMapPanel.tsx`, `StackedPanel.tsx`, `MixPanel.tsx`, `DecisionsPanel.tsx`, models `skill.ts`, `stacked.ts`, `mix.ts`, `decisions.ts`) |
| Key figures (8 tiles, 4 per tab) | The span tiles follow the Annual-returns bracket: annualised return (+growth of $1) and max drawdown on Holdings, years positive (+% quarters positive) and volatility on Analysis. The others cover the whole period: turnover per year and average hold length on Holdings, Sharpe/Sortino/Calmar and positions profitable on Analysis (code `KpiStrip.tsx`, prop `group`) |
| Annual returns | Bars per year, 15 years or Max, % labels, draggable annualised-return bracket, year tooltip (max drawdown, volatility, each quarter), "Show the numbers" table (code `ReturnsPanel.tsx`, `returnsLayout.ts`) |
| Return constituents (was "What drove") | Waterfall of contribution points for a year or a period (strip, stepper), named stocks by \|contribution\| + "Other stocks", one-line headline (code `DrivePanel.tsx`, `drive.ts`) |
| What if they'd kept it | Tiles (sold too early, losses dodged, sold stocks that beat SPY next year, buys vs sells next 12 months) and a sold/trimmed table in the Positions style (code `WhatIfPanel.tsx`, `whatif.ts`) |
| **About tab** | About only (Assets under management moved to Analysis on 2026-11-20) |
| About | SEC EDGAR facts only (`summary.about`): a sentence built from the facts (a clause left out for each missing one), then Headquarters, 13F signed by, Other managers in the report (first 4, "Show all N"), Incorporated in, Former names, SEC CIK (links to EDGAR's 13F-HR list, new tab); state codes in full, SEC capitals title-cased; "No SEC details yet" when the block is null (code `AboutPanel.tsx`, `about.ts`) |
| Assets under management | Static stacked bars: carried-over book, net inflows, gains; dotted boxes for losses and outflows; tooltip pinned top-left (code `AumPanel.tsx`, `aum.ts`) |

## Metric definitions
All figures are 13F estimates from quarter-end snapshots of long US stock positions (spec §5). Pipeline formulas are listed in `docs/ARCHITECTURE.md` with their source functions.

| Metric | Definition | Source |
|---|---|---|
| Quarter return | (end − start − net buying + dividends) ÷ (start + ½ net buying) | spec §5.3; pipeline engine |
| Year / span return | product of (1 + quarterly returns) − 1; part years are never annualised, and they count in the span figures and in "Years positive" (the workbook and the published `metrics` still count full years only) | `web/src/fund/series.ts` (code) |
| Annualised return | growth^(4 / n quarters) − 1, null under 4 quarters | `spanKpi` (code) |
| Volatility | stdev of quarterly returns × 2, null under 4 quarters | `spanKpi` (code) |
| Max drawdown | worst peak-to-trough of the chained quarterly index | `spanKpi` (code) |
| Years positive | full years (4 quarters with a return) with a gain, of full years | `spanKpi` (code) |
| Sharpe, Sortino, Calmar, turnover, hold length | from `summary.metrics` (pipeline) | `pipeline/contract.md` |
| Positions profitable | share of positions with total P&L > 0 among those computable | `web/src/lib/live.ts` `profitablePct` (code) |
| Avg cost, realised | average cost (cost of the shares sold leaves at the running average) | `web/src/fund/positions.ts` `asOf` (code) |
| Return (position) | total P&L ÷ dollars invested | `asOf` (code) |
| IRR | Excel's XIRR convention: trades dated mid-quarter (quarter start + half its days), days ÷ 365; terminal value at the period end; dividends excluded. Changed 2026-11-10 from the old quarter-step clock (`q/4 + 0.125`); median gap 0.011 pp on Berkshire | `web/src/lib/live.ts` (code) |
| Weight | position value ÷ priced book at the period end | `positions.ts` (code) |
| Price at an older quarter end | the stock's published quarter-end close (`weekly.json` `qclose`, the price the engine values the book with), else the last weekly close on or before the quarter's last day (older files), else the position's last trade price | `positions.ts` `quarterClose`, `priceAt` (code) |
| Fund's return on a holding (tree map colour) | (end + sales + dividends − start − buys) ÷ (start + buys) over the period: shares held at qs − 1 at that quarter-end close, trades in qs..qe at their `px`, dividends received in the period, the holding at qe at its period-end price; null when the denominator ≤ 0, a needed price is missing, or the period starts before the fund's record | `treemap.ts` `holdingReturn` (code) |
| Weight (cell) | "was% → now%" where the fund traded in the period; bar: old weight solid grey, change striped (blue larger, orange smaller); was = weight before at the period-end prices | `positions.ts` `wPrev`, `PositionsTable.tsx` (code) |
| Last change (box, What-if table only) | weight change in % of AUM from the stock's own trade: A/(vb−B+A) − B/vb at period-end prices | `positions.ts` (code) |
| Contribution points | stock P&L ÷ (year start + ½ inflows) × 100 | `pipeline/contract.md` |
| Conviction move | see DECISIONS "Conviction v3" and `pipeline/contract.md` Home | (git)(code) |

## Product decisions
See `docs/DECISIONS.md`. Key points: quarterly returns are the source of truth; tiles follow the bracket; tables show all columns; first paint is kept small; a "Max" range always shows.

## Non-goals
- Not a fund's real return: no claims beyond 13F estimates; "Not investment advice" in the site footer (code `App.tsx`).
- No SPY benchmark columns on fund pages (ruling R23); SPY appears only in what-if comparisons (code).
- No always-on server, database server, or competitor data sources (spec §1).
- No real-time or intra-quarter data; nothing before Q1 1999 (no electronic 13F tables) (spec).
- No user accounts or paid gating yet (chat).
- No market-flow or retail-share estimates at launch: 13F net buying is only a lower bound on institutional volume, and FINRA's retail-proxy data likely needs a commercial licence (chat).
- No CUSIPs shown anywhere (licensing risk; code `CusipLeakError`) (chat)(code).
