# Decisions (ADR log)

Last verified: 2026-11-09

Newest first. Tags: (chat) session conversation, (code) checked in code, (git) commit history.
Earlier build rulings R1–R33 (pipeline and website, 2026-10-30/31) are in
`docs/superpowers/2026-10-31-orca-rulings-and-backlog.md`; they are not repeated here.

## 2026-11-09 — Excel/paid downloads parked
- Decision: no Excel export for now (chat).
- Context: owner may want a gated paid feature. Every published JSON file is public, so anything built client-side cannot be gated (chat).
- Rejected: client-side export now; pipeline-generated .xlsx per fund (thousands of files, stale prices) (chat).
- Consequences: a gated version needs login plus a server step and the data moved behind it. Check the price vendor's redistribution terms before exporting prices. Guard against formula injection (`=`, `+`, `-`, `@`) (chat).

## 2026-11-09 — HSTS, noindex on pages.dev, sitemap/robots/canonical (PR #3, open)
- Decision: HSTS 6 months, no `includeSubDomains`/`preload`; `X-Robots-Tag: noindex` only on `*.pages.dev`; canonical only on pre-rendered fund pages (chat)(code).
- Context: duplicate content across `orca-88p.pages.dev` and `www.orcaetf.com`; `/robots.txt` returned the SPA HTML (chat).
- Rejected: a static canonical in `index.html` (wrong for every other route); `Disallow` for pages.dev (crawlers must see the noindex) (chat).
- Consequences: undo HSTS with variable `HSTS_MAX_AGE=0` + redeploy (code `web/scripts/prerender.mjs`).

## 2026-11-09 — Data on `data.orcaetf.com` behind Cloudflare's cache, purge after each run
- Decision: R2 custom domain on bucket `orca-site`; cache rule edge 1 month / browser 2 hours; pipeline purges the zone after upload (`purge_everything`) (chat)(code `.github/workflows/pipeline.yml`).
- Context: the `r2.dev` address is rate-limited and uncached; the fund page can fetch thousands of `weekly.json` files (chat).
- Rejected: same-origin Worker proxy (billed per request); versioned immutable paths (changes the JSON contract); quarter-long TTL without purge (stale prices: the pipeline runs monthly) (chat).
- Consequences: needs `CF_PURGE_TOKEN` + `CF_ZONE_ID`; purge clears the site's cache too (accepted for now). R2 answers `Vary: Origin` and Cloudflare keeps one copy per Origin, so no `Access-Control-Allow-Origin: *` rule is needed (chat, checked with curl).

## 2026-11-09 — `www.orcaetf.com` is the main address
- Decision: bare `orcaetf.com` 301-redirects to `www` via a Cloudflare Redirect Rule; both stay Pages custom domains (chat).
- Consequences: CORS origins must list `www`, bare, `orca-88p.pages.dev`, `http://localhost:5173` (code `.github/workflows/site-cors.yml`).

## 2026-11-09 — CSP generated at build, fonts self-hosted
- Decision: `dist/_headers` written by `web/scripts/prerender.mjs` with `connect-src 'self' <origin of VITE_DATA_URL>`; strict `style-src 'self'` (React sets styles through the CSSOM); Instrument Sans + Geist Mono woff2 in `web/src/assets/fonts` (code).
- Rejected: static `public/_headers` (cannot name the data origin); switching to system fonts (would lose the approved look) (chat).
- Consequences: any new third-party script/host (analytics, embeds) is blocked until added to the CSP; Cloudflare Web Analytics must stay off (chat)(code).

## 2026-11-09 — Bucket CORS set in the dashboard
- Decision: the owner set the `orca-site` CORS policy by hand (chat).
- Context: the `Site CORS` workflow's R2 token has object rights only (`AccessDenied`) (chat).
- Consequences: the workflow keeps failing until a token with Admin Read & Write is stored; the policy persists (chat).

## 2026-11-09 — Row budget for big tables (measured)
- Decision: `INITIAL_ROWS=50`, `AUTO_FILL_MAX=200`, `CHUNK=25`, `MORE_STEP=100` for the Positions and What-if tables (code `web/src/fund/loading.ts`).
- Context: layout cost of a plain `<table>` grows with rows. The measurements (1x and 4x CPU) are in the file header (code).
- Rejected: auto-filling every row (100–250 ms tasks at 2,000+ rows); virtualising (not done) (chat).

## 2026-11-09 — Prefetch every weekly price file after landing
- Decision: after first paint and idle, prefetch `stock/{id}/weekly.json` for every position. Demand loads (stepping back, opening a row) jump the queue: 8 demand, 3 background at low fetch priority. Skipped on Save-Data/2G; waits until the tables finish filling (code `web/src/fund/prefetch.ts`, `usePositionData.ts`).
- Context: owner: "land fast, load details later" (chat).
- Rejected: per-fund quarter-end price file (pipeline contract change; still the biggest future speed win) (chat).

