# Roadmap: design audit against the planned features

Last verified: 2026-11-10

Status: **proposal, not approved by the owner.** Built so far: F1 as a paid workbook (phase 1), D1/D3 partly (parity and schema tests), D2, E2, E3, X3, U3, H1–H3 (WORKLOG 2026-11-10). Not built: everything else.

Update 2026-11-10: F1 is now a paid per-fund Excel workbook, built on demand (DECISIONS 2026-11-10). This supersedes X1 (client-side export) and the F1 approach below. New scaling rule: GitHub Actions only for tests, deploys and the monthly batch; anything a user triggers runs on Cloudflare. Escape hatch: the pipeline is packaged in the same Container image as the workbook builder.

Sources: `CLAUDE.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/WORKLOG.md` and `docs/domain-and-data-hosting.md`, plus a few spot-checks in code and against the live `data.orcaetf.com` (marked "measured"). Vendor and platform limits come from a web search on 2026-11-09 (links at the end) and can change.

Planned features (owner, 2026-11-09):

| Id | Feature |
|---|---|
| F1 | CSV/Excel download of data |
| F2 | Columns users can rearrange, and saved views |
| F3 | Weekly stock picks from online popularity (e.g. Reddit) |
| F4 | Sector momentum and volume page |
| F5 | Ranking fund managers as stock pickers (picks vs sub-sector ETF comparables) and as sector pickers (sector returns) |

## Facts these priorities rest on

Measured 2026-11-09:
- The live manifest `20261105` (built 2026-11-05T09:55:49Z) lists 76,080 files: 53,284 under `fund/`, 22,779 `stock/*/weekly.json` and 13 under `home/`. The site has not been republished since then.
- The biggest fund page (`/fund/102909`, Vanguard) loads `positions.json`, which is 3.4 MB brotli and 8.3 MB decoded with 6,177 positions. Every fund page also loads `securities.json` (461 KB brotli, 2.1 MB decoded), `latest_prices.json` (110 KB, 852 KB) and `funds.json` (294 KB, 780 KB). That is about 4.4 MB on the wire and about 14 MB of JSON to parse before Vanguard's figures appear. After that comes the prefetch of up to 6,177 `weekly.json` files.
- `health.json`:
  - `unmapped_cusips` 33,964, `cusip_mapping_errors` 29,374, `dropped_rows` (non-positive shares) 10,409, `coverage_median` 0.988.
  - `price_mismatch` and `split_suspect` are both at the 100-flag cap, with `*_more` overflow flags.
  - Nothing in the workflows reads `health.json` or alerts on it.
- `web/src` has no URL state at all: no `useSearchParams`, `URLSearchParams` or `location.search`.
- "Not investment advice" appears only in `web/src/pages/Method.tsx`. There is no site-wide footer disclaimer.
- The repo has no Dependabot or CodeQL config. Workflow actions are pinned to commit SHAs, which is good.
- `pipeline.yml` has no failure notification and no backup step. `pipeline/tests/golden/` holds only `.gitkeep`.
- `@tanstack/react-virtual` is used only by `web/src/components/DataTable.tsx`. The fund Positions and What-if tables are plain tables capped by `loading.ts`.

Platform and vendor limits (web, 2026-11-09):

| Service | Limit |
|---|---|
| Cloudflare Pages | 20,000 files per site on Free. 100,000 on paid plans, which needs `PAGES_WRANGLER_MAJOR_VERSION=4` (changelog 2026-01-23). Orca prerenders 15,000 fund pages plus assets. |
| Workers, Free plan | 10 ms CPU per request, 100,000 requests a day, 50 external subrequests. |
| Workers, Paid plan | 30 s CPU by default (up to 5 min), 10,000 subrequests by default. |
| D1 | 10 GB per database (Paid) or 500 MB (Free). 30 s maximum query time. Each database runs one query at a time. 50 MB maximum result from 2026-11-04. On the Free plan, queries fail past the daily row limits from 2026-09-01. |
| Cache purge | Every plan can purge by URL, hostname, prefix or tag. Free allows 5 purge requests a minute. |
| GitHub Actions | Scheduled workflows in a public repo are switched off after 60 days with no repository activity. The pipeline commits nothing to the repo. |
| SEC | 10 requests a second per user, with a declared User-Agent. Orca uses 8/s and a contact address, so it is compliant. |
| Tiingo | The personal plans and the commercial plan are both licensed for internal use only. Showing the data on a website or in an app needs a separate redistribution licence (email sales@tiingo.com). |
| Reddit Data API | The free tier is 100 queries a minute per OAuth client and is non-commercial. Commercial use needs a separate agreement with Reddit. |

