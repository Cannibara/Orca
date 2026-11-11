# Product

Last verified: 2026-11-10

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
| Shipped | Home: fund search (`/` focuses it) and 5 tabs (Top funds 1y/3y/5y/10y/15y/since start + Index giants, Conviction moves, Big wins & losses, Crowded buys, Best & worst calls) | `web/src/pages/Home.tsx` (code) |
| Shipped | Fund page panels (below) | `web/src/pages/Fund.tsx`, `web/src/fund/*` (code) |
| Shipped | Position page `/fund/:id/stock/:stockId` (tiles, price chart with trade markers and quarter ranges, shares-held step chart, trades table) | `web/src/pages/Position.tsx` (code) |
| Shipped | Not found page (the How it works page was removed 2026-11-11: users need no 13F education) | `web/src/pages/NotFound.tsx` (chat)(code) |
| Shipped | Site-wide footer on every page: "Estimates from SEC 13F filings. Not investment advice." | `web/src/App.tsx` (code) |
| Shipped | Pre-rendered fund pages (title/description/noscript) for the largest 15,000 funds | `web/scripts/prerender.mjs` (code) |
| Shipped | Background loading (first 50 rows, fill to 200, Show 100 more; all weekly prices prefetched) | `web/src/fund/loading.ts`, `prefetch.ts` (code) |
| Shipped (PR #3, a2a1554) | HSTS, noindex on pages.dev, sitemap/robots/canonical | (git 006b9d8, a2a1554) |
| File only | Just filed list: `home/just_filed.json` is still published; its tab was removed 2026-11-06 | `pipeline/orca/home.py` `just_filed` (code) |
| Proposed, unanswered | Conviction: drop funds with ≥ 30% of book in ETFs; common stock only (no convertibles/preferreds); name filters for wealth managers and charities | (chat) |
| Proposed, declined | Best & worst calls from every qualifying buy, re-cut live (owner kept the 50 + 50 file) | (chat) |
| Backlog | Per-fund quarter-end price file (fewer requests) | (chat) |
| Phase 1 built (owner-only) | Paid per-fund workbook (phase 1: owner-only): an Excel file per fund with the raw quarterly data and formulas for every fund-page metric, reconciled to Orca's figures; built by hand with Actions > Workbook into the private bucket; not for sale until the Tiingo licence is settled; login, payment and on-demand build are phase 2 | `pipeline/orca/workbook/`, `docs/superpowers/specs/2026-11-10-fund-workbook-design.md` (code)(chat) |
| Backlog | Gated paid tier, login | (spec)(chat) |
| Backlog (F1) | Paid per-fund workbook, the phase 2 of the row above | `docs/ROADMAP.md` (proposal until the owner approves) |
| Backlog (F2) | Column choices and saved views (may need accounts) | `docs/ROADMAP.md` (proposal) |
| Backlog (F3) | Weekly popularity list | `docs/ROADMAP.md` (proposal) |
| Backlog (F4) | Sector momentum and volume | `docs/ROADMAP.md` (proposal) |
| Backlog (F5) | Manager rankings, with benchmarks | `docs/ROADMAP.md` (proposal) |
| Backlog | Spec 2 skill scores, spec 3 sector rotation, stock pages "who holds X", alerts, pre-2013 history | (spec) |

## Home list rules
Thresholds in `pipeline/orca/config.py`, applied in `pipeline/orca/home.py` (code).

| List | Who and what qualifies |
|---|---|
| Top funds (1y/3y/5y/10y/15y/max) | book ≥ $1B, ≥ 12 quarters filed, ≥ 4 positions (owner lowered it from 10), ≥ 80% of book priced; names starting a word with BANK, BANCORP, TRUST CO, INSURANCE, ASSURANCE, SECURITIES LLC or BROKERAGE excluded; ≥ 1,000 priced positions → Index giants tab. Pensions and retirement systems count (owner, 2026-11-04) |
| Conviction moves | quarter filed with the one before, end AUM ≥ $500M, AUM change within ½–2×, < 1,000 positions, largest holding at the start 0–33%; move ≥ 3% of AUM, ≥ 2× the usual move (floor 1%), ≥ ½ the largest holding; ETFs neither listed nor counted; 200 rows per view; ranked by a hidden score |
| Best & worst calls | top funds (not giants) or concentrated funds (4–60 positions, ≥ $500M); new or add ≥ 1% of book; market cap ≥ $300M; price ≥ $1; 50 best + 50 worst cut at build time, re-ranked live (R7) |
| Crowded buys | new or add by ≥ 3 distinct concentrated active funds (4–60 positions, ≥ $500M) in the latest quarter |

The 15y tab stays empty until 2028: SEC bulk 13F data starts in 2013 (chat).

## Views
| View | Shows |
|---|---|
| Fund header | Name (the `<h1>` text equals the fund name, which e2e checks), "$X reported book", "N holdings now, M positions ever", "Updated <filed date> · Qn filing", a priced-% badge below 80%, an inactive note, and Overview/Positions tabs (code `FundHeader.tsx`) |
| Key figures (8 tiles) | Row 1 follows the Annual-returns bracket: annualised return (+growth of $1), years positive (+% quarters positive), max drawdown, volatility. Row 2 covers the whole period: Sharpe/Sortino/Calmar, turnover per year, average hold length, positions profitable (code `KpiStrip.tsx`) |
| Annual returns | Bars per year, 15 years or Max, % labels, draggable annualised-return bracket, year tooltip (max drawdown, volatility, each quarter), "Show the numbers" table (code `ReturnsPanel.tsx`, `returnsLayout.ts`) |
| Return constituents (was "What drove") | Waterfall of contribution points for a year or a period (strip, stepper), named stocks by \|contribution\| + "Other stocks", one-line headline (code `DrivePanel.tsx`, `drive.ts`) |
| Assets under management | Static stacked bars: carried-over book, net inflows, gains; dotted boxes for losses and outflows; tooltip pinned top-left (code `AumPanel.tsx`, `aum.ts`) |
| Positions | Quarter/Year/Custom period picker (wheel, arrows, jiggle at the ends); 12 columns (Stock, Held, Weight, Return, IRR, Value, Avg cost, Price, Avg exit, Realised, Unrealised, Total P&L), all as of the period end; click a row to see its price chart and trades (code `PositionsPanel.tsx`, `PositionsTable.tsx`, `PeriodPicker.tsx`, `StockPanel.tsx`) |
| What if they'd kept it | Tiles (sold too early, losses dodged, sold stocks that beat SPY next year, buys vs sells next 12 months) and a sold/trimmed table in the Positions style (code `WhatIfPanel.tsx`, `whatif.ts`) |

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
- No real-time or intra-quarter data; pre-2013 history is out of scope (spec).
- No user accounts or paid gating yet (chat).
- No market-flow or retail-share estimates at launch: 13F net buying is only a lower bound on institutional volume, and FINRA's retail-proxy data likely needs a commercial licence (chat).
- No CUSIPs shown anywhere (licensing risk; code `CusipLeakError`) (chat)(code).