## 2026-11-09 — Key figures: eight tiles
- Decision: row 1 (annualised return, years positive, max drawdown, volatility) follows the Annual-returns bracket; row 2 (Sharpe/Sortino/Calmar in one tile, turnover, average hold, positions profitable) is whole period from `summary.metrics` (code `web/src/fund/KpiStrip.tsx`).
- Context: Sharpe/Sortino need 3-month T-bill rates, which are not published to the browser (chat).
- Rejected: separate "More figures" section; Best/worst-year tile (dropped by the owner) (chat).

## 2026-11-09 — What-if table follows the holdings table, no period picker
- Decision: same look and behaviour as Positions; figures shared with the as-of model at the newest quarter; "Last change $" dropped (chat)(code `web/src/fund/whatif.ts`).

## 2026-11-09 — Home move boxes
- Decision: Conviction shows one "Move" box (New/Added/Trimmed/Sold all + `change_pts` to 1 dp); Calls show "Bought Q2 ’26" (calls rows have no weight change) (chat)(code `web/src/pages/Home.tsx` `MoveBox`, `BoughtBox`).

## 2026-11-08 — Port the approved artifact to the fund page
- Decision: the fund page matches the artifact from the fund-name heading down. Guidebook parts are left out (theme switch, command palette, crumbs, Compare/Watch, Trades/Filings tabs) (chat).
- Context: owner approved "Orca Modern UI" v13 (chat).
- Consequences: the parallel-agent build used fixed file ownership (`web/src/fund/*`) and stub contracts (chat).

## 2026-11-08 — Quarterly returns are the source of truth
- Decision: a year or span = product of (1 + quarterly return) − 1; annualise with growth^(4/n quarters); part years are never annualised for display (chat)(code `web/src/fund/series.ts` `spanKpi`).
- Context: owner's rule; matches the pipeline engine (chat).
- Consequences: a part year is derived from quarter counts (`qCount < 4`), not labels: the demo labels the part year 2014 as "2014" (code `buildSeries`).

## 2026-11-08 — As-of positions for earlier quarters
- Decision: prices for earlier quarter ends come from `weekly.json` (last close on or before the quarter end, walking back over nulls); the newest quarter uses `latest_prices.json`. Dividends before the newest quarter are spread by shares held at each quarter end (code `web/src/fund/positions.ts`).
- Rejected: the artifact's value-weighted dividend spread (needs every weekly file for every view) (chat).
- Consequences: Total P&L at earlier quarters differs from the artifact by a median of about $3m on the demo fund (chat).

## 2026-11-08 — Tidy SEC names in the UI
- Decision: `tidyName` title-cases capitalised names and drops legal suffixes ("ALPHABET INC" → "Alphabet") on the fund, stock and Home pages (code `web/src/lib/format.ts`).
- Consequences: "BANK AMER CORP" → "Bank Amer"; word order is not fixed (chat).

## ≤ 2026-11-08 — Visual direction
- Decision: modern UI on warm paper neutrals; ocean blue = up, orange = down; ink for controls; Instrument Sans + Geist Mono (chat)(code `web/src/tokens.css`).
- Rejected: consulting/FT-style "Paper & Ink" deck look (owner: "forget the BCG and McKinsey slide style") (chat).

## 2026-11-03..05 — Conviction v3 (git)
- Decision: a move is dollars traded in one stock over the fund's AUM (a buy over end AUM, a sale over start AUM). Adds and trims lose their pro-rata share of the quarter's net flow first. Listed when ≥ 3% of AUM, ≥ 2× the usual move (biggest of the 4 quarters before, floor 1%) and ≥ ½ the largest holding at the start. Ranked by `score` (git 5122d70, 79d8628; `pipeline/contract.md`).
- Rejected: v1/v2 rules (moves vs largest holding; sized on last quarter's book) (git 0377f16).

## 2026-11-02 — Pipeline runs monthly on the 16th (git 49e3a54)
- Context: the 16th falls after each 13F deadline (Feb 14, May 15, Aug 14, Nov 14).
- Rejected: weekly runs.

## 2026-11-01 — Price only what the vendor lists (git 8155ed7)
- Decision: resolve each stock's vendor ticker from Tiingo's supported-tickers list (table `vendor_tickers`).
- Context: 19,222 of 40,268 tickers came back empty (delisted stocks mapped to foreign tickers by OpenFIGI).

## 2026-10-30 — Architecture: static site + published JSON (git aaff236; spec)
- Decision: Python pipeline on GitHub Actions → private R2 lake (holds CUSIPs) → public R2 bucket of brotli JSON (`pipeline/contract.md`) → static React site on Cloudflare Pages that computes live values in the browser.
- Rejected: always-on server, database server, 13F competitors as data sources (spec §1).
- Consequences: no server-side gating; publishing uses stable paths with `manifest.json` last (ruling T13, overriding the spec's version folders).