Already solid, no action needed:
- SEC fair access.
- SHA-pinned actions.
- Secrets in the `production` environment, which only `main` can use.
- Strict CSP, HSTS and `frame-ancestors 'none'`.
- The CUSIP leak guard (`_json_ready`, `cusip_leaks`).
- Incremental, idempotent publish with `manifest.json` written last.
- `ErrorBoundary` and the `State` component.
- Approval required for fork PR workflows.

## Prioritised review

Effort: S = under a day, M = a few days, L = a week or more. Priority: **now** = before any new feature, **next** = before or with the first feature it names, **later** = when that feature or a paid tier arrives.

### 1. Scalability

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| S1. Decide that new metrics are precomputed in the pipeline as static JSON (contract first), with no D1, KV or Worker on the read path | F4 and F5 are aggregates across all funds and stocks. They fit "approach A" (precompute). D1 runs one query at a time per database and caps queries at 30 s; a Free-plan Worker gets 10 ms of CPU. | Per-request cost, CPU-limit failures and a database to operate. It also breaks the "no server" model in DECISIONS. | S | now |
| S2. Per-fund quarter-end price file (already in the backlog) | F1 exports of past quarters, F2 views pinned to a period and F5 per-pick returns all need prices at past quarter ends. Today one past quarter on Vanguard needs up to 6,177 `weekly.json` files. | Waits of 7 s or more and thousands of requests per visit. An export button would set off the same flood of requests. | M | next (before F1 and F2) |
| S3. Parallel fund compute on the runner's 4 cores (estimated 48 → 17–20 min) | F5 adds benchmark returns for every pick of 13,321 funds. A full rebuild already takes about 2–2.5 h of a 330-min job. | Rebuilds run past the time budget, and each rule change costs hours. | M | next (before F5) |
| S4. One benchmark table in the lake: sector and sub-sector × quarter (and week) returns on the same VWAP and close convention as the engine | F4 shows it and F5 measures against it, so it is computed once. | Two different sets of benchmark maths give different "sector returns" on two pages. | M | next (before F4 and F5) |
| S5. Pages file budget: 15,000 pre-rendered pages plus assets against the 20,000-file Free cap | Any pre-rendered stock, sector or manager pages (SEO for F3–F5) go over it. | The deploy fails, or the new pages never get indexed. | S (decide: paid plan opt-in, edge meta via a Worker, or SPA only) | next |
| S6. Split price refresh: keep the monthly full run, and add a weekly light job for a bounded universe (pick tickers plus sector constituents above the market-cap floor) | F3 is weekly and F4 is momentum. Monthly prices can be about a month old (PRODUCT "Data cadence"). | "Momentum" a month old. Weekly work cannot fit inside the 5 h monthly pipeline either. | M | next (with F3 and F4) |
| S7. Size of the shared files (`securities.json` 2.1 MB and `latest_prices.json` 852 KB decoded, loaded on every fund page) | F4 adds sector fields, and every new field in a shared file slows every page. | First paint gets slower across the whole site. | S–M (shard or trim) | later |

