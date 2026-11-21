# Orca: context for coding agents

Last verified: 2026-11-21

Orca turns SEC 13F filings into estimated fund returns and stock-by-stock P&L for amateur investors ("WhaleWisdom shows what funds own; Orca shows how well they did it"). A Python pipeline on GitHub Actions ingests the SEC 13F data, prices and T-bill rates. It keeps its state in a private Cloudflare R2 bucket and publishes brotli JSON files to a public R2 bucket. A static React site on Cloudflare Pages reads those files in the browser and computes live values. The site is live at https://www.orcaetf.com, with data at https://data.orcaetf.com. Claude Code project name: "Whale Wisdom 13F Analytics Platform".

## Session protocol
1. Read this file first. Open the docs below only when the task touches them.
2. Before ending a session, add an entry at the top of `docs/WORKLOG.md` and update any doc your change made stale (`Last verified:` date too).
3. If code and a doc disagree, trust the code, fix the doc, and say so.

## Read X when doing Y
| Doing | Read |
|---|---|
| Anything in the pipeline, data, hosting, Cloudflare | `docs/ARCHITECTURE.md` |
| Changing a published JSON file or its reader | `pipeline/contract.md` (source of truth; change it first) |
| UI, metrics, what a view shows | `docs/PRODUCT.md` |
| The Excel workbook (`pipeline/orca/workbook/`) | `docs/superpowers/specs/2026-11-10-fund-workbook-design.md`, `docs/ARCHITECTURE.md` (Workbook) |
| "Why is it like this?" | `docs/DECISIONS.md`, then `docs/superpowers/2026-10-31-orca-rulings-and-backlog.md` (rulings R1–R33) |
| Domain, DNS, cache, CORS, secrets/variables, rollback | `docs/domain-and-data-hosting.md` (owner runbook) |
| What happened recently, open issues | `docs/WORKLOG.md` |
| The logo, favicon or app icons | `docs/brand/README.md` (files, colours, rules; `brand-sheet.png` is the guide) |
| The sector → industry → industry vertical hierarchy (labels, naming, review page) | `pipeline/orca/hierarchy/README.md`, `docs/DECISIONS.md` (2026-11-16) |
| Planning a new feature (CSV export, saved views, popularity list, sector page, manager rankings) | `docs/ROADMAP.md` (audit, priorities; proposal until the owner approves) |
| Building the home page's Famous funds chart (ranked return bars, fitted scale, Chart / Table switch) | `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md` (approved design, build checklist; mock-ups beside it) |
| Original design and build plans | `docs/superpowers/specs/`, `docs/superpowers/plans/` |

## Stack and hosting
- Pipeline: Python ≥ 3.13, `uv`, Polars, httpx, brotli (`pipeline/pyproject.toml`). Runs on GitHub Actions (`.github/workflows/pipeline.yml`): monthly on the 16th at 06:23 UTC, a check on the 1st, or by hand.
- Storage: R2 bucket `R2_LAKE_BUCKET` (private Parquet lake; holds CUSIPs, never public). R2 bucket `orca-site` (`R2_SITE_BUCKET`, public JSON) is served at `data.orcaetf.com` with a Cloudflare cache rule (edge 1 month, browser 2 h), purged after each upload.
- Web: React 18 + Vite 7 + TypeScript, react-router 7 (package `react-router`), @tanstack/react-virtual, vitest 4 + jsdom, Playwright (`web/package.json`). Cloudflare Pages project `orca` (`orca-88p.pages.dev`; custom domains `www.orcaetf.com`, bare `orcaetf.com` 301 → www).
- External data: SEC EDGAR (bulk 13F data sets, daily index, full index and pre-2013 text filings, data.sec.gov), OpenFIGI, Tiingo prices, FRED (DTB3). Google Trends (Most searched) is a hand-refreshed snapshot (`pipeline/scripts/google_trends.py`), not fetched by runs. Keys live only in GitHub secrets.

## Repo map
```
pipeline/            Python package `orca` (ingest → lake → engine → publish), tests/, contract.md
pipeline/orca/workbook/  per-fund Excel workbook builder (inputs, model/outputs/summary tabs; private, owner-only)
pipeline/orca/hierarchy/ sector → industry → industry vertical labels (labels.txt is the source of truth; parser, name matching, labelling and review-page tools; draft, not in the pipeline yet)
web/src/pages/       Home, Fund (assembles the fund page), Position, NotFound (+ page css)
web/src/fund/        fund-page panels (Holdings/Analysis/About tabs) and pure models: series.ts (returns/KPIs), positions.ts (as-of model, periods),
                     treemap.ts + treemapView.ts (holdings tree map), about.ts,
                     drive.ts, aum.ts, whatif.ts, loading.ts (row budget), prefetch.ts (price queue), base.css
web/src/charts/      PriceChart, StepChart, shared Tooltip (one #tip for the app), scale.ts
web/src/components/  DataTable, Tabs, Panel, Choice (Seg wrapper), Pager, State, Tiles, Signed, StockLabel
web/src/data/        api.ts (cached fetch per URL, loaders), types.ts (mirrors contract.md)
web/src/lib/         format.ts (money/pct/tidyName), live.ts (IRR, P&L at latest prices), sort, useLoad
web/scripts/         prerender.mjs (fund pages, _headers, sitemap/robots), dataOrigin.ts, siteUrl.ts
web/src/assets/people/ photos of the people behind famous funds (<slug>.jpg, people.json, credits.json, README.md; fetch script pipeline/scripts/fetch_people_images.py)
web/tests/, web/e2e/ vitest suites; Playwright smoke (1280/400 px, light/dark)
web/public/demo-data synthetic demo data (funds 9100001–9100012) used by dev, tests and CI
.github/workflows/   ci.yml (pipeline tests), web.yml (web tests + deploy), pipeline.yml, people-photos.yml, site-cors.yml, purge-cache.yml
docs/                PRODUCT, ARCHITECTURE, DECISIONS, WORKLOG, domain runbook, brand/ (logo kit), superpowers/ (spec, plans, rulings)
```

