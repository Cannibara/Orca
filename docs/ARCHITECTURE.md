# Architecture

Last verified: 2026-11-28 (market caps from the code; the sector files and their publish part from the code; `spx_window` in the `home.py` row from the code; `famous_rank.csv` from the code; `fund_about` and the About step, `weekly.json` quarter-end closes, from the code; pre-2013 history from text filings; vendor-ticker repair; the `hierarchy/` row from the code on 2026-11-16; `shares_hist`, `sector_returns`, `fund_flows`, `fund_skill` from the code on 2026-11-17; workbook section from code and the 2026-11-10 spec; pipeline facts from a full read of `pipeline/orca`; web and hosting checked in code and with curl against the live site)

## Overview

```mermaid
flowchart LR
  subgraph Sources
    SEC[SEC EDGAR<br/>13F data-set ZIPs, daily index,<br/>full index + pre-2013 text filings,<br/>submissions, company_tickers, companyconcept]
    FIGI[OpenFIGI mapping API]
    TI[Tiingo daily prices<br/>+ supported_tickers.zip]
    FRED[FRED DTB3]
  end
  subgraph GHA[GitHub Actions: pipeline.yml]
    RUN[python -m orca.run weekly<br/>ingest → securities → prices → compute → shared files → About facts → publish]
  end
  LAKE[(R2 private lake<br/>R2_LAKE_BUCKET<br/>Parquet + state JSON, has CUSIPs)]
  SITE[(R2 public bucket orca-site<br/>brotli JSON per pipeline/contract.md)]
  CDN[Cloudflare cache<br/>data.orcaetf.com]
  PAGES[Cloudflare Pages project orca<br/>www.orcaetf.com]
  UI[Browser: React app<br/>computes live values]
  SEC --> RUN
  FIGI --> RUN
  TI --> RUN
  FRED --> RUN
  LAKE <-->|rclone restore / save| RUN
  RUN -->|rclone upload, manifest.json last| SITE
  RUN -->|purge_everything| CDN
  SITE --> CDN --> UI
  PAGES -->|HTML, JS, CSS, fonts, _headers| UI
```

There is no API server. The "API" is the set of static JSON files defined in `pipeline/contract.md`. The browser fetches them through `web/src/data/api.ts` (one cached promise per URL) and computes value, unrealised P&L, IRR and as-of figures (`web/src/lib/live.ts`, `web/src/fund/positions.ts`).

## Pipeline (`pipeline/orca`)