### 2. Performance

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| P1. Cache key on `data.orcaetf.com` ignores query strings (Cache Rule), and the `r2.dev` address is switched off | All JSON is public. `?x=<random>` skips the cache, and `r2.dev` is never cached. Each skipped request is a billed R2 read, and R2 has no hard spending cap (WORKLOG cost Q&A). | A scraper or prankster runs up R2 read bills. This gets worse once F1 and F3 draw traffic. | S | now |
| P2. Purge only the files that changed (by URL or prefix; all plans since 2025-04) instead of `purge_everything` | F3 republishes 1–3 files a week. A weekly `purge_everything` would empty the cache for 76,000 data files and the site. | The cache goes cold every week: slow first loads and more R2 reads. | S | next (before F3) |
| P3. Performance budget in CI: Playwright timing on 3 production funds (small, `/fund/1067983`, `/fund/102909`) with limits on bytes, request count and time to the first table | F1 and F2 add work to the heaviest page. There is no real-user measurement (analytics are off). | Regressions on big funds go unseen. Core Web Vitals have never been measured. | S | next |
| P4. Virtualise the fund Positions and What-if tables (`react-virtual` is already a dependency, used in `DataTable`) | With F2, every column change re-lays-out the table. F1 users expect all rows on screen. `loading.ts` measured 100–250 ms tasks at 2,000+ rows. | Slow interactions (INP) on big funds. Users keep pressing "Show 100 more". | M | next (with F2) |
| P5. Parse big fund files off the main thread (a Web Worker; CSP `worker-src 'self'`), or split `positions.json` for funds with 1,000+ positions | Vanguard parses about 14 MB of JSON before the first figure. | Poor LCP and INP on phones for the biggest funds. | M | later |

### 3. Security

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| X1. F1 stays client-side: a Blob download built from JSON already loaded, with no export endpoint | With no endpoint there is nothing to rate-limit or authenticate, and the CSP stays the same. Gating is impossible anyway while the JSON is public (DECISIONS 2026-11-09). | An endpoint brings auth, rate limits, Worker billing and a scraping target. | S (decision) | now |
| X2. CSV safety: prefix `'` to any cell that starts with `=`, `+`, `-`, `@`, tab or CR; write numbers as plain ASCII (no `−`, `$`, `%` or thousands separators) | F1. The UI convention is a real minus `−`, and Excel reads "−5" as text. | Formula injection. Exported numbers that cannot be summed. | S | with F1 |
| X3. Dependency and secret scanning: Dependabot (npm, GitHub Actions SHA pins), `npm audit --omit=dev` in `web.yml`, `uvx pip-audit` in `ci.yml`, GitHub secret scanning with push protection | F3 brings a new API client and key. The repo and its run logs are public. | A vulnerable dependency goes unnoticed, or a key gets pushed to a public repo. | S | now |
| X4. Delete the leftover `orca-eiq` Pages project and its `orca-pages` token (open since 2026-11-02, status UNKNOWN) | Observed gap. | A live token with Pages Edit rights sits in a second account. | S | now |
| X5. F3 input handling: never render raw post text or links; pull tickers only by matching `securities.json`; cap sizes; new keys only in `production`; add each key to `check-keys` | F3 | Injected links or spoofed cashtags. A bad key that fails an hour into the run. | S | with F3 |
| X6. Accounts only with a paid tier: a Worker plus D1 for views, a managed auth provider, HttpOnly + SameSite cookies, Turnstile on sign-up, a WAF rate-limit rule on `/api/*`, a CSP `connect-src` update and a privacy policy | F2 phase 2 and the paid tier. | Session theft, scraping of paid data, and privacy-law duties with no plan in place. | L | later |

