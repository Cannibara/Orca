# Orca Website (Spec 1, Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The static Orca site — Home, Fund page, Position detail, How it works — reading the pipeline's JSON files and computing every latest-price figure in the browser.

**Architecture:** Vite + React SPA with path routes, deployed to Cloudflare Pages with pre-rendered fund pages for search engines. A typed data layer loads the column-oriented JSON contract; a small live-calc library turns positions + latest prices into unrealised P&L, returns and IRRs; hand-written SVG charts are ported from the approved mockup.

**Tech Stack:** Node 22, Vite 5, React 18, TypeScript 5, react-router-dom 6, @tanstack/react-virtual 3, Vitest + @testing-library/react + jsdom, @playwright/test, wrangler.

**Spec:** `docs/superpowers/specs/2026-10-30-orca-fund-pnl-design.md` §7. Visual reference: `docs/superpowers/specs/2026-10-30-orca-mockups.html` (the approved version: home without the "below cost" tab and without SPY on the leaderboard; fund page with performance + how-they-trade tiles, no SPY on annual returns, centered contribution bars, merged avg cost). Data contract: `pipeline/contract.md` (Plan A Task 13). Demo data: `web/public/demo-data/` (Plan A Task 14).

## Global Constraints

- Routes: `/`, `/fund/:id`, `/fund/:id/stock/:stockId`, `/how-it-works`; anything else → not-found page.
- Data base URL from `VITE_DATA_URL` (default `/demo-data`).
- Every figure that depends on the latest price is computed in the browser from `latest_prices.json`: live value, unrealised, total P&L, return %, IRR, IRR if held, since sale, $ missed/dodged, % since buy, % positions profitable.
- Trade time for IRR = `q / 4 + 0.125` years after 2013-01-01; "now" = `(asof − 2013-01-01) / 365.25`.
- Labels: estimates are labelled as 13F estimates; the methodology page ends with "Orca is research software. Nothing here is a recommendation to buy or sell anything."
- Charts follow the mockup: bars ≤ 24 px with 4 px rounded data ends, 2 px lines, solid hairline grid, series colours `--s1` blue / `--s2` orange, positive/negative `--pos` / `--neg`, a legend for ≥ 2 series, text never in series colours, tooltips on hover and keyboard focus, a table toggle where the mockup has one.
- Light and dark themes via the mockup's token blocks; works at 400 px wide with no horizontal page scroll; tables scroll inside their own container.
- Numbers: `−` (U+2212) for negatives, `$1.2B / $340M` money format, tabular figures only in table columns.

## Review Focus

1. **New fund with no full calendar year** — performance tiles show "—" instead of crashing or NaN; owned by Task 5 (`renders dashes when metrics are null`).
2. **Stock missing from `latest_prices.json`** (delisted) — live value skips it, its unrealised/since-sale cells show "—"; owned by Tasks 2 and 6 (`liveValue skips missing prices`, `shows dash for missing price`).
3. **Very large fund** (16,000 positions) — table virtualises; owned by Task 6 (`virtualises 16k rows`).
4. **Unknown fund id or stock id in the URL** — not-found page, no blank screen; owned by Task 7 (`unknown fund shows not found`).
5. **Phone width** — no horizontal page overflow on any route; owned by Task 8 (Playwright `no horizontal overflow at 400px`).

---

## File Structure

```
web/
  package.json, vite.config.ts, tsconfig.json, index.html, public/_redirects
  src/main.tsx, src/App.tsx, src/styles.css
  src/lib/format.ts        money, pct, pp, px, qLabel
  src/lib/live.ts          latest-price calculations
  src/data/types.ts        contract types
  src/data/api.ts          loaders + column→row helper + cache
  src/charts/scale.ts      niceTicks, barPath
  src/charts/Tooltip.tsx, ColumnChart.tsx, DivergingBars.tsx, PriceChart.tsx, StepChart.tsx
  src/components/Tiles.tsx, DataTable.tsx, Chips.tsx, Tabs.tsx
  src/pages/Home.tsx, Fund.tsx, FundTables.tsx, Position.tsx, Method.tsx, NotFound.tsx
  scripts/prerender.mjs
  tests/*.test.ts(x), e2e/smoke.spec.ts, playwright.config.ts
.github/workflows/web.yml
```

