# Orca build: rulings and deferred backlog

Decisions taken on the owner's behalf while executing the pipeline plan (Plan A) and the website plan (Plan B), in the order they were made, each with what it costs if wrong. Then every review finding that was deferred rather than fixed, for later triage.

## Rulings: pipeline (docs/superpowers/plans/2026-10-30-orca-pipeline.md)

- work directly on the user-designated feature branch instead of a new worktree — the session's instructions fix this branch for all work — cost if wrong: none beyond branch history.
- (1) T6 select_reports keeps the bulk row when the same accession exists from both "bulk" and "live" sources — spec §4.1 step 2 says bulk replaces live-parsed rows — cost if wrong: duplicate holdings for a quarter until fixed.
- (2) T4 step 5 and T15 step 2 run only if www.sec.gov/data.sec.gov/OpenFIGI/Tiingo/FRED are reachable and keys exist; otherwise implementer records "unverified/skipped" in the commit — network is blocked in this environment — cost if wrong: SEC column names unverified until owner allows hosts.
- implementer commits keep the attribution trailer their own harness supplies (not the controller's model) — the subagent wrote the code — cost if wrong: cosmetic commit trailers.
- T3 3xx responses raise FetchError (no retry, Location in detail) instead of following redirects — following would bypass the rate limiter and forward custom headers — cost if wrong: callers must use canonical hosts (www.sec.gov, data.sec.gov).
- secrets never travel in URLs that reach FetchError/health.json — Tiingo key goes in the `Authorization: Token <key>` header (T8); FRED requires `api_key` in the query, so T9 must catch FetchError and re-raise with the query stripped, and T14 strips query strings from any URL written to health.json (which is published) — cost if wrong: leaked API key in a public file.
- T4 parser drops (and counts via optional stats=) bad rows/filings instead of raising; raises only on structural problems (missing TSV member/header) — spec §8 says bad input is logged, never stalls a run — cost if wrong: silent data loss is visible only in health counts.
- T6 tail carry kept (fund that filed last_q−1 but not last_q gets last_q carried); T14 passes last_q = latest quarter whose 45-day deadline has passed (q_end + 45 days ≤ today), and T13's fund "period"/"filed" use the latest FILED (not carried) quarter — spec §5.7 one missed quarter = unchanged — cost if wrong: a late filer briefly shows carried holdings for one quarter.
- T7 shares outstanding = companyconcept dei endpoint; latest end → latest-filed accn → drop exact duplicates → SUM classes — multi-class issuers otherwise undercounted (market-cap gate) — cost if wrong: occasional double count if SEC repeats a class fact under different fp/form in one filing.
- T7 tickers normalised to SEC style (BRK/B→BRK-B) and a no-figi row adopts the figi key of a same-ticker row — prevents two stock_ids for one issuer — cost if wrong: rare wrong merge when two issuers share a ticker over time (reused tickers).
- T8 update_prices is fail-soft per ticker (stats failed/empty/fetched/stopped), flushes every 500 tickers, circuit-breaks on 401/403/429 or 25 consecutive failures — spec §8 — cost if wrong: a broken vendor week stores partial prices (flagged in health).
- T8 a new day with split_factor != 1 counts as "changed" (ratified) — a split re-bases history and must trigger fund recompute — cost if wrong: extra recomputes.
- Tiingo rate configurable via TIINGO_RATE_PER_SEC, default 2.5/s — assumes the paid ~10k req/hour plan — cost if wrong: 429s trip the breaker; owner lowers the env var.
- T10/T14 the engine runs on each fund's LATEST tracking segment only (history before a ≥2-quarter filing gap is excluded from P&L) — keeps one PositionResult per stock — cost if wrong: older history of funds with long gaps is not shown.
- T10 a held-but-unpriced position stays out of the book until its first priced quarter, then enters at that quarter's close (first-report style); a priced position hitting an unpriced quarter keeps its previous valuation — keeps the bridge exact with no invented gains — cost if wrong: small P&L distortion for implied-price-only stocks.
- T10 check_bridge tolerance = 1e-6 × max(1, |end|, |start|, buys + sells) (amends plan's 1e-6 × max(1, end)) — the plan's rule falsely fails full sell-offs of $2B+ books and would abort T14 — cost if wrong: a real tiny bridge error on a large book could pass.
- T10 quarter ret is None when start <= 0 (as well as segment-first quarter / denominator <= 0) — avoids invented 0% quarters — cost if wrong: one fewer quarter in a fund's return series.
- T12 FundSnapshot.trades_latest is list[(stock_id, Trade)] (Trade carries no stock id) — T14 builds it as [(p.stock_id, t) for p in positions for t in p.trades if t.q == last_q] — cost if wrong: none (internal shape).
- T12 index giants are excluded from calls (only top-eligible non-giants or concentrated funds) — giants' inflow adds would flood the list — cost if wrong: giants' genuine calls missing.
- T12 conviction_moves, wins_losses and crowded_buys use only snapshots whose period_q == max period_q — spec says "latest quarter" — cost if wrong: late filers appear only once they file.
- T12 latest-quarter anchor is an explicit latest_q (T14 passes the latest quarter whose 45-day deadline has passed); fallback = max period_q of non-excluded snapshots — an early filer must not empty every list during filing season — cost if wrong: early filers' moves appear only after the deadline.
- T13 publishes to STABLE public paths (funds.json, fund/{id}/…); the "version folder" is local staging of changed files only; manifest.json (version, built, checksums) is uploaded last and is the diff base for the next run — per-run full version trees would defeat upload-only-changes — cost if wrong: a reader mid-upload may briefly see a mix of old and new files.
- T13 weekly.json keeps calendar alignment — start = Friday of the first week, one close per calendar week, null for empty weeks (overrides my earlier "skip gaps" ruling, which made the series unplaceable) — cost if wrong: slightly larger files.
- T13 write_health(staging, stats) returns {"health.json": sha} (interface change confirmed); prices rounded to 4 dp at publish (weekly, latest_prices, trade px/low/high).
- T15 uses TWO R2 buckets — a private lake bucket and a public site bucket — the lake holds CUSIPs, which must never be public — cost if wrong: none.
- final fix wave covers C1, C2, I1–I6 plus cheap minors (cap calls lists, word-boundary exclusion, SUBMISSION dedupe) in ONE dispatch; run.py split into an orca/run/ package as part of the C1 refactor — reviewer recommends doing both together — cost if wrong: larger diff to re-review.
- I5 contract change — latest_prices.json gains a per-stock `date` column; weekly price refresh covers stocks held in the latest quarter plus stocks exited within the last 8 quarters; older exits keep their last price with its date shown — keeps the what-if figures honest without unbounded vendor calls — cost if wrong: very old exits show dated prices.
- real and load-bearing for production, but nothing is deployed yet and the skill allows no second fix wave; queued as a follow-up task and must be fixed before the first production run (recommended fix: reconcile lake published.json with the site manifest at run start and mark differing funds/stocks pending) — cost if wrong: stale/missing fund files on the site after a failed upload.
- rare (bulk data starts 2013); fold into the same follow-up — cost if wrong: phantom trades for funds whose segment starts before 2013.
- minor/edge; same follow-up — cost if wrong: wasted budget / stalled live ingest until fixed.

Note: the four parked pipeline residuals (N1 failed upload left published.json claiming files, N2 pre-2013 share splits, N3 budget-stopped empty tickers, N4 refused filing download) were fixed by commits d076e16..65b9354 from another session and merged here; pipeline tests 680 passed, 1 skipped.

## Rulings: website (docs/superpowers/plans/2026-10-30-orca-website.md)

- work directly on the user-designated feature branch — session instructions fix this branch — cost if wrong: none beyond branch history.
- R2 port the mockup's niceTicks verbatim (steps 1/2/2.5/5/10) and correct T3's test to niceTicks(-3.2, 7.9, 5) → [-5, -2.5, 0, 2.5, 5, 7.5, 10] — the user approved the mockup's charts; the plan's expected list contradicts the function it says to port — cost if wrong: cosmetic axis steps.
- R3 money(usd) uses the mockup's thresholds in dollars (≥$10B 1 dp B, ≥$1B 2 dp B, ≥$10M rounded M, ≥$1M 1 dp M) and adds: ≥$10K → rounded thousands "$340K"; <$10K → rounded dollars with commas "$1,110" — mockup has no rule below $1M, T6 asks for "$1,110" — cost if wrong: cosmetic.
- R4 home types follow the contract: TopList {latest_q, period, eligible, giants}, RowsFile<T> {latest_q, rows} (conviction, just_filed, crowded, calls_q, calls_y), WinsLosses {latest_q, wins, losses}; plan's single HomeList is replaced — contract is the source of truth — cost if wrong: none (types only).
- R5 priceMap(lp) holds every non-null price (stale ones too: a delisted stock's last close is the best value it has); priceDates(lp): Map<number,string> is also exported and the Position page shows "Latest price $X · {date}" so a stale close is visible; tables do not mark staleness — contract says show a price as current only when its date is recent — cost if wrong: a stale close in a table cell may read as current.
- R6 Weekly.close and PriceChart `closes` are (number|null)[]; the line breaks at nulls (no carry-forward) — contract — cost if wrong: none.
- R7 Best & worst calls: "Best" = rows sorted by live % since the fund's buy, descending; "Worst" = ascending; both over every row in the file — the file already holds the 50 best + 50 worst at build time — cost if wrong: order can drift from the build-time cut as prices move.
- R9 IRR (actual and if-held) excludes dividends; totalPnl/returnPct include them as the plan says — positions.json has no dividend timing — cost if wrong: IRR slightly understated for dividend payers.
- R10 trade flow at t = q/4 + 0.125 is −delta × px (buys negative, sales positive); positionFlows adds sharesNow × price at nowT when sharesNow > 0 and returns [] (→ IRR "—") when sharesNow > 0 and price is unknown; heldFlows keeps only buys (delta > 0) plus a terminal (Σ bought shares) × price at nowT, [] when price is unknown — plan names the functions but not the terms — cost if wrong: IRR figures off; fix is local to live.ts.
- R11 DataTable (T4) implements `virtual` with @tanstack/react-virtual; jsdom has no layout, so the virtualizer takes an initialRect / fixed row-height estimate and T6's test asserts 0 < rendered rows < 100 — a test that passes on zero rows asserts nothing — cost if wrong: none.
- R12 do not create public/_redirects; rely on Cloudflare Pages' single-page-app fallback (no top-level 404.html in dist) — Pages rejects `/* /index.html 200` as an infinite loop and the fallback already serves index.html for unknown paths — cost if wrong: deep links to non-prerendered routes 404 on Pages until a rule is added.
- R13 prerender writes pages for the PRERENDER_MAX (default 15000) largest funds by book — Cloudflare Pages caps a deployment at 20,000 files and funds.json can list every 13F filer since 2013 — cost if wrong: smaller funds have no pre-rendered SEO page (they still work as SPA routes).
- R14 default selected year = String(metrics.last_year) when it is a label in years.label, else the last label — "latest full year" — cost if wrong: cosmetic.
- R17 production data lives on the public R2 site bucket (another origin): no code change; owner adds an R2 CORS rule allowing GET from the Pages domain — surfaced at finish — cost if wrong: the live site cannot load data until the rule exists.
- R18 profitablePct = share of positions with totalPnl > 0 among positions whose totalPnl is computable (null excluded) — plan gives no denominator — cost if wrong: small % shift.
- R19 T6 may modify Fund.tsx to mount <FundTables> below the charts — the plan's file list omits the mount point — cost if wrong: none.
- R20 exits table joins positions.json by stock_id for avg cost, return, IRR actual, IRR if held, last change, last change $ — exits.json lacks them — cost if wrong: none.
- R16 leave public/demo-data in the production dist (0.9 MB, ~80 files) — harmless and useful as a demo; excluding needs build config — cost if wrong: 0.9 MB of fictional data publicly reachable under /demo-data.
- R21 profitablePct returns number | null (null when no position has a computable total) instead of the plan's number — a fund whose every position lacks a price has no meaningful % — cost if wrong: none (tile shows "—").
- R22 Task 2 adds positionRows(p: Positions): PositionRow[] (toRows + trade tuples → Trade objects) and tradeT(q) = q/4 + 0.125 in live.ts — every consumer needs both; the plan names Trade and PositionRow but no converter — cost if wrong: none.
- R23 a fund's own SPY/ETF holding is shown like any stock; "no SPY" forbids SPY benchmark columns/rules only — spec §7.1 "No SPY column" is about the benchmark — cost if wrong: none (an ETF row reads as a holding).
- R24 Annual returns chart plots only years whose `ret` is non-null; year chips list every contrib.years label so partial years stay selectable for "What drove" — ColumnChart takes number[] — cost if wrong: a partial year without a chained return has no bar.
- R25 What-if tiles: "Sold too early" = money(Σ positive missed); "Losses dodged" = money(|Σ negative missed|) shown unsigned; buys vs sells tile reads "Sells were smart" when sells_12m < buys_12m, "Sells were costly" otherwise, "—" when either is null — plan names the tiles but not signs or the comparison — cost if wrong: tile wording.
- R26 Every-stock stat tiles: realised = Σ realised; unrealised = Σ live unrealised (unpriced skipped); avg winner / avg loser = mean returnPct over positions with total > 0 / < 0; $ won per $ lost = Σ positive totals ÷ |Σ negative totals| ("—" without losers); best / worst = position with the highest / lowest total P&L (ticker + money) — plan lists tiles without formulas — cost if wrong: tile values; local to FundTables.
- R27 Last change keeps the mockup's quarter suffix on "New"/"Sold all" ("New Q2 2026") instead of the controller's bare label — the mockup is the approved visual reference — cost if wrong: cosmetic.
- R28 Position page loads the fund's summary (cached) for the back-link name and the StepChart endQ = summary.period_q for an open position (to_q for a closed one); a missing weekly.json (NotFoundError) shows "No price history" instead of not-found — the plan's consumer list omits loadSummary, and the contract says a stock with no priced day has no weekly file — cost if wrong: one extra cached fetch.
- R29 an unknown fund is decided by funds.json (loadFunds index), an unknown stock by the fund's positions; Fund.tsx switches to the same index check — SPA fallbacks can answer a missing JSON with index.html 200, so 404 alone is not a reliable signal — cost if wrong: none.
- R30 pin @playwright/test 1.63.0 to match the pre-installed Playwright/Chromium; locally launch with executablePath from PW_CHROMIUM; CI runs `npx playwright install --with-deps chromium` — the environment's browser only matches its own Playwright version — cost if wrong: none.
- R31 the deploy job uses the GitHub `production` environment (restricted to the default branch) for CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, and fetches funds.json with `curl --compressed` (files are brotli-encoded) — matches Plan A's secret scoping — cost if wrong: owner adds the two secrets to `production`.
- R32 "What drove {year}" draws the 15 largest and 15 smallest contributions plus one "{N} other stocks" row carrying their summed points (caption sum stays exact), with a "Show all {N}" toggle that lists every stock in a virtual DataTable — spec §7.2.6 says every stock, which buries the page for a 4,000-position fund (112,000 px) — cost if wrong: users see 31 bars by default instead of every stock (all still reachable).
- R33 fix wave also takes the cheap same-batch minors the final review named (sign after rounding, svg role="group", dismissable search, Unrealised "—" when nothing priced and neutral colour at $0, plurals/thousands separators, engines + .nvmrc, error boundary, workflow_dispatch on web.yml, smoke on /how-it-works and a not-found URL, Playwright report upload on failure); the rest stay deferred — one fix wave only — cost if wrong: deferred minors remain as listed.

## Deferred review findings: pipeline

- Task 1: minor (deferred): pyproject pytest pythonpath=["."] redundant with editable install
- Task 1: minor (deferred): PERIODS is a mutable module dict (as specified) — don't mutate downstream
- Task 2: minor (deferred): manifest "atomic" test doesn't prove atomicity; no zstd assertion test; roundtrip test sorts instead of checking part order
- Task 2: minor (deferred): Manifest.save no fsync / mode 0600; Lake.read unions table.parquet + table/ parts; no guard on part names ('/', '..', '')
- Task 3: minor (deferred): UnsupportedProtocol retried as network error; DecodingError escapes un-wrapped; no close()/context manager; rate_per_sec<=0 unchecked; make_client helper duplicated setup
- Task 3: minor (deferred): query re-encoded (%20→+); FetchError.url now carries full query
- Task 4: minor (deferred): error messages lack ZIP/accession context (partly addressed by fix round); list_bulk_zips returns [] silently on a page redesign (T14 should flag 0 ZIPs in health); INFOTABLE peak memory ~1.4 GB per 3M rows; tautological COLUMNS test; polars has no version floor
- Task 4: minor (deferred): NaN/inf VALUE kept (no is_finite check); padded numeric fields drop instead of strip; duplicate SUBMISSION rows would double holdings; long lines
- Task 5: minor (deferred): dropped-index-line count untested; dropped lines not logged; INFO_FIELDS/FILINGS_SCHEMA duplicate bulk definitions; holdings collected as Python dicts (memory); parse_infotable_xml unused in production
- Task 6: minor (deferred): raw_holdings issuer/title strings carried through joins (memory); long lines
- Task 6: minor (deferred): live-without-source check false-positive when a bulk copy supersedes the live accession; fill_gaps assumes holdings ⊆ filed_quarters (caller contract, T14)
- Task 7: minor (deferred): name-matched rows always is_etf=False; duplicated handler in test_http
- Task 7: minor (deferred): reused ticker can attach a new name-matched security to a retired stock_id; test for ticker-only existing row + figi row rewritten (coverage gap); cusip_map rebuild must join on the stock key (T14)
- Task 8: minor (deferred): compaction hard-codes Lake path layout (add Lake.delete_part); non-atomic overwrite of y/z parts; duplicated dedupe expression; untested compaction-crash claims
- Task 8: minor (deferred): flush_every=0 ZeroDivisionError; bad-split bars only logged not counted; first backfill rewrites one z part ~12× (peak ~1–1.5 GB)
- Task 9: minor (deferred): rf docstring lacks year-to-date note; no Q1-2013 (q=0) anchor test in quarter_px; monthly_vwap None semantics only in a comment
- Task 10: minor (deferred): test helpers build QuarterPx with low/high None while vwap/close set (harmless)
- Task 11: minor (deferred): avg_exit recomputed in whatif (duplicate of PositionResult.avg_exit); implicit fall-through of non-buy trades to sells; BASE_YEAR + q//4 duplicated (expose quarters.year_of); no unsorted-input test for performance; turnover KeyError if years/quarters mismatched
- Task 12: minor (deferred): _concentrated sorts all weights before cheap checks (use heapq.nlargest)
- Task 13: minor (deferred): _write_all serialises during the write loop; health int() truncation; test_manifest_written_last can't fail (real ordering test lives in T14)
- Task 13: minor (deferred): home-row est_price not rounded to 4 dp; publish.py docstring references "Task 12"
- Task 14: minor (deferred): is_excluded_name substring-matches "BANK" inside words (e.g. "DRIFTBANK") — word-boundary match later
- Task 14: minor (deferred): spec §9 "weights sum to ~100%" invariant not checked; no run-level tests for a re-pulled live filing or live→bulk arrival; small crash window between write_manifest and fund_state writes; verify builds holdings for every fund; demo.py globals/broad except/unchecked unlink; test_run.py adds ~40 s
- Task 14: minor (deferred): shares outstanding not refreshed for recovered stocks; pending_all run doesn't republish all weekly files / un-merge manifest like a full run
- Task 15: minor (deferred): cron strings duplicated in `if:` conditions and on.schedule (must be edited together); verify job gating by cron string
- Task 15: minor (deferred): golden isclose also applied to int/int pairs; abs_tol 0; bucket names must be repository variables
- Final review: parked — N1 lake saved after a failed/cancelled upload with published.json + cleared pending sets, so lost uploads are never redone — Ruling: real and load-bearing for production, but nothing is deployed yet and the skill allows no second fix wave; queued as a follow-up task and must be fixed before the first production run (recommended fix: reconcile lake published.json with the site manifest at run start and mark differing funds/stocks pending) — cost if wrong: stale/missing fund files on the site after a failed upload.
- Final review: parked — N2 pre-2013 report periods lose split adjustment (split_factors_by_quarter starts at q=0) — Ruling: rare (bulk data starts 2013); fold into the same follow-up — cost if wrong: phantom trades for funds whose segment starts before 2013.
- Final review: parked — N3 budget-stopped price run re-asks empty tickers first; N4 a single refused filing download stalls the live stage with no give-up — Ruling: minor/edge; same follow-up — cost if wrong: wasted budget / stalled live ingest until fixed.
- Final review: parked (out of scope) — latest_closes reads the whole price table; state.json owed-work entries saved before data writes; storage.py stale comment; brotli-9 switch re-uploads every file once.

## Deferred review findings: website

- Task 1: minor (deferred): sign taken from unrounded value — money(-0.4) "−$0", pct(-0.0001) "−0.0%", pp(-0.04) "−0.0 pts" (format.ts sgn)
- Task 1: minor (deferred): tests' bare MemoryRouter lacks main.tsx v7 future flags; setup.ts filter hides the notices — keep aligned in T4–T8
- Task 1: minor (deferred): routing untested in committed code — T7 owns route/not-found tests
- Task 1: minor (deferred): src/vite-env.d.ts redundant with tsconfig types vite/client
- Task 2: minor (deferred): in-flight dedup untested (await Promise.all two loads → fetch once); NotFoundError.url/.name unasserted (api.test.ts:650)
- Task 2: minor (deferred): demo reconciliation tolerance toBeCloseTo(-2) too loose; nowT hardcoded 13.8 (live.test.ts:1003,1023)
- Task 2: minor (deferred): 200 non-JSON (SPA fallback html) rejects as SyntaxError, not NotFoundError (api.ts:62) — T7 checks ids against the index first
- Task 2: minor (deferred): PositionRow repeats Positions' field list (types.ts:281)
- Task 3: minor (deferred): year-tick thinning + client→SVG x conversion duplicated in PriceChart/StepChart (mockup has same)
- Task 3: minor (deferred): click on a focusable hit target fires onFocus and parks the tooltip at the column top (Tooltip.tsx:49) — anchor only on :focus-visible
- Task 3: minor (deferred): only TooltipProvider exported (no <Tooltip>) — carried: T4 mounts it once in App.tsx
- Task 3: minor (deferred): StepChart default endQ = last change — carried: T7 passes endQ = latest filed quarter
- Task 3: minor (deferred): PriceChart crosshair and StepChart tooltip pointer-only — T7 position page must offer the trades table as the keyboard route
- Task 3: minor (deferred): svg role="img" wraps focusable hit targets (nested-interactive) — role="group" would fix; controller's decision — final review triage
- Task 3: minor (deferred): untested tooltip flip placement, PriceChart dot x vs line x, ColumnChart negative-stack rounding
- Task 3: minor (deferred): unused DEFAULT_WIDTH export; compact() lives in scale.ts not format.ts
- Task 4: minor (deferred): search dropdown not dismissable (no Escape/blur) and overlays tabs (Home.tsx:175)
- Task 4: minor (deferred): DataTable useLayoutEffect has no deps; minWidth ratchet never shrinks (DataTable.tsx:65) — pointer carried to T6
- Task 4: minor (deferred): fmtDate/ratio file-local in Home.tsx — carried: T5 moves them to lib/format.ts
- Task 4: minor (deferred): "1 positions" plural; raw counts without thousands separators (Home.tsx:192,218,365)
- Task 4: minor (deferred): h1 → h3 with no h2 (Home.tsx:246,314,316)
- Task 4: minor (deferred): securities/prices load failure errors five tabs; untested (Home.tsx:495)
- Task 4: minor (deferred): "scrolls inside its own container" test near-tautology (components.test.tsx:31)
- Task 4: minor (deferred): home tests coupled to specific demo values
- Task 4: minor (deferred): RED was a module-resolve failure (mutation checks reported)
- Task 5: ⚠️ carried: vite preview/Pages SPA fallback may answer a missing JSON with index.html 200 → SyntaxError, not NotFoundError — T7 checks ids against funds.json / positions before treating a page as found
- Task 5: minor (deferred): not-found classification matches NotFoundError by URL substring (Fund.tsx:60,442)
- Task 5: minor (deferred): Signed and securities→Map duplicated Home/Fund — carried: T6 extracts stockMap (data/api.ts) and Signed (components/)
- Task 5: minor (deferred): Fund.tsx 457 lines; toRows<YearRow> built twice (Fund.tsx:220,295)
- Task 5: minor (deferred): empty-year wording "No positions this year" misleads when denominator ≤ 0 (Fund.tsx:402)
- Task 5: minor (deferred): coverage warning explanation only in a title attribute (Fund.tsx:129)
- Task 5: minor (deferred): load errors never logged (useLoad.ts, Fund.tsx:442)
- Task 5: minor (deferred): fmtDate("2026-08") → "undefined Aug 2026"; −0.00 / −0.0% for tiny negatives (format.ts:61)
- Task 5: minor (deferred): untested: gains tooltip end-value row, series colours, priced_pct 0.8 boundary, empty-years branches, "1 holding"
- Task 5: minor (deferred): large funds — What drove draws one row per stock; positions gate the page; carried: T6 reuses Fund's parsed positionRows
- Task 6: minor (deferred): DataTable pin reset relies on identity-stable columns/rows from callers (DataTable.tsx:71-86)
- Task 6: minor (deferred): profitable share computed three times (Fund loadFund, PositionsSection, PositionTiles)
- Task 6: minor (deferred): Unrealised tile shows "$0" when nothing is priced (FundTables.tsx:192)
- Task 6: minor (deferred): add/trim with last_pct null sorts as a sale and reads "— Q1 2026" (FundTables.tsx:81)
- Task 6: minor (deferred): what-if Enter-to-open and missing-security "#id" untested; first test name carries a suffix
- Task 7: minor (deferred): quarter range "$a–$b" unspaced vs PriceChart tooltip " – " (Position.tsx:570)
- Task 7: minor (deferred): NotFound h1 "Page not found" + lede "We couldn't find that page." (says it twice) (NotFound.tsx:466)
- Task 7: minor (deferred): weekly SPA-fallback html 200 → page alert instead of "No price history" (Position.tsx:543) — production data is on R2 (real 404s)
- Task 7: minor (deferred): api/routeId tests written after code; "names the position" asserts concatenated textContent
- Task 8: ⚠️ carried to finish: Pages trailing-slash behaviour for /fund/{id}; real wrangler deploy (project `orca` must exist, production branch = repo default branch); P&amp;L escaping is correct HTML
- Task 8: minor (deferred): no engines/.nvmrc though build needs Node >= 22.18 (type stripping) (prerender.mjs:5610)
- Task 8: minor (deferred): duplicate fund ids not rejected in prerender
- Task 8: minor (deferred): missing meta/body failure branches untested
- Task 8: minor (deferred): Playwright traces/report never uploaded in CI; wrangler (~138 MB) installed in the test job too
- Task 8: minor (deferred): smoke h1 assertion repeated; no JS-disabled noscript check
- Final fix wave: re-review — 11/11 ADDRESSED, no new Critical/Important; minors: clamped others-label can clip ≥100 pts; title lags during load