### 4. Data quality and correctness

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| D1. Golden dataset: 2–3 real funds × 4 quarters with expected figures computed outside the code (a spreadsheet built from the raw filing and the prices): quarter return, average cost, realised P&L, contribution, IRR. Add synthetic edge cases (restatement, NEW HOLDINGS amendment, 13F-NT, a 2-quarter gap, a split, VALUE reported in thousands after 2023). Add a parity test: annualised return and volatility are computed twice, in web `spanKpi` and pipeline `metrics.performance`, and must agree on the demo data. The Berkshire figures from the 2026-11-02 live check (1067983: $299.3B book Q2 2026, +11.6%/yr 2014–2025) are the site's own output: usable as a regression snapshot, not as proof. | F5 rankings can only be as right as each fund's returns. The golden test harness has no snapshots. | A silent engine regression reorders every ranking. | M | now |
| D2. Health gates: fail the run when flags cross thresholds (for example mapped tickers = 0, as in run 5; `coverage_median` below 0.95; `funds_recomputed` = 0 when work was owed). Keep a per-run health history in the lake. | F3 adds a weekly job, and F4 and F5 add stages. | Bad data goes out silently. Run 5 published 0 tickers and logged nothing. | S | now |
| D3. Contract schema tests: a JSON Schema per file derived from `pipeline/contract.md`; CI validates the demo data and a sample of production files; `web/src/data/types.ts` is checked against it | F1–F5 each add files or fields. | The web and pipeline drift apart; NaN or shape errors reach the live site. | M | next |
| D4. Survivorship: 18,728 stocks have no vendor ticker and are skipped; delisted stocks are priced to their last close; dead funds and history before a 2+ quarter gap are dropped (only the last segment is computed) | F5. Bankrupt holdings with no price disappear from P&L, so skill looks better than it is. Selecting only active funds flatters the field. | Inflated "stock picker" scores. The ranking cannot be defended. | M | next (before F5) |
| D5. CUSIP repair by check digit: pad a dropped leading zero only when the padded CUSIP passes the check digit and its issuer matches the SEC Official List of Section 13(f) Securities. This revisits DECISIONS 2026-11-01: the repair is deterministic, not a guess. | F5 coverage: 33,964 CUSIPs are unmapped. | Rankings tilt toward funds with clean filings. | M | next |
| D6. Restatements and amendments: log which fund-quarters changed in each run, and show "ranked as of run X". Confidential-treatment positions (not handled) can arrive in amendments up to a year later. | F5 ranks shift when restatements land. | Ranks flip with no explanation. | S–M | next (with F5) |
| D7. Sector mapping: SIC codes are coarse and dated, and GICS is licensed. Build a SIC → sub-sector → comparable-ETF table with manual overrides for the largest ~500 stocks by value held. | F4 groups, F5 peer groups. | Wrong peer group, so the skill score is wrong. | M | next |
| D8. Close the deferred invariants: weights ≈ 100%, and the crash window between `write_manifest` and the `fund_state` writes (ARCHITECTURE "Tech debt") | F5 sums weights across 13,000 funds. | Allocation effects that do not add up. | S | next |
| D9. State the 13F limits on every F5 view and in Method: 45-day lag; long US 13(f) securities only; no shorts, cash, non-US holdings, fees or real cost basis; quarter-end snapshots (intra-quarter trades and window dressing are invisible); trades assumed at the quarter VWAP; options and bonds excluded | F5 | "Skill" claims that are misleading. Regulatory exposure (L3). | S | with F5 |

### 5. Third-party data and legal

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| L1. Tiingo redistribution licence. The public site already serves Tiingo prices (`latest_prices.json`, 22,779 `weekly.json`) on a personal plan. Tiingo's docs say every self-serve plan is internal-only. DECISIONS ("business plan before commercialising") understates this. | F1 would hand out bulk price files; F4 shows more prices and volume; F3 tracks performance. | A licence breach today, not only once the site charges. Losing the account means no prices. | S to ask; recurring cost | now |
| L2. Reddit terms: commercial use needs an agreement, and scraping the HTML is outside the terms. Decide on the source before designing F3. Free alternative: the Wikimedia pageviews API (open licence, a weaker signal). | F3 | API cut-off or legal claims; F3 rebuilt on another source. | S to decide | now (before F3) |
| L3. Advice rules: the owner is in Australia (WORKLOG: AEDT). "Weekly picks" and "best stock pickers" may count as general financial product advice under ASIC rules, and the US publisher's exclusion has conditions. Get a legal view. Name F3 "Most discussed", not "picks". Add a site-wide footer and a general-advice warning on F3 and F5. | F3, F5, the paid tier | Regulatory exposure. Today the disclaimer is only on Method. | S (naming, footer) / M (legal view) | now (naming, footer) / next (legal view) |
| L4. CUSIPs in exports: F1 must never include a CUSIP, and `cusip_leaks` must cover any new published file | F1 | CUSIP Global Services licence claims (quoted $10.5k–$518k a year, DECISIONS). | S | with F1 |
| L5. ETF comparables: their prices fall under the same Tiingo licence (L1). ETF holdings files and GICS are licensed. Use Orca's own SIC baskets as the main benchmark and show ETFs as labelled comparables. | F5, F4 | A licence breach, or a methodology that depends on data Orca cannot show. | S | next |
| L6. Volume: PRODUCT's non-goal rules out market-flow and retail-share estimates. F4 "volume" should be exchange volume from the price vendor (L1), never mixed with 13F net buying (a lower bound only). | F4 | A contradiction with the documented non-goal; flows shown that are misleading. | S | next |

