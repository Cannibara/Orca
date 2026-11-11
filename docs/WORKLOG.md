# Worklog

Last verified: 2026-11-11

Reverse-chronological. Tags: (chat) = said in a working session, (code) = checked in the code,
(git) = from commit history. "PR #n" = github.com/Cannibara/Orca/pull/n. Append new entries at the top.

## 2026-11-11 — Home matches the fund page; How it works removed

| What changed | Why | Files |
|---|---|---|
| Deleted the How it works page: route, nav, footer and Position-page links, sitemap entry, its CSS and tests | Users need no 13F education (chat) | `web/src/App.tsx`, `pages/Method.tsx`, `pages/method.css`, `pages/Position.tsx`, `scripts/prerender.mjs`, tests |
| Removed the home paper look: the home page now uses the fund page's cream page, surface panels, sunken heading row and trough, line borders; heading is the fund page's 34px; "Open fund" is a secondary button like the fund page's | Home should match the fund pages (chat) | `web/src/pages/home.css`, `Home.tsx`, `tokens.css` (code) |

- Checked: vitest (923), typecheck, build, Playwright e2e (44, 1280 and 400 px, light and dark), home screenshots light and dark at 1280 px.
- Original entry below is superseded by this one.

## 2026-11-11 — Home page paper look (superseded)

| What changed | Why | Files |
|---|---|---|
| Home page only: white page and content box (hairline on left, right and bottom), paper-80 top bar, paper-50 panel and tab strip, paper-80 heading row, paper-30 cells, paper-100 toggle trough, #C8BAA7 borders on input, heading row and pager buttons; panel header and pager rows about 10px shorter (chat)(code) | The paper page colour (#FAF3EA) was too dominant; the owner picked this combination from design-canvas options (chat) | `web/src/tokens.css`, `web/src/pages/home.css` |

- Roles are tokens (`--home-*`, built on `--white`, `--paper-30/50/80/100`, `--sand-border`). Dark values equal the old dark neutrals, so dark is unchanged (code).
- Scoped with `:has(.home)`; fund, position and method pages are unchanged (code).
- Follow-up: tab strip is white (`--home-tabs`); lists whose table follows the header directly (Crowded buys, Best & worst calls) get a 100px header-to-heading height like Top funds (`web/src/pages/home.css`) (chat)(code).
- Open: fund/position pages still use the #FAF3EA page colour; extend the look there if wanted (chat).

## 2026-11-10 — Roadmap safety net: health gates, failure alert, lake backup

| What changed | Why | Files |
|---|---|---|
| `check_health` aborts a run (before the manifest) when no CUSIP is mapped, median coverage is under 0.90 or owed funds were not computed; scheduled run/verify failures open a GitHub issue; each successful scheduled run copies the small lake state to `backups/<date>/` (3 kept), excluded from restore and save (code) | ROADMAP D2, E2, E3: run 5 published 0 tickers silently; failures went unseen; one bad run overwrote the only lake copy (chat) | `pipeline/orca/run/gates.py`, `pipeline/orca/config.py`, `.github/workflows/pipeline.yml`, `.github/actions/restore-r2/action.yml`, `docs/ARCHITECTURE.md`, `docs/domain-and-data-hosting.md` |

- Open: the `alert` job and the backup step have only been linted (actionlint, shellcheck, a stubbed-rclone run of the backup script); neither has run on GitHub. Do the restore drill once on a scratch bucket. The freshness monitor (rest of E2) is not built.

## 2026-11-10 — Roadmap batch: safety net and quick wins (PR after #4)

| What changed | Why | Files |
|---|---|---|
| Health gates abort a run before the manifest when no stock is mapped, coverage_median < 0.90 or every tried fund came out empty (`run/gates.py`); failure issue for scheduled pipeline/verify runs; monthly lake-state backup to `backups/<date>/` (keep 3, schedule only, excluded from the restore and save syncs) (ROADMAP D2, E2, E3) | Bad data was never published only by luck (go-live run 5 published 0 tickers); failures were silent; the lake had one copy | `pipeline/orca/run/gates.py`, `weekly.py`, `.github/workflows/pipeline.yml`, `.github/actions/restore-r2/action.yml`, `docs/ARCHITECTURE.md`, `docs/domain-and-data-hosting.md` |
| Dependabot (monthly, grouped, uv/npm/github-actions) and non-blocking `npm audit` / `pip-audit`; site-wide estimate footer; `types.ts` vs `contract.md` test; stale-doc fixes (contract, virtualisation, Tiingo licence, F1–F5 backlog) (ROADMAP X3, U3, D3, H1–H3) | Quick wins from the audit | `.github/dependabot.yml`, `ci.yml`, `web.yml`, `web/src/App.tsx`, `web/tests/contract-types.test.ts`, docs |