| Module | Purpose |
|---|---|
| `config.py` | thresholds (top lists, conviction, calls), `PERIODS`, `VALUE_DOLLARS_FROM`, lake/out dirs |
| `http.py` | `Client` (rate limit, retries), `FetchError`, `sec_client`, `figi_client`, `tiingo_client`, `fred_client` |
| `sec/bulk.py` | list and parse SEC 13F data-set ZIPs (`list_bulk_zips`, `parse_bulk_zip`, `raw_holdings`, `value_to_usd`) |
| `sec/live.py` | EDGAR daily index + submission `.txt` parsing (`fetch_new_filings`, `parse_daily_index`) |
| `sec/about.py` | SEC facts for the fund page's About tab: the filer's record (`data.sec.gov/submissions`: address, incorporation, former names, SIC description, tickers, newest 13F-HR(/A)) and that filing's cover (`primary_doc.xml` at the folder root: signature block, other included managers); any namespace, HTML entities decoded (`fetch_about`, `parse_submissions`, `parse_cover`; lake schema `SCHEMA`) |
| `sec/legacy.py` | pre-2013 13F filings: EDGAR full index (`fetch_index`), free-text information tables found by CUSIP check digit (`read_table`), checked against the filer's declared totals (`check_table`), per full-index quarter (`fetch_quarter`, 4 downloads at once) |
| `holdings.py` | `select_reports`, `build_holdings`, `fill_gaps` |
| `securities.py` | CUSIP → FIGI/ticker (`map_cusips`), stock ids, SIC → sector, SEC lookups |
| `vendor.py` | Tiingo ticker universe (`load_universe`, `resolve`, `candidates`) |
| `prices.py` | `TiingoSource`, incremental price store, compaction, split adjustment |
| `quarter_px.py` | quarter VWAP/low/high/close/dividends (`quarter_px`, `last_close_before`) |
| `rf.py` | FRED DTB3 yearly average (`fetch_tbill`) |
| `storage.py` | `Lake` (zstd Parquet, atomic writes), `Manifest` |
| `engine/position.py`, `engine/fund.py`, `engine/metrics.py`, `engine/whatif.py` | average-cost P&L, fund quarters/years/contributions, performance metrics, exits |
| `famous.py`, `famous.csv`, `famous_search.csv`, `famous_rank.csv` | the hand-kept Famous funds list (CIK, match word, manager, group, search keyword), the owner's popularity order (a keyword or CIK and the owner's `score`, higher first, ties in file order; ahead of any score; a typo fails the tests) and the Google Trends snapshot of its keywords (keyword, topic id, score with Warren Buffett = 100, date) for Most searched; `Sources.famous` / `Sources.search` (the demo injects its own). No run fetches Trends: `pipeline/scripts/google_trends.py` refreshes the snapshot by hand (Google has no Trends API; uses pytrends, unmaintained) |
| `home.py` | home lists (`top_funds` with its `famous` rows, `conviction_moves`, `wins_losses`, `just_filed`, `crowded_buys`, `calls`) and `spx_window` (SPY total return, dividends reinvested, annualised over each home period's window to `latest_q`: the `spx` of `home/top_{period}.json`, null for max) |
| `publish.py` | JSON + brotli writers, manifest, health; `weekly_closes` (weekly and quarter-end closes), `about_json` (the summary's `about`: street and city title-cased) |
| `workbook/` | the per-fund Excel workbook builder (see Workbook below) |
| `hierarchy/` | sector → industry → industry vertical labels for the stock-picker / sector-picker metric: `labels.txt` (source of truth), `model.py` (parser and labeller), `matching.py` (Orca security names to Damodaran's company list), `tools/` (labelling, model batches, review page). Draft, not read by the pipeline yet; see its `README.md` |
| `run/` | `cli.py` (argparse), `weekly.py` (`run_weekly`, `run_home`, `verify`), `workbook.py` (`build_workbooks`), `ingest.py`, `market.py`, `compute.py`, `publish_step.py`, `about_step.py` (`update_fund_about`), `sectors_step.py`, `state.py`, `budget.py`, `sources.py`, `preflight.py` |
| `demo.py` | synthetic offline dataset for `web/public/demo-data` |

CLI: `python -m orca.run {weekly | rebuild | backfill | home | check-keys | verify [--sample N --seed S] | workbook --fund ID [--fund ID …] [--out DIR --max-positions N] | demo [--out --plain --seed]}`. Demo data: `uv run python -m orca.run demo --plain --out ../web/public/demo-data` (from the pipeline plan; `DEMO_TODAY` 2026-10-30, 12 funds).

Env var names read by code: `ORCA_CONTACT`, `OPENFIGI_KEY`, `TIINGO_KEY`, `TIINGO_RATE_PER_SEC`, `FRED_KEY`, `ORCA_TIME_BUDGET_MIN`, `ORCA_LAKE_DIR` (default `data/lake`), `ORCA_OUT_DIR` (default `data/out`), `ORCA_NETWORK` (tests).

### Ingestion
| Item | Fact |
|---|---|
| Schedule | `pipeline.yml`: `23 6 16 * *` (the job is named `weekly` but runs monthly), `41 7 1 * *` runs `verify`; both need `vars.ORCA_SCHEDULE_ENABLED == 'true'`; manual inputs `full`, `home_only`, `backfill` (one at most; `backfill` uploads and purges nothing); concurrency group `pipeline` |
| Prices | daily bars from each stock's last stored date to today, from `prices.HISTORY_START` = 1999-01-01 for a new stock (`prices.TiingoSource`, `startDate`/`endDate`); then stage "price history": the missing years before a stock's first stored bar for stocks held before 2013 (`run/market.backfill_price_heads`, `prices.fetch_heads`, once each: `state.price_backfilled`); targets: latest-quarter holdings, SPY, exits within `EXIT_REFRESH_QUARTERS = 6`, never-fetched stocks; stalest first (`run/market.refresh_prices`) |
| About facts | after compute and the shared files, before health and the manifest (`run/weekly._update_about`): funds without a `fund_about` row first, then those whose row is out of date (the lake has a 13F-HR(/A) of the fund filed after the row's), active and bigger books first; ≤ `about_step.MAX_CALLS` = 12,000 SEC calls a run (two a fund, ~25 min at 8/s), stopped with `RESERVE_MIN` = 30 min of the budget left; a failed lookup is flag `about_failed` and never stops the run. A summary is written with the row its fund had at compute; a fund computed this run whose facts changed has its staged summary rewritten (`publish.publish_about`), one not computed is owed to the next run (`pending_funds`). First fill of ~16,100 funds: ~32,000 calls, three runs (code) |
| Timeouts | job 330 min, step 300 min; budget `ORCA_TIME_BUDGET_MIN` (default 270, `run/budget.py`); the price stage stops with `min(90, budget/3)` min left (`run/market.py` `PRICES_RESERVE_MIN`) |
| SEC | `SEC_RATE_PER_SEC = 8.0` (`http.py`); User-Agent `Orca research {ORCA_CONTACT}`, `RuntimeError` if unset |
| Others | OpenFIGI keyed 25 req/6 s × 100 jobs (anonymous 25/60 s × 10); Tiingo 2.5/s default; FRED 2/s; timeout 30 s |
| Retries | up to 4, sleeping 2/4/8/16 s, on transport errors, 429 and 5xx; other 4xx and all 3xx raise (no redirects) (`Client._request`) |
| Breakers | prices stop on 401/403/429 or 25 consecutive failures (`prices.py`); live ingest stops after 3 refused days/downloads or a 429 (`live.py`) |
| Idempotency | `ingested.json` (ZIP name → sha256; the skip check is by name only); per-quarter parts replaced by (accession, source); `state.json` pending sets are cleared only after a successful publish; `_reconcile_published` compares `published.json` with the site manifest; only changed files upload; `manifest.json` last |
| Failures | `health.json` flags (e.g. `fetch_failed`, `live_failed`, `cusip_mapping_failed`, `prices`, `tbill_failed`, `time_budget`, `price_mismatch`, `split_suspect`, `about_failed`), at most 100 per kind; `InvariantError` / `CusipLeakError` / `HealthGateError` abort before the manifest; the lake is saved after any run. Health gates (`run/gates.check_health`, called in `run_weekly` after the CUSIP scan): lake has CUSIPs but none mapped to a stock; median `priced_pct` of the active funds below `config.COVERAGE_MIN` = 0.90 (live 0.988); funds with reports were tried and none was computed (`_Funds.with_reports`; funds without a report are not counted, and not when the time budget cut the run). `run_home` is not gated |
| verify | rebuilds 50 random published funds from raw parts and compares sha256 with `published.json`, leaving out funds owed a recompute (after a backfill they differ until the next run); no API calls |

### 13F quirks handled
| Quirk | Handling (file, function) |
|---|---|
| Amendments | base = latest 13F-HR, or the latest RESTATEMENT; NEW HOLDINGS amendments filed after it are added and summed; unknown types ignored, unless the fund-quarter has no original or restatement (then the latest is the base: Kahn Brothers filed every pre-2013 report as an unmarked amendment); bulk beats live beats legacy for the same accession (`holdings.select_reports`, `_bulk_first_unique`) |
| Value units | VALUE × 1000 for filings before 2023-01-03, dollars from then (`config.VALUE_DOLLARS_FROM`, `bulk._unit_multiplier`); valuation uses shares × our price, VALUE only as a fallback price |
| CUSIP mapping | OpenFIGI (prefer `exchCode == "US"`, composite FIGI), else exact name match to one SEC ticker; a CUSIP first held before 2013 is never name-matched and, if not found, is asked again with `includeUnlistedEquities` (`securities.map_unlisted`, method `unlisted`: Enron, Lehman; a vendor code such as `8181760Q` is not kept as a ticker, and no SEC CIK lookups); ETF when `securityType == "ETP"`; retried/remapped every 28 days (≤ 2000 per run); vendor tickers resolved from Tiingo's list (`securities.map_cusips`, `vendor.candidates`) |
| Options, bonds | PUT/CALL and PRN rows are stored but only `kind == "SH"` enters P&L and pricing (`run/compute.py`); their value still counts in `priced_pct` |
| Pre-2013 (legacy) | `python -m orca.run backfill` (`run/weekly.run_backfill`): EDGAR full-index quarters 1999Q1–2013Q3 not in `state.legacy_done`, oldest first, until 40 min of the budget are left (`run/ingest.ingest_legacy`); accessions already stored from bulk/live are not downloaded; each filing's check goes to `legacy_checks/<YYYYQn>`; a quarter with failed downloads is tried once more by the next backfill, those filings only (`state.legacy_retry`); then new CUSIPs, vendor tickers and price history. Stored statuses: `ok` (entry count = coded rows, or value total within 0.5%, × 1 / × 1000 / ÷ 1000), `close` (within 2%), `unverified` (no totals declared, and no table total line that adds up: an `ok` then). Not stored: `mismatch`, `no_rows`, `empty`, `paper`, `no_period`, `download_failed`. Period from the SEC header, CIK from its first filer, amendment type from the cover's checked box. Funds touched wait in `pending_funds` for the next ordinary run. Sample of 607 (2026-11-17): 89.8% of text filings stored (spec `docs/superpowers/specs/2026-11-17-pre-2013-13f-design.md`) |
| Filing lag | latest quarter = quarter whose 45-day deadline has passed (`weekly.deadline_quarter`, `DEADLINE_DAYS = 45`) |
| Missed quarters | one missed quarter is carried (`carried=True`); a gap of 2+ starts a new segment and only the last segment is computed; `inactive` when the last filing is older than `last_q − 1` (`holdings.fill_gaps`, `compute_fund`) |
| Splits | prices split-adjusted, share counts adjusted by quarter factors; suspicious 2/3/4/5/10× changes flagged (`prices.split_adjust_prices`, `compute.split_suspects`) |
| Unpriced | a held unpriced stock enters the book at its first priced close; fallback chain last close → implied price; > 10× mismatch flagged (`engine/position.compute_position`) |
| Duplicates | SUBMISSION/COVERPAGE de-duplicated by accession; share classes summed per `stock_id` |
| Confidential treatment | UNKNOWN / not handled in code |
| Pre-2013 text tables | fixed-width, tabs, quotes, wrapped rows, one field per line, HTML; 6-2-1 spaced or hyphenated CUSIPs; 8-character CUSIPs (check digit computed) when no 9-character one validates; Berkshire-style rows repeating the CUSIP above; total and subtotal lines skipped (they add up the rows above); rows with a mistyped CUSIP or a SEDOL counted for the check, not stored; headings with SHARES before VALUE swap the two numbers; a table in dollars (median value per share > 1 in thousands) stored as dollars (`sec/legacy.py`) (code) |
| Pre-2013 unreadable quarters | a quarter the fund filed but whose text table was not stored (`legacy_checks`) is carried from the last readable quarter, at most 2 in a row (`holdings.fill_gaps`, `MAX_BRIDGED`); 3 or more start a new segment like a gap (code) |
| Splits without vendor data | before a stock's first vendor bar (q ≤ 0 only), splits are read from the filings: at least 2 holders, and half of those holding it in both quarters, report exactly k× the shares at ~1/k the price, k in 2, 3, 3/2, 4, 5, 10 or a reverse split (`splits.infer_splits`, `run/compute.Context._inferred_splits`) (code) |
| Dead companies' tickers | a stock mapped only among delisted securities (`unlisted`) takes only a vendor line that has ended (Tiingo's "T" is today's AT&T from 1984); a stock held only before 2013 gets no by-name alternate (`vendor.resolve(gone=...)`, `run/market.alternate_tickers`) (code) |
| Notice filings | 13F-NT / 13F-NT/A carry no holdings and are skipped (`sec/bulk.KEPT_FORMS`); a fund that only filed a notice shows its previous quarter (Pershing Square Q2 2026) (code)(chat) |
| Value in thousands after 2023 | some filers kept reporting thousands; ~1,000 `price_mismatch` flags, often exactly 1000× (chat) |
| Invalid CUSIPs | ~29,000 filing CUSIPs (often a dropped leading zero) get an OpenFIGI error → method "error", no name match, left out (`securities.py`) (code)(chat) |
| Delisted stocks | OpenFIGI drops the US ticker and returns a foreign listing (`XLNXEUR`, `TWTRUSD`, `EA*`, `RTN1USD`, `ZKN`). `vendor.candidates` strips a currency suffix (GBX included) or a trailing `*`, then trailing digits after one. A stock still without a vendor ticker tries, in order: `pipeline/orca/ticker_overrides.csv` (hand-checked, by CUSIP: Exxon's pre-2026 CUSIP → XOM, CenturyLink → LUMN, …), the SEC ticker of the same normalised name (exactly one SEC row; not for tickers with `-` or spaces), and OpenFIGI's US ticker with `includeUnlistedEquities` (asked once per stock, kept in lake table `figi_us_tickers`, ≤ 1000 a run). Bonds and options (tickers with spaces) only get overrides (`run/market.alternate_tickers`) (code) |
| Reused tickers | Tiingo serves a ticker's prices for whoever trades under it today, so only a ticker's current line (the one that ends last) counts, only when it overlaps the stock's held span, and not when the stock was also held during an older line that ended over 31 days before the current one began (a filer still reporting Anadarko in 2026) (`vendor.resolve`; `FB` today is not Facebook, `APC` today is not Anadarko). A stock whose vendor ticker changes or goes has all its stored bars dropped (`prices.drop_stocks`; a changed one is fetched again), its funds recomputed, and its published `weekly.json` deleted: the run lists the paths in `out/deleted.txt` and the upload step deletes them (lines checked against `stock/<id>/weekly.json`). More than 2000 lost in one run is taken for a broken vendor list: nothing changes, flag `vendor_tickers_lost` (`run/market.resolve_vendor_tickers`) (code) A stock also held from 2013 on is checked over its 2013+ span only, so its pre-2013 quarters cannot cost it today's ticker (`run/market.held_spans`) (code) |
| Holding companies and corporates | single-stock vehicles jump 0 → 96%+; filers like Alphabet Inc. report huge new stakes; book jumps from newly priced holdings or restructurings (Woodbridge $737M → $25.2bn). Conviction skips largest holding > 33% and AUM change outside ½–2× (code `home._conviction_quarter`)(chat) |
| Share-count errors | some BRK-A share counts were off 15–28× (chat) |
| Spin-offs, in-kind transfers | shares received in a spin-off or moved in kind by a wealth-management client look like trades; not separable in 13F data (chat) |

### Home lists and conviction (code)
- Each fund snapshot (`home.FundSnapshot`) carries `conviction_quarters`: `ConvictionQuarter` records for its last 8 quarters (`q, start, end, top_prev, n_held, filed_pair, moves[(stock_id, kind, usd, w_prev, w_after, px)], flow`), built by `run/compute._conviction_quarters`. A move under `CONVICTION_KEEP` (1% of the smaller of start and end AUM) is not stored.
- `home.conviction_moves` applies the thresholds at publish: `_conviction_quarter` (eligibility), `_usual_move` (biggest move of the 4 quarters before), `_move_size` (buys ÷ end AUM, sales ÷ start AUM; adds/trims minus `flow × w_prev`, clipped). ETFs = `securities.is_etf` or `sector == ETF_SECTOR` (`run/publish_step.py`).
- `python -m orca.run home` (`run/weekly.run_home`) rebuilds `funds.json`, `securities.json`, `latest_prices.json` and `home/*.json` from stored `fund_state` with no fetch or recompute; it refuses when the deadline quarter moved or work is owed. Pipeline input `home_only` runs it (~5 min vs ~2 h rebuild, chat).

### Workflow resilience (code `.github/workflows/pipeline.yml`, `.github/actions/*`)
| Guard | Why (chat) |
|---|---|
| rclone install variables named `ORCA_RCLONE_*` | rclone reads every `RCLONE_*` env var as an option (run 1 failed) |
| Secrets stripped of whitespace; malformed R2 key id named; Cloudflare account id = the 32-hex part of whatever was pasted; Pages project created if missing (`web.yml`) | runs 2–4 and the first deploys failed on pasted secrets |
| `check-keys` step (`run/preflight.py`) before the restore | a bad OpenFIGI/Tiingo/FRED key otherwise fails an hour in |
| Manifest restored with `copyto --ignore-size --ignore-checksum`; reader accepts plain JSON | R2 hands brotli files back decoded (run 6) |
| `RCLONE_TIMEOUT=60s`, `RCLONE_CONTIMEOUT=15s`, stats every 30 s; restore retried 3× under `timeout 15m` | a 41-min silent restore stall |
| Upload 64 at a time with `--s3-no-head` | the first full upload took ~75 min |
| `echo 1000 > /proc/self/oom_score_adj`; memory/disk logged every 60 s | an out-of-memory runner loses the save step with it |
| Save step kills a leftover `orca.run` (TERM, then KILL after 30 s) and runs only if the restore succeeded | a cancelled run kept writing the lake during the save |
| `_recompute_set` scans CIKs only; `latest_closes` reads the last `LATEST_CLOSE_WINDOW_DAYS = 14` days of bars per stock | both loaded whole tables and killed the 8 GB runner (runs 9–12) |

Run size (chat, 2026-11-02): 13,314 funds, 74,358 files on a full publish, ~80 min, memory peak ~4.5 GB of the public repo's 16 GB / 4-core runner; restores 15–64 s; fund compute ~48 min on one core.

### Engine formulas
| Figure | Formula (function) |
|---|---|
| Quarter return | `(end − start − net_buying + dividends) / (start + net_buying/2)`; None for a segment's first quarter or a non-positive start/denominator (`fund.aggregate_fund`) |
| Bridge | `end = start + market_move + net_buying + trade_gains`, tolerance 1e-6 × max(1, \|end\|, \|start\|, buys+sells) (`check_bridge`) |
| Year | `∏(1+r) − 1`; `approx_ret = (gains + dividends) / (start + inflows/2)` (`fund_years`) |
| Metrics | ann = growth^(4/n) − 1; vol = stdev × 2; Sharpe = mean(excess)×4 / (stdev(excess)×2); Sortino = mean(excess)×4 / (sqrt(mean(min(0,x)²))×2); Calmar = ann/\|max_dd\|; rf per quarter = year's DTB3 mean / 4; needs ≥ 4 returns (`metrics.performance`) |
| Turnover, hold | mean over full years of min(buys, sells) / mean book; hold = quarters held / 4 (`metrics.turnover`, `hold_lengths`) |
| Trade price | first report: close; else quarter VWAP of (H+L+C)/3; else last close; else implied (`position._trade_price`, `quarter_px.quarter_px`) |
| Avg cost, realised | buy adds delta×px; sell realises −delta×(px − cost/shares) (`compute_position`) |
| Contribution | pnl / (year start + inflows/2) × 100 (`fund.contributions`) |
| Conviction | score = size / max(usual, 0.01) (`home.conviction_moves`) |
| Exits | one_y = close(q+4)/last sale px − 1; spy_one_y = SPY close(q+4)/SPY VWAP(q) − 1 (`whatif.exit_rows`) |

## Lake schema (zstd Parquet, `storage.Lake.write`)
| Table | Columns (units) |
|---|---|
| `filings/qNNN`, `reports/qNNN` | accession, cik i64, period i16 (quarter index), filed date, form, amendment_type, manager_name, source (bulk/live/legacy; bulk beats live beats legacy for one accession, `holdings.SOURCE_RANK`). Before 2013 NNN is negative (`q-56` = Q1 1999; parts sort as text) |
| `raw_holdings/qNNN` | accession, cusip, issuer, title, shares f64, sh_type, put_call, value_usd f64 (dollars), source |
| `holdings/qNNN` | cik, q i16, cusip, kind (SH/PRN/PUT/CALL), shares, value_usd, filed |
| `securities` | stock_id i32, figi, ticker, name, is_etf, cik, sic i32, sector, shares_out |
| `cusip_map` | cusip, stock_id, method (openfigi / name / unmapped / error / unlisted: found only with delisted securities included, for CUSIPs first held before 2013, never by name), tried (internal only, never published) |
| `legacy_checks/<YYYYQn>` | accession, cik, period, filed, form, status, rows, invalid_rows, parsed_value, declared_value, declared_entries (one row per pre-2013 filing read; private) |
| `prices_daily/{y<year>, z<run>-NNNN}` | raw unadjusted OHLC f32, volume f64, split_factor f32, dividend f32 |
| `vendor_tickers` | stock_id, ticker, end |
| `vendor_rejects` | stock_id, ticker, quarters, off, checked: vendor tickers a stock never takes again, because 80%+ of its quarters with a 13F price (4+) were mispriced under it, or its quarter-on-quarter price changes were a median 15%+ from its holders' (8+ pairs of quarters) (`engine/sectors.vendor_rejects`, written by `run/sectors_step.update_vendor_rejects`, at most 300 new a run; read by `run/market.resolve_vendor_tickers`, which then drops the stock's bars and looks for another ticker) |
| `rf` | year i32, rate f64 (decimal); from 1999 (`rf.START`), fetched again when the stored table starts later |
| `fund_about` | cik i64, name, street, city, state, incorporated, sic, tickers list[str], exchanges list[str], former_names list[{name, from date, to date}], signer, signer_title, signed date, other_managers list[str], accession, filed date (the 13F the row was read from; the lake's newest when the record lists none), fetched date. One row per fund, as the SEC gives it; `run/about_step.update_fund_about` (two SEC calls a fund) |
| `adr_ratios` | cik i64, form str ("20-F" or null), filed date, ratio f64 (ordinary shares per ADS; null = none stated or no 20-F), source str ("cover" or "text"), checked date. One row per company, asked again after a year, biggest first, at most 2,500 a run; one SEC call, up to three for a 20-F filer (`sec/adr.fetch_adr`: submissions, the rendered cover `R1.htm`, then the 20-F). `run/sectors_step.update_adr_ratios`; `adr_ratios()` merges it under `share_overrides.csv` (the CSV wins; a disagreement is logged) |
| `shares_hist` | stock_id i32, end date, filed date, shares f64 (as reported, on the share basis of `end`; null = the company reports no count). One SEC call per company, `run/sectors_step.update_share_history`. The sector indices' market cap = split-adjusted close × the count filed by the quarter end (before the first one, the earliest), times the splits after its `end`, 1,000^k slips divided out and counts 5x off the 9 around them dropped (`engine/sectors.todays_counts`, `market_caps`); before the first count, the earliest scaled down where the stock's 13F-held shares grew 2x+ faster than the market's by its first 8 counts (`held_scales`) |
| `sector_returns` | label (hierarchy path, or `Market`), tier i8 (0 market, 1 sector, 2 industry, 3 vertical), q, ret, level_end, level_avg, n, cap, top_weight (`engine/sectors.py`; not published as such: the sector files below are built from it) |
| `stock_quarters` | stock_id, q, close, div, vwap (split-adjusted; stocks and ETFs), written with `sector_returns`. Close and vwap are null in a quarter whose as-traded close is 5x or more off the median price per share 3+ of its 13F holders report, of the CUSIP mapped to it that they hold the most dollars of, where that CUSIP holds 25–150% of the company's shares (another security's history under the ticker; `engine/sectors.mispriced`, read from `holdings` one quarter at a time by `run/sectors_step.reported_prices`) |
| `fund_flows`, `fund_flows_run/bNNNNN` | cik, stock_id, q, delta, px, shares_after: each fund's trades over its tracking segment, merged like `fund_state` but streamed (each part sorted, a sorted merge on cik, `Lake.sink`): ~85M rows with the history from 1999 |
| `fund_skill` | cik, tier (1–3), ret_fund, ret_label, ret_mkt, ret_spy, picking, allocation, coverage, n: dollars made each way on the fund's own money ÷ dollar-years (`engine/skill.py`; draft, not published) |
| `etf_ranks` | cik, stock_id, label, ret, rank, of, best, best_ret: each single-sector ETF position's label ranked against every label at its tier, on the position's own money |

Sector files (published since 2026-11-22; contract.md "Sector files"): `orca.run sectors --part publish` (`run/sectors_step.publish_sectors`, maths in `engine/skill_detail.py`) replays every listed fund's trades again from `fund_flows`, `stock_quarters` and `sector_returns`, chunked by trades like the scores, and stages `sectors/labels.json`, `sectors/scores.json` and `fund/{id}/skill.json` in `data/out/sectors_staging`, runs the CUSIP guard and adds their paths to `data/out/manifest.json`. The workflow's "Sector files", "Upload the sector files, then the manifest" and "Clear the Cloudflare cache after the sector files" steps run after "Save the score tables" (and in a `sectors_only` run after the main command), all `continue-on-error`. The monthly run never counts these paths as owed (`publish_step.is_sector_path`, `weekly._reconcile_published`) and carries them over into its own manifest (`weekly.sector_files`). The demo runs the real sector step on its lake (`demo.write_demo`).
| `fund_state`, `fund_state_run/bNNNNN` | cik, meta JSON, snap JSON |
| JSON | `ingested.json`, `state.json` (watermarks, pending sets, `last_q`, `rf_stale`, `price_backfilled`, `legacy_done`, `legacy_retry`), `published.json` |

### Lake backups (`pipeline.yml`, step "Back up the lake state")
- After a scheduled run that succeeded end to end (pipeline and save; never a manual run, so reruns cannot flush the good monthly backups), `rclone copy` puts the small, hard-to-rebuild lake state in `backups/<UTC date>/` of the PRIVATE lake bucket: `ingested.json`, `state.json`, `published.json`, `fund_state`, `cusip_map`, `vendor_tickers`, `securities`, `rf`. Not `fund_about` (refetched from the SEC over three runs), not `prices_daily` (large; refetched from Tiingo) and not `filings`/`raw_holdings`/`holdings`/`reports` (rebuilt from the SEC's files). The source is the local lake just saved, not a server-side copy (no overlap with the live keys).
- Then the 3 newest folders named exactly `YYYY-MM-DD/` are kept and older ones removed with `rclone purge`; nothing is removed unless today's folder is listed. Anything else under `backups/` is never touched.
- `restore-r2` and the save both `--exclude "backups/**"`, like `workbooks/**`: backups are never restored into a run and the save's `sync` never deletes them.
- The step is the last one, with a 10-minute timeout. A failed copy removes today's partial folder, prints `::error::` and fails the run (red run, and the `alert` job opens an issue); the site and lake are already published and saved by then. Restore drill: `docs/domain-and-data-hosting.md`, "Restore from backup".

Published files: `fund/{id}/{summary,positions,contrib,exits}.json` (`publish.publish_fund`; the summary's `about` from `fund_about`); `funds.json`, `securities.json`, `latest_prices.json`, `home/*.json` (`publish.publish_shared`); `stock/{id}/weekly.json` (`publish.publish_weekly`: weekly closes, and `q0`/`qclose`, each quarter's close by the engine's valuation rule, so the site values an older quarter's holdings exactly as the summary does); `health.json`, `manifest.json`. They are minified with sorted keys and brotli quality 9, uploaded with `Content-Encoding: br` and `Cache-Control: public, max-age=300`, which the Cloudflare cache rule overrides. CUSIP guard: `_json_ready` refuses a `cusip` key and `publish_step.cusip_leaks` scans the staged files. Field meanings and units: `pipeline/contract.md`.

### Workbook (`pipeline/orca/workbook/`, phase 1: owner-only)
- Modules:
  - `inputs.py`: `FundInputs`, taken from exactly what the engine used (`run.compute.Prepared` and `FundResult`); `validate`, `to_json` / `from_json` (brotli JSON, no CUSIP ever).
  - `cut.py`: funds over 500 positions keep the top 500 by peak value; the rest become one "All other positions" line.
  - `layout.py`: the block and column registry; `model.py`, `outputs.py`, `summary.py`: the three tabs (xlsxwriter, constant memory); `sheet.py`: fast writer and formats; `build.py`: `build_workbook`, `file_name`; `parity.py`: site-versus-Excel test support.
- CLI: `python -m orca.run workbook --fund ID [--fund ID …]` (`run/workbook.py`). It reads the lake like `verify`, then per fund validates the inputs, checks `from_json(to_json(fi)) == fi`, and writes `<out>/inputs/<id>.json` and `<out>/orca-<id>-<name>-<price date>.xlsx`. Unknown fund: `fund N: not found`, exit 1. No priced positions: skipped, exit 0. Output lines carry only ids, sizes and timings.
- Action `.github/workflows/workbook.yml` (manual, `fund_ids`, at most 20 numeric ids on one line, checked in a step that refuses control characters and passes only the validated list on): restores the lake (`production` environment, `concurrency: pipeline`), builds, and copies `pipeline/data/workbooks` to the PRIVATE lake bucket under `workbooks/manual/<UTC date>/`. It never saves the lake and uploads no artifact (the repository is public). The upload step runs even when a fund failed (`!cancelled()` and some file built), so the funds that built are stored while the job stays red through the failed build step.
- A fund that fails for any reason (unknown, invalid inputs, any other exception) prints `fund N: ...` (the exception type only), leaves no file (workbook built to `.part` and renamed, inputs file written last, partial files removed), and the other funds still build; the command exits 1.
- The lake sync in `restore-r2` and the save in `pipeline.yml` both `--exclude "workbooks/**"` and `--exclude "backups/**"` (see Lake backups below): past workbooks are not restored (no run reads them), and the save would otherwise delete them from the bucket.
- Private paths: `workbooks/manual/<date>/` in the lake bucket only. Nothing is public, so `pipeline/contract.md` is unchanged.
- Design: workbooks are built on demand, never pre-built (a monthly pre-build was estimated at ~2.5 h on four cores). GitHub Actions are only for this owner-only phase.
- Phase 2 (own spec, not built): the monthly run writes small private input files for every fund; a Worker checks payment; a Cloudflare Container builds the file. Needs login and payments, and Tiingo's redistribution licence.
- Tests: LibreOffice recalculates the files (`tests/lo.py`); CI installs it and sets `ORCA_REQUIRE_LIBREOFFICE=1`, so a missing `soffice` fails there instead of skipping. Excel itself has not been run.

## Web (`web/`)
- Routes (`web/src/App.tsx`): `/`, `/fund/:id`, `/fund/:id/stock/:stockId`, `*` (`/how-it-works` was removed 2026-11-11).
- Data: `VITE_DATA_URL` (build-time; default `/demo-data`). The fund page loads `funds.json` (to tell an unknown fund from a failed load, R29), `securities.json`, `latest_prices.json` and the fund's 4 files; the Specialization tab, when first opened, also loads `fund/{id}/skill.json` (a 404 means "Not scored yet"), `sectors/scores.json` and `home/top_max.json` (the map's peers). `weekly.json` files load lazily: on demand when a period or row needs them, and prefetched in the background after landing (`web/src/fund/prefetch.ts`).
- Row budget for big tables: `web/src/fund/loading.ts` (50 / 200 / 25 / 100).
- Build: `vite build`, then `scripts/prerender.mjs`. Prerender writes `dist/fund/{id}/index.html` for the `PRERENDER_MAX` (15,000) largest funds and `dist/_headers`; the `PRERENDER_RICH` (500) largest also get their holdings written into the HTML from the data site's `summary.json`, `securities.json` and `latest_prices.json` (a file that cannot be read only costs that page its extra text). With `SITE_URL` (PR #3, merged a2a1554) it also writes `sitemap.xml`, `robots.txt` and canonical links. With `SITE_URL` it also adds Open Graph / Twitter tags, with `og:image` when `dist/og-default.png` exists (the logo card from `docs/brand/`, shipped in `web/public/`). With an absolute `VITE_DATA_URL` (PR #3) it removes `dist/demo-data`. Logo and icons: `docs/brand/`.

## Cloudflare setup
| Service | Setting |
|---|---|
| Pages project `orca` | deployed by `wrangler pages deploy dist --project-name ${CF_PAGES_PROJECT:-orca} --branch main` (`.github/workflows/web.yml`); default address `orca-88p.pages.dev`; custom domains `www.orcaetf.com`, `orcaetf.com`; no Functions/Workers, no bindings |
| Redirect rule | `orcaetf.com/*` → `https://www.orcaetf.com/${1}` 301 (dashboard) |
| R2 `orca-site` | public; custom domain `data.orcaetf.com`; CORS GET/HEAD for www, bare, pages.dev, localhost:5173 (set in dashboard); `r2.dev` address still enabled |
| Cache rule | host `data.orcaetf.com`: eligible, edge TTL 1 month, browser TTL 2 hours (dashboard) |
| DNS | DNSSEC on; SPF `v=spf1 -all`; DMARC `p=reject` (verified via DoH) |
| R2 lake bucket | private (`R2_LAKE_BUCKET`) |

GitHub secrets (names): `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `ORCA_CONTACT`, `OPENFIGI_KEY`, `TIINGO_KEY`, `FRED_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_PURGE_TOKEN`. Variables: `R2_LAKE_BUCKET`, `R2_SITE_BUCKET`, `ORCA_SCHEDULE_ENABLED`, `ORCA_TIME_BUDGET_MIN`, `TIINGO_RATE_PER_SEC`, `VITE_DATA_URL`, `SITE_ORIGINS`, `CF_ZONE_ID`, `CF_PAGES_PROJECT`, `SITE_URL`, `HSTS_MAX_AGE`. The deploy and pipeline jobs run in the `production` environment.

Deploy: a push to `main` touching `web/**` runs `web.yml`. The test job (vitest, demo build, Playwright) runs first. Then the deploy job fetches `funds.json` from `VITE_DATA_URL`, builds with `PRERENDER_FUNDS`, `SITE_URL` and `HSTS_MAX_AGE`, and runs wrangler. PRs run tests only.

## Tech debt and risks
- Confidential-treatment 13F filings are not handled (code).
- Only the latest tracking segment is computed, so history before a gap of 2+ quarters is dropped (code).
- The bulk ZIP skip ignores the checksum; there is no `is_finite` check on VALUE (code).
- Golden snapshots were never committed (`pipeline/tests/golden/` holds only `.gitkeep`) (code).
- Deferred review items: the weights ≈ 100% invariant is unchecked; a crash window between `write_manifest` and the `fund_state` writes; a `pending_all` run doesn't republish every weekly file (rulings doc).
- The Site CORS workflow lacks an R2 Admin token; the purge clears the whole zone (chat).
- A big fund fetches ~2,000+ `weekly.json` files when stepping back a quarter before the prefetch is done (about 7 s measured). A per-fund quarter-end price file would fix that (chat).
- The fund Positions and What-if tables, and every Home table, are plain `<table>`s with all loaded rows: layout cost grows with rows; capped by `loading.ts` (fund tables) and not virtualised. `DataTable` has a `virtual` mode (`@tanstack/react-virtual`), but no caller turns it on (code).
- No server-side gating is possible while all data is public (chat).
- Fund compute runs on one core (~48 min); parallel compute was estimated at 17–20 min, not built (chat)(code).
- `home/just_filed.json` is built and published with no reader since 2026-11-06 (code).
- `.trunc` and `.two-line` in `web/src/styles.css` have no users since PR #1 (code).
- A hard cap on files uploaded per run was offered (2026-11-01) and not built (chat)(code).
- Conviction cannot tell spin-off receipts or in-kind client transfers from trades (chat).