### 6. Engineering practice

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| E1. Confirm `ORCA_SCHEDULE_ENABLED=true` before the 2026-11-16 run (Q3 2026; deadline 11-14). It was left unset during setup, and the live data is from 11-05. | All features | Q3 2026 never lands, and nobody notices. | S | now |
| E2. Alerting: on any pipeline or verify failure, open a GitHub issue (`permissions: issues: write`). Add a freshness monitor outside GitHub (a Cloudflare Cron Trigger Worker, free plan) that checks `manifest.json` `built` is under 35 days old and that the latest quarter equals the deadline quarter. | F3 adds a weekly schedule. Public-repo schedules switch off after 60 days with no activity, and the pipeline commits nothing. | The site goes stale silently. The schedule dies after 60 quiet days. | S | now |
| E3. Lake backups: a monthly dated copy (keep 3) of the state JSON, `fund_state`, `cusip_map`, `vendor_tickers`, `securities` and `prices_daily` to a backup prefix, plus one restore drill. The lake is saved after every run, failed ones included. | F5 rebuilds and new lake tables (S4, F3). | One bad run overwrites the only copy. Re-pricing about 39,000 stocks took more than 4.5 h (runs 8–9). | S–M | now |
| E4. Staging: a second public bucket (or prefix) and Pages branch previews (`*.pages.dev` already gets `noindex`), with a `preview` GitHub environment that holds the Pages token but no data keys | F3–F5 files should be reviewed before they go live. Today `home_only` publishes straight to production. | The owner reviews on production; a bad rule goes live. | M | next |
| E5. Feature flags by file presence: the web shows a new tab only when its file exists (a 404 hides it), plus build-time `VITE_FEATURE_*` for half-built UI | F1–F5 | The 2026-11-04 deploy-order dance repeated by hand for each feature. | S | next |
| E6. Contract migration rule in `contract.md`: additive changes only; bump `v`; the reader accepts `v` and `v−1`; remove old fields one release later | F1–F5. HTML is not immutable and the browser TTL is 2 h, so an old bundle can meet new JSON. | Breakage in the window between deploy and publish. | S | next |
| E7. Cost monitoring: Cloudflare billing notifications (R2, Workers); log lake and site bucket size each run; record vendor plan costs in DECISIONS | P1 abuse path, F3 API costs, L1 licence. | Surprise bills. R2 has no hard cap, and the stored data is estimated at 6–18 GB against a 10 GB free tier. | S | next |
| E8. Demo and test coverage per feature: `orca/demo.py` writes F3–F5 files; Playwright smoke covers the new routes at 400 px | Dev, CI and tests run on demo data only. | Features that cannot be tested offline. | S | with each feature |
| E9. SLOs as error budgets: the latest quarter is live by the 17th of Feb, May, Aug and Nov; the F3 file is at most 8 days old; the F4 prices are at most 8 days old | F3, F4 | No shared definition of "broken". | S | later |