## Commands
| Task | Command |
|---|---|
| Web install | `cd web && npm ci` (Node ≥ 22.18) |
| Web dev (demo data) | `cd web && npm run dev` → http://localhost:5173 |
| Web tests / types | `cd web && npm test` ; `npm run typecheck` |
| Web build | `cd web && npm run build` (vite build + `scripts/prerender.mjs`) |
| Web e2e | `cd web && npx playwright test` (cloud sessions: prefix `PW_CHROMIUM=/opt/pw-browsers/chromium`) |
| Pipeline install / tests | `cd pipeline && uv sync --locked && uv run pytest -m "not network"` |
| Pipeline run (ingest) | Actions > Pipeline > Run workflow (inputs `full`, `home_only`, `backfill`); locally `uv run python -m orca.run {weekly\|rebuild\|backfill\|home\|check-keys\|verify}` (needs the API key env vars) |
| Sector indices + fund scores (after a relabel) | Actions > Pipeline > Run workflow (input `sectors_only`); locally `cd pipeline && uv run python -m orca.run sectors` (needs a restored lake; lake only, nothing published). Check an edit first: `uv run python orca/hierarchy/tools/relabel_check.py` |
| Fund workbook | Actions > Workbook > Run workflow (input `fund_ids`, at most 20); locally `cd pipeline && uv run python -m orca.run workbook --fund ID [--fund ID …] [--out DIR]` (needs a restored lake; output stays private) |
| People photos (famous funds) | Actions > People photos > Run workflow, **choosing a branch, not `main`** (it commits the photos to that branch; merge it after); locally `cd pipeline && uv run --with pillow --with opencv-python-headless==4.10.0.84 python scripts/fetch_people_images.py`; see `web/src/assets/people/README.md` |
| Demo data | `cd pipeline && uv run python -m orca.run demo --plain --out ../web/public/demo-data` (no network) |
| Deploy site | merge to `main` (Web workflow deploys), or Actions > Web > Run workflow |
| Clear data cache | Actions > Purge cache |

## Conventions
- Published JSON shapes follow `pipeline/contract.md` exactly (snake_case, columnar arrays, `null` = missing, quarters `q = (year−2013)*4 + (quarter−1)`, money in dollars, returns as fractions).
- UI: one gain colour (blue) and one loss colour (orange), always with a printed sign and real minus `−`. Tokens are in `web/src/tokens.css`. Fund-page CSS is scoped under `.fp`.
- Missing values show "–" or "—", never NaN. Every figure is labelled as an estimate.
- Comments explain why, briefly. No new npm dependencies without need; versions pinned exactly.
- Commits: `area: what changed` with a body explaining why. Branch work goes to the session's assigned branch; PRs are squash-merged.

## Gotchas
- Merging to `main` deploys production (Web workflow). PR #3 was squash-merged as a2a1554 on 2026-11-09.
- After a squash merge, merge `main` into the working branch; force-push is blocked in cloud sessions.
- The CSP is strict (`web/scripts/prerender.mjs`). A new external script, font or fetch host must be added there. Cloudflare Web Analytics is on and allowed there (`static.cloudflareinsights.com`, `cloudflareinsights.com`).
- `VITE_DATA_URL` must be a bare origin (no trailing slash or space); a bad value fails the build. `SITE_URL` likewise.
- The demo fund IDs (9100001–9100012) do not exist in production. Test production with e.g. `/fund/1067983` (Berkshire Hathaway).
- Part years are derived from quarter counts, not labels (the demo labels a part year "2014").
- Quarters before 2013 are negative (Q1 1999 = −56): in TypeScript use `qOfYear` (`web/src/lib/format.ts`), never `q % 4`. The pre-2013 history comes from text filings (`pipeline/orca/sec/legacy.py`), read by the `backfill` input before an ordinary run computes it. The demo has no pre-2013 fund.
- jsdom has no IntersectionObserver/ResizeObserver. Hooks in `web/src/fund/hooks.ts` degrade, and tests stub `requestIdleCallback` (`web/tests/idle.ts`).
- The R2 CORS policy was set in the dashboard. The Site CORS workflow fails (`AccessDenied`) until its token has Admin rights.
- The pipeline job is named `weekly` but runs monthly.
- `npm install` on npm 10.9 (Node 22's bundled npm) crashes with "reading 'edgesOut'" when vitest's optional peers are resolved. Change versions with `npx -y npm@11.6.2 install`; `npm ci` on npm 10 reads the resulting lockfile fine.
- The cloud shell's cwd drifts: use absolute paths. Running 4+ heavy agents in parallel hit the 5-hour usage limit twice.