Not done: ROADMAP U1 (URL state) waits for the saved-views work it is groundwork for; L1 (Tiingo licence), E1 (`ORCA_SCHEDULE_ENABLED`), P1 (data-host cache key, `r2.dev`), X4 (old `orca-eiq` token), secret scanning and push protection are owner or dashboard actions. The alert and backup steps and the rclone filters have only been checked offline (stubbed rclone, actionlint, shellcheck); Issues must be enabled on the repo.

## 2026-11-10 — Per-fund Excel workbook, phase 1 built (owner-only)

| What changed | Why | Files |
|---|---|---|
| Builder for a per-fund workbook (Model, Outputs, Summary tabs; every fund-page metric as formulas, 57 in-file checks against Orca's figures); `orca.run workbook` CLI that validates, round-trips and writes inputs plus the file; manual Workbook Action to the private lake bucket; CI installs LibreOffice and requires it; the site's IRR now uses Excel's XIRR convention (mid-quarter dates, days ÷ 365); docs and spec brought in line with the build (code)(git) | Owner decision: paid per-fund workbook, phase 1 for the owner only (chat) | `pipeline/orca/workbook/`, `pipeline/orca/run/workbook.py`, `pipeline/orca/run/cli.py`, `pipeline/orca/run/compute.py`, `.github/workflows/workbook.yml`, `.github/workflows/ci.yml`, `web/src/lib/live.ts`, `docs/*`, `CLAUDE.md` |

- The public pipeline contract is unchanged (no public file changed).
- Open:
  - Excel has never opened these files; only LibreOffice 24.2 recalculated them. Open one in Excel and check Summary's "Checks failing" before anyone relies on it.
  - Tiingo's redistribution licence is a blocker before selling or sharing a workbook.
  - Phase 2 (login, payment, Worker, Container, per-fund private input files for every fund) needs its own spec.
  - actionlint 1.7.12 and shellcheck were run clean on workbook.yml and ci.yml; the Action itself has not run on GitHub yet.

## 2026-11-10 — Per-fund Excel workbook design: sections 1–2 approved

| What changed | Why | Files |
|---|---|---|
| New DECISIONS entry (2026-11-10): paid per-fund Excel workbook built on demand, 500-position cut, site IRR moves to the XIRR convention, scaling rule for GitHub Actions; ROADMAP update note; ROADMAP D1 golden-dataset wording corrected (the Berkshire figures are the site's own output, not independent) (chat) | Owner's design session: "raw data first, then Excel formulas for every fund-page metric, reconciled to ours" (chat) | `docs/DECISIONS.md`, `docs/ROADMAP.md` |

- Approved layout (chat):
  - 3 tabs: Model, Outputs, Summary.
  - Model has rows = variables, with stocks in blocks in the same order everywhere. Its columns are years | gap | quarters | Latest, and the year columns are formulas over the quarter columns.
  - Outputs: stock snapshot (positions now and what-if) plus the checks table.
  - Summary: header figures, the 8 tiles and the overall check status.
- Measured (chat): xlsxwriter ~1,255 stock-quarter rows/s per core; LibreOffice headless recalculates XIRR, STDEV.S, SUMIFS and INDEX/MATCH correctly (spike in the scratchpad, not in the repo).
- Next: design sections 3–5 (data flow and code, reconciliation and tests, ops), then the spec at `docs/superpowers/specs/2026-11-10-fund-workbook-design.md`.
- Gaps: both inventory subagents failed on a 429 rate limit after a container restart; the inventory was redone by reading the code (chat).

## 2026-11-09 — Design audit against planned features (`docs/ROADMAP.md`)

| What changed | Why | Files |
|---|---|---|
| Prioritised audit of the design against F1 CSV/Excel export, F2 columns/saved views, F3 weekly popularity list, F4 sector momentum/volume, F5 manager rankings; from the docs, spot-checks in code and live `data.orcaetf.com` sizes/health (measured), vendor/platform limits by web search (chat) | Owner asked for best practices missing before building those features (chat) | `docs/ROADMAP.md`, `CLAUDE.md` (Read-X row) |

Found (measured): live manifest from 2026-11-05 (76,080 files); Vanguard `positions.json` 3.4 MB brotli / 8.3 MB decoded; no URL state in `web/src`; disclaimer only on Method; no Dependabot/CodeQL, no failure alert, no lake backup. Web: Tiingo's self-serve plans are internal-use only (redistribution licence needed); public-repo schedules stop after 60 days without activity; Pages Free cap 20,000 files per site.
Open: owner to approve the roadmap; confirm `ORCA_SCHEDULE_ENABLED=true` before the 2026-11-16 run; stale lines in `pipeline/contract.md` not fixed in this pass (ROADMAP H1).

## 2026-11-09 — Context backfill from the build session

| What changed | Why | Files |
|---|---|---|
| The 2026-10-30..11-07 entries below rewritten from the build session's own transcript (owner messages, replies, run reports), checked against the code and git log (chat) | The first context pass had only commit messages for that period (chat) | `docs/WORKLOG.md`, `docs/DECISIONS.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` |

Gaps: the exact text of the owner's 9 review comments (2026-11-03) lives on the review artifact, not in the chat; the cause of run 5's failed CUSIP mapping and run 4's exact error were never logged (chat).

## 2026-11-09 — LLM context layer

| What changed | Why | Files |
|---|---|---|
| Added `CLAUDE.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/WORKLOG.md`, backfilled from this chat, the code and git log (chat) | Future sessions onboard from a few files instead of scanning the codebase (chat) | the five files above |

Open issues: chat history of the 2026-10-30..11-06 sessions was not available; those entries come from git and the rulings doc only. A prompt was handed to the owner to backfill them from that chat (chat). Done the same day: see the entry above.
Owner clarified: holdings are quarterly, prices refresh monthly; added "Data cadence" to `docs/PRODUCT.md` (chat).

## 2026-11-09 — Domain move, hardening, SEO (PR #2 merged; PR #3 merged later that day as a2a1554)

| What changed | Why | Files |
|---|---|---|
| PR #3 (open at the time; squash-merged as a2a1554 on 2026-11-09 (git)): HSTS `max-age=15552000`, `X-Robots-Tag: noindex` on `*.pages.dev`, canonical link + `sitemap.xml` + `robots.txt` when `SITE_URL` is set, `dist/demo-data` removed when `VITE_DATA_URL` is absolute (git 006b9d8)(code) | Optional follow-ups the owner asked for ("make the improvement changes") (chat) | `web/scripts/prerender.mjs`, `web/scripts/siteUrl.ts`, `.github/workflows/web.yml`, `docs/domain-and-data-hosting.md` |
| PR #2 merged (27f7be6): build-generated `dist/_headers` (CSP naming the data origin, nosniff, referrer/permissions policies, `frame-ancestors 'none'`, 1-year immutable `/assets/*`), self-hosted fonts, data-host preconnect, cache purge after pipeline upload + manual `Purge cache` workflow, CORS default origins (git)(code) | Move to `www.orcaetf.com` + cached data host `data.orcaetf.com` (chat) | `web/scripts/prerender.mjs`, `web/scripts/dataOrigin.ts`, `web/vite.config.ts`, `web/src/fonts.css`, `.github/workflows/{pipeline,purge-cache,site-cors}.yml` |
| Cloudflare/GitHub settings done by the owner: `www` primary, bare 301 redirect rule, R2 custom domain `data.orcaetf.com` on bucket `orca-site`, cache rule (edge 1 month, browser 2 hours), DNSSEC, SPF `-all` + DMARC reject, purge token `CF_PURGE_TOKEN` + `CF_ZONE_ID`, `SITE_ORIGINS`, `VITE_DATA_URL=https://data.orcaetf.com` (chat; DNS/headers checked with curl) | Speed (CDN cache, no r2.dev rate limit) and security | Dashboard only; recorded in `docs/domain-and-data-hosting.md` |
| R2 CORS policy for `orca-site` set by hand in the dashboard (chat) | `Site CORS` workflow failed: `AccessDenied` on PutBucketCors, R2 token has object rights only (chat, run 42600509949) | — |
| Verified live after deploy (Web run #51): CSP with `https://data.orcaetf.com`, preconnect, immutable assets, bundle uses only the new data URL, `Purge cache` run green, cache MISS→HIT per Origin (chat) | — | — |

Open issues: PR #3 awaited the owner's "merge" (merged as a2a1554 (git)); after merge check `strict-transport-security`, `/robots.txt`, `/sitemap.xml`, `x-robots-tag` on pages.dev (chat). Owner may switch off the bucket's `r2.dev` address after a few days (chat). Site CORS workflow still fails until an R2 token with Admin Read & Write exists (chat).
Next: decide purge scope (`purge_everything` vs host) (chat).

## 2026-11-08..09 — New UI on the live site (PR #1, squash 1bb18f8)

| What changed | Why | Files |
|---|---|---|
| Fund page rebuilt from the approved "Orca Modern UI" artifact: header, KPI strip, Annual returns (draggable annualised bracket), What drove (waterfall + period strip), AUM, Positions (period picker, as-of figures, expandable rows) (git)(code) | Owner approved the design artifact; "output exactly what we have, from the heading down" (chat) | `web/src/fund/*`, `web/src/pages/Fund.tsx`, `web/src/tokens.css` |
| Round 2: KPI strip to 8 tiles (+ Sharpe/Sortino/Calmar, turnover, hold length, profitable share), What-if panel in the holdings-table style, Home/Position/Method/NotFound restyle, Conviction "Added +6.0%" boxes, Calls "Bought Q2 ’26" boxes (git)(code) | Owner kept those figures and asked to restyle everything (chat) | `web/src/fund/KpiStrip.tsx`, `WhatIfPanel.tsx`, `whatif.ts`, `web/src/pages/Home.tsx`, `Position.tsx` |
| Loading: first paint 50 rows, idle fill to 200 in chunks of 25, then "Show 100 more"; background prefetch of every weekly price file, demand loads first (git)(code) | "Land fast, load details later"; numbers measured (chat) | `web/src/fund/loading.ts`, `prefetch.ts`, `usePositionData.ts` |
| Old charts `ColumnChart`/`DivergingBars`, `FundTables.tsx`, `MoreFigures.tsx`, `components/Chips.tsx` deleted (git) | Replaced by the new panels | — |

Bugs hit: global `.panel` padding and table rules leaked into fund panels → reset in `web/src/fund/base.css` (chat)(code); click on a bar re-rendered the chart and moved the tooltip → re-shown at cursor (chat); jiggle not visible in the Claude app window (left as is, owner's call) (chat); agent runs stopped twice on the 5-hour usage limit and were resumed (chat).

## ≤ 2026-11-08 — Design artifacts (exact dates UNKNOWN)

Built in a chat, not in the repo (chat): "Orca Paper & Ink" consulting style (claude.ai/artifact/MuTEJxXWbiJezFXKdpQmse), then "Orca Modern UI" v1–v13 (claude.ai/artifact/SNFpgMQd6B12CcQLADKUpo). Prototype source lived in a session scratchpad (`build-m/app.js`, `style.css`, `palette.py`), not in the repo; the port is now the reference.

## 2026-11-06..07 — Formatting template request, domain and name (chat)

- 11-06: owner asked for a McKinsey-slide formatting template for the site, "without updating the page". Consulting-slide conventions were researched: action titles of at most 15 words and 2 lines, one message per exhibit, a source line, one highlight colour with the rest grey, at most 2 fonts, no gridlines, direct labels (chat). A Design System artifact "Orca Exhibit System" (claude.ai/artifact/8heHsqsdaEsj9CN4mj9cMH) was created but left EMPTY when the owner switched to domain questions (chat). A later session built "Orca Paper & Ink", which the owner then rejected (see DECISIONS "Visual direction") (chat).
- 11-06: domain options given. Option 1 renames the pages.dev address with a new Pages project (`CF_PAGES_PROJECT`), because projects cannot be renamed. Option 2 is a custom domain: Cloudflare Registrar, Pages custom domain, R2 custom domain for the data, `VITE_DATA_URL`, CORS origins (chat). Main reason given for a domain: the `r2.dev` address is rate-limited and not meant for production (chat).
- 11-07: name. "Orca" was chosen because orcas hunt whales, and WhaleWisdom is the main 13F site (chat). Concerns raised: "Orca" is a crowded name (Orca Security and many apps), and "whale" should stay out of the name to avoid confusion with WhaleWisdom's mark (chat).
- 11-07: a `.com` RDAP check (rdap.verisign.com) found these unregistered: orca13f, orcapnl, orcafilings, sonar13f, 13fsonar, pod13f, breach13f, fundbreach, 13fpnl, fundpnl, holdingspnl. Taken: orcafunds, getorca, orcahq, orcadesk, orcaledger, orcawatch, fundsonar, apex13f, podfunds, convictionlist, echofunds, wakefunds, podwatch, apexpnl (chat). Recommended orca13f.com (chat). The final choice, `orcaetf.com`, was made in a later session; its reasoning is UNKNOWN here.

## 2026-11-06 — Just filed tab dropped, conviction pager, Best calls question, tables fit (git 2f6a77a, 85ec00a)

| What changed | Why | Files |
|---|---|---|
| Just filed tab removed. The pipeline still writes `home/just_filed.json` (code `publish.py` `HomeLists.just_filed`) | Owner request (chat) | `web/src/pages/Home.tsx` |
| Conviction: the pager shows in both views whenever there are rows; buttons are disabled on a single page ("Showing 1–67 of 67 moves") | Owner: make the 1-quarter and 4-quarter views consistent (chat) | `web/src/components/Pager.tsx` |
| Tables fit at ≥ 1180 px: fund, company and ticker names cut with "…" (full name on hover), headers wrap, Held/Last change cells take two lines, cell padding 9 px, table text 13 px | Owner: no sideways scrolling, mainly Conviction and Best & worst calls (chat) | `web/src/styles.css` (`.trunc`, `.two-line`), `web/src/pages/FundTables.tsx` (deleted in PR #1) |

- Measured overflow before (1,146 px content width): Conviction +48 px (4-quarter view +212), Best calls +99, fund Positions +227, Sold or trimmed +428 (chat). After: fits at 1180–1920 px on every home tab and 8 large fund pages. At 1024 px still over: 4-quarter Conviction +2 px, widest fund table +129 px (chat).
- Best & worst calls: the owner asked why "Best" shows losers (Ouster by Shannon River at #12 onwards). Cause: the file keeps the 50 best and 50 worst buys cut at quarter-end prices, and the site re-ranks all 100 by today's price (ruling R7). The median of the 100 was −23.6% while SPY went from $738 to $767 (chat). Proposed fix: publish every qualifying buy and take the live top and bottom 50. Owner: "keep it as is, that makes sense" (chat).
- Open: the two conviction views still differ on purpose (a Quarter column, and "Weight after" vs "Weight now"); the owner was asked whether to match them, no answer (chat).
- Conflict: `.trunc` and `.two-line` are still in `web/src/styles.css`, but no component uses them since PR #1 rebuilt the pages (code). Whether the ≥ 1180 px fit still holds is UNKNOWN.

## 2026-11-05 — Conviction: money in/out taken out of moves, sales sized on last quarter's AUM (git 79d8628)

| What changed | Why | Files |
|---|---|---|
| Adds and trims lose their pro-rata share of the quarter's net flow (`flow × w_prev`, clipped so it never enlarges or flips a move); new positions and exits count in full; sales are sized on the start AUM, buys on the end AUM; the usual move uses the same measure | Owner: "the math should isolate for money in and out"; "sell quantum should be compared to last quarter" (chat) | `pipeline/orca/home.py` `_move_size`, `ConvictionQuarter.flow`; `pipeline/orca/run/compute.py` `_conviction_quarters` |

- Needed one rebuild (~2.5 h) because each fund had to store its net flow per quarter (chat). Tests: 722 pipeline, 345 site (chat).
- Result: last quarter 76 → 67 moves from 57 funds; 4 quarters 200 (cap) from 172 funds (chat).
- Limit: a client moving one stock in or out of a wealth manager in kind looks the same as a trade in 13F data. Top rows were still Pitcairn (exit $195M), Fi3 (add $164M) and Evolution Wealth (add $239M). 11 of 67 rows (40 of 200) were wealth, advisor or charity-named funds (chat).
- Open, asked but not answered (chat): (1) leave out funds with ≥ 30% of their book in ETFs. Wealth-type names have a median 33% ETF share vs 0% for the rest. The rule drops 23 of 41 wealth-type funds plus 14 others (Harbor Group 89%, Cynosure 77%, SEEDS 75%); it keeps Kayne Anderson, Paradigm Biocapital and WorldQuant; it costs Karpus Management (48%, closed-end funds count as ETFs) and SAVA pension fund (47%). (2) Keep common stock only: the 4-quarter list's #1 was Long Focus "trimming" a −$4.27bn Alibaba convertible bond.

## 2026-11-04 — Conviction v3; run speed and safety (git 5122d70, bed422e)

| What changed | Why | Files |
|---|---|---|
| Moves sized on this quarter's AUM, compared with the biggest single-stock move of the 4 quarters before, each on its own quarter's AUM; listed at ≥ 3% of AUM, ≥ 2× usual, ≥ ½ of the largest holding at the start; ranked by a hidden score | Owner's own definition after two corrections (chat); see DECISIONS | `pipeline/orca/home.py` `conviction_moves`, `_conviction_quarter`, `_usual_move` |
| New "Last 4 quarters" view (each quarter judged on its own past, cap 200 rows) and files `home/conviction_q.json`, `home/conviction_y.json` | Owner: "we might want to know highest conviction moves in the last 4 quarters as well" (chat) | `pipeline/orca/publish.py`, `web/src/pages/Home.tsx` |
| Each fund stores raw per-quarter moves for 8 quarters (`ConvictionQuarter`); rules run at publish time; `python -m orca.run home` and the Pipeline input `home_only` republish the home lists in ~5 min without fetching or recomputing | Every rule tweak had needed a ~2 h rebuild of 13,317 funds (chat) | `pipeline/orca/run/weekly.py` `run_home`, `pipeline/orca/run/state.py` `_RETIRED`, `.github/workflows/pipeline.yml` |
| rclone: `RCLONE_TIMEOUT=60s`, `RCLONE_CONTIMEOUT=15s`, progress every 30 s; restore retried 3× under `timeout 15m`; the save step stops a leftover pipeline (`pkill -TERM`, then `-KILL` after 30 s) | A rebuild's restore took 41–42 min (earlier restores 15–32 s; data the same size), most likely silent R2 stalls; a cancelled run kept writing the lake during the save (chat) | `.github/workflows/pipeline.yml`, `.github/actions/restore-r2/action.yml` |
| `PENSION` and `RETIREMENT SYSTEM` removed from `EXCLUDE_NAME_WORDS` (all home lists) | Owner: pension, provident and retirement funds have professional managers; endowments (Yale, Harvard, MIT) were never excluded (chat) | `pipeline/orca/config.py` |

- Planning: two read-only planning agents ran first, one for run speed and one for the conviction fix (chat).
- Speed finding not acted on: fund compute takes ~48 min on 1 of 4 cores; running in parallel was estimated at 17–20 min. It was not built (code: no multiprocessing in `pipeline/orca`).
- After the fix the restore took 18 s (chat). Result: last quarter 76 moves from 55 funds; 4 quarters 200 (cap) from 156 funds (chat). Tests: 717 pipeline, 345 site, 46 browser (chat).
- Deploy order: the web change waited on the branch until the rebuild had published the new files, then `main` was fast-forwarded, so the tab never pointed at missing files (chat).
- Quality issues found (chat): wealth managers at the top (Pitcairn, Fi3, Dakota, Evolution, Elk River, Laurel, Falcon); spin-off receipts read as buys (Meyer Handelman "New" Honeywell Aerospace $424M); non-stocks (an Alibaba convertible bond); charities selling donated stock (National Philanthropic Trust −$1.75bn). Proposed name filters ("Wealth", "Planning", "Family Office", "Philanthropic", "Charitable", "Donor") or a ≤ 60-position cap; no answer (chat). A received spin-off cannot be told from a bought one in 13F data (chat).

## 2026-11-03 — Home review via artifact comments; Conviction v2 (git 2a30794, 0377f16, f1e31d6)

| What changed | Why | Files |
|---|---|---|
| Eyebrow "Quarterly 13F Data from SEC.gov", h1 "Fund Manager Research", subtitle and "who qualifies" line removed, columns renamed "AUM" and "Max Drawdown", every column sortable, 100 funds per page (1,492 funds, 15 pages), 10y and 15y tabs | The owner's 9 comments on the review artifact (chat) | `web/src/pages/Home.tsx`, `web/src/lib/sort.ts`, `web/src/components/Pager.tsx`, `pipeline/orca/config.py` `PERIODS` |
| Conviction v2: sort arrows on every home list; "Move" renamed "Buy/Sell" (New/Add/Trim/Exit kept); new "$ bought / sold" and "Price now" columns; "13F book" → "AUM" on Just filed | Owner's 3-point request (chat) | `web/src/pages/Home.tsx`, `pipeline/orca/home.py` |

- Review method: a static, commentable copy of the live site published as a private artifact (claude.ai/artifact/HeRzxwYG7YaMdzJKoFghnN) with home tabs, Berkshire's fund page, its Apple position and How it works; later every home tab got its own copy, and tab links were made to jump between copies (chat). The comments' exact text lives on the artifact, not in the chat.
- The 15y tab says no fund qualifies; SEC bulk 13F data starts in 2013, so the first 15-year results arrive in 2028 (chat)(code `web/src/pages/Home.tsx`).
- v1 listed 2,381 moves from 527 funds ranked by weight change; holding companies topped it (Woodbridge 0 → 96%, Valor 0 → 99.8%) (chat).
- v2 cut that to 152 moves from 98 funds, but 21 moves were worth more than 100% of last quarter's AUM (Woodbridge new $25.8B, 35× its AUM; Alphabet Inc. $96.6B) and pro-rata inflow top-ups counted (DMKC Advisory 5 rows) (chat). That led to v3.
- A web fix shows "—" for conviction rows published before `vs_usual` existed (git f1e31d6).

## 2026-11-02 — Monthly schedule; site live; site and data in one Cloudflare account (git 5f160a0, 49e3a54, d4cfb3f, 5fd1305, 200638e, 0b6b5f5, d82de30)

| What changed | Why | Files |
|---|---|---|
| Schedule weekly → monthly, the 16th at 06:23 UTC (17:23 AEDT) | Owner: why weekly when 13F is quarterly; weekly runs cost no Claude tokens, but "perhaps just monthly is fine" (chat) | `.github/workflows/pipeline.yml` |
| Web deploy: secrets stripped of whitespace; account id taken out of a pasted address (the 32-hex part); the Pages project is created if missing | The deploy failed on a 53-character `CLOUDFLARE_ACCOUNT_ID` with no 32-hex id in it, then on a token that lacked Pages Edit (code 10000, an R2 token reused) (chat) | `.github/workflows/web.yml` |
| `Site CORS` workflow (PutBucketCors with the R2 key) | The dashboard showed no buckets; the workflow also reports whether site and data share an account (chat) | `.github/workflows/site-cors.yml` |

- Run 13 (11-01 23:33 → 11-02 00:49 UTC): green, 13,314 funds, 74,358 files uploaded, ~80 min, memory peak ~4.5 GB of 16 GB (chat).
- First deploy skipped: the GitHub default branch was still `claude/whale-wisdom-13f-clone-wapyqz`; deploys and schedules run only from the default branch, and the `production` environment allows only `main` (chat).
- Site move: the first live deploy went to `orca-eiq.pages.dev` in the account tied to the owner's GitHub login, while the buckets were in another account. The browser blocked the data (CORS), and `Site CORS` failed with `AccessDenied` (object-only R2 token) and reported two accounts (chat). The owner made a Pages token in the data account and updated `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The project `orca` there got `orca-88p.pages.dev`, because `orca` was taken, and the owner edited the CORS origins (chat).
- Live check (chat): Berkshire Hathaway $299.3B book (Q2 2026), 100% priced, +11.6% a year over 2014–2025, best year 2019 (+40%), worst 2022 (−16%). Pershing Square shows Q1 2026 as its latest report because its Q2 filing was a 13F-NT notice.
- Owner items left (status UNKNOWN): set `ORCA_SCHEDULE_ENABLED=true`; delete the `orca-eiq` project and its `orca-pages` token in the other account; move Tiingo to a business plan before charging (chat).

## 2026-11-01 — Go-live setup and production runs 1–13 (git 8c78d68 … 5fba6af)

Setup by the owner, step by step (chat): `main` created from the feature branch and pushed (02:43–02:50 UTC); a Pages direct-upload project with a placeholder zip (not Git-connected, because the workflow builds with data and prerender settings); R2 buckets `orca-lake` (private) and `orca-site` (public, Standard class, `r2.dev` URL); CORS; the `production` environment restricted to `main`; 9 secrets; variables `R2_LAKE_BUCKET`, `R2_SITE_BUCKET`, `VITE_DATA_URL` (the bucket's `r2.dev` URL). `ORCA_SCHEDULE_ENABLED` was left unset during the first load so a scheduled run could not clash with manual ones.

| Run | Result | Cause and fix |
|---|---|---|
| 1 | failed after 13 s | rclone treats every `RCLONE_*` env var as its own option; the install variables became `ORCA_RCLONE_*` (git 8c78d68) |
| 2–3 | R2 refused | `R2_ACCESS_KEY_ID` had the right length (32) but wrong characters (a capitalised first letter); the run now names the malformed secret (git 42b7a83, 0c9ce94); the owner re-pasted it (chat) |
| 4 | failed | stray whitespace in the R2 secrets; stripped before rclone runs (git 581d906). Exact error UNKNOWN |
| 5 | green: 13,314 funds, 53,270 files, upload ~75 min | but 0 tickers: CUSIP mapping failed and the log said nothing. Cause UNKNOWN (run 7 mapped fine). Health flags are now printed and `check-keys` tests OpenFIGI, Tiingo and FRED first (git 6208659; `pipeline/orca/run/preflight.py`) |
| 6 | failed in restore | R2 hands `manifest.json` back decoded, so its size did not match; `copyto --ignore-size --ignore-checksum`, and the reader accepts plain JSON (git 00ac498) |
| 7 | green: 43,152 CUSIPs mapped, 41,043 stocks, 13,098 funds | only 48 stocks priced: the Tiingo free plan's 50 requests/hour; the owner upgraded to the paid personal plan. Uploads now go 64 at a time with no HEAD (git d4b9a58) |
| 8 | prices for ~4.5 h, ~39,000 stocks | 19,222 of 40,268 tickers asked came back empty (chat) |
| 9 | runner lost at 4.5 h, price work lost | likely out of memory. The price stage now stops with 90 min left and asks stalest first; `oom_score_adj 1000` kills the pipeline, not the runner, so the lake is still saved; resource log (git 952fa15) |
| 10 | old code; progress saved | — |
| 11 | vendor universe working: 22,315 stocks with a Tiingo ticker, 1,185 repaired, 18,728 skipped; 1,188 stocks asked (8 min vs ~2.6 h); compute 50 min, peak 3.8 GB | the runner then "received a shutdown signal" before upload (git 8155ed7, 97f3e4b) |
| 12 | died just after compute | `latest_closes` loaded ~70 million bars; it now reads only each stock's last 14 days of bars (git 5fba6af; `LATEST_CLOSE_WINDOW_DAYS`) |
| 13 | green | on the public repo's 16 GB runner (see 11-02) |

- Repo made public (22:03–23:10 UTC) for free Actions minutes and the 16 GB / 4-core runner; the private 8 GB runner was too small (chat). Checked first: no keys in code or history, commits authored "Claude <noreply@anthropic.com>", the lake stays private, forked PRs get no secrets; fork PR workflows set to "Require approval for all external contributors" (chat).
- The owner asked whether weekly price bars would be faster. No: Tiingo returns a stock's whole history in one request either way, and daily bars feed the quarter VWAP, dividends and splits (chat).
- The owner asked to price only stocks funds own. That was already the case: the 41,043 are every stock any 13F filer held since 2013 (chat).
- The empties were Orca's bug: OpenFIGI drops a delisted stock's US ticker, so the pipeline took a foreign listing's ticker (`XLNXEUR`, `TWTRUSD`). Big past holdings (Twitter, Xilinx, Activision, Celgene) had no prices (chat). Fix: Tiingo's `supported_tickers` list, currency-suffix repair, and a ticker counts only if it traded while the fund held the stock (`FB` today is not Facebook) (code `pipeline/orca/vendor.py` `candidates`, `resolve`).
- About 1,000 `price_mismatch` flags, often exactly 1000×: filers reporting thousands of dollars instead of dollars (chat).
- About 29,000 CUSIPs in filings are invalid (often a dropped leading zero); they stay unmapped (OpenFIGI error → method "error", code `pipeline/orca/securities.py`), because a repair could match the wrong stock (chat).
- Cost Q&A (chat): R2 free tier is 10 GB storage, 1M writes and 10M reads a month, with free egress and no hard spending cap. A leaked R2 key is the only realistic route to a big bill. Avoid the Infrequent Access class. Estimated data 6–18 GB; a full rebuild uploads ~70,000–100,000 files.
- FRED key request: one series (DTB3) as the Sharpe/Sortino risk-free rate; the drafted reason mentions a possible public site (chat).
- Tiingo: the paid personal plan (~10,000 requests/hour; default 2.5/s) most likely does not cover a public site; business plan before commercialising, owner's call (chat).
- Times: the owner is in AEDT (UTC+11); replies from 11-01 give AEDT times (chat).

## 2026-10-31 — Pipeline fix wave, website build (Plan B), rulings (git f5bbe2a … b8c9864)

| What changed | Why | Files |
|---|---|---|
| Fix wave after the final pipeline review: `run.py` split into `orca/run/` with a streaming full recompute; time budget, numbered price parts, lake saved after any run; transient failures retried; ticker changes followed; `latest_prices.json` dates each close and exits within 8 quarters refresh; first reports are no moves; brotli 9 (git 25f5764, d514a4d, 9856863, 6db0639, 18a2e41, 0976d36, 6ec0818) | Review verdict "ready with fixes": a full recompute would run out of memory, the first run could not finish in GitHub's 6 h job limit and lost progress on failure, short outages became permanent gaps, stale prices looked current, first reports counted as buys (chat) | `pipeline/orca/run/*`, `pipeline/orca/prices.py`, `pipeline/orca/publish.py` |
| Website T1–T8 against demo data (git adfff7a … e63e1c6); final-review fixes: What drove capped at 15 + 15 + "N other stocks" with Show all, route-aware tab titles (git 4523ef0, 2b5c9ab) | A 16,000-stock fund drew ~500 screens of bars; the tab title stuck on the first fund (chat) | `web/` |
| Pipeline T14 (weekly orchestrator, incremental recompute, demo data) and T15 (schedule, CI, golden test) (git 3ae1b4a, 65f4fd0, ab2e0b4) | Plan A | `pipeline/orca/run.py` (later `run/`), `.github/workflows/{pipeline,ci}.yml` |
| Rulings R1–R33 and deferred findings logged (git b8c9864) | Taken by the controller during subagent-driven execution, with no owner review ("I settled 16 conflicts in the website plan on my own, all logged") (chat) | `docs/superpowers/2026-10-31-orca-rulings-and-backlog.md` |

- Note added 2026-11-10: the "golden test" in this entry is the harness `pipeline/tests/test_golden.py` (network, needs keys). No snapshots were ever committed (`pipeline/tests/golden/` holds only `.gitkeep`), so it fails when run until a person hand-checks and commits them (ROADMAP D1). The "exits within 8 quarters" above is also outdated: `EXIT_REFRESH_QUARTERS = 6`.

- 671 pipeline tests after the fix wave; final: 680 pipeline (1 skipped), 339 web unit, 46 browser (chat).
- actionlint and shellcheck were blocked by the session's permission policy; the owner switched the mode to approve one run, and both found 0 errors (chat).
- A container restart lost the first website T1 attempt; it was re-dispatched (chat).
- Another session (branch `claude/nifty-hamilton-zf99ry`) fixed parked residuals N1–N4 (git d076e16 … 65b9354); they were merged here without this run's reviewers checking them (chat).
- Not proven at the end: SEC column names against live data (sec.gov was blocked in the session) and a real deploy (chat).

## 2026-10-30 — Brainstorm, spec, plans, pipeline T1–T13 (git aaff236 … 69cf440)

- 01:22 UTC: session started with `/superpowers:brainstorming` on "a clone of whalewisdom.com" presenting 13F data differently: returns, entry/exit prices, fresh capital, fund style, sector rotation, sector-relative skill, post-exit returns (chat). sec.gov, whalewisdom.com and gurufocus.com were blocked in the session; research went through web search and curl (chat).
- Ideas grouped A–D (fund P&L, fund DNA, market flows, skill). The owner ranked them: fund P&L, then skill scores, then sector rotation; market flows optional (chat). The owner's market-flow idea (13F volume vs total volume to infer retail share) was recorded as a lower bound only, with FINRA OTC data as a retail proxy that likely needs a licence (chat).
- Product and data decisions taken that day are in DECISIONS (2026-10-30 entries).
- Clickable mockup of home, fund, position and method pages: claude.ai/artifact/YbADtEdgNYE7NUm3L7vSUF, copied to `docs/superpowers/specs/2026-10-30-orca-mockups.html` (chat).
- 07:24 spec `docs/superpowers/specs/2026-10-30-orca-fund-pnl-design.md` (git aaff236); 12:05 plans A (15 tasks) and B (8 tasks) (git a89449b). The owner chose subagent-driven execution (chat). Pipeline T1–T13 landed the same day.
- Agents for T8 and T14 stopped on the 5-hour usage limit and were restarted after "Continue" / "Try again" (chat).