### 7. Product and UX

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| U1. URL state for tab, period, sort, columns and filters, through one hook (none exists today) | A saved view in F2 is just a URL string. It makes views shareable and reproducible for F1 exports. | F2 gets built twice; links cannot be shared. | M | now (groundwork for F2) |
| U2. Freshness labels: "Data as of {manifest built}" across the site, and "Prices as of {date}" on F3 and F4. Ruling R5 says tables do not mark stale prices. | F3, F4 | Weekly or monthly data read as live. | S | with F3 and F4 |
| U3. Site-wide footer: "Estimates from SEC 13F filings. Not investment advice." | F3, F5 (L3) | The disclaimer is easy to miss today. | S | now |
| U4. Accessibility: a keyboard way to reorder columns (move left/right; WCAG 2.2 2.5.7 Dragging Movements); an axe check in Playwright; a table version of each new chart (like "Show the numbers") | F2, F4 | Keyboard and screen-reader users are excluded. | S–M | with F2 and F4 |
| U5. Analytics: Cloudflare Web Analytics added by hand with CSP entries (not the injected script, which must stay off), or a minimal self-hosted counter. Measure tab, export and view use. | Demand for F1–F5 and the paid-tier decision. | Building features nobody uses. | S | next |
| U6. A Method section for each new metric, plus empty, loading and error states (reuse `State` and the "no fund qualifies yet" pattern from the 15y tab) | F3–F5 | Numbers that cannot be explained; blank pages. | S | with each feature |

### 8. LLM workflow hygiene

| Item | Why it matters for the planned features | Risk if ignored | Effort | Priority |
|---|---|---|---|---|
| H1. Fix the stale lines in `pipeline/contract.md`: prices refresh monthly, not weekly; exits refresh for 6 quarters, not 8. CLAUDE.md calls the contract the source of truth and says to change it first. | Every F1–F5 contract change starts from this file. | Agents copy wrong facts into new files. | S | now |
| H2. Record F1–F5 in PRODUCT, and add DECISIONS entries for the conflicts with stated positions: "no database server" (F2 accounts), "no market-flow estimates" (F4 volume), R23 "no SPY benchmark on fund pages" (F5 benchmarks), the rejected "luck vs skill" idea (2026-10-30; F5 reopens it), and the parked Excel export (2026-11-09; F1) | F1–F5 | Agents refuse a feature or quietly contradict a ruling. | S | now |
| H3. Doc conflicts to fix: ARCHITECTURE says tables are "not virtualised" but `DataTable` is; WORKLOG 10-31 says a "golden test" exists, ARCHITECTURE says golden snapshots were never committed; the Tiingo note says a "business plan" is enough, Tiingo's docs say a redistribution licence is needed | P4, D1, L1 | Wrong assumptions in planning sessions. | S | now |
| H4. `docs/GLOSSARY.md`: quarter index `q`, book vs AUM, `priced_pct`, segment, carried, `filed_pair`, usual move, contribution points, `stock_id` vs fund id (CIK), giants, concentrated. Then F5 terms: allocation, selection, comparable, excess return. | F5 brings a second vocabulary. | Terms used differently across sessions. | S | next |
| H5. `docs/RUNBOOK.md` for the pipeline: failed run, what each health flag means, restoring the lake from backup, `home_only` rerun, purge. The domain runbook covers hosting only. | E1–E3 | Incidents handled from memory. | S | next |
| H6. CLAUDE.md "Read X when doing Y" row for this file (added with this file) | All | — | S | done |

## Top 5 before building any new feature

1. **Price licence (L1).** Email Tiingo about redistribution for the current site and for F1 and F4. Without the licence, F1 (bulk price download) and F4 (more prices and volume) cannot ship, and the current site may already be in breach.
2. **Safety net (E1, E2, D2).** Before 2026-11-16, confirm `ORCA_SCHEDULE_ENABLED` is `true`. Fail the run on bad health flags. Open a GitHub issue on failure. Add an external freshness check.
3. **Lake backup (E3).** Set up dated monthly copies and do one restore drill. This comes before F5 rebuilds and new lake tables.
4. **Correctness baseline (D1, D3).** Commit the golden funds and edge cases, and add schema tests derived from the contract. Every new file in F1–F5 is checked against them.
5. **Foundations and docs (U1, H1–H3).** Build URL state as the base for F2 views and F1 exports. Fix `contract.md` and the doc conflicts. Record F1–F5 and their conflicts in PRODUCT and DECISIONS.

Quick "now" items under an hour each: P1 (cache key and `r2.dev`), X3 (Dependabot and audits), X4 (delete the `orca-eiq` token), U3 (footer).

## Per feature: main design risks and the recommended approach