---

### Task 1: Scaffold, theme, router, format helpers

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/public/_redirects` (`/* /index.html 200`), `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/lib/format.ts`
- Test: `web/tests/format.test.ts`

**Interfaces:**
- Produces: `money(usd: number | null, signed?: boolean): string`, `pct(x: number | null, digits?: number, signed?: boolean): string`, `pp(points: number | null): string`, `px(price: number | null): string`, `qLabel(q: number): string`, `signClass(x: number | null): "up" | "down" | ""`. Null → `"—"`. `App` renders the app bar (Orca wordmark + nav: Home, How it works) and the four routes with placeholder pages.

- [ ] **Step 1: Create the Vite React TS project files** with the stack versions above; copy the `:root` / dark token blocks, base type, tile, table, chip, tab and chart classes from the mockup's `<style>` into `styles.css` (fonts: Archivo, IBM Plex Sans, IBM Plex Mono via Google Fonts link in `index.html`). `npm install`.
- [ ] **Step 2: Write failing tests**

```ts
test("money", () => {
  expect(money(1_234_000_000)).toBe("$1.23B");
  expect(money(15_200_000_000)).toBe("$15.2B");
  expect(money(-340_000_000, true)).toBe("−$340M");
  expect(money(4_500_000)).toBe("$4.5M");
  expect(money(null)).toBe("—");
});
test("pct and pp", () => {
  expect(pct(0.1234)).toBe("+12.3%");
  expect(pct(-0.05, 0)).toBe("−5%");
  expect(pct(0.2, 1, false)).toBe("20.0%");
  expect(pp(-2.04)).toBe("−2.0 pts");
});
test("qLabel", () => expect(qLabel(53)).toBe("Q2 2026"));
```

- [ ] **Step 3: Run** `cd web && npx vitest run tests/format.test.ts` — FAIL.
- [ ] **Step 4: Implement `format.ts`, `App.tsx` routes.**
- [ ] **Step 5: Run** — PASS; `npm run build` succeeds.
- [ ] **Step 6: Commit** `feat(web): scaffold, theme tokens, routes and formatters`

### Task 2: Data layer and live calculations

**Files:**
- Create: `web/src/data/types.ts`, `web/src/data/api.ts`, `web/src/lib/live.ts`
- Test: `web/tests/api.test.ts`, `web/tests/live.test.ts`

**Interfaces:**
- Consumes: `pipeline/contract.md`.
- Produces: types `FundsIndex`, `Securities`, `LatestPrices`, `Summary`, `Positions`, `PositionRow` (one row of `positions.json`), `Trade = {q: number; delta: number; px: number; low: number | null; high: number | null; sharesAfter: number}` (parsed from the contract's `[q, delta, px, low, high, shares_after]` tuples), `Contrib`, `Exits`, `Weekly`, `HomeList` (exact field names from the contract); `toRows<T>(cols: Record<string, unknown[]>): T[]`; loaders `loadFunds()`, `loadSecurities()`, `loadLatestPrices()`, `loadSummary(id)`, `loadPositions(id)`, `loadContrib(id)`, `loadExits(id)`, `loadWeekly(stockId)`, `loadHome(name)` (each `Promise<T>`, cached per URL, throwing `NotFoundError` on 404); `priceMap(lp: LatestPrices): Map<number, number>`; `yearsSince2013(isoDate: string): number`.
- Produces (`live.ts`): `irr(flows: [number, number][]): number | null` (bisection on [−0.99, 10], 200 iterations, null without a sign change); `positionFlows(trades: Trade[], sharesNow: number, price: number | undefined, nowT: number): [number, number][]`; `heldFlows(trades, price, nowT)`; `unrealised(sharesNow, costNow, price): number | null`; `totalPnl(row: PositionRow, price): number | null` (realised + unrealised + dividends; realised + dividends when closed); `returnPct(row, price): number | null` (total ÷ invested); `missed(soldShares, soldUsd, price): number | null` (soldShares × price − soldUsd; positive = sold too early); `sinceSale(avgExit, price)`; `liveValue(holdings, prices): { value: number; missing: number }`; `profitablePct(rows, prices): number`.

- [ ] **Step 1: Write failing tests**

```ts
test("irr simple", () => expect(irr([[0, -100], [2, 121]])).toBeCloseTo(0.10, 6));
test("irr none without sign change", () => expect(irr([[0, -100], [1, -5]])).toBeNull());
test("missed and dodged", () => {
  expect(missed(150, 2640, 25)).toBe(1110);      // sold too early
  expect(missed(150, 2640, 10)).toBe(-1140);     // dodged
});
test("liveValue skips missing prices", () => {
  expect(liveValue({ stock_id: [1, 2], shares: [10, 5], cost: [0, 0] }, new Map([[1, 3]])))
    .toEqual({ value: 30, missing: 1 });
});
test("totalPnl closed position", () => { /* realised 940 + dividends 125, shares_now 0 → 1065 */ });
test("toRows", () => expect(toRows({ a: [1, 2], b: ["x", "y"] })).toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]));
test("loader caches and maps 404", async () => { /* mocked fetch: second call not refetched; 404 → NotFoundError */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): typed data loaders and latest-price calculations`

### Task 3: Charts

**Files:**
- Create: `web/src/charts/scale.ts`, `Tooltip.tsx`, `ColumnChart.tsx`, `DivergingBars.tsx`, `PriceChart.tsx`, `StepChart.tsx`
- Test: `web/tests/scale.test.ts`, `web/tests/charts.test.tsx`

**Interfaces:**
- Produces: `niceTicks(lo: number, hi: number, n: number): number[]`; `barPath(x, w, yBase, yEnd, round: boolean): string`; `<ColumnChart cats: string[] series: {name: string; color: string; values: number[]}[] stacked?: boolean selected?: number onSelect?: (i: number) => void yFmt tipFmt topLabel?: (i: number) => string | null height?: number label: string />`; `<DivergingBars items: {label: string; sub: string; value: number; extra?: {label: string; value: string}[]}[] fmt: (v: number) => string label: string />` (domain symmetric around 0, label beside the axis on the opposite side of the bar, value at the bar tip); `<PriceChart closes: number[] start: string trades: Trade[] />` (weekly line in `--ink2`, buy dots `--s1`, sell dots `--s2`, quarter low–high band, crosshair tooltip); `<StepChart quarters: number[] shares: number[] />`; one shared `<Tooltip>` driven by context. Width from a `ResizeObserver` on the wrapper.

Port the drawing logic from the mockup functions `columnChart`, `hbarChart` (center mode), `priceChart`, `sharesChart`, `niceTicks`, `barPath`.

- [ ] **Step 1: Write failing tests** — `niceTicks(-3.2, 7.9, 5)` → `[-4, -2, 0, 2, 4, 6, 8]`; `niceTicks(-5, 5, 5)` is symmetric; `barPath` of a positive bar rounds only the top corners (path starts at the baseline); `ColumnChart` with 3 categories renders 3 focusable hit targets and calls `onSelect(1)` on Enter; `DivergingBars` puts the zero line at the horizontal centre of the plot and renders one bar per item.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): SVG charts ported from the mockup`

### Task 4: Home page

**Files:**
- Create: `web/src/pages/Home.tsx`, `web/src/components/Tabs.tsx`, `web/src/components/Chips.tsx`, `web/src/components/DataTable.tsx`
- Test: `web/tests/home.test.tsx` (loads demo JSON from `public/demo-data` via `fs`)

**Interfaces:**
- Consumes: `loadFunds`, `loadHome`, `loadLatestPrices`, `loadSecurities`.
- Produces: `<DataTable columns: Column<T>[] rows: T[] sort? onSort? onRow? virtual?: boolean />` (`Column<T> = {header: string; key?: string; align?: "l" | "r"; cell: (row: T) => ReactNode}`), reused by Tasks 5–7.

Content per spec §7.1: search (filters `funds.json` by name as you type; Enter or click opens `/fund/:id`); tabs Top funds (period chips 1 year / 3 years / 5 years / Since start; rule text; giants under a "Index giants" sub-heading; columns fund, 13F book, positions, return per year, worst drop, Sharpe), Conviction moves, Big wins & losses, Just filed, Crowded buys, Best & worst calls (best/worst and window chips; % since fund's buy and % since filed computed with latest prices). Each tab shows its rule sentence from the mockup. No SPY anywhere on Home.

- [ ] **Step 1: Write failing tests** — `shows six tabs in order` (Top funds, Conviction moves, Big wins & losses, Just filed, Crowded buys, Best & worst calls); `search filters and navigates` (typing a demo fund's first word lists it; Enter routes to `/fund/{id}`); `top funds period switch reloads list` (3 years → `top_3y.json` requested); `calls computes since-buy from latest price` (row est price 10, latest 12 → "+20.0%").
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): home page with search and six lists`

### Task 5: Fund page — header, tiles, charts

**Files:**
- Create: `web/src/pages/Fund.tsx`, `web/src/components/Tiles.tsx`
- Test: `web/tests/fund.test.tsx`

**Interfaces:**
- Consumes: `loadSummary`, `loadPositions`, `loadContrib`, `loadSecurities`, `loadLatestPrices`, charts, `liveValue`, `profitablePct`.

Sections in this order (spec §7.2): header (name, "13F-HR · Period {q} · Filed {date}", 13F book, live value, holdings, % of book priced with a warning badge below 80%, tracked since); Performance tiles (return per year with period `first_year–last_year`, Sharpe, Sortino, volatility, max drawdown, Calmar, best/worst year, years positive + % quarters positive); How-they-trade tiles (turnover per year, avg position hold length with sold-only sub-line, % positions profitable); note "All figures are 13F estimates built from quarter-end holdings, so risk numbers understate swings inside a quarter. Sharpe and Sortino use 3-month T-bill rates as the risk-free rate."; Gains vs inflows (stacked `ColumnChart`, end-value labels, table toggle); Annual returns (single series, no SPY, no legend, year chips, table toggle; default selected year = latest full year); What drove {year} (`DivergingBars` of every stock sorted by points, ticker labels, tooltip name + $ P&L, caption "Contributions add up to {pp}, an approximate return. The chained quarterly return for {year} is {pct}.").

- [ ] **Step 1: Write failing tests** — `renders performance tiles` (labels Sharpe ratio, Sortino ratio, Volatility, Max drawdown, Calmar ratio, Best / worst year, Years positive); `renders dashes when metrics are null` (summary with `metrics` all null → each tile value "—", no "NaN" in the document); `clicking a year updates contributions heading` (chip "2023" → heading "What drove 2023"); `contribution bars sorted descending`; `coverage badge below 80%` (priced_pct 0.75 → badge text "75% of book priced").
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): fund page header, metrics and charts`

### Task 6: Fund page — positions and what-if tables

**Files:**
- Create: `web/src/pages/FundTables.tsx`
- Test: `web/tests/fundTables.test.tsx`

**Interfaces:**
- Consumes: `loadPositions`, `loadExits`, `DataTable`, `live.ts`.

"Every stock they've owned": stat tiles (profitable %, realised, unrealised, avg winner / avg loser %, $ won per $ lost, best, worst — all with latest prices); filter chips All / Still held / Sold; sortable columns stock (ticker + name), held (`from → to|now`), avg cost, current price, avg exit, return, IRR, last change (`+35% Q1 2026`, "New", "Sold all"), last change $, $ in, realised, unrealised, total P&L; default sort total P&L descending; rows open `/fund/:id/stock/:stockId`; `virtual` when > 500 rows.
"What if they'd kept it": tiles (sold too early = Σ positive `missed`, losses dodged = Σ negative, % of sales that beat SPY next year, buys vs sells next 12 months with "Sells were smart" / "Sells were costly"); columns stock, status, shares sold, avg cost, current price, avg exit, return, IRR actual, IRR if held, last change, last change $, since sale, 1y after, SPY 1y after, $ missed / dodged; default sort $ missed descending.

- [ ] **Step 1: Write failing tests** — `default sort is total P&L descending`; `sold filter shows closed only`; `shows dash for missing price` (stock absent from latest prices → current price, unrealised, IRR show "—"); `missed and dodged tiles add up` (two exits: missed +1,110 and −1,140 → "Sold too early $1,110" style values via `money`); `virtualises 16k rows` (16,000 generated rows → fewer than 100 `tr` in the DOM).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): positions and what-if tables with live prices`

### Task 7: Position page, How it works, not found

**Files:**
- Create: `web/src/pages/Position.tsx`, `web/src/pages/Method.tsx`, `web/src/pages/NotFound.tsx`
- Test: `web/tests/position.test.tsx`

**Interfaces:**
- Consumes: `loadPositions`, `loadWeekly`, `loadSecurities`, `loadLatestPrices`, `PriceChart`, `StepChart`, `DataTable`, `live.ts`.

Position page per spec §7.3 (back link to the fund, ticker + name, sector, held from–to, latest price; tiles shares now, avg cost "avg of estimated buy prices", $ in, total P&L with return % and dividends, IRR; price chart; shares chart; trades table quarter, move, shares, est. price (VWAP), quarter range, $ value, shares after). Method page copies the mockup's "How it works" text and formulas. Not-found page: "We couldn't find that page" + link home.

- [ ] **Step 1: Write failing tests** — `renders trades table rows` (demo position with 4 trades → 4 rows, first move "New"); `irr tile uses live price`; `unknown fund shows not found` (`/fund/999999`); `unknown stock shows not found`; `method page ends with not-advice line`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): position detail, methodology and not-found pages`

### Task 8: Pre-render, smoke tests, deploy workflow

**Files:**
- Create: `web/scripts/prerender.mjs`, `web/playwright.config.ts`, `web/e2e/smoke.spec.ts`, `.github/workflows/web.yml`
- Modify: `web/package.json` (scripts `build: vite build && node scripts/prerender.mjs`, `e2e: playwright test`)

**Interfaces:**
- Consumes: built `dist/`, `funds.json` (from `PRERENDER_FUNDS` path or `${VITE_DATA_URL}/funds.json`).
- Produces: `dist/fund/{id}/index.html` for every fund — `index.html` with `<title>{name} · Orca</title>`, `<meta name="description" content="Estimated returns, P&L and trades for {name} from 13F filings.">`, and a `<noscript>` line with the 13F book.

- [ ] **Step 1: Write failing tests** — `web/tests/prerender.test.ts`: running the script on demo data writes one file per demo fund with the fund's name in `<title>`; `e2e/smoke.spec.ts` (against `vite preview` with demo data): for `/`, a demo `/fund/{id}`, and its first `/fund/{id}/stock/{stockId}`, at 1280×900 and 400×900 in light and dark: no console errors, `document.documentElement.scrollWidth <= innerWidth` ("no horizontal overflow at 400px"), main heading visible.
- [ ] **Step 2: Run** `npx vitest run tests/prerender.test.ts` and `npx playwright test` — FAIL. (Locally use the pre-installed browser: `launchOptions.executablePath = process.env.PW_CHROMIUM` when set, e.g. `/opt/pw-browsers/chromium`; CI runs `npx playwright install --with-deps chromium`.)
- [ ] **Step 3: Implement** the script and config.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: `web.yml`** — on push/PR: `npm ci`, `npx vitest run`, `npm run build` (demo data), `npx playwright test`; on push to the default branch only: build with `VITE_DATA_URL` (repo variable) and `PRERENDER_FUNDS` fetched from it, then `npx wrangler pages deploy dist --project-name orca` with secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Validate the YAML as in Plan A Task 15.
- [ ] **Step 6: Commit** `ci(web): prerender fund pages, smoke tests and Pages deploy`
