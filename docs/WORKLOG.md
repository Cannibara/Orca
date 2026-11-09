# Worklog

Last verified: 2026-11-09

Reverse-chronological. Tags: (chat) = said in a working session, (code) = checked in the code,
(git) = from commit history. "PR #n" = github.com/Cannibara/Orca/pull/n. Append new entries at the top.

## 2026-11-09 — LLM context layer

| What changed | Why | Files |
|---|---|---|
| Added `CLAUDE.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/WORKLOG.md`, backfilled from this chat, the code and git log (chat) | Future sessions onboard from a few files instead of scanning the codebase (chat) | the five files above |

Open issues: chat history of the 2026-10-30..11-06 sessions was not available; those entries come from git and the rulings doc only. A prompt was handed to the owner to backfill them from that chat (chat).
Owner clarified: holdings are quarterly, prices refresh monthly; added "Data cadence" to `docs/PRODUCT.md` (chat).

## 2026-11-09 — Domain move, hardening, SEO (PR #2 merged, PR #3 open)

| What changed | Why | Files |
|---|---|---|
| PR #3 (open, not merged): HSTS `max-age=15552000`, `X-Robots-Tag: noindex` on `*.pages.dev`, canonical link + `sitemap.xml` + `robots.txt` when `SITE_URL` is set, `dist/demo-data` removed when `VITE_DATA_URL` is absolute (git 006b9d8)(code) | Optional follow-ups the owner asked for ("make the improvement changes") (chat) | `web/scripts/prerender.mjs`, `web/scripts/siteUrl.ts`, `.github/workflows/web.yml`, `docs/domain-and-data-hosting.md` |
| PR #2 merged (27f7be6): build-generated `dist/_headers` (CSP naming the data origin, nosniff, referrer/permissions policies, `frame-ancestors 'none'`, 1-year immutable `/assets/*`), self-hosted fonts, data-host preconnect, cache purge after pipeline upload + manual `Purge cache` workflow, CORS default origins (git)(code) | Move to `www.orcaetf.com` + cached data host `data.orcaetf.com` (chat) | `web/scripts/prerender.mjs`, `web/scripts/dataOrigin.ts`, `web/vite.config.ts`, `web/src/fonts.css`, `.github/workflows/{pipeline,purge-cache,site-cors}.yml` |
| Cloudflare/GitHub settings done by the owner: `www` primary, bare 301 redirect rule, R2 custom domain `data.orcaetf.com` on bucket `orca-site`, cache rule (edge 1 month, browser 2 hours), DNSSEC, SPF `-all` + DMARC reject, purge token `CF_PURGE_TOKEN` + `CF_ZONE_ID`, `SITE_ORIGINS`, `VITE_DATA_URL=https://data.orcaetf.com` (chat; DNS/headers checked with curl) | Speed (CDN cache, no r2.dev rate limit) and security | Dashboard only; recorded in `docs/domain-and-data-hosting.md` |
| R2 CORS policy for `orca-site` set by hand in the dashboard (chat) | `Site CORS` workflow failed: `AccessDenied` on PutBucketCors, R2 token has object rights only (chat, run 42600509949) | — |
| Verified live after deploy (Web run #51): CSP with `https://data.orcaetf.com`, preconnect, immutable assets, bundle uses only the new data URL, `Purge cache` run green, cache MISS→HIT per Origin (chat) | — | — |

Open issues: PR #3 awaits the owner's "merge"; after merge check `strict-transport-security`, `/robots.txt`, `/sitemap.xml`, `x-robots-tag` on pages.dev (chat). Owner may switch off the bucket's `r2.dev` address after a few days (chat). Site CORS workflow still fails until an R2 token with Admin Read & Write exists (chat).
Next: merge PR #3 on the owner's word; decide purge scope (`purge_everything` vs host) (chat).

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

## 2026-11-01..06 — Production runs and owner review (git; chat history of these sessions not available)

- 2026-11-06 Home: "Just filed" tab dropped (file still published); wide tables fit from 1180 px (git 2f6a77a, 85ec00a).
- 2026-11-03..05 Conviction v2 → v3 → flow-adjusted moves; `conviction_q.json` / `conviction_y.json`; `python -m orca.run home` republishes home lists only (git 0377f16, 5122d70, 79d8628).
- 2026-11-03 Home review: 10y/15y periods, sortable lists, pager (git 2a30794).
- 2026-11-02 Pipeline monthly on the 16th instead of weekly; Site CORS workflow; site moved to the bucket's account (`orca-88p.pages.dev`) (git 49e3a54, 0b6b5f5, d82de30).
- 2026-11-01 Vendor-ticker resolution (19,222 of 40,268 tickers came back empty); time budget keeps 90 min for funds; OOM protection (git 8155ed7, 952fa15).

## 2026-10-30..31 — Spec, plans, pipeline (Plan A) and website (Plan B) builds (git)

Spec `docs/superpowers/specs/2026-10-30-orca-fund-pnl-design.md`, plans in `docs/superpowers/plans/`, rulings and deferred review findings in `docs/superpowers/2026-10-31-orca-rulings-and-backlog.md` (R1–R33). Pipeline T1–T15, website T1–T8, CI and Pages deploy (git aaff236 … 2b5c9ab).