### F1. CSV/Excel download
- Risks:
  - Price redistribution (L1).
  - A CUSIP leak (L4).
  - Formula injection, and formatted strings (`−`, `$`, `%`) that Excel cannot sum (X2).
  - Exporting a past quarter triggers the `weekly.json` request flood (S2).
  - It cannot be gated while the JSON is public (DECISIONS 2026-11-09).
- Approach:
  - Generate the file client-side from the same rows the table renders. One column registry should feed both the table and the export, so the export always matches the screen and F2's column order carries over.
  - Write UTF-8 CSV with a BOM, which Excel opens. Do not build `.xlsx` (it needs a dependency).
  - Use raw numbers, units in the header names (`return_pct` or `return_frac`, `value_usd`), and the fund, quarter and data date in the file name.
  - Add an "estimate" note as the last row.
  - Ship it after S2 so past quarters are cheap.
  - Build a server-side or gated export only if it adds something the public JSON does not, such as a multi-fund bulk export. That would mean a Worker with auth and a WAF rate limit (X6).

### F2. Rearrangeable columns and saved views
- Risks:
  - There is no URL state to build on (U1).
  - Column ids are not stable yet.
  - Drag-only reordering fails WCAG 2.5.7.
  - Re-layout costs on non-virtualised tables (P4).
  - Accounts would conflict with the "no database server" and "no accounts yet" non-goals.
- Approach:
  - Phase 1 needs no backend. Store views in the URL (`?cols=…&sort=-pnl&period=…&tab=…`) and keep named views in `localStorage` under a versioned key (wrapped in try/catch). Ignore unknown column ids. Sharing a view means copying the URL.
  - Reorder by drag or by move left/right buttons, with a "Reset columns" button.
  - Phase 2 comes only with the paid tier: a Worker plus D1 table `views(user_id, name, spec_json, updated_at)`. That is tiny data, far below D1 limits, with auth as in X6.

### F3. Weekly popularity list
- Risks:
  - Reddit terms (L2).
  - Pump-and-dump and bot noise in small caps.
  - Ticker ambiguity (`A`, `IT`, `ALL`, `DD`, `CEO`).
  - Advice rules (L3).
  - A weekly cadence against the monthly pipeline (S6).
  - Weekly purges (P2).
  - The 60-day schedule shutoff (E2).
- Approach:
  - Run a separate weekly workflow (15 min or less, its own concurrency group) that writes a small `social` lake table and `social/weekly.json` plus history. Change the contract first.
  - Extract tickers only by matching `securities.json`. Use a stoplist, and require cashtags for ambiguous tickers.
  - Apply filters:
    - The same floors as Calls: market cap of at least $300M and a price of at least $1.
    - US listing only.
    - At least N distinct authors across at least 2 communities.
    - A cap on mentions per author.
    - Rank by a spike score: a z-score against the stock's own 8-week baseline.
  - Label the list "Most discussed this week". Show how past lists did against SPY, losers included.
  - Orca's edge is the join with 13F data: "discussed, and held or bought by N concentrated funds last quarter".
  - Purge only `social/*` (P2).

### F4. Sector momentum and volume
- Risks:
  - The price universe covers only stocks some 13F filer held, refreshed monthly. Stocks not held lately are not refreshed.
  - SIC codes are coarse (D7).
  - Volume and price licensing (L1, L6).
  - The Pages file budget, if pages are pre-rendered (S5).
  - Confusion with 13F net buying.
- Approach:
  - Fix the universe: market cap of at least $300M with a vendor ticker.
  - Refresh it weekly (S6).
  - Compute cap-weighted sector and sub-sector indices in the pipeline: 1w, 1m, 3m, 6m and 12m returns, the gap to SPY, and volume against its 20- and 50-day averages. Publish `sector/index.json` and `sector/{id}.json`.
  - Reuse the same table as the F5 benchmark (S4).
  - Show quarterly 13F sector rotation as a separate, clearly labelled panel.
  - Show "prices as of" (U2) and a table for every chart (U4).

### F5. Manager rankings (stock picker, sector picker)
- Risks:
  - The 13F limits (D9).
  - Survivorship (D4).
  - CUSIP gaps (D5).
  - Restatements (D6).
  - The benchmark choice, and ETFs held by funds (no look-through without licensed holdings data).
  - Multiple testing: with 13,000+ funds, the top of any raw ranking is mostly luck.
  - Compute time (S3).
  - Conflicts with R23 and the rejected "luck vs skill" idea (H2).
  - Advice rules (L3).
- Approach:
  - Use holdings-based attribution per quarter (Brinson-Fachler) against Orca's own SIC benchmark (S4):
    - Sector picking is the allocation effect: Σ (w_fund,s − w_bench,s) × (R_bench,s − R_bench).
    - Stock picking is the selection effect: Σ w_fund,s × (R_fund,s − R_bench,s).
  - Measure each pick: the excess return of each new or added position against its sub-sector basket over 4 quarters, from the same quarter-VWAP trade price the engine uses, so the timing assumption cancels out.
  - Show ETF comparables only as labelled cross-checks (L5).
  - Exclude ETF holdings from selection, or treat each as its sector.
  - Set eligibility like Top funds: at least 12 quarters, at least 20 picks, at least 80% priced, giants ranked apart.
  - Rank by a shrunk mean or t-stat, and show n with an interval.
  - Keep delisted and bankrupt holdings at their last price and flag them.
  - Store the raw per-quarter inputs in fund snapshots and apply the thresholds at publish (the conviction pattern, `orca.run home`), so rule changes need no rebuild.
  - Also show a "follower" return measured from each filing date. That is what a reader can actually capture after the 45-day lag.

## UNKNOWN (not verifiable from the docs)

- Whether `ORCA_SCHEDULE_ENABLED` is `true` today, so whether the 2026-11-16 run will fire.
- Whether the `orca-eiq` Pages project and its `orca-pages` token were deleted.
- Whether the `r2.dev` address of `orca-site` is still on (the runbook says it "can be switched off").
- Actual R2 storage (lake plus site) against the 10 GB free tier. The docs give a 6–18 GB estimate.
- The Cloudflare plan for the zone and account (Free, Pro or Workers Paid). This decides 20,000 vs 100,000 Pages files, WAF rate-limit rules and Worker CPU.
- Whether the data host's cache key includes the query string. Cloudflare's default does; the docs do not say.
- Tiingo's terms for derived figures (returns computed from its prices) as opposed to raw prices; the redistribution price; the personal plan's daily request cap for a weekly refresh of a bigger universe.
- Reddit's current Data API terms and commercial pricing (redditinc.com was not read).
- Whether rankings and popularity lists count as general advice under Australian law (needs a lawyer; this is not legal advice).
- Whether GitHub secret scanning and push protection are on for the repo.
- Whether the draggable annualised-return bracket and the period picker work by keyboard.
- Whether R2 CORS accepts a wildcard origin for preview subdomains (`*.orca-88p.pages.dev`).
- Whether manual workflow runs count as "activity" for GitHub's 60-day schedule rule.
- Core Web Vitals on production (never measured; no real-user data).
- How many of the 18,728 vendor-skipped stocks are bankruptcies, i.e. how big the survivorship bias is.
- Whether confidential-treatment positions show up as NEW HOLDINGS amendments in the bulk data sets.
- Whether the "fits at ≥ 1180 px" table rule still holds after PR #1 (already UNKNOWN in DECISIONS); it matters for F2 column changes.

## Sources (web, 2026-11-09)
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/ and subrequests changelog https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/ and pricing https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare Pages limits: https://developers.cloudflare.com/pages/platform/limits/ and https://developers.cloudflare.com/changelog/post/2026-01-23-pages-file-limit-increase/
- Cloudflare purge for all plans: https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/
- GitHub scheduled workflows (60-day rule): https://docs.github.com/actions/managing-workflow-runs/disabling-and-enabling-a-workflow
- SEC fair access: https://www.sec.gov/about/webmaster-frequently-asked-questions and https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data
- Tiingo licensing: https://api.tiingo.com/documentation and https://www.tiingo.com/documentation/appendix/developers
- Reddit Data API limits and commercial terms (secondary sources): https://data365.co/blog/reddit-api-limits and https://www.activepieces.com/blog/reddit-api-access-in-2026-how-to-get-started.md
