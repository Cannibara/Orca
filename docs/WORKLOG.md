# Worklog

Last verified: 2026-11-28

Reverse-chronological. Tags: (chat) = said in a working session, (code) = checked in the code,
(git) = from commit history. "PR #n" = github.com/Cannibara/Orca/pull/n. Append new entries at the top.

## 2026-11-28 — Home tables: seamless Chart | Table; Conviction moves and Best & worst calls in the Famous look

| What changed | Why | Files |
|---|---|---|
| One table for the home lists, `ScrollTable`: the chart's grid (photo 32 px, 14 px gap, 252 px name column), 42 px header strip with a hairline as wide as the chart's axis (it reached 8 px past the module before), 46 px rows (phone 48), hover band, no lines, and the chart's window: 20 rows in view (phone 10) scrolling under a fixed header with the eased glide (`useEasedScroll` "rows" mode: the sub-pixel rest as `--sub` on the body), fades, thin scrollbar and caption | Owner: switching Chart \| Table should change as little as possible: first column, height, placement, funds per scroll | `web/src/home/ScrollTable.tsx`, `rankTable.css`, `useEasedScroll.ts` |
| Famous funds' and Top funds' Table view opens in the chart's order (best return first; most popular one click away) and at the funds the chart was showing, and back; Top funds' table shares the chart's page. The Famous table's 10-a-page (phone 30) pages are gone. Captions name their rows ("Showing 21–40 of 50 funds · one scale for the whole list"; the table's is the same without the scale note); a list that fits one page says "Showing all 10 funds" in both views | Owner answered: chart's order; the same scroll window | `web/src/home/RankTable.tsx`, `FamousChart.tsx` (`start`, `onView`), `famousChart.ts` (`captionText` noun, scale), `web/src/pages/Home.tsx` |
| Conviction moves and Best & worst calls drawn as that table, in the Famous module: no card; window (and Best \| Worst) on the toolbar; the module named "Moves in Q3 2026 filings" / "Buys in the 4 quarters to Q3 2026"; Fund first (photo of a famous fund's person, from Famous funds' rows, or initials; short name · AUM; the person), stock as ticker over company, the ranked figure bold; Quarter column only for 4 quarters; 100 a page; prices fold away below 1,000 px, phone rows below 760 px; rules and source under the table | Owner: "make the tables for Conviction moves and Best and worst calls consistent with the Famous funds table"; chose the full module, these two only | `web/src/pages/Home.tsx` (`ListSection`, `Conviction`, `Calls`), `web/src/home/moveTables.tsx`, `famousChart.css` (`.fo-mode`), `web/src/styles.css` (weight bar shared) |
| Design review (agent) fixes: the chart's header hairline was hidden under its scrolling window (a shadow below the strip), so the table's appeared and the chart's did not; both are now drawn inside the strip at the same pixel. Conviction's Fund heading steps A–Z, Z–A and back to "most unusual" (its opening order, shown beside it). A phone's sort menu is a chip over the device's picker (16px, no iOS zoom; 44px target). The Weight heading starts where the weights do. "Person · filed until" uses the drawn dot, and the chart's line says "filed until" too. Axis label 11px like the headings. Both phones' window switch reads "1 quarter \| 4 quarters"; phone tickers in mono. The footnote lines up with the module (no 2px indent). Not taken: AUM inline in the Famous table (it has an AUM column), the person on a phone table's second line (owner's figures line), Big wins & losses (owner) | Design critique of screenshots | `famousChart.css`, `rankTable.css`, `ScrollTable.tsx`, `RankTable.tsx`, `FamousChart.tsx`, `moveTables.tsx`, `Home.tsx`, `home.css` |
| Checks: web suite green (1,226), typecheck, Playwright smoke green incl. two new tests (Chart \| Table: header, window, foot and the fund at the top of the window at the same pixels after scrolling, 1280/400 px, light/dark; Conviction and Calls: no card, 42/36 px header, 46/48 px rows); screenshots on live production data at 1280, 1000, 820, 400 px and dark | | `web/tests/home.test.tsx`, `home-famous-chart.test.tsx`, `famous-chart.test.ts`, `web/e2e/smoke.spec.ts` |

## 2026-11-28 — Landscape follow-ups: firms as one tile, quant trading firms, hedge styles, short names, quarterly refresh

| What changed | Why | Files |
|---|---|---|
| A firm filing under several names is one tile per type (Vanguard 10 filers, Capital Group 6, Susquehanna, MUFG, Mizuho, Sequoia 7, ...): books added, returns weighted by book, the largest filer's page on click; `funds.n` and `funds.members` in `home/landscape.json` (contract first) | Owner approved the 5 recommendations | `pipeline/orca/investor_parents.csv`, `investors.load_parents`, `landscape.py`, `pipeline/contract.md`, `web/src/home/landscape.ts`, `LandscapeMap.tsx`, `web/src/data/types.ts` |
| Spot-check of the register-typed filers: 20 corrected (Los Angeles Capital, IFM, Axiom, Generation IM: institutional; Gotham: quant; Rothschild Wealth UK, W1M: wealth; Ares: credit; Cerberus: PE; ...); 29 market makers and trading firms moved to Quant & multi-strategy | Owner: label market makers as quant firms | `pipeline/orca/investor_types.csv` (490 rows) |
| Hedge styles: ~180 of the largest "Other hedge funds" by hand; the rest from holdings at run time (60%+ health care or tech and communication: a specialist; 400+ priced positions: quant) | 928 hedge funds had no style | `investors.refine_hedge`, `investor_types.csv` |
| Short names for ~90 of the largest filers (Fidelity, JPMorgan Chase, CalPERS, GMO, VanEck, ...) | Names like "Jpmorgan Chase & Co", "Deutsche Bank Ag" (the filing name ends in a backslash) | `web/src/lib/famousNames.ts` |
| Workflow Investor types: quarterly (20th of Jan/Apr/Jul/Oct) and by hand, refreshes the adviser-register file, checks it loads, pushes `investor-types-refresh` and opens a PR | The register snapshot ages | `.github/workflows/investor-types.yml` |
| Colours stay green/red (the holdings map's), noted as the exception in CLAUDE.md; custodian money in banks left as is (owner) | Owner | `CLAUDE.md` |
| Checks: pipeline and web suites green; demo data rebuilt (one filer per row) | | `pipeline/tests/test_landscape.py`, `test_investors.py`, `web/tests/landscape.test.ts` |

## 2026-11-26 — Home Landscape tab: every 13F filer by type of investor; Perigee's $266T book removed

| What changed | Why | Files |
|---|---|---|
| Owner asked: how many 13F filers, and who must file. Checked: 8,907 managers filed 13F-HR holdings for Q2 2026 and 9,232 filings for Q3 2026 so far (SEC full index), plus ~1,950 13F-NT notices (holdings reported in another's filing); any manager with investment discretion over $100M+ of SEC-listed securities (US-listed stocks, ETFs, listed options, some convertibles; long only) on the last trading day of any month. Orca has 16,121 filers since 1999 | Owner question | — |
| New home tab **Landscape**: a tree map of every current filer, grouped by type of investor under heading strips, area = 13F holdings, colour = estimated return a year over the shared period (the holdings map's ramp); headings zoom in, filers open their page, breadcrumb and Escape zoom out; the note says ETF money is counted twice and bounds it with the ETF providers' total ($24.4T of $72.7T at Q3 2026) | Owner's idea; owner chose to keep the index firms as Asset managers > ETF providers and call out the double counting | `web/src/home/LandscapeMap.tsx`, `landscape.ts`, `landscape.css`, `web/src/pages/Home.tsx`, `web/src/fund/treemapView.ts` (optional `fit`, `fixed`, `kind`, `onActivate`), `web/src/fund/treemapDom.ts` (moved from HoldingsPanel) |
| Published file `home/landscape.json` (contract first): each leaf type's 150 largest filers and the rest as one row, returns for all six periods; ~45 KB brotli on real data | One file serves every period and zoom | `pipeline/contract.md`, `pipeline/orca/landscape.py`, `run/publish_step.py`, `publish.py` |
| Types: hand labels for the ~300 largest (`investor_types.csv`), the famous lists, the SEC's monthly adviser register (7,877 filers typed by CIK or exact name: client mix and private funds; `scripts/investor_types.py`), SEC industry codes and name words. Unclassified: 2% of the money at Q3 2026 | 13Fs carry no type | `pipeline/orca/investors.py`, `investor_types.csv`, `investor_types_adv.csv`, `pipeline/scripts/investor_types.py` |
| Perigee Private Management (1074020) showed $266T in Q2 1999: its text table ran two columns into 3.5 trillion-share rows. Rows over 50 billion shares are dropped at parse and build; the next ordinary run removes those in the lake and recomputes their funds | Owner: get rid of it | `pipeline/orca/holdings.py`, `sec/legacy.py`, `run/ingest.py` (`purge_misread_holdings`), `run/weekly.py` |
| Checks: pipeline suite green (1,121 + new tests for types, landscape and the share guard); web suite green (1,220); Playwright smoke incl. a new Landscape test at 1280/400 px, light and dark; build and prerender green. Screenshots on real published data looked right | | `pipeline/tests/test_investors.py`, `test_landscape.py`, `web/tests/landscape.test.ts`, `web/tests/home.test.tsx`, `web/e2e/smoke.spec.ts` |
| To go live: merge, then Actions > Pipeline > Run workflow with `home_only` (publishes `home/landscape.json`, ~5 min); the next ordinary run removes Perigee's rows. Until then the tab says the landscape arrives with the next data update | | — |

## 2026-11-28 — Run 57: opportunity-cost scores live; the map says "too close to call" and names every dot (owner)

| What changed | Why | Files |
|---|---|---|
| Run 57 (`sectors_only`, `main` 7025667, PR #89): 18 min (was ~70; no IRR solving), 15,544 funds scored, dropped positions 596,360 → 193,372, median coverage 64.6%, 3,276 funds on the map. Berkshire at industry level: stock choice −0.13 pts a year (IRR −0.66), industry choice −0.33 (IRR +0.03); top Adds Apple +0.65, American Express +0.32, Kraft Heinz −0.44, Occidental −0.22; Adds sum to the scores | The rebuild, checked on the live site | (run) |
| A fund inside the grey cross both ways now reads "too close to call either way" (Berkshire read "Neither, so far" while its dot sat in the band) | Owner: "Yes" (fix both map issues) | `web/src/fund/skill.ts` (`quadrant` → "close"), `SkillMapPanel.tsx` |
| Every dot on the map is named: this fund's name above its own dot, each peer's name right, left, above or below its dot, clear of every name, dot, corner label and axis number; where none fits, a number beside the dot and a key under the map (Berkshire: all 6 peers named on desktop, Markel keyed on a phone) | Two of Berkshire's peers had no name, and Berkshire's name sat beside another fund's dot | `web/src/fund/skill.ts` (`placeMapLabels`), `SkillMapPanel.tsx`, `skill.css` |
| Checks: 3 new tests; web suite green (1,211), typecheck clean, Specialization e2e green (12); checked on Berkshire's live data at 1280 and 400 px | | |

## 2026-11-28 — Sector choice vs stock choice rebuilt as an opportunity cost, no IRR (owner)

| What changed | Why | Files |
|---|---|---|
| Run 56 (`sectors_only`, `main` 0a323d3, PR #86, flat start): Berkshire's coverage 77% → 94% (142 picks), its map shows; median coverage 61.5% → 64.7%, dropped positions 792,655 → 596,360 | The flat start scores positions held from 1998 Q4 | (run) |
| Scores rebuilt: each half quarter, the fund's dollars in each stock are put in the stock, its label's index, the market and SPY; picking and allocation = dollars beaten ÷ dollar-years at work. Years = what the money made ÷ its average in the year; Lines = dollars made so far; the map's path, the decisions' Adds (now exact: they sum to the scores) all use the same sums | Owner: "ensure that we are not using IRR, but rather an opportunity cost framework … given the same bet size and timing" | `pipeline/orca/engine/skill.py`, `skill_detail.py`, `run/sectors_step.py`, `contract.md`, `web/src/fund/{skill,stacked,decisions}.ts`, `StackedPanel.tsx`, `DecisionsPanel.tsx`, `SkillMapPanel.tsx`, `data/{types,api}.ts` |
| `skill.json`: `irr_*` → `ret_*`, `cap` and `adds` added, `v_*` dropped. The site treats an older file as not scored until the sector step rewrites it | One measure, named for what it is | `pipeline/contract.md`, `web/src/data/api.ts` |
| Checks: pipeline suite green (1,117), web suite green (1,209), typecheck clean, Specialization e2e green (12); demo data regenerated. Takes effect with the next `sectors_only` run | | |

## 2026-11-26 — The map names low coverage instead of "Too early to tell" (owner)

| What changed | Why | Files |
|---|---|---|
| A fund with 3+ years of trades and 20+ picks that misses the map only on coverage now reads "Too little of its buying could be scored": the map needs 80% of its buying matched to a sector with prices, and it says how much was. A young fund still reads "Too early to tell" | Berkshire (108 quarters, 128 picks, 77% scored) read "Too early to tell"; owner: build it | `web/src/fund/SkillMapPanel.tsx`, `web/tests/fund-skill-ui.test.tsx` |
| Checks: 1 new test; web suite green (1,208), typecheck clean | | |

## 2026-11-26 — Positions held from the start of the data are scored, not dropped (owner)

| What changed | Why | Files |
|---|---|---|
| A stock's own series and every index series that begin with the data (first quarter 1999 Q2 or before) are flat from 1998 Q4: level 1.0 before their first quarter. A position first reported in 1998 Q4 or 1999 Q1 is then replayed from there instead of dropped whole | Berkshire's map read "Too early to tell": 77% of its buying could be scored, under the 80% the map needs, because Coca-Cola ($25bn first reported in 1998 Q4), Wells Fargo, American Express, Walmart, Freddie Mac and its 1999 Chubb stake had a first trade no series had a level for (13F data from 1998 Q4, prices from 1999 Q1, index returns from 1999 Q2). Owner: "assume it's the same" year to year before then. Fund and index side start alike, so neither gains; a series that begins later is left as it is | `pipeline/orca/engine/skill.py` (`_flat_start`, `own_series`, `label_series`) |
| Checks: 1 new test (a 1998 Q4 position replayed, a later listing left alone; fails on the old code); pipeline suite green (1,119); demo data unchanged. Takes effect with the next sectors run | | `pipeline/tests/test_skill.py` |

## 2026-11-26 — Runs 54–55: 34 wrong-company tickers off the fund pages

| What changed | Why | Files |
|---|---|---|
| Run 54 (`sectors_only`, `main` 01aad7b, PR #84): 20 more vendor tickers rejected, mostly on the price-move test: JNP for Juniper Networks (moves 26% apart over 77 pairs), EXK for Exact Sciences (24%), PGF and EPI (ETFs) for Pengrowth and ESSA Pharma, RYI (Ryerson's) for Viracta, TR (Tootsie Roll's) for Trillium, APH (Amphenol's) for Aphria, WTW (Willis Towers Watson's) for WW International, VTOL (Era's history) for the old Bristow, CZR for the old Caesars, and others. Borderline, possibly right tickers with patchy prices: SMSMY (Sims) and YZCAY (Yankuang), thin OTC ADRs at 17%, ECHO (16%), ARIS; if so their funds are valued at reported prices instead | PR #84 | — |
| Run 55 (ordinary, `main` 01aad7b): 20 vendor tickers changed and 25 lost (155,001 bars dropped), 7,013 funds recomputed, 41,202 files changed, health 99.4% median priced; no time-budget cut, no `vendor_tickers_lost`. Live after the run: Juniper Networks (386) on JNPR ($37.96 in 2001 Q1, $36 in 2025), Exact Sciences (1684) on EXAS ($131.78 in 2021 Q1), Oncolytics on ONCY, CRH Medical on CRHM; Mechanics Bancorp (3881) has no other ticker: chart deleted, valued at its holders' reported prices | The fix reaches the fund pages | — |
| Left: BP Prudhoe Bay Royalty Trust (1308) still under BMI (Badger Meter's prices): its 13F CUSIP shows 0% of its units held, so neither test counts its quarters; a hand override (`ticker_overrides.csv`) would fix it | | — |

## 2026-11-26 — Run 53: 14 vendor tickers rejected; a price-move test for the rest

| What changed | Why | Files |
|---|---|---|
| Run 53 (`sectors_only`, `main` 1a4b1e9, PR #83): all steps green. 14 vendor tickers rejected, each another company's: MCHB for Mechanics Bancorp (52 of 57 quarters off), GPR for Great Panther, VAC (Marriott Vacations') for VBI Vaccines, ONC (BeiGene's) for Oncolytics, CRH (CRH plc's) for CRH Medical, TTEN for an old TotalEnergies ADR id (the main one, TTE, is another id), ENZB, AZN for id 7137 (an AstraZeneca id whose 13F CUSIP is not the ADR's: few holders, 2017–20), ABT (Abbott's) for Absolute Software, AI (C3.ai's) for Arlington Asset, AXON (Axon's) for Sio Gene Therapies, PD (PagerDuty's) for Precision Drilling's old id, HIVE for Aerohive, SPAQ for Fisker. None is a company's right ticker | PR #83 | — |
| Missed: Exact Sciences under EXK (41 of ~70 quarters off) and Juniper Networks under JNP (47 of ~77): the other company's prices were within 5x in the rest. Now also rejected where the quarter-on-quarter price changes are a median 15%+ apart (8+ pairs of quarters, log terms); the same company's are a few percent apart | Prices in the same range, moves unlike | `pipeline/orca/engine/sectors.py` (`vendor_rejects`), `pipeline/orca/run/sectors_step.py` (log) |
| Checks: a test with an Exact Sciences-shaped history (8 of 12 off, rejected on its moves), a right one 3% off and one with too few pairs (kept); sector tests green | | `pipeline/tests/test_sectors.py` |

## 2026-11-26 — Wrong-company prices: the vendor ticker is rejected, for the fund pages too

| What changed | Why | Files |
|---|---|---|
| The sectors step now also rejects a stock's vendor ticker where 80%+ of its quarters with a 13F price (4+) are mispriced (held-share guard; 20+ holders without a count) and records it in lake table `vendor_rejects`; `resolve_vendor_tickers` skips rejected tickers, so the existing path drops the bars, looks for another ticker, recomputes the holders and deletes the chart. At most 300 new a run. The monthly run's sector-table save step saves the table | Juniper Networks under JNP (Juniper Pharmaceuticals' prices, 1999–2017), Exact Sciences under EXK (Endeavour Silver's) and Mechanics Bancorp under MCHB price the fund pages too; owner: fix, efficiently | `pipeline/orca/engine/sectors.py` (`vendor_rejects`), `pipeline/orca/run/sectors_step.py` (`update_vendor_rejects`), `pipeline/orca/vendor.py` (`resolve` `rejected`), `pipeline/orca/run/market.py`, `.github/workflows/pipeline.yml` |
| To take effect now: a `sectors_only` run (writes the table), then an ordinary run (drops, refetches, recomputes, publishes) | The monthly run's sectors step runs after its fund step, so a rejection reaches the fund pages one run later | — |
| Checks: 4 new tests (the rule; the table, once and with a flood held back; `resolve` skipping a rejected ticker for an alternate; a run where a rejected stock loses its prices and chart, fails on the old lookup) | | `pipeline/tests/test_sectors.py`, `test_sectors_step.py`, `test_vendor.py`, `test_run.py` |

## 2026-11-26 — Specialization tab back on (owner)

| What changed | Why | Files |
|---|---|---|
| The production build no longer sets `VITE_SPECIALIZATION=hold`, so the fund page's Specialization tab shows the sector files again (held since 2026-11-23). The hold stays in the code for a next time | Owner: "Yes of course" after run 52 (market vs SPY within 8.7 points every year 1999–2026) | `.github/workflows/web.yml` |
| Next, also approved: fix the wrong tickers of delisted companies (Juniper Networks under JNP, Exact Sciences under EXK, ...) that price the fund pages too | | — |

## 2026-11-25 — Run 52: Lloyds scaled again; the indices are where the data allows

| What changed | Why | Files |
|---|---|---|
| Run 52 (`sectors_only`, `main` 14d30cf, PR #80): all steps green, files published, tab still on hold. Lloyds is scaled in 47 quarters and at 4%+ of the market in 3 (2002 Q1–Q3, to 6.6%; run 50: 13). "caps heavy" otherwise lists only Citigroup before 2009 (to 10.4%) and real giants (Nvidia, Apple, Microsoft, GE, Amazon); no stock moved the market 3 points in a quarter | PR #80 | — |
| Market vs SPY, every year 1999–2026: Berkshire within 8.7 points (worst 2000, −1.0% vs −9.7%: Citigroup), Pershing, Tiger Global and 1649339 within 6.5 (worst 2021, +22.2% vs +28.7%: the whole market has small and foreign companies, which lagged that year). No new error pattern: index fixes stop here | | — |
| Left, the known limits: Citigroup before 2009 (no SEC count before Sept 2009 and the 13F proxy does not reach it); wrong tickers for some delisted companies (Juniper Networks under JNP, Exact Sciences under EXK, ...) that also price the fund pages, the owner's call | | — |

## 2026-11-25 — Run 51: the 13F price check now spares the big names it misread

| What changed | Why | Files |
|---|---|---|
| Run 51 (`sectors_only`, `main` b37e073, PR #79): all steps green, files published, tab still on hold; the four funds' market vs SPY unchanged (Berkshire's worst gap 8.2 points, 2000; the others within 6.5). "prices set aside (13F price)": Mechanics Bancorp (funds hold 66% of HomeStreet's shares), Exact Sciences under EXK (88%), Octave Specialty (79%), Dawson Geophysical, Argan before 2002, a few small ones. "prices kept": BlackRock's 2024 id (8% outside 2006–07), Accenture (17%), Juniper Networks under JNP (no count on record, so no cap either), BP Prudhoe Bay under BMI (0%), Oncolytics; Honeywell and Eaton no longer listed | PR #79 | — |
| Left among those set aside, likely wrong but small: Check Point 2023–26 (40% at $2.61, a CUSIP that is not its stock), Jazz 2021–22, Freeport-McMoRan in 2000 (one quarter) | | — |

## 2026-11-25 — Run 50: Citigroup still unscaled; the holder guard undid Lloyds before 2006

| What changed | Why | Files |
|---|---|---|
| Run 50 (`sectors_only`, `main` cc5d14e, PR #78): all steps green, files published, tab still on hold. Berkshire's market vs SPY: 2000 −1.5% vs −9.7% (run 49: −0.3%), 2004 +13.1% vs +10.7% (+12.3%), 2005 +8.3% vs +4.8% (+7.7%); worst gap 8.3 points (2000); the other three within 6.5 every year. JPMorgan and Bank of America's one-quarter dip are no longer scaled. Citigroup is still not scaled (10.0% of the market in 2001): against its first 8 counts too, its 13F-held shares in 2001, over the market's growth, stay above half of its 2009 count. Lloyds is scaled in 37 quarters but back at 4–6.4% of the market in 2002–05 | PR #78 | — |
| Why Lloyds: in 2002–05 far fewer US funds held its ADRs than at its first counts (2017–18), so the guard (a quarter as many holders as at the count) dropped those quarters. Now a tenth: JPMorgan's 2000 CUSIP (12 holders against 500) still fails it | | `pipeline/orca/engine/sectors.py` (`HOLDER_DROP`) |
| Left: Citigroup before 2009, the known limit; the 13F proxy does not reach it | | — |
| Checks: a Lloyds-shaped case in the scaling test (fails at a quarter); sector tests green; demo data unchanged | | `pipeline/tests/test_sectors.py` |

## 2026-11-25 — Run 49: the most-held CUSIP did not spare Honeywell or Accenture; a held-share guard does

| What changed | Why | Files |
|---|---|---|
| Run 49 (`sectors_only`, `main` fce731c, PR #77): all steps green, files published, tab still on hold. "prices set aside (13F price)" still listed BlackRock (61 quarters), Accenture (33), Eaton before 2013, Honeywell 2016–19, Check Point, an AstraZeneca id and Eversource 2005–09 next to the right catches (Mechanics Bancorp, Juniper Networks under JNP, Exact Sciences under EXK, ...). Their published prices are right (`stock/8758/weekly.json`: Honeywell $172.58 in 2019 Q2), so the most-held CUSIP under their stock ids in those quarters is not their stock: some other security mapped to them. BlackRock has two ids, 196 (BLACKROCK INC) and 632 (BlackRock, Inc., the 2024 holding company, priced back to 2006 under the same ticker) | PR #77 assumed the company's own CUSIP is always among those mapped to its id | — |
| Now the check acts only where the funds hold 25–150% of the company's shares in that CUSIP (held shares on today's basis over the count the index uses, per ADR): what a fund holds of a company is its stock; a security mapped to it by mistake is not. Mechanics Bancorp's holders held 79% of HomeStreet's 19M shares. The run logs the spared ones as "prices kept (13F holdings not its stock)", with the share held, to tune the range | Spares the stock whose 13F data is someone else's, keeps the catches | `pipeline/orca/engine/sectors.py` (`mispriced`, `market_caps` `units`), `pipeline/orca/run/sectors_step.py` (order: caps before the check; `_log_mispriced`) |
| Checks: the mispriced test now has the guard (HomeStreet set aside at 79%, a Honeywell-shaped 15% kept); pipeline suite green (1,113); demo data unchanged | | `pipeline/tests/test_sectors.py`, `pipeline/tests/test_sectors_step.py` |

## 2026-11-25 — Run 48: Lloyds scaled, Citigroup not; the scale now reads 8 counts

| What changed | Why | Files |
|---|---|---|
| Run 48 (`sectors_only`, `main` 183210c, PR #76): all steps green, files published, tab still on hold. Berkshire's market vs SPY: 2008 −39.2% vs −36.8% (run 47: −40.6%), 2007 +5.2% vs +5.1%, 2006 +18.1% vs +15.8%, 2004 +12.3% vs +10.7%; 2000 −0.4% vs −9.7% (worse: Citigroup, up in 2000, weighs more once Lloyds is right). "caps scaled by 13F holdings": Lloyds in 50 quarters (x0.22 in 2003, to x0.007), now off the heavy list; Bank of America (x0.47), HSBC, Santander, Barclays, BBVA, Novartis, TSMC, Ecopetrol and others, mostly banks that issued shares in 2008–10. Citigroup was not scaled and stays at 10.5% of the market in 2001 | PR #76 | — |
| Why Citigroup was not: at its first count (Sept 2009) the government held a third of it, which no 13F reports, so its 13F-held shares were low against its count and the ratio stayed above 0.5. Also seen: JPMorgan x0.001 in 2000 (its CUSIP then, Chase's, mostly maps elsewhere: 12 holders against 500 at the count), Bank of America x0.05 in one quarter (one quarter's big holder missing). Now: the scale is the median over the company's first 8 filed counts (by 2011 institutions held Citigroup as before); the market's move is a chained index of the median stock's quarter-on-quarter change; held shares are a centred median of 5 quarters; a quarter counts only with at least a quarter as many holders as at the count | Each failure has a guard | `pipeline/orca/engine/sectors.py` (`held_scales`) |
| Checks: the scaling test now has all four cases (Citigroup scaled x0.4; AIG, JPMorgan's CUSIP and a one-quarter dip not scaled; fails on the old code at JPMorgan); pipeline suite green; demo data unchanged | | `pipeline/tests/test_sectors.py` |

## 2026-11-25 — Run 47: the 13F price check finds other companies' prices, and set aside some right ones

| What changed | Why | Files |
|---|---|---|
| Run 47 (`sectors_only`, `main` 40e6b6b, PR #75): all steps green, files published, tab still on hold. The four funds' market vs SPY barely moved (Berkshire 2019 +28.9% vs +31.2%, 2025 +18.2% vs +17.7%; worst 2000, 8.4 points). "prices set aside (13F price)" named Mechanics Bancorp (52 quarters) and other prices that are another company's: Juniper Networks under JNP (Juniper Pharmaceuticals; Networks is JNPR) 1999–2017, Exact Sciences under EXK (Endeavour Silver), BP Prudhoe Bay under BMI (Badger Meter), Oncolytics under ONC (now BeiGene's), TotalEnergies at $0.03 | The check works where our price is wrong | — |
| It also set aside right prices: BlackRock in 73 quarters (ours $834, theirs $10.18), Accenture, Eaton before 2013, Honeywell. The CUSIP map gives such a stock other securities too (dozens of BlackRock funds at ~$10; Eaton Vance funds under Eaton), and the median over all their rows is theirs. Now the price, holders and held shares come from the one CUSIP per stock and quarter that the funds hold the most dollars of | The company's own shares always dwarf funds named after it | `pipeline/orca/run/sectors_step.py` (`reported_prices`) |
| Not changed: those wrong tickers also price the fund pages (Juniper Networks 1999–2017 at Juniper Pharmaceuticals' prices); fixing the tickers themselves is the owner's call | | — |
| Checks: 1 new test (BlackRock-shaped, fails on the old code); pipeline suite green; demo data unchanged | | `pipeline/tests/test_sectors_step.py` |

## 2026-11-24 — Run 46 (ADR lookup); stand-in counts before 2009 scaled by 13F holdings

| What changed | Why | Files |
|---|---|---|
| Run 46 (`sectors_only`, `main` 6fa2d0c, PR #74): all steps green, files published, tab still on hold. `adr_ratios`: 2,500 companies asked (3,413 owed to later runs), 343 file a 20-F, 216 ratios read; no ratio disagreed with `share_overrides.csv`. Berkshire's market vs SPY moved closer in most years (2021 +22.4% vs +28.7%, 2014 +9.9% vs +13.5%, 2008 −40.6% vs −36.8%); worst gap 8.3 points (2000, −1.4% vs −9.7%); the other three funds within 6.3 points every year. "caps heavy": Citigroup (to 9.9% in 2001) and Lloyds (6.3%) before 2009, then only Nvidia, Apple, Microsoft, Amazon, GE | PR #74 | — |
| Citigroup's first SEC count is Sept 2009 (22.9bn shares; 2007: ~5.0bn), Lloyds' is 2017 (72bn; 2007: ~5.7bn), and before a company's first count its earliest stands in. Now, there, the earliest count is scaled by the stock's 13F-held shares in that quarter over those at the count (rows priced within 5x of the median only, so a misread count cannot swamp the sum), against the median stock's same ratio, where 10+ funds hold it at both ends; only scales of 0.5 or less are used, so a stock is only ever read smaller (a higher scale is more often institutions leaving, like AIG's in 2009, than a buyback). The run logs "caps scaled by 13F holdings" (biggest first) and a `caps_scaled` flag | The known pre-2009 limit, from data already in the lake | `pipeline/orca/engine/sectors.py` (`held_scales`, `market_caps`), `pipeline/orca/run/sectors_step.py` (`reported_prices`, `_log_scaled`) |
| Checks: 2 new tests (Citigroup- and AIG-shaped; a misread count left out); pipeline suite green (1,112); demo data unchanged | | `pipeline/tests/test_sectors.py`, `pipeline/tests/test_sectors_step.py` |

## 2026-11-24 — Run 45: every year within 8 points of SPY; a price history that is another bank's

| What changed | Why | Files |
|---|---|---|
| Run 45 (`sectors_only`, `main` 5f9722c): all steps green, files published, tab still on hold. For Berkshire, Pershing, Tiger Global and 1649339, Orca's market is within 8 points of SPY in every year 1999–2026: 2021 +21.6% vs +28.7% (run 44: +16.0%), 2017 +22.1% vs +21.7%, 2025 +17.9% vs +17.7%; worst 2008, −41.3% vs −36.8% (Citigroup and Lloyds too big before 2009, the known limit). "caps heavy" lists only Nvidia, Apple, Microsoft, GE and those two; no stock moved the market 3 points in a quarter | PR #73 | — |
| Left in "caps market": Mechanics Bancorp (once HomeStreet, 19M shares, ~$27) at $875bn and 2.8% of the market in 2017. Its ticker MCHB was Mechanics Bank's on the OTC market, and the vendor's history under it is that bank's ($10,800–36,500 a share) to the 2025 merger; the published `stock/3881/weekly.json` shows it. Now each stock-quarter's as-traded close is checked against the median price per share its 13F holders report (value over shares, share rows, one quarter's `holdings` at a time); 5x or more off with 3+ funds reporting, close and VWAP are set aside in `stock_quarters` (not in a quarter where over a tenth of 100+ stocks checked disagree: that points at the filings' units), so the stock sits out of the indices and the fund scores' stock series there. The run logs "prices set aside (13F price)" and a `prices_set_aside` flag | Catches any ticker whose history is another security's, not just this one | `pipeline/orca/engine/sectors.py` (`mispriced`), `pipeline/orca/run/sectors_step.py` (`reported_prices`, `_log_mispriced`) |
| Not changed: fund returns on the other pages still value HomeStreet at the vendor's close (the engine's `price_mismatch` flags report it); a fix there changes production returns, so it is the owner's call | | — |
| The monthly run's "Save the sector tables" step now also saves `adr_ratios` (PR #74 left it out, so monthly runs would have looked every ratio up again; `sectors_only` runs save the whole lake) | | `.github/workflows/pipeline.yml` |
| Checks: 2 new tests; pipeline suite green (1,110); demo data unchanged | | `pipeline/tests/test_sectors.py`, `pipeline/tests/test_sectors_step.py` |

## 2026-11-24 — ADR ratios read from each filer's 20-F, not typed by hand

| What changed | Why | Files |
|---|---|---|
| New lake table `adr_ratios` and step `update_adr_ratios` in the sectors command: per company, its latest 20-F (submissions), the ratio from the SEC's rendered cover page `R1.htm`, else from the 20-F (tagged `dei:Security12bTitle` titles, then the text, the ratio stated most often). Asked again after a year, biggest first by count x close (so an ADR counted in ordinary shares ranks high), at most 2,500 companies a run. `share_overrides.csv` stays on top for hand corrections; a disagreement is logged | Missing ADR ratios were the most common error left (Banco Santander-Chile, HSBC, Vodafone, America Movil, Barclays, Banco de Chile, Ecopetrol, Lloyds, LATAM in runs 39–43) | `pipeline/orca/sec/adr.py`, `run/sectors_step.py`, `run/sources.py`, `run/cli.py`, `shares_hist.py` |
| Checked against the SEC: 34 of the CSV's 35 ratios read right, AstraZeneca none (it states none; the CSV keeps it), none wrong; 29 of 29 other ADRs with known ratios right (Novo, SAP, Petrobras 2, SMFG 3/5 ...), three 1:1 ones state none. RedHill reads 10,000 | Precision before trusting it | `pipeline/tests/test_sec_adr.py` |
| Checks: 10 new tests; pipeline suite green (1,108); demo data unchanged | | |

## 2026-11-24 — Run 44: the top of the market is now real companies; one slip repair misfired

| What changed | Why | Files |
|---|---|---|
| Run 44 (`sectors_only`, `main` 653c9ad): all steps green, files published, tab still on hold. Berkshire's market vs SPY: 2019 +26.0% vs +31.2% (run 43: +19.8%), 2020 +18.1% vs +18.3%, 2017 +16.8% vs +21.7%; every year within 8 points but 2021 (+16.0% vs +28.7%). The 15 biggest market shares are now real (Nvidia, Apple, Microsoft, Amazon, Cisco, Bank of America, AT&T, Pfizer, TSMC, Intel, GE) apart from Citigroup and Lloyds before 2009 (the known limit) and two below | PR #72 | — |
| The slip repair misfired on RedHill Biopharma (4–12% of the market in 31 quarters, 2013–21): its ADS went from 10 to 400 to 10,000 ordinary shares (Tiingo records splits) while it issued ~10x more, which on today's basis read as a 1,000x slip, so every earlier count was multiplied by 1,000. The repair now works on the counts as reported and skips a pair with a split between them | A split explains a jump | `pipeline/orca/engine/sectors.py` (`_unit_slips`, `todays_counts`) |
| Also seen: VCI Global at 3.4% in 2025 Q4 (−92%), likely the same; the next run's "caps heavy" shows | | — |
| Checks: a RedHill-shaped test (fails on the old code); pipeline suite green; demo data unchanged | | `pipeline/tests/test_sectors.py` |

## 2026-11-24 — Run 43: within 10 points of SPY in all years but 2019; thousands slips and five ADR ratios left

| What changed | Why | Files |
|---|---|---|
| Run 43 (`sectors_only`, `main` 4768bb8): all steps green, files published, tab still on hold. Berkshire's market vs SPY: every year within 10 points but 2019 (+19.8% vs +31.2%); 2003 +34.3% vs +28.2% (run 42: +48.8%), 2013 +27.1% vs +32.3% (+20.4%), 2020 +12.8% vs +18.3% (+29.6%). Pershing, Tiger Global and 1649339 the same. Only Apple, Microsoft and Nvidia among real companies reach 4% ("caps heavy"); 1 stock set aside as outsized (run 42: 19) | PR #71 | — |
| Left, from "caps heavy": ADRs without a ratio (Banco Santander-Chile at 4–14% of the market in 89 quarters; HSBC, Vodafone, America Movil, Barclays) and 1,000x slips that are most of a stretch, where the median keeps the slip: Chesapeake Utilities' 10-Qs of 2024–25 report the count in thousands between right 10-Ks (60% of Utilities in 2025 Q1), Methode's first four counts. Now, walking back from a company's latest count, a count within 2.5x of 1,000^k times the next later one is divided by 1,000^k, before the median check | Repair the slips the median cannot see | `pipeline/orca/engine/sectors.py` (`_unit_slips`, `todays_counts`) |
| ADR ratios from each 2026 20-F: Banco Santander-Chile 400, HSBC 5, Vodafone 10, America Movil 20, Barclays 4 | Counted in ordinary shares | `pipeline/orca/hierarchy/data/share_overrides.csv` |
| Known limit: before 2009 (no SEC count yet) a company's earliest count stands in, so one that issued many shares in 2008–10 reads too big before then (Citigroup 4–7% in 1999–2007, Lloyds). Years before 2013 are within 7 points of SPY all the same | No count to use | — |
| Checks: one new test (thousands slips in most of a stretch; a doubling diluter left alone), two updated (slips now divided out, not dropped); pipeline suite green; demo data unchanged | | `pipeline/tests/test_sectors.py` |

## 2026-11-24 — Positions table: the mouse wheel steps the period again (desktop only)

| What changed | Why | Files |
|---|---|---|
| The mouse wheel over the Positions table steps the period picker, same rules as over the tree map: down = earlier, only from rest (a page scroll in the last 300 ms keeps scrolling the page), the selected pill springs back at the ends. The picker lost this when it moved into the Holdings panel (PR #46) and the table had no wheel of its own | Owner: "reinstate as identical as the treemap" (chat) | `fund/PeriodPicker.tsx` (new `wheelOn` prop), `fund/HoldingsTab.tsx` (owns the table ref), `fund/HoldingsPanel.tsx`, `fund/PositionsPanel.tsx`, `fund/PositionsTable.tsx` (`wrapRef`) |
| Wheel only, no swipe: a phone is too narrow for the 12 columns, so a sideways finger swipe on the table must keep scrolling them. Touch scrolling fires no wheel events, so nothing else was needed for phones | Owner: "do not put this for mobile" (chat) | same |
| A sideways wheel (shift + wheel, a trackpad swipe: \|deltaX\| > \|deltaY\|) is now left to the browser everywhere the picker listens, so a narrow desktop window can still scroll the table's columns | Without it the table's columns could not be scrolled with a trackpad | `fund/PeriodPicker.tsx` |
| Checks: 3 new tests (wheel on the table, sideways wheel, swipe on the table vs the tools); typecheck and all 1,207 web tests green; checked in Chromium on the demo fund (wheel steps Q2 ’26 ↔ Q1 ’26, page does not move, sideways wheel does nothing). Side effect to know: with the pointer over the table and the page at rest, a wheel turn changes the quarter instead of scrolling the page | | `tests/fund-positions-ui.test.tsx`, `tests/holdings-harness.tsx` |

## 2026-11-24 — Run 42: splits fixed; bad early SEC counts and three ADR ratios are what is left

| What changed | Why | Files |
|---|---|---|
| Run 42 (`sectors_only`, `main` d15b8dc): all steps green, files published, tab still on hold. Market vs SPY per year (Berkshire): 2021 +19.8% vs +28.7% (run 41: +1.4%), 2022 −15.1% vs −18.2% (−31.9%), 2025 +23.4% vs +17.7%. Still off by 10+ points: 2000, 2003, 2004, 2013, 2014, 2019, 2020. Big names no longer set aside, except Chipotle, Netflix and Qualcomm in 2 to 4 quarters | The split-basis fix (PR #69) | — |
| What is left, from the movers log and the SEC's own data: the first XBRL cover pages (2009–11) often scaled the count 1,000x or 1,000,000x (Truist 648 trillion shares, West Pharmaceutical 33 trillion, EOG and Sanmina 1,000x; BioNTech's first two 20-Fs 1,000x). PR #69's earliest-count fallback carried such a slip back to 1999 (EOG, Sanmina, Truist at 5–15% of the market for 40+ quarters). New `todays_counts`: each count goes to today's share basis, then any count 5x or more off the median of the 9 around it is dropped and its neighbours stand in | Bad counts, not prices | `pipeline/orca/engine/sectors.py`, `pipeline/orca/shares_hist.py` |
| ADR ratios added from each company's 2026 20-F: Banco de Chile 200, Ecopetrol 20, Lloyds 4 (each 8–28% of the market in some quarters) | Counted in ordinary shares | `pipeline/orca/hierarchy/data/share_overrides.csv` |
| The movers log also names every stock at 4%+ of the market ("caps heavy", quarters and top weight), so an overweight stock shows even when its price stood still | Find what is left without another blind run | `engine/sectors.index_returns`, `run/sectors_step._log_caps` |
| Checks: three new tests (slips dropped, the earliest clean count used, heavy stocks listed); pipeline suite green; demo data unchanged. Unexplained: WW International's 9.6% in 2018 Q2 (its SEC counts look right; maybe its price history) | | `pipeline/tests/test_sectors.py` |

## 2026-11-24 — Run 41: the filters dropped big names at their splits; share counts now follow the splits

| What changed | Why | Files |
|---|---|---|
| Run 41 (`sectors_only`, `main` 28da3bd): all steps green, files published, tab still on hold. The new count-jump filter set aside big names at their split quarters (Nvidia, Amazon, Apple, Netflix, Mastercard, Tesla, Chipotle), and reverse-split penny stocks (BioLineRx, Ridgetech, Meiwu, Greenlane, MSP Recovery) still weighed 4–14% of the market in single quarters. Berkshire's market IRR fell to +4.8% a year (SPY +11.6%); years still off (2003, 2005, 2009, 2013, 2021, 2022, 2024) | The "caps movers" and "caps set aside" lines | — |
| Root cause: a quarter-end price after a split was paired with a share count dated before it (the count filed by the quarter end is often months old), so caps read 10x too small after a split and 50x too big after a reverse split. Now cap = split-adjusted close × the filed count turned to today's share basis by the splits dated after the count's own date. Price and count always stand on the same basis | Proper fix instead of more filters | `pipeline/orca/engine/sectors.py` (`market_caps(..., splits)`), `pipeline/orca/shares_hist.py` (`shares_asof` returns `end`), `run/sectors_step.py` (collects the splits from the daily bars) |
| Before a company's first filed count, the cap now uses that earliest count (on today's basis), not today's count: companies that later issued 1000s of times their shares (most of the penny stocks above; foreign filers whose SEC counts start in 2017+) read as giants in 2013 | Second source of the penny-stock weights | same |
| Checks: two tests rewritten/new (a 10-for-1 split and a 1-for-50 reverse split between count and quarter end; the earliest-count fallback); pipeline suite green. Next: merge, run `sectors_only`, compare years with SPY for Berkshire, Pershing, Tiger Global, then ask to lift the hold | | `pipeline/tests/test_sectors.py` |

## 2026-11-24 — Run 40: the guard caught 64 bad caps; years still off, so two more filters and a movers report

| What changed | Why | Files |
|---|---|---|
| Run 40 (`sectors_only`, `main` d8aae32): all steps green; 15,489 funds' files published (175.6 MB, largest 44.8 KB); the Specialization tab stays on hold. The cap report found far more than LATAM: single-quarter share counts ~10^6 too big for large US companies (Oracle q−2, Clorox q0, Exelon q−11, Yum q15, Chubb, Truist, AEP...) and reverse-split penny stocks read as quadrillions (Top Ships for 31 quarters, Biodexa, Aditxt, Euronet q32). The 15% guard set aside 64 stocks | First run with the cap report | — |
| After it: no sector has one stock over 38% (Communication), and Berkshire's market IRR is +8.5% a year (SPY +11.6%). But years still differ from SPY: 2013 +66% vs +32%, 2018 +37% vs −5%, 2021 +2% vs +29%, 2022 −32% vs −18% (Berkshire, Pershing, Tiger Global alike) | Errors too small for the 15% guard | — |
| Two more filters in `index_returns`: a quarter whose implied share count (cap ÷ close) moves 5x or more against the quarter before loses its cap (the stock sits out the next quarter's weights), and a quarterly return over +300% sits out. Each indices run now also logs, per quarter, the stocks that moved the market 3 points or more ("caps movers"), with weight and return. The set-aside log says why ("count jump", "price jump", "outsized"). Demo unchanged | Name the remaining culprits by year, and drop the slips the report showed | `pipeline/orca/engine/sectors.py`, `run/sectors_step.py`, `tests/test_sectors.py` |

## 2026-11-23 — The culprit: LATAM Airlines' ADR ratio; a guard and a cap report for the indices

| What changed | Why | Files |
|---|---|---|
| `labels.json` put the giant in Industrials > Transportation & Logistics > Airlines (98.98% of 19 stocks). LATAM (LTM, stock 1334) is an ADR of 2,000 common shares with ~604bn shares out, and `share_overrides.csv` had no row for it: its cap read as ~$21tn. Added `LTM,2000` | Run 39's absurd market index (WORKLOG below) | `pipeline/orca/hierarchy/data/share_overrides.csv` |
| Guard: in a quarter with 100+ stocks, a stock whose start-of-quarter cap is over 15% of all labelled caps (the biggest real ones are ~7%) sits out of every index that quarter, repeated until none is; the sectors step logs each with ticker, name and quarters ("caps set aside") and flags it | So the next missing ADR ratio or unit slip cannot swing the market again | `pipeline/orca/engine/sectors.py` (`_set_aside_outsized`, `index_returns(..., set_aside)`), `run/sectors_step.py` |
| Cap report in every indices run's log ("caps market/sector/jumps"): the 15 biggest shares of the market in any quarter, stocks that are half or more of a sector of 10+, and caps that jumped 5x in a quarter with the close under 2x. Tickers and caps only | Names the next bad count instead of hiding it | `engine/sectors.cap_report`, `run/sectors_step._log_caps` |
| Checks: pipeline 1,091 tests green (two new); demo unchanged (24 stocks, the guard does not apply). Next: merge, run `sectors_only`, read the "caps" lines, check Berkshire's market replay, then lift the Specialization hold | | |

## 2026-11-23 — Famous funds and Top funds: the table on the chart's grid

| What changed | Why | Files |
|---|---|---|
| The ranked lists' Table view is its own component, `RankTable`, laid out on the chart's grid so Chart ↔ Table moves nothing: the same 42px header strip with one hairline (labels on its foot, "Fund" over the names), 46px rows (48px on a phone), photo 32px / 14px gap / 252px name column, the chart's hover band 8px past each side, no row or column lines. Measured in Chromium: header strip, first rows, names and photos at identical pixels in both views at 1440px and on an iPhone 13. Columns: Fund (photo or initials, short name with the legal name as its title, person · filed until), Return / yr (where the chart's plot starts; one decimal; the S&P 500 figure over its heading, as on the chart's axis), AUM ("$3.6B"), Positions, Max drawdown (one decimal), Sharpe. A click anywhere on a row opens the fund. Sorting (incl. Famous funds' most-popular cycle) and paging unchanged; the foot is the chart's (caption left, page buttons right, no rule) | Owner: the table should match the chart's axis, border lines, alignment and spacing and "look seamless when users switch"; no return bars in the table (the chart has them) (chat) | `web/src/home/RankTable.tsx`, `web/src/home/rankTable.css`, `web/src/pages/Home.tsx`, `web/src/lib/sort.ts` (`setSort`), `web/src/home/FamousChart.tsx` (exports `Photo`) |
| Phone (< 560px): each fund is the chart's phone row (photo, name, and under it "$3.6B • 56 pos • Max DD −12.4% • Sharpe 2.31" where the chart has AUM • person), the return on the right; a Sort by menu sits in the header strip in place of the headings (kept for screen readers) | Owner chose two-line rows earlier (chat) | same |
| Removed the old Famous/Top table pieces (`TOP_COLUMNS`, `PersonFund`, `personColumns`, `famousColumns`, `components/Face.tsx`, `.home .face`/`.fund-row` CSS) | Unused after the change | `web/src/pages/Home.tsx`, `web/src/pages/home.css`, `web/src/home/famousChart.css` |
| Checks: web 1,203 vitest (new: the grid's cells and row click; phone Sort by) and 102 Playwright green; typecheck clean | | `web/tests/home.test.tsx`, `web/tests/home-famous-chart.test.tsx` |

## 2026-11-23 — Run 39 published the sector files; the market index is wrong, so the tab is held

| What changed | Why | Files |
|---|---|---|
| Run 39 (`sectors_only`, `main` 6f249d6): indices and scores 24 min, sector files 25 min, upload 4 min, cache cleared. Live: `sectors/scores.json` (15,489 funds; 3,082 eligible for the map at industry level), `sectors/labels.json` (322 labels), every scored fund's `skill.json` | The dollars-as-decimals fix (PR #63) let the CUSIP guard pass | — |
| The numbers are wrong. Orca's whole-market index swings absurdly (Berkshire's market replay: 2008 −84%, 2011 −84%, 2013 +157%, 2022 −83%; IRR −17% a year) while SPY is sane. `labels.json` at Q3 2026: one stock is 96.6% of Industrials > Transportation & Logistics (91 stocks) and 76.7% of Industrials (544 stocks); Business Services > Other Commercial Services has one at 84%. A bad market cap (likely an ADR counted in ordinary shares, or a share-count unit error) dominates the cap-weighted indices | Found when checking Berkshire after the run; the sector indices were never sanity-checked quarter by quarter (plan phase 4) | — |
| Proposed hold: the production build sets `VITE_SPECIALIZATION=hold`, and the Specialization tab says "Being checked" and loads nothing, until the indices are fixed. Dev, tests and the demo are unchanged | Wrong numbers should not stay on the site | `web/src/fund/SkillPanels.tsx`, `web/src/pages/Fund.tsx`, `.github/workflows/web.yml`, `web/tests/fund-skill-ui.test.tsx` |
| Next: find the stock (a diagnostic in the sectors step: per quarter, the biggest weights in Market and each sector, and caps that jump ×5 or more), fix its cap (ADR ratio in `share_overrides.csv`, or a guard that sets such caps aside), re-run, check Berkshire and a few funds, then lift the hold | | |

## 2026-11-23 — Home: tighter top, no group names, "Search" button

| What changed | Why | Files |
|---|---|---|
| The top bar's button reads "Search" (was "Open fund"; it still opens the best match, as Enter does) | Owner struck "Open fund" and wrote "Search"; chose a button named Search (chat) | `web/src/components/FundSearch.tsx`, `web/tests/home.test.tsx` |
| Famous funds' group names (Popular, Investing style, Type of investor) and the lines under them are gone; the names stay for screen readers. Their grid rows collapse, so the lists sit straight under the tabs; on mid-width pages a later group keeps a 12px gap | Struck out; owner chose to drop the lines too (chat) | `web/src/home/famousChart.css` |
| Gaps tightened: top bar → page 32 → 20px on every page (`main`), home title → tabs 24 → 12px, a list's name → its chart 38 → 22px (the axis header 46 → 42px) | Owner's ↕ marks, "tighten them all" (chat) | `web/src/styles.css`, `web/src/pages/home.css`, `web/src/home/famousChart.css` |
| Checks: web 1,201 vitest and 102 Playwright green; typecheck clean | | |

## 2026-11-23 — Tree map: wheel and swipe change the period

| What changed | Why | Files |
|---|---|---|
| The mouse wheel over the tree map steps periods, as over the picker's header and tools (down = back in time; only from rest, so a page scroll passing over the map keeps scrolling). On touch screens a sideways swipe on the tree map, the period tools or the header steps one period (left = later, right = earlier); `touch-action: pan-y pinch-zoom` keeps up-and-down scrolling and pinch zoom with the page; the lift after a swipe does not also press a pill | Owner: "when i scroll with my mouse on the treemap itself, it should scroll between quarters … on mobile, i should be able to swipe" (chat). The earlier "animations don't work" was Windows' Animation effects being off (owner turned it on); the label-glide fix stays | `web/src/fund/PeriodPicker.tsx` (`alsoOn`), `web/src/fund/HoldingsPanel.tsx`, `web/src/fund/holdings.css`, `web/tests/fund-holdings-ui.test.tsx` |
| Checks: web 1,201 vitest green, typecheck clean; in Chromium the wheel over the map steps without scrolling the page, and on an emulated iPhone 13 swipes step one period each while a vertical swipe scrolls | | |

## 2026-11-23 — Tree map: big tiles' text glides with the box

| What changed | Why | Files |
|---|---|---|
| The larger labels on big tiles (PR #62) changed size at once when a period step resized the tile, while the box still glided, so big tiles looked like they jumped. The label scale now tweens with the box (same 600 ms curve) | Owner: "treemap animations don't work consistently … worked before the last push" (chat). Checked live in headless Chrome (1440 px, 1.25× and 1.5× scale, real scrollbars, direct load, search, Back, browser back/forward, quarter and year steps): the boxes moved every time; the snapping text was the one change to the motion. Not reproduced otherwise: owner asked what exactly they see | `web/src/fund/treemapView.ts`, `web/tests/fund-treemap-view.test.ts` |

## 2026-11-23 — Run 38 (`sectors_only`): the CUSIP guard stopped the sector files; dollars now keep their decimals

| What changed | Why | Files |
|---|---|---|
| Run 38 (`main` 4b9a157, started by Claude at the owner's request): indices and scores in the main step (27 min, saved). "Sector files" computed every chunk (29 min, peak 7.1 GB of 16 GB) and then the CUSIP guard refused 80 staged `skill.json` files, so nothing was uploaded: the site and its manifest are unchanged | Dollar amounts were rounded to whole dollars, and a bare 9-digit number can equal an all-digit CUSIP (Microsoft's is 594918104); the other files keep decimals, which the guard skips | — |
| Dollars in the sector files are rounded to the cent and always written as decimals; a regression test runs the guard on such a value. Contract notes it. Demo data rebuilt | So the next run publishes | `pipeline/orca/run/sectors_step.py` (`_dollars`), `pipeline/tests/test_skill_detail.py`, `pipeline/contract.md`, `web/public/demo-data/` |

## 2026-11-23 — UI trims from the owner's marked-up screenshots

| What changed | Why | Files |
|---|---|---|
| Fund search (with Open fund) and the day / night switch moved into the top bar, on every page. The fund list now loads only when the reader points at or focuses the search, so a fund page fetches no `funds.json` for it; the box empties on a page change; on phones Open fund is hidden (Enter opens the best match) | Owner's mark-up: arrows moving search, Open fund and the switch up; "Search" drawn in the fund page's top bar (chat) | `web/src/components/FundSearch.tsx`, `components/search.css`, `web/src/App.tsx`, `styles.css`, `pages/Home.tsx`, `pages/home.css`, `fund/FundHeader.tsx`, `pages/Position.tsx`, `NotFound.tsx`, `PhotoCredits.tsx`, `state.css` |
| Fund page: a round Back button before the fund's name (the browser's Back when the reader came from this site, else Home); on screens ≥ 1320px it hangs in the left margin so the name keeps the content edge | Owner circled a "<" left of the title (chat) | `fund/FundHeader.tsx`, `fund/returns.css` |
| Tree map: labels on big tiles drawn up to 2.2× larger (`labelScale`, fitted as if the tile were w/k × h/k); legend and caption under it removed (kept as hidden text for screen readers) | Owner: "Larger Font"; legend and caption struck out (chat) | `fund/treemap.ts`, `fund/treemapView.ts`, `fund/HoldingsPanel.tsx`, `fund/holdings.css` |
| Key-figure tiles: the sparkline sits beside the number, not at the bottom by the note (under it on narrow phones); the whole-period tiles' numbers (Turnover, Average hold, Positions profitable) no longer sit 6px lower than the others | Owner's arrows on the sparklines and the 70% (chat). Read as "move up"; the 6px pad was for the risk tile's sub-labels | `fund/returns.css` |
| Return constituents: the one-line headline is hidden (screen readers keep it) | Struck out (chat) | `fund/DrivePanel.tsx` |
| Home: Famous funds' heading and standfirst hidden (h2 kept for screen readers), "50 funds" count removed; the "… leads with … beat the S&P 500" line removed from Famous funds and Top funds (`leadLine` deleted) | Struck out (chat) | `pages/Home.tsx`, `home/famousChart.ts` |
| Follow-up, same day: Top funds trimmed like Famous funds (heading hidden, standfirst and "1,509 funds" count removed; `standfirst`/`periodPhrase` deleted). With no standfirst, the chart's axis now says "Estimated return a year" on every width (it said "Est. return a year" on phones only), so the bars stay labelled as estimates. The key-figure pictures now fill the tile's free space beside the words (stretched SVG, lines keep their width, the dot stays round); under 420px they sit under the number | Owner: "All 3" for Top funds; "make them take up the space in the boxes up top" (chat) | `pages/Home.tsx`, `home/famousChart.ts`, `home/famousChart.css`, `home/FamousChart.tsx`, `fund/KpiStrip.tsx`, `fund/returns.css` |
| Checks: web 1,198 vitest and 102 Playwright (1280/400, light/dark) green; typecheck clean | | tests, `web/e2e/smoke.spec.ts` |

## 2026-11-23 — Licensing approved; PR #61 merged

| What changed | Why | Files |
|---|---|---|
| The owner approved the licensing gate (Tiingo, Damodaran) and asked for the merge of PR #61 (Specialization tab, sector files). Next: Actions › Pipeline with `sectors_only` publishes the first real sector files; until then every fund's Specialization tab says "Not scored yet" | Owner: "Ok with licensing, go for pr and merge" (chat) | `docs/DECISIONS.md` |

## 2026-11-22 — Sector panels moved to their own tab, Specialization

| What changed | Why | Files |
|---|---|---|
| New fund-page tab **Specialization** (`#specialization`), right of Analysis, with the four sector panels in order: map, Annual return stacked graph (Stacked ↔ Lines), Sector mix over time, Which decisions made the gap. Analysis is back to key figures, AUM, Return constituents, What if. A fund without a sector file shows "Not scored yet" there; the file loads when the tab first opens. Tabs tighter under 420px (four fit at 360px) | Owner: "don't put these … in the analysis tab. Make a separate tab to the right called Specialization" (chat) | `web/src/fund/FundHeader.tsx`, `web/src/pages/Fund.tsx`, `web/src/fund/SkillPanels.tsx`, `web/src/fund/returns.css`, tests, `web/e2e/smoke.spec.ts` |
| Checks: web 1,200 vitest and 102 Playwright (1280/400, light/dark) green; typecheck clean | | |

## 2026-11-22 — Sector choice vs stock choice built: pipeline files and four panels (first on Analysis)

| What changed | Why | Files |
|---|---|---|
| Contract: `sectors/labels.json`, `sectors/scores.json`, `fund/{id}/skill.json` (Sector files) | Spec 2026-11-21 phase 1; contract first | `pipeline/contract.md` |
| `engine/skill_detail.py`: each fund's replays valued every quarter end, time-weighted quarterly returns (fund, label per tier, market, SPY), calendar years with `summary.json` labels, IRRs of the 30 biggest positions and of every label bought (with the market's share when bought), the book's mix by vertical, the label list. `skill.replay` can return units; `irr_by` takes a step count (64 = a double's precision) | Spec §6. Modified Dietz (the spec's formula) inflated years with big sales; time-weighted returns at the trade do not (DECISIONS 2026-11-22) | `pipeline/orca/engine/skill_detail.py`, `engine/skill.py`, `tests/test_skill_detail.py` |
| `orca.run sectors --part publish` stages the files for every fund the site lists, runs the CUSIP guard and adds them to the manifest. The monthly run never counts them as owed and carries them in its manifest. Workflow: stage, upload, purge after "Save the score tables" (and after a `sectors_only` run), each `continue-on-error`, 90-minute step | Spec §7.2. Without the bookkeeping change every scored fund would be recomputed each month | `run/sectors_step.py`, `run/publish_step.py`, `run/weekly.py`, `run/cli.py`, `.github/workflows/pipeline.yml`, `tests/test_run.py` |
| Demo: the real sector step runs on the demo lake; `web/public/demo-data` has the three new files (12 funds, ~240 KB plain) | Spec §7.6; dev, vitest and Playwright see the panels | `pipeline/orca/demo.py`, `web/public/demo-data/` |
| Web: "What kind of investor?" (top of Analysis), then after the key figures "Annual return stacked graph" (AUM twin, Stacked ↔ Lines with the S&P 500), "Sector mix over time", "Which decisions made the gap". One Sector / Industry / Sub-industry switch, default Industry. Table view on every panel; wide charts scroll inside their box on phones. Twelve `--sec-*` colours. Famous lists' order moved to `data/famousGroups.ts` | Spec §5, §7.3–7.5 | `web/src/fund/SkillPanels.tsx`, `SkillMapPanel.tsx`, `StackedPanel.tsx`, `MixPanel.tsx`, `DecisionsPanel.tsx`, `skill.ts`, `stacked.ts`, `mix.ts`, `decisions.ts`, `skill.css`, `web/src/pages/Fund.tsx`, `web/src/data/*`, `web/src/tokens.css` |
| Checks after merging main (#57–#60): pipeline 1,088 tests green (offline); web 1,198 vitest and 94 Playwright (1280/400, light/dark) green; typecheck clean. The map now uses main's short fund names (`lib/famousNames.shortNameOf`). A local 640,000-trade synthetic chunk: detail 14 s (scores 4.4 s), peak 2.1 GB | Spec §8 | `web/tests/fund-skill.test.ts`, `fund-skill-ui.test.tsx`, `web/e2e/smoke.spec.ts` |
| Not done: "never rotated" (spec §6.9, optional; `v_never` is null). Not run on real data yet: the owner's Actions run (`sectors_only` on the merged branch) gives the first real files; licensing (Tiingo, Damodaran) must be confirmed before merging to `main` | Spec §8 phase 9; DECISIONS 2026-11-21 | — |

## 2026-11-22 — Top funds made consistent with Famous funds; Index giants removed

| What changed | Why | Files |
|---|---|---|
| Top funds is the Famous funds module: h2 + standfirst, Period and Chart \| Table, then "Funds over $1B" with its count and lead line ("Anatole leads with +138.2% a year. 321 of the 1,509 beat the S&P 500; 20 lost money."), the chart, and the rules + source under it. No card: chart and table on the page background (section classes `ranked top-funds`; famousChart.css now styles `.fp .ranked`, shared with `ranked famous`) | Owner: same UI and design as Famous funds (chart first, colours, headings) | `web/src/pages/Home.tsx`, `web/src/home/famousChart.css` |
| The chart shows 80 funds a page in its 20-row window (phone 10); Previous / Next sit beside the caption ("Showing 81–100 of 1,509 · one scale for this page"); row labels and the lead label use the place in the whole list (`FamousChart` `offset`, `total`, `foot`). Table view: 80 a page, buttons below | Owner: 20 funds before scrolling, Next after 80 | `web/src/home/FamousChart.tsx`, `famousChart.ts` (`captionText` total, `leadLine` thousands, `standfirst` sort note) |
| Short names (`shortNameOf`) and a photo or initials on every row; a famous fund also shows its person (from the file's famous rows). `fundShortName` names a "dba" filer by its trading name | Owner: images/initials and simpler names | `Home.tsx`, `web/src/lib/format.ts` |
| Index giants list removed from the page (still in `top_{period}.json`) | Owner | `Home.tsx`, `docs/PRODUCT.md`, `docs/DECISIONS.md` |
| Tests: home.test.tsx (chart, 80-a-page chart and table, person/initials, giants not listed), helper tests, e2e Top funds chart at 1280/400 light/dark (90/90 pass); checked on production data at 1280/400, light and dark | — | `web/tests/`, `web/e2e/smoke.spec.ts` |
| Open: each page has its own scale, so bars compare within a page, not across pages; individual filers keep SEC word order ("Gendell Jeffrey L"); some short names are bare words ("Main", "Todd") — the full name is in the tooltip and the table | — | — |

## 2026-11-22 — Famous funds table: 30 rows a page on a phone

| What changed | Why | Files |
|---|---|---|
| The Famous funds Table view shows 30 funds a page on a phone (< 560 px); desktop stays at 10 | Owner request | `web/src/pages/Home.tsx` (`FAMOUS_PAGE_PHONE`), `web/tests/home-famous-chart.test.tsx` |

## 2026-11-21 — Tree map on a first visit, Chrome's glide, the Famous funds list index

| What changed | Why | Files |
|---|---|---|
| The tree map draws on a first visit at any browser zoom. The draw waited until the measured box matched the width hook exactly, but at a zoom other than 100% the box is fractional: clientWidth rounds (1150) where the hook floors the ResizeObserver width (1149), so a cold load whose prices came after the first measure never drew (reproduced at 80/90/110% in Chromium). A return visit drew only because cached prices landed before the observer fired. Within 1 px now counts as the same size | Owner: "the tree map doesn't appear when first opening a fund page; it does the second time, with no animation" | `web/src/fund/HoldingsPanel.tsx`, `web/tests/fund-holdings-ui.test.tsx` |
| The Famous window's glide moves every frame in Chrome. Chrome keeps a scrollTop set from script in whole CSS pixels (10.25 → 10, also at 2x), so the slow start and settle were 1 px hops with 33–133 ms stalls. The box takes the whole pixels and the list a sub-pixel translateY; the target is a whole pixel so nothing stays shifted at rest | Owner: "the scrolling still feels abrupt and without smoothing in Chrome; smooth on iOS Safari" (iOS scrolls natively) | `web/src/home/useEasedScroll.ts`, `web/tests/home-famous-chart.test.tsx` |
| The list switch is a list index: equal grid tracks in three labelled groups (Popular: Most searched as one tall cell with five faces; Investing style 4 columns; Type of investor: Family offices, Big companies, Sovereign & pension funds), 1 + 4 + 1 columns × 3 rows from 1140 px of content, four tracks at 760–1139 px; below that the names in one swiped row (the next one cut and faded at the edge) with "All 16" pinned beside it over the device's own grouped select (owner: a closed picker alone hides the names, few would open it). The period and Chart \| Table sit on one toolbar on the same tracks, both 32 px on one line (checked at 90/110/125% zoom too); a phone's periods read 1y … Max. Chosen from three mocked concepts (side rail; one toolbar with a list menu; this) because every list stays in view and the chart keeps its width. `Choice wrap` and the two-way Seg thumb are gone (unused) | Owner: "tidy up the bar ... it isn't symmetrical ... and Chart/Table looks like it sits higher than the period bar"; design agents | `web/src/home/listIndex.ts`, `ListIndex.tsx`, `famousChart.css`, `web/src/pages/Home.tsx`, `web/src/components/Choice.tsx`, `web/src/fund/Seg.tsx`, `base.css`, tests, `e2e/smoke.spec.ts` |
| Open: the groups (and Tiger cubs under Investing style) are this session's call, for the owner to confirm. Chart \| Table measured level with the period before the change too (y 395.7, 32 px, headless Chrome), so the old offset was not reproduced; the toolbar now shares tracks and a height by construction | — | — |

## 2026-11-21 — Famous funds chart after launch: one scale per list, wrapped list switch, 20 rows

| What changed | Why | Files |
|---|---|---|
| The chart keeps one scale per list: `windowDomains` gives a fixed span (the widest window's need; a window with a loss also keeps room for its labels) and the left end each window allows; `domainAt` slides the axis along a smoothed Catmull-Rom track. Caption "· one scale for the whole list" | Owner: a bar changing length as you scroll (the fitted scale) was misleading | `web/src/home/famousChart.ts`, `FamousChart.tsx` |
| The list switch wraps onto 2–3 rows above the period and Chart \| Table (`Choice wrap`; Seg's thumb moves in both directions); a phone keeps one swiped row | Owner: the one-row switch overlapped the period | `web/src/components/Choice.tsx`, `web/src/fund/Seg.tsx`, `base.css`, `famousChart.css`, `Home.tsx` |
| Desktop window shows 20 funds (was 15); PgUp/PgDn 19 rows | Owner request | `FamousChart.tsx` |

Shipped as PR #57 (merged 825b7a5) and the `home_only` run the same morning (S&P 500 3y +22.7%, 5y +13.7%).

## 2026-11-21 — Famous funds ranked return chart built (merged as PR #57)

| What changed | Why | Files |
|---|---|---|
| Home's Famous funds lists are one ranked return chart each (Most searched + 15 styles): sorted by return, scale fitted to the rows in view, eased scroll, S&P 500 total-return dotted line, Chart \| Table switch (Table keeps popularity order). Pipeline publishes `spx` in `home/top_{period}.json` | Owner-approved design (spec) | `web/src/home/`, `web/src/pages/Home.tsx`, `web/src/lib/famousNames.ts`, `web/src/lib/format.ts` (`fundShortName`), `pipeline/orca/` (spx), `pipeline/contract.md` |
| Phone pass at 400 px on production data (all six periods, every list): `PHONE_SHORT` names for every name that ellipsised; `SHORT_NAME` for venture filers named by their legal vehicle (IVP, TCV, Kleiner Perkins, Sequoia Growth); `fundShortName` never returns "" | Phone checks | `web/src/lib/famousNames.ts`, `web/src/lib/format.ts` |
| Axis ticks: the spec's step by span (desktop 5/10/20, phone 10/20), raised to the smallest of 5, 10, 20, 40, 50, 100, 200, 500 that keeps labels ≥ 48 px apart on the measured plot (`ticksFor(dom, phone, innerW)`; replaces the phone-only step 40). The axis header clips ticks parked past the plot (they widened the page at 1216–1248 px) | Labels overlapped below 1280 px (1y Venture capital) | `web/src/home/famousChart.ts`, `famousChart.css` |
| Scroll speed: React renders only when the whole row at the top changes; memoised rows; `paint` writes bar, label, tick and line positions to the DOM for the rows near the window, skipping unchanged values; the finished grow-in is taken off; the window has the page colour behind it so Chrome scrolls it on the compositor at 1x. 4x CPU, review perf script: p50 33.3 → 16.7 ms (400 and 1280 px), p90 33–50 → 16.8 ms (1280 px: 33 ms in some runs). Positions identical to the pixel | Review: 33 ms frames | `web/src/home/FamousChart.tsx`, `famousChart.css` |
| Review fixes: wheel events that are not cancelable and sideways swipes pass through; the caption's live region speaks only once the window settles (300 ms); a phone row's spoken label holds its shown short name (WCAG 2.5.3); phone axis "Est. return a year"; placeholder initials keep a leading acronym (IVP, TCV, NEA); AUM under $0.05B prints "<$0.1B"; phone names "Lightspeed", "N. Carolina pension"; the list switch scrolls the pressed list into view (tab return, fallback) and has no scrollbar on a phone; `run_home` test checks `spx` | Whole-branch review | `web/src/home/`, `web/src/pages/Home.tsx`, `web/src/lib/famousNames.ts`, `pipeline/tests/test_run.py` |
| Playwright smoke for the chart (demo data; a 50-row `top_5y` fixture for the scroll window), 1280/400, light/dark; the list switch keeps the pressed list in view; no sideways page scroll with a wide scale at 1240 px | Done when | `web/e2e/smoke.spec.ts` |
| **After merge:** production has no `spx` until Actions > Pipeline > Run workflow with `home_only`; until then the chart shows no S&P line. Open: a person's line under a name (`.mg`) still ellipsises on a phone for a few long names (e.g. "Paul Marshall & Ian Wace"); long Sovereign & pension names are cut at 1280 px (could reuse `PHONE_SHORT` on the desktop); the acronym phone names (Korea NPS, Saudi PIF, Malaysia EPF, Ohio OPERS, Florida SBA, Wisconsin SWIB, Arizona ASRS, Oregon PERF) await the owner's review | — | — |

## 2026-11-21 — Sector choice vs stock choice on the fund page: design approved, build spec written

| What changed | Why | Files |
|---|---|---|
| Build spec for four Analysis-tab panels that show a fund's sector choice vs stock choice from the existing `engine/skill.py` replays: the map with famous-list peers and a 3-year path, the Annual return stacked graph (AUM style; Stacked ↔ Lines with the S&P 500), sector mix by sector / industry / sub-industry with detected rotations, and the decisions panel (share of money, beat by, Adds). Also the pipeline additions (quarter values and returns of each replay, SPY replay, per-position and per-label IRRs, market share via a new `cap` column, mix), the contract for `sectors/labels.json`, `sectors/scores.json`, `fund/{id}/skill.json`, a `publish` part for `orca.run sectors`, demo data, and phases with done-when checks | Owner: "publish this plan into a document for an LLM to execute", after approving draft v5 ("Wonderful") | `docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md`, `…-draft.html` |
| Owner decisions recorded: panels and order, Annual returns stays on Holdings, S&P 500 reference line (R23 override), "sub-industry" wording; default tier Industry (R9); licensing gate before merging to `main` | So the build session does not re-ask | `docs/DECISIONS.md`, `CLAUDE.md` (Read-X row), plan `2026-11-17-sector-indices.md` (phase 6 pointer) |
| Nothing built; no code changed | Design session only | — |

## 2026-11-21 — Famous chart spec checked against main and made build-ready

| What changed | Why | Files |
|---|---|---|
| Owner answered the last two questions: fund estimates include dividends, so the S&P 500 line is SPY total return, computed in the pipeline over the funds' own window and published as `spx` in `home/top_{period}.json` (a contract change the build makes first); each list's chart sorts by return, the Table view keeps popularity order. Spec status: ready to build, with a paste-in prompt for a new session | Owner, 2026-11-21 | `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md` |
| The spec now follows #55: Most searched membership and the table's opening order use `popularity()` (owner's `rank`, then `fame`, then AUM); no Search interest column anywhere; 15 style lists (Credit & event-driven added). The mock-ups' Table view dropped the column too. Added a build checklist with done-when checks, phone tick margins, and a CLAUDE.md "Read X when" row | Owner: "ensure this documentation is ready for a new LLM session to implement", then merge it to main | `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md`, `…-mock/`, `CLAUDE.md` |

## 2026-11-20 — Home: Famous funds as one ranked return chart (design approved, not built)

| What changed | Why | Files |
|---|---|---|
| Design spec for replacing the Famous funds tables with one full-width bar chart per list: sorted by 5y return, zero line (gains right, losses left), shaded blue/orange by size, labels at the bar tips, S&P 500 dotted line (+12.2% a year, SPY Q3 2021–Q3 2026), a 15-row (phone 10) scrolling window whose scale fits the funds in view and glides with an eased scroll. Written so an LLM or developer can build it cold; mock-ups saved beside it | Owner: "make the home page simpler and more visual with a colourful annual return graph"; approved over several rounds on the claude.ai Design canvas RBrW19wJQpU4mToFrVpG8B (v4 boards) | `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md`, `docs/superpowers/specs/2026-11-20-home-famous-chart-mock/` |
| Open: dividends in fund estimates vs SPY price return; sorting by return vs the 2026-11-18 "most popular first" rule in PRODUCT.md | Owner to decide | — |

## 2026-11-20 — Famous funds: Wikipedia's hedge funds added; rank by the owner's score

| What changed | Why | Files |
|---|---|---|
| famous_rank.csv orders by its `score` column (renamed from `google_score`), higher first, ties in file order; a blank score is not ranked, a non-number fails the tests | Owner edited the numbers, not the line order, and chose "the number decides" | `orca/famous.py` (`load_rank`), `orca/famous_rank.csv`, `tests/test_search.py` |
| 86 rows for the firms on Wikipedia's List of hedge funds (revision 1362551728, 4 Jul 2026) that were missing, every one checked on EDGAR (13F-HR filer, match word in its SEC name); renamed or moved filers get one row per CIK. New style list Credit & event-driven, after Macro | Owner: all of them, all regions | `orca/famous.csv`, `orca/famous.py`, `web/src/pages/Home.tsx` |
| Not added: no 13F filer found for PIMCO, Archegos, Avenue Capital, ESL Investments, K2 Advisors, Revere, SPX Capital, Statar, TGS, Universa, Systematica, G-Research, Navigator Global, SPARX, High-Flyer, Lingjun, Minghong, Ubiquant, Yanfu. Left out on purpose: BlackRock, Goldman Sachs Asset Management, Wellington (their 13F is mostly index and mutual-fund money, not the hedge-fund book). Quantum Fund is Soros Fund Management (already listed) | — | — |
| New rows have no Google Trends score until the next `scripts/google_trends.py` refresh; they follow by AUM. Data appears after a `home_only` run; funds that stopped filing may need one `full` rebuild | — | — |

## 2026-11-20 — Famous funds: the owner's own order (famous_rank.csv)

| What changed | Why | Files |
|---|---|---|
| New `pipeline/orca/famous_rank.csv`: one name per line, top first (a famous.csv `search` keyword, or a CIK for a fund with none). Listed funds lead Most searched and every list's most popular order; the rest follow by Google Trends score, then AUM. A name listed twice or matching nothing fails the tests. Seeded with today's Trends order (108 keywords), so nothing moves until it is edited. Home rows gain `rank` (contract) | Owner wants to rank the famous funds by hand; editing Trends scores would show made-up numbers and be overwritten by the next refresh | `orca/famous.py` (`load_rank`, `apply_rank`, `load_ranked_famous`), `orca/home.py`, `orca/run/sources.py`, `orca/run/weekly.py`, `orca/demo.py`, `contract.md` |
| Most searched has no "Search interest" column and no Trends caption ("The famous funds investors look up most."); it uses the style lists' columns and order | Owner: users don't need the score, only the right funds | `web/src/pages/Home.tsx`, `homeFmt.ts` (`fSearch` gone), `data/types.ts` |
| To publish an edit: merge it to main, then Actions > Pipeline > Run workflow with `home_only` | — | — |

## 2026-11-20 — Home: Famous funds first

| What changed | Why | Files |
|---|---|---|
| Home tabs now run Famous funds, Top funds, Conviction moves, …; the page opens on Famous funds. The period chip is still shared by both lists | Owner: "swap the positions of top funds and famous funds" | `web/src/pages/Home.tsx` (`TABS`, default tab), `web/tests/home.test.tsx` (`openTop` helper), `docs/PRODUCT.md` |

## 2026-11-20 — Fund page: Annual returns to Holdings, AUM to Analysis, tiles 4 and 4

| What changed | Why | Files |
|---|---|---|
| Holdings: four tiles (Annualised return, Max drawdown, Turnover per year, Average hold length), Holdings tree map, Annual returns, Positions. Analysis: four tiles (Years positive, Volatility, Risk-adjusted return, Positions profitable), Assets under management, Return constituents, What if they'd kept it. About: About only. Panels unchanged; only their place moved | Owner approved draft (claude.ai artifact HqU6sXjkXUy91FNa9GoN64, v4) | `web/src/pages/Fund.tsx`, `fund/KpiStrip.tsx` (`group` prop), `fund/HoldingsTab.tsx`, `fund/returns.css` |
| The window, selected year and bracket stay page state: Analysis' span tiles, AUM and Return constituents follow what was picked on Holdings' Annual returns. The phone full-row rule for the profitable tile names `.kpi-prof` instead of `:last-child`, so Holdings' tiles sit 2×2 | Keep the panels as they were | `fund/returns.css` |
| Open, not built: a year picker on Analysis; clicking a year on Holdings to set the tree map period | Raised in the draft | — |

## 2026-11-20 — Tree map: the fund's return for the period beside the weight and the value

| What changed | Why | Files |
|---|---|---|
| Second row of a tile: `12.3% · $80.2B · +4.1%` (weight, value, return; a real minus on losses). Too narrow: the weight goes first, then the return (`$80.2B · +4.1%`, `$80.2B`, `12.3%`); a tile under 39 px tall puts value and return at the right end of the ticker's row. A hollow tile (first tracked quarter, no price) and Other stocks print no return, no dash. Year mode prints the 12-month return. The legend now says "Colour, and the % after each value: the fund's return…"; its label wraps on a phone (the shared `.legend span` is nowrap and the longer text made the page scroll sideways at 400 px) | Owner: "add beside it the return for the quarter" with four rules: shares held before the quarter from the quarter's start price, shares bought in it from the quarter's VWAP, both to the current price (newest quarter) or the quarter-end close (older) | `fund/treemap.ts` (`labelSet`, `LabelTile.ret`), `fund/HoldingsPanel.tsx`, `holdings.css` |
| No new return maths: the figure is `holdingReturn`, which already coloured the tiles and fills the tooltip, and it matches the four rules (checked). The demo-data test `fund-holdings-returns.test.ts` rebuilds each holding's return from the rules as separate lots (carried shares start to end, bought shares VWAP to end, dividends added) on 12 funds, 4 quarters and 2 year-ends and compares; changing how buys are priced or dropping dividends breaks it. Live files already carry the quarter-end closes (`q0`/`qclose` checked on stocks 1, 3, 6 on 2026-11-20) | "Ensure this logic is consistent with the positions table" | `tests/fund-holdings-returns.test.ts` |
| Not the table's Return column: that is the whole life of a position (total P&L ÷ invested), so a long-held stake reads differently there. For a position that began in the period the two are the same number and the test asserts it. A "Qtr return" column in the table would show both side by side; not built, the owner decides | The owner's wording reads as if the table already had the per-quarter figure | `docs/PRODUCT.md`, `docs/DECISIONS.md` |

## 2026-11-19 — Tree map motion: grow-in on landing fixed, no colour animation, words by the midway point, a $ value on every tile

| What changed | Why | Files |
|---|---|---|
| Landing: the grow-in never ran in a real browser. The box is first drawn at the 600 px fallback width and measured a moment later; that re-measure counted as a resize and redrew the tiles finished (jsdom never measures, so the tests passed). The first draw now waits for the measured size, and a redraw within 750 ms of landing (fonts, a scrollbar) joins the landing. Regression tests: a jsdom test with a stubbed `clientWidth` (fails without the fix) and a Playwright test that samples every frame | Owner: "make the rectangles of the tree map form upon page load" | `fund/HoldingsPanel.tsx`, `tests/fund-holdings-ui.test.tsx`, `e2e/smoke.spec.ts` |
| Colours: tiles were drawn beige and tweened to red/green when the weekly files arrived (32 shades per tile on a step). Nothing is drawn now until every tile's prices are in (a "Loading prices…" note meanwhile); a tile has its final colour from its first frame, on landing and on every step, and tiles no longer fade in (a pale red is not the red) | Owner: "I don't want colour animations. Keep it the striking red and green" | `fund/HoldingsPanel.tsx`, `fund/treemapView.ts` |
| Words: hidden until 100 ms, fully in at 250 ms (the box is ~89% there on the curve); a changed text goes out in 70 ms; an unchanged word stays put. Before, they were clipped by the moving box and arrived late | Owner: "find a midway point where you can see most of where the rectangle is going, then have the words completely visible" | `fund/treemapView.ts` (`LABEL_OUT/FROM/FULL`) |
| Speed: already 600 ms on the bars' curve since #50 (900 ms in #48). A test now holds `DUR` and the curve to `--d-grow` and `--ease-out` in `tokens.css`. Measured on the demo build: tiles start moving 58-66 ms after a click (136-140 ms at 4x CPU slowdown), the Analysis bars 123 ms (317 ms) after their tab click; both run 600 ms. A deferred table render was tried and gave nothing, so it was left out | Owner: "start moving (delay) equal to the delay found in the Analysis tab" | `tests/fund-treemap.test.ts` |
| Value on every tile: the second row is `12.3% · $80.2B`, the value alone when both do not fit (the weight alone only when the value cannot); a tile under 39 px tall puts the value at the right end of the ticker's row; Other stocks shows `$ · %` and its stock count on the third row. The value was already the table's: today's prices for the newest quarter, the quarter-end close for older ones. A tile too small for any text (some on a phone) still has only the tooltip | Owner: "ensure all of them have the $ amount" | `fund/treemap.ts` (`labelSet`), `holdings.css` |
| Smaller: a redraw in place no longer schedules 600 ms of idle frames. New `tests/fund-treemap-view.test.ts` drives the view on a hand-turned clock | - | `fund/treemapView.ts` |

- Not live until this branch is merged to `main` (the Web workflow deploys). Open: with real funds the blank wait under "Loading prices…" depends on how many weekly files a fund's tiles need; the demo funds have 9 to 24 holdings, so check Berkshire after the deploy.

## 2026-11-19 — People photos: 33 checked photos; the finder was loosened, then tightened

| What changed | Why | Files |
|---|---|---|
| The People photos workflow ran on a GitHub runner (about 4 minutes; the cloud sandbox is throttled by Wikimedia). The finder now also tries a person's Wikidata image and their Commons category (files named after them), accepts a Wikidata human whose description fits, and logs why each missing person has none (`WHY` lines in the run summary). A first loosened version also searched Wikipedia and Commons by name: it produced wrong faces (a baseball player for Chris Davis, a congressman for Steve Cohen, cartoons, a manuscript). 33 photos were removed by eye; the name search over Commons is gone, the description check is tighter, and a `BLOCK` list in the script keeps the wrong ones from coming back | A wrong face is worse than none. Photos were checked on a contact sheet, but only by eye: the owner should look at the lists too | `pipeline/scripts/fetch_people_images.py`, `.github/workflows/people-photos.yml`, `web/src/assets/people/` |
| 33 photos remain, including Warren Buffett (Berkshire's row; he was missing only because the first workflow run had not been merged yet). About 100 of the 299 "people" are firms, pensions or sovereign funds (no photo by design); of the rest, many have no free photo or no Wikipedia page | — | — |

## 2026-11-19 — Fund page tabs, holdings tree map, quarter-end closes, SEC About

| What changed | Why | Files |
|---|---|---|
| Fund page split into Holdings / Analysis / About tabs (URL hash). Holdings: new tree map (squarify, Other stocks under 1%, colour = fund's return on the holding, green/red through grey, tweened between periods) above the Positions table, one picker for both; Year mode = 12 months to a chosen Q1–Q4 quarter-end; Custom removed. Money in every table is $80.2B (fMm removed). About panel from SEC facts | Owner approved the interactive draft (claude.ai artifact 3J9eYBogzVdLTv6ipm5VGx, v4) | `web/src/pages/Fund.tsx`, `fund/HoldingsPanel.tsx`, `fund/treemap.ts`, `fund/treemapView.ts`, `fund/AboutPanel.tsx`, `fund/PeriodPicker.tsx`, `fund/positions.ts`, `tokens.css` |
| weekly.json gains `q0`/`qclose` (each quarter's close, the engine's valuation price); the web reads it for past quarters, so tiles + table = `summary.quarters.end`. Before this the table took the Friday close before the quarter end (e.g. Berkshire Q2 ’26 $297.9B vs $299.25B) | Owner: tree map, table and book must match | `pipeline/orca/publish.py`, `contract.md`, `web/src/fund/positions.ts` |
| New lake table `fund_about` filled by a budgeted step after the fund publish (two SEC calls per fund, 12,000-call cap, failures flagged); `summary.json` gains `about`. First fill ~16,000 funds spreads over ~3 runs; a fund whose facts change without a recompute is owed a recompute next run | About tab, SEC data only (owner) | `pipeline/orca/sec/about.py`, `run/about_step.py`, `run/weekly.py` |
| Not live until merged and a Pipeline run republishes the weekly files and summaries; until then past quarters fall back to the Friday close and About shows its empty state | — | — |

## 2026-11-18 — Run 31: sector indices and fund scores built and saved

| What changed | Why | Files |
|---|---|---|
| Run 31 (`sectors_only`, `main` 591984a, 27 min after waiting behind backfill run 29) succeeded and saved the lake. Shares: 5,908 companies, none owed (13 min, 163 MB). Indices: 6,765 stocks in 323 labels (default 3,829, placed 1,293, model 798, sic 748, rule 97), 0.01% of last-quarter market value unlabelled and 0.01% on today's share count (2,791 stocks used it in some quarter); peak 2.1 GB. Scores: 2,771 of 2,773 funds scored in 160 chunks of ≤300,000 trades (14 min, peak 4.3 GB of 16 GB), 45,741 ETF positions, 268,056 positions dropped (no label or series), median coverage 78%. Nothing published; phase 6 (contract, publish, web) waits for the owner | Owner: "Ensure the run occurs" | — |

## 2026-11-19 — Famous funds: photo of the person before the fund name

| What changed | Why | Files |
|---|---|---|
| Each Famous funds row shows a round 52 px photo of the person under the fund name (phone 44 px), before the name; rows in these lists are 68 px tall (phone 60; other tables stay 38). A fund with no photo shows no circle, so its name starts at the left edge | Owner: put the founder's photo before the fund name, bigger than the row, easy to replace by hand | `web/src/components/Face.tsx`, `lib/people.ts`, `pages/Home.tsx` (`famousColumns`, `FAMOUS_FUND_W`), `pages/home.css` |
| Photos live in `web/src/assets/people/<slug>.jpg` (slug = the name lower case with hyphens). Any jpg/png/webp dropped in with the same name replaces it; `people.json` maps the text under a fund name to a slug when it differs. Bundled by `import.meta.glob`, so no manifest to keep and a replaced file gets a new URL (no stale cache) | Owner wants to swap images manually | `web/src/assets/people/` (+ `README.md`) |
| `pipeline/scripts/fetch_people_images.py` (by hand, like `google_trends.py`) finds each person's Wikipedia photo on Wikimedia Commons, keeps only public domain, CC0, CC BY and CC BY-SA, crops around the face (OpenCV) to 192 px and writes `credits.json`. Credits show on a new `/photo-credits` page linked from the footer, as CC BY and CC BY-SA require. People with no free photo are skipped. Wikimedia rate-limits the cloud sandbox (HTTP 429), so a run is slow and resumable; a picture with no face found is skipped (a guess cropped to clothing) | Owner: public, copyright-free images; chose CC BY/BY-SA with credits | `pipeline/scripts/fetch_people_images.py`, `web/src/pages/PhotoCredits.tsx`, `App.tsx` |
| New workflow **People photos** (Actions > People photos > Run workflow): runs the script on a GitHub runner, whose network Wikimedia limits far less than the cloud sandbox's, and commits the photos to the branch it was run on. It refuses the default branch (a commit there deploys). 20 photos were in when it was added; the rest come from running it | Owner: a click instead of running a script; the sandbox could fetch only a handful in an hour | `.github/workflows/people-photos.yml` |

## 2026-11-18 — Run 28: monthly run fine, sector scores lost the runner; chunks by trades

| What changed | Why | Files |
|---|---|---|
| Run 28 (`main` e5c8b58): the monthly run published and saved (pipeline 2 h 14 min). The sector step fetched share counts for 5,903 companies (16 min, 156 MB) and built the indices in 12 s (peak 1.25 GB): 6,765 stocks in 323 labels, 0.01% of market value unlabelled. 20 s into the scores the runner got a shutdown signal, before any save, so the tables were lost | Owner asked for the run | — |
| Scores are chunked by trades (300,000 a chunk; was 200 funds, and a few giant funds hold most trades) and one tier is replayed at a time. A local test with 720,000 trades peaks at 1.7 GB in 8 s. The workflow saves the indices before the scores start (two steps, two saves). The fallback health figure counted a stock that used today's count in any quarter (it read 50%); it now counts the last quarter only | The likely cause: one chunk of giant funds replayed 9 ways | `run/sectors_step.py`, `engine/skill.py`, `run/cli.py` (`sectors --part`), `pipeline.yml` |

## 2026-11-18 — Pipeline run 27 lost its runner; sector steps moved out of the monthly run

| What changed | Why | Files |
|---|---|---|
| Run 27 (manual, `main` at 33a9869, the first with the sector steps inside the monthly run) failed at 00:56 UTC, 1 h 49 min in, during "Run the pipeline". GitHub kept no log (404) and no later step ran, not even "Save the lake" (`always()`): the runner itself died, most likely out of memory. Nothing was saved or uploaded, so the lake and the site are as before; the share counts it fetched are lost | Owner asked for the run | — |
| The monthly run now only keeps each fund's trades (`fund_flows`). Share counts, indices and scores run in `orca.run sectors`, a separate workflow step after the lake is saved (`continue-on-error`, then "Save the sector tables" copies only its tables), and the whole job with `sectors_only`. Each part logs its peak memory; chunks are smaller (1,000 stocks, 200 funds) | A draft step must never cost the month's run, and the next failure must say where it grew | `run/weekly.py`, `run/sectors_step.recompute`, `run/cli.py`, `pipeline.yml` |

## 2026-11-18 — Famous funds: every list opens by popularity

| What changed | Why | Files |
|---|---|---|
| Every famous list opens with its most popular fund first: Google Trends score, then AUM. The Fund heading cycles A–Z, Z–A, most popular (shown as "most popular" beside it); from another column it starts at A–Z | Owner: rank every fund by search or popularity, and let users get back to it by clicking Fund | `web/src/pages/Home.tsx` (`popularity`, `famousColumns`), `lib/sort.ts` (`cycle`, `orders`), `components/DataTable.tsx` (`alt`) |
| New `fame` on every famous row: its keyword's score on all rows of the keyword (`search` stays on one filer per keyword for Most searched). Needs a Pipeline run before the order shows live; until then every fund falls back to AUM | Sequoia's other filers need the score to sort with their firm | `pipeline/orca/home.py`, `contract.md`, `web/src/data/types.ts` |

## 2026-11-17 — Pre-2013 13F history (1999 to mid-2013) from the old text filings

| What changed | Why | Files |
|---|---|---|
| New source `legacy`: every 13F-HR / 13F-HR/A in the EDGAR full index 1999Q1–2013Q3 not already stored, its free-text table read by CUSIP check digit and stored only when it agrees with the filer's declared entry count or value total (or declares none); a check row per filing in lake table `legacy_checks` | Owner: "fully utilise pre-2013 SEC 13F data". The bulk data sets start with 2013 Q2 filings, so even Q1 2013 was missing (Berkshire began Q2 2013) | `pipeline/orca/sec/legacy.py`, `run/ingest.py` (`ingest_legacy`) |
| New command `backfill` (Pipeline input `backfill`): legacy filings until 40 min of the budget are left, then new CUSIPs, vendor tickers and older prices; computes and publishes nothing | ~160,000 downloads at 8/s ≈ 5.5 h: two runs, then one ordinary run computes | `run/weekly.py` (`run_backfill`), `run/cli.py`, `.github/workflows/pipeline.yml` |
| Reader measured on 607 sampled filings (1999–2013): of 568 text filings 74.3% `ok`, 3.0% `close`, 12.5% `unverified`, 6.3% `mismatch`, 3.0% `no_rows`, 0.9% `empty`; Berkshire Q4 2004 exact (66 rows, $35.76bn) | Prototype first, rules added for each failure seen (wrapped rows, one field per line, Berkshire repeats, totals, typo CUSIPs, 8-char CUSIPs, swapped headings, dollar tables) | `tests/test_legacy.py` |
| Dead companies kept: a CUSIP first held before 2013 that OpenFIGI misses is asked again with delisted securities (method `unlisted`), never matched by name, no vendor code kept as a ticker, no SEC lookups | OpenFIGI's plain mapping returns nothing for Enron, Lehman, WaMu, Gillette (checked); without them old returns read too high; a name match would merge old and new GM (design review) | `securities.py` (`map_unlisted`), `run/market.py` |
| Prices from 1999 (`HISTORY_START`); stocks held before 2013 get only their missing years fetched once (stage "price history", after the regular refresh); vendor tickers checked over the 2013+ span for stocks also held since; T-bills from 1999, refetched when the stored table starts later | Old closes, dividends and splits (a missed split reads as a trade); keep today's prices unchanged | `prices.py` (`fetch_heads`), `run/market.py` (`backfill_price_heads`, `held_spans`, `update_rf`), `rf.py` |
| `verify` skips funds owed a recompute; the coverage gate counts active funds only; source rank bulk > live > legacy; the SEC client's rate limit is thread-safe | The monthly check and the gate would fail after a backfill; downloads run 4 at once | `run/weekly.py`, `holdings.py`, `http.py` |
| Web: one `qOfYear` helper for every quarter-of-year sum (`-1 % 4` is −1 in JS: Q4 2012 read "Q0 2012"), no quarter-0 floors in charts and What-if, new 15y empty note. Workbook: `Q_OFFSET` = 100 in "last quarter" formulas | Negative quarter indexes before 2013 | `web/src/lib/format.ts` and callers, `web/src/fund/whatif.ts`, `pipeline/orca/workbook/layout.py`, `summary.py` |
| Design spec, then a design review (14 findings, 8 changes folded in; see its section 13) | Plan first | `docs/superpowers/specs/2026-11-17-pre-2013-13f-design.md` |
| Famous-funds test (owner: "take a sample of famous funds … test again"): all 2,494 pre-XML filings of 40 funds filing since 2005 or earlier; three rounds of reader fixes (glued `SH` and decimals, a 9-digit voting count passing the check digit, totals in "1 335 366 000" or "$43.7 Billion", dropped leading zeros, foreign rows' repeats, lone unmarked amendments as the quarter's report, stricter fallbacks after 4,280 junk Renaissance rows). Final: 91.2% stored; unbroken pre-2013 history median 11.5 years, 28 of 40 funds 10+ years; 99.4% of their pre-2013 dollars identified by OpenFIGI (35.4% only as delisted) | Owner asked; the random sample missed big filers' layouts | `sec/legacy.py`, `holdings.py` (`select_reports`), `tests/test_legacy.py`, spec section 5 |
| Filings without totals explained: the filer left the summary page blank or out (17–20% in 1999–2001), not small funds (all are over $100M); labels without "Total" and totals below blank lines now read; a table's own TOTAL line checks a blank summary. Failed downloads are retried once by the next backfill (`state.legacy_retry`) | Owner asked why | same, `run/ingest.py` |
| Pre-merge measurement (owner: "measure twice and cut once"): 40 famous + 100 random funds, every pre-2013 filing. Stored 92%; one unbroken pre-2013 history covers 86–88% of the quarters the funds filed; real gaps 5–6%; unreadable 6–9%. Fixes: unreadable quarters carried (≤2 in a row), splits read from the filings when 2+ holders agree (genuine splits ~0.4% of a book a quarter, ≤0.7 pts/yr at worst), rows worth over $2M a share dropped, Harris-style repeats and SEDOL rows. A second independent review: delisted companies take only ended vendor lines (Tiingo's "T" is today's AT&T), no by-name tickers for pre-2013-only stocks, lone amendments only without an original, period sanity, per-filing error capture, price recovery | Owner asked how much is unreadable and how much splits distort | `holdings.py`, `splits.py`, `vendor.py`, `run/market.py`, `run/ingest.py`, `sec/legacy.py`, spec section 14 |
| Merged main (sector steps). The sector step is skipped after a backfill run. The `fund_flows` merge (new on main, not yet run in production) is now streamed: every run part is sorted and the stored table and the parts merge sorted on the fund, written with `Lake.sink`. Sized from the public fund files: ~59–65M trade rows today, ~85M with the history from 1999; merging that in memory peaked at 10.6 GB of the runner's 16 GB, streamed 0.2 GB | Run 27 died of memory; the first ordinary run after the backfill recomputes every fund with older history and would have been the first to merge `fund_flows` | `run/weekly._merge_fund_state`, `storage.Lake.sink` |

- Not run yet: the backfill itself (plan for three backfill runs). Next: merge, run Pipeline with `backfill` until it prints `"left": {"price_histories": 0, "quarters": 0}`, then an ordinary run; check `legacy_checks` counts, Berkshire from 1999, the 15y lists, health flags, run time, and the share of funds whose tracking segment reaches their first legacy quarter (two unreadable filings in a row cut a fund's older history).
- Open: Famous funds that stopped before 2013 (Pabrai's 2004–11 filer, Peninsula, Castle Point; WORKLOG 2026-11-16) can now be listed: the owner decides.

## 2026-11-17 — Famous funds: Most searched list (Google Trends)

| What changed | Why | Files |
|---|---|---|
| New first list, Most searched: the 50 famous funds whose manager or founder (or firm, for venture firms) is searched most on Google, Google Trends worldwide over 12 months, Warren Buffett = 100, with a "Search interest" column. One fund per keyword (Sequoia's 7 filers count once). Big companies and Sovereign & pension funds are not ranked. Exceptions the owner asked for (2026-11-17): the Gates trust ("Gates Foundation", 14.0) and Markel ("Markel Group", 3.9, the insurer: customers search it too, so it reads high); Gardner Russo & Quinn has no measurable searches and stays out | Owner: "the most searched funds" first (e.g. Situational Awareness), measured with Google Trends on the manager's name, not the fund's | `famous.csv` (`search`), `famous_search.csv`, `famous.py` (`load_search`), `home.py` (`_searched`), `web/src/pages/Home.tsx` |
| Keywords are compared as Google topics (an investor, not a namesake), 4 a batch with an anchor (Bill Ackman, then a smaller one for faint names) so all share one scale | Trends compares at most 5 terms and only relatively | `pipeline/scripts/google_trends.py` |
| The scores are a committed snapshot, refreshed by hand with the script (30–60 min; Google throttles). No pipeline run fetches Trends | Google has no Trends API; pytrends is unmaintained and blocked from cloud servers like GitHub's | same |
| First snapshot (2026-11-17), top 10: Buffett 100, Soros 31, a16z 25, Burry 21, Dalio 19, Sequoia 17, Cathie Wood 14, Ackman 14, Munger 13, Aschenbrenner 12. 109 keywords score above 0 (14 more are too faint to read and show nowhere); 9 common names (e.g. John Griffin, Rajiv Jain, Tom Slater) have no Google topic and are left out; 15 distinctive names with no topic are searched as exact phrases ("Nick Train": the bare words scored 60× more, from unrelated searches) | Topics picked by hand where automatic matching chose a namesake (David E. Shaw → the firm, La Caisse → the pension fund, not a Crédit Agricole bank); Farallon uses the firm, not Tom Steyer (searched for his politics) | `famous_search.csv` |
| State funds dropped from the ranking: in a first run AustralianSuper (30), CalPERS, Texas Teachers, the Saudi and Swiss central banks and the Gates Foundation outranked Dalio | Their names are searched by members, citizens and markets, not for their investing; the owner asked for manager or founder names | `famous.csv`, `test_search.py` |
| A first version ranked by Wikipedia page views (fetched each run); replaced before merge at the owner's request | | PR #39 |
| Cross-checked against `docs/famous-funds.txt` (PR #37, CIKs matched to live funds.json): 61 of its 68 CIKs are the same as famous.csv's; the other 7 are added (Slate Path → Tiger cubs; Samlyn, Alpha Wave, Encompass, Woodson, Sylebra's older filer → Fundamental long/short; GMO → Value). The Famous funds tab covers that file's Popular funds idea | Validation from live data this session cannot reach | `famous.csv` |

## 2026-11-17 — Fund scores built (plan phase 5), waiting on the owner's run

| What changed | Why | Files |
|---|---|---|
| `engine/skill.py`: every score is one replay of a fund's real trades through a series (buys = same dollars at the quarter's average level, sells = same fraction of units, the rest valued at the last quarter end). The fund side replays each stock through its own total-return series, so fund and index both include dividends. Picking = IRR(fund) − IRR(own labels' indices); allocation = IRR(own labels) − IRR(market); per tier 1–3. A single-sector ETF is a pick at its own tier; conglomerates are compared with SPY; neutral ETFs and unlabelled stocks only count in coverage. IRR = the web's bisection, solved for all funds at once in polars | Plan §7 | `orca/engine/skill.py` |
| `etf_ranks`: each single-sector ETF position's label ranked by IRR against every other label at its tier (the owner's "did Semiconductors beat the other industries") | Owner, 2026-11-17 | same |
| The fund compute keeps each fund's trades (`fund_flows`, merged like `fund_state`); a `skill` stage scores all funds after the merge; `orca.run sectors` (Actions input `sectors_only`) rebuilds indices and scores from the lake for a relabel, with no fetch and no fund compute | Relabelling must be cheap | `run/weekly.py`, `run/sectors_step.py`, `run/cli.py`, `pipeline.yml` |
| Both steps apply the ticker guard: a CSV row (stock or ETF) whose ticker no longer matches the lake's is not trusted and the stock falls back to its SIC code | Ids are a local counter; the test lake's ids are not production's | `run/sectors_step.stock_paths` |
| Not done: KS-PME (no IRR when a position is too short or no root in [−0.99, 10]); per-position ranks for stocks (ETFs only: 71 replays per position for every stock is too slow); the contract, publish step and web view (phase 6) | | |

## 2026-11-17 — Sector indices built (plan phases 1–3), waiting on the owner's run

| What changed | Why | Files |
|---|---|---|
| Phase 1: the pipeline reads each stock's hierarchy label from `data/stock_nodes.csv` (`how=owner` wins; rows placed by name follow `labels.txt`), then a SIC fallback table (870 codes and prefixes, built from Damodaran's SIC codes). ETFs give a tier and a label, or neutral (leveraged ETFs too). The name match over all 41,407 securities added 2,441 stocks (7,552 rows). `relabel_check.py` shows what an edit moves | One CSV to edit; relabel = edit + re-run | `pipeline/orca/hierarchy/assign.py`, `data/`, `tools/` |
| `labels.txt` overrides only rows placed by name: Orca keeps delisted tickers, so 12 rows share a ticker with a placed company but are another company (stock 611 "AMT" is TD Ameritrade, 14232 "APH" is Aphria) | A ticker-wide override would have mislabelled them | `assign.py` |
| ETF review: 96 of 98 single-sector ETFs at the right tier; FAS and SOXL are leveraged, so neutral (R12) | Phase 1 | `assign.read_etf_labels` |
| Phase 2: lake table `shares_hist` (every cover-page count, one SEC call per company, missing first, at most 19,000 calls a run, refreshed after 100 days) and `data/share_overrides.csv` (ordinary shares per ADR for 26 big ADRs, from memory: check in phase 4) | Today's single count misweights the past | `orca/shares_hist.py`, `run/sectors_step.py`, `run/sources.py`, `securities.fetch_shares_history` |
| Phase 3: `engine/sectors.py` builds every hierarchy label's index (cap weights at the quarter's start, dividends, a quarter-end and a quarter-average level, stale-price and delisting rules, one count per company). The run builds `sector_returns` in the lake after the price stages; a failure is flagged and never stops the run. Nothing is published | Indices first, scores next (phase 5) | `engine/sectors.py`, `run/weekly.py` |
| Not done: no demo output; `shares_hist` is not in the lake backups (it rebuilds in ~40 min); the ADR ratios are unchecked | | |

## 2026-11-17 — Sector indices: plan reviewed, labels committed, handoff written

| What changed | Why | Files |
|---|---|---|
| Labels committed: 5,111 labelled securities (stock → vertical) and 462 classed ETFs (class, level, hierarchy label), plus the model batch inputs and answers keyed by stock id | Owner approved committing (Damodaran's file is public); the scratchpad copies were the only ones and are ephemeral | `pipeline/orca/hierarchy/data/` |
| Plan reviewed by an architecture review and a code check, then rewritten: share-count history (`shares_hist`), sells replayed as a fraction, quarter-average and quarter-end levels, stale-price rule, SIC fallback for unlabelled stocks, scoring in the pipeline, six phases | Today's single `shares_out` × past price misweights (Apple's count fell ~40% since 2013); matching sell dollars can drive a shadow negative | `docs/superpowers/plans/2026-11-17-sector-indices.md` |
| Owner: indices at all three tiers with a toggle; ETFs labelled at the tier they track | Chat | `docs/DECISIONS.md` |
| Not done: no code. Next: a fresh chat runs phases 1–3 from the plan's paste-ready prompt | | |

## 2026-11-17 — Sector return series: decisions recorded, nothing built

| What changed | Why | Files |
|---|---|---|
| Decisions recorded: market-cap weighted with no cap (R5), total return with dividends from the start, an existing cap-weighted ETF as a hierarchy label's index where a good one exists, our own index for the 12 broad sectors, for hierarchy labels with no ETF and for back-filling short ETF histories, industry level (tier 2) as the scoring level with sector and vertical toggles | Owner's answers in chat | `docs/DECISIONS.md`, `docs/ROADMAP.md` (S4), `make_review_page.py` (R5) |
| Analysis (read-only): existing ETFs give 31 of our 327 hierarchy labels (11 of 12 sectors, 8 of 71 industries, 12 of 244 verticals) an ETF of their own, counting only ETFs the 100 funds held; about 25% of our Technology value sits in names XLK does not hold; the funds' buying that predates an ETF is 62% for memory (DRAM, Apr 2026), 22% for airlines, 9% for cybersecurity; the engine's `quarter_px` already gives quarterly closes and dividends per share | Sizes the build and shows where ETFs stand in and where our own index is needed | none |
| Not done: no index code, no table, no contract change. The first real numbers need a pipeline run because dividends and share counts are in the private lake | | |

## 2026-11-16 — Popular funds: draft list of 68 names

| What changed | Why | Files |
|---|---|---|
| Draft list of 68 well-known funds, grouped by lineage (Buffett/Graham, Tiger Cubs, macro, activists, quant, other), each matched to a live CIK, book and position count, and flagged if in a top-25 list | Owner asked for a list of famous funds for backlog item 2b, from Wikipedia and press lineage articles (chat) | `docs/superpowers/specs/2026-11-14-popular-funds-draft.md`, `docs/famous-funds.txt` (names, CIK and link only) |

- Not approved: the owner picks names and whether the tab groups by lineage. Only 3 of 68 (Coatue, Slate Path, Appaloosa) are in a top-25 list. Seed Stapleton and Sequoia lineages were not found by search. Nothing built; the contract (`home/popular.json`) comes next.

## 2026-11-16 — Famous funds: Buffett inspired, more moat, Fundamental long/short

| What changed | Why | Files |
|---|---|---|
| New Buffett inspired list (21; Berkshire moved here from Value, with Pabrai, Li Lu, Daily Journal, Spier ×2, Markel, Fairfax, Sequoia Fund ×2, Tweedy Browne, Russo, Bloomstran, Lou Simpson, Mecham, Alleghany, Biglari ×2, Chou, Van Den Berg, Kahn Brothers). Pabrai's 2004–11 filer, Weschler's Peninsula and Combs' Castle Point left out: they stopped before 2013. Pabrai's Wagons fund files N-PORT, not 13F | Owner; "Richer, Wiser, Happier" insurer = Markel (Gayner) | `pipeline/orca/famous.csv`, `famous.py`, `web/src/pages/Home.tsx` |
| Moat investing +31 (strong and medium fits: Nomad, Magellan, Hyperion, Veritas, Findlay Park, Seilern, Comgest, AKO, Troy, GuardCap, Cantillon, Ensemble, Jensen, WCM, SGA, Bares, Saber, FMI, GQG, Lakehouse, Montaka, Mawer, Burgundy …), Wedgewood moved from Value, Rule One Partners (Phil Town, CIK 2040263) | Owner | same |
| New Fundamental long/short list (31 + Glenview from Value: Egerton, Lansdowne, Marshall Wace, Melvin, Eminence, Kingdon, Soroban, Steadfast, Darsana, Holocene, Woodline, Lakewood, Cat Rock …); Sculptor (OZ Management) and Farallon added to Quant & multi-strategy. Left for the owner: 18 smaller or Tiger-linked long/shorts and 11 healthcare specialists (Baker Bros, RA, Perceptive, OrbiMed, Deerfield …), in the session research | Owner: a home for famous funds no other list fits | same |
| Owner approved the rest: Healthcare specialists list (11: Perceptive, RA, Baker Bros, Deerfield, OrbiMed, Casdin, EcoR1, Redmile, Rock Springs, Avoro, Visium); Tiger-linked long/shorts to Tiger cubs (Joho, Tiger Legatus, Valinor, Kora, Conatus); 13 smaller long/shorts to Fundamental long/short. A match may list alternatives split by `|` for a renamed filer (Brookside → Bain Capital Public Equity, venBio → Avoro) | Owner (chat) | `famous.csv`, `famous.py`, `home.py` (`_name_matches`), `Home.tsx` |
| Lists now open with Buffett inspired, Moat investing, Value | | `famous.py` `FAMOUS_GROUPS`, `Home.tsx` |
| Answers: Market Wizards' latest is "Market Wizards: The Next Generation" (June 2026), traders without 13Fs. Funds off 13F (e.g. Aoris) publish holdings under local rules (Australian PHD twice a year, ASX active funds quarterly, UCITS half-yearly, US N-PORT quarterly); not built | | none |

## 2026-11-16 — Reused tickers: current vendor line only, wrong prices dropped

| What changed | Why | Files |
|---|---|---|
| `vendor.resolve` accepts a ticker only on its current line at Tiingo (the one ending last; a tie goes to the longer line), still only when it overlaps the held days | Tiingo answers a ticker with today's company: Anadarko got today's APC from 2026-02, Macquarie got a 2026 ETF's MIC. About 67 stocks from the repair above, and about 509 from before it, were priced this way (code)(chat) | `pipeline/orca/vendor.py`, `tests/test_vendor.py` (the old "OLD" case now gets no ticker) |
| A stock whose vendor ticker changes or is lost has every stored bar dropped (`prices.drop_stocks`, one file at a time), is fetched again if it still has a ticker, and is owed to its funds and its weekly file. Over 2000 lost in one run: nothing changes, flag `vendor_tickers_lost` | Refetching on a ticker change kept the old ticker's bars on days the new one lacks; a lost stock kept another company's bars | `pipeline/orca/prices.py`, `run/market.py` |
| Run 43984346762 (17 Nov, 2 h 7 min, after #38): 106 stocks lost their vendor ticker, 65,939 bars dropped, 106 weekly files deleted (Macquarie, Navigant, Sotheby's now 404); XOM, EA, ZK kept. Share-like unpriced 638 → 744 (the 106 wrong ones). Anadarko kept today's APC: a filer still reports it in 2026, so its held days overlap the new line. Fixed after: a current line is refused when the stock was also held during an older line that ended over 31 days before it (`vendor._held_before_reuse`; a 3-day gap such as Wolfspeed's relisting still counts as the same listing) | | `pipeline/orca/vendor.py`, `tests/test_vendor.py` |
| Run 44005418817 (17 Nov, 50 min, after #40): 45 more stocks lost their vendor ticker (42,634 bars dropped, 45 weekly files deleted), Anadarko among them (`stock/188/weekly.json` 404, no latest price). XOM, EA, ZK still priced. Share-like unpriced 789 (was 1,420 before #35; 638 at the high point, which included ~151 priced as another company) | | |
| Published `stock/<id>/weekly.json` of a stock left with no priced day is deleted: the run writes `out/deleted.txt`, the upload step checks every line is `stock/<digits>/weekly.json` and deletes them before the manifest | The contract says such a stock has no file, and the upload never deleted anything, so the wrong chart would have stayed | `run/weekly.py` (`stale_weekly`, `write_deletions`), `.github/workflows/pipeline.yml` |

## 2026-11-16 — Prices for stocks with a broken ticker; analytics allowed

| What changed | Why | Files |
|---|---|---|
| Cloudflare Web Analytics allowed in the CSP (`script-src` + `static.cloudflareinsights.com`, `connect-src` + `cloudflareinsights.com`). Checked against the live page with the new header: no CSP error, beacon loads | It had been switched on in the dashboard while the CSP blocked it: nothing counted, a console error on every page. Owner wants the figures (chat) | `web/scripts/prerender.mjs`, `web/tests/prerender.test.ts`, DECISIONS, runbook step 8, ROADMAP U5, CLAUDE.md |
| Vendor-ticker repair: more suffix rules (`*`, GBX, digits after a suffix), then hand-checked overrides by CUSIP, SEC name match, OpenFIGI US ticker with delisted listings (`includeUnlistedEquities`), all still limited to vendor spans that overlap the held days | Owner asked why two stocks had no `weekly.json`. Zeekr: OpenFIGI gave the Mexican "ZKN", Tiingo has "ZK". The Oracle one is a bond (no price expected). The same fault left 1,420 share-like stocks unpriced, among them Exxon's pre-2026 CUSIP ("EXMOC"; Exxon moved under ExxonMobil Holdings Corp with a new CUSIP), EA, WBD, QRVO, RTN, PX, APC: 4.03% of the 60 largest funds' holdings by cost | `pipeline/orca/vendor.py`, `securities.py` (`tickers_by_name`, `us_tickers`), `run/market.py` (`alternate_tickers`, `ticker_overrides`), `run/weekly.py`, `ticker_overrides.csv` (new), tests |
| Measured on the published files and Tiingo's list, without the OpenFIGI step (needs the private lake): 447 of 1,420 repaired; the 60 largest funds' unpriced share 4.03% → 0.57%. Each repaired stock's history is fetched again on the next pipeline run, so that run is longer | | |
| Live result (pipeline runs 43810473859 and 43838862209, 16 Nov). Run 1 spent 3 h on 3,213 new filings (the 14 Nov deadline), so its price stage started under the 90-minute reserve and fetched nothing; run 2 fetched 16,362 tickers (110 min), recomputed 11,131 funds. Securities: 653 + 168 vendor tickers changed, 118 by SEC name, 1,551 OpenFIGI US-ticker lookups. Share-like stocks without a price 1,420 → 638; latest prices 13 Nov. Exxon's old CUSIP (XOM, weekly from 2013), EA, WBD, QRVO, RTX, LUMN, TEVA, AUY, LBRDK, Zeekr (ZK, 2024-05 → 2025-12) priced | | |
| Found after: Tiingo serves a ticker's current company only. A stock matched to an older line of a reused ticker gets the new company's bars (Anadarko → today's APC from 2026-02, Macquarie MIC, Navigant NCI, Sotheby's BID): wrong chart and latest price; fund P&L is mostly untouched, since those holdings ended before the new company's first bar. About 67 such stocks came from this fix, and about 509 were already priced this way before it (`vendor.resolve` accepted any overlapping line). Open: accept only the ticker's latest line and drop prices stored from another company | | |
| Caveat: a company whose spin-off the vendor shows as a price drop (UTX → RTX in 2020, Carrier and Otis) now shows that drop as a loss; the engine has no spin-off handling (as for any other spin-off) | | |
| Checked: full pipeline suite (10 new tests; the run-level ones fail with the alternates switched off) | | |

## 2026-11-16 — ETF mapping restored, fund 66 dropped, data refreshed to quarter 54, rules decided

| What changed | Why | Files |
|---|---|---|
| Owner's answers recorded as decided rules: R9 (industry level by default, toggle to sector or vertical), R12 (a single-sector ETF counts as a bet on its hierarchy label, every other ETF has no sector), R13 (the sector score is the IRR of each call replayed through every other sector). Accepted: 13F is quarterly with a 45-day lag, so trades inside a quarter are invisible. Licensing can wait until something is commercial | Chat, 2026-11-16, after a diagram page ("Scoring Sector Picks", private artifact) explained the ETF mapping and the dividend catch | `make_review_page.py`, `docs/DECISIONS.md` |
| ETF classification restored (it was removed in bf901e0 on a misreading) and applied to the new list: a model classed the 462 biggest ETFs; 98 are single-sector ($17bn bought, 0.8% of all dollars), 364 get no sector | The owner: a fund's ETF buy is a sector pick, so ETF-heavy funds stay in | `tools/etf_batches.py`, `tools/etf_prompt.md` |
| International Assets Investment Management (rank 66) excluded with `top_funds_universe.py --exclude 1818604` | Owner: drop it ($718bn bought on a $1.7bn book, desk flow) | `tools/top_funds_universe.py` |
| The monthly run published new data while we worked (latest quarter 53 → 54; 41,407 securities; 328 garbled tickers fixed, e.g. EXMOC → XOM), so everything was re-downloaded and 15 of the 100 funds changed. 7,025 securities; 437 were new: a model labelled 226 stocks (batch 12) and 81 ETFs (ETF batch 3). Earlier answers were reused by stock id (`make_batches.py --missing`, `etf_batches.py make --missing`) | One snapshot must be one vintage; answers keyed by stock id stay valid | `tools/make_batches.py`, `tools/etf_batches.py` |
| Result: 5,111 stocks labelled, 95% of the $2.1tn bought. ETFs 4.6%, funds, SPACs and unidentified lines 0.1%. Blind audit of 880 default-labelled stocks: the model agrees with the group default on 73% of verticals (97% with labels placed by name); it replaced 234 defaults. 1,034 small defaults (0.8% of dollars) unchecked | The numbers the owner reviews on the page (v11) | `pipeline/orca/hierarchy/README.md` |
| Check for sector indices: the 30 biggest funds outside the top 100 (Vanguard, BlackRock, State Street, FMR) hold 93.9% labelled stocks, 5.7% ETFs and 0.4% stocks we have not labelled, by value | Answers whether every stock needs a tag before a sector index can be built: a size-weighted index is already about 99.6% covered | README |
| Not done: no sector return table (ROADMAP S4) exists yet. Next: prototype the 12 sector indices from our labels and compare them with the Select Sector ETFs (XLK, XLF and the rest) | The test of whether hierarchy-built indices track real sector ETFs | `docs/ROADMAP.md` |

## 2026-11-16 — The stocks the 100 best funds ever held, found and labelled

| What changed | Why | Files |
|---|---|---|
| The 100 best funds by return since start (`home/top_max.json`) ever held 7,702 securities. 5,361 are labelled (92% of the $2.2tn they bought); 1,815 ETFs and 526 funds, SPACs and unidentifiable lines are not | The owner asked for every stock the top 100 funds ever owned, classified in the hierarchy (chat). Period chosen by me: since start, the one window that covers "ever"; 1y, 3y, 5y and 10y give different funds (any two of the five top-100 lists share only 21 to 58 funds) | `pipeline/orca/hierarchy/tools/top_funds_universe.py` |
| `matching.py`: matches Orca's names (Bloomberg style, cut at 28 characters, garbled tickers such as EXMOC, 8QR) to Damodaran's global 48,000-company file by distinctive words. 3,433 stocks matched strongly to a US listing, 741 partly or to a foreign line, 1,359 not at all | The 4,014-stock US list reached only 9% of Orca's 41,113 securities. His global file also covers ADRs (Nestlé, Novo, Toyota), so names carry the match, not tickers | `pipeline/orca/hierarchy/matching.py`, `tools/label_securities.py` |
| A model (11 Claude agents, 295 stocks each, about 200,000 tokens each) gave a first-pass vertical to what the match could not settle, confirmed or rejected the partial matches, and labelled 840 default-labelled stocks blind as an audit | Stocks outside Damodaran's list (delisted, ADRs, new) have no group. SIC codes need a company id Orca does not hold and are too coarse for verticals | `tools/make_batches.py`, `tools/model_prompt.md`, `tools/merge_batches.py` |
| Audit result: the model agrees with labels placed by name 97% of the time but with Damodaran's group default on only 73% of verticals (94% of sectors). A model that knows the company now replaces a default (224 stocks) | Group defaults are the weakest part of the hierarchy. 1,282 small default-labelled stocks (under 1% of the dollars) are still unchecked | `merge_batches.py` |
| Review page: top-fund columns (dollars bought, funds), sort by them, dotted orange for a model's label, "group default was ...", a Not labelled tab, rule R8 (changed) | The owner reviews in the artifact; the new stocks and sources must be visible | `tools/make_review_page.py`, `tools/review_page.html` |
| 15 more tests (name matching, merge, universe, page data). Data outputs are not committed: the repo is public and Damodaran's file has no licence (R10) | A public repo would publish his derived labels | `pipeline/tests/test_hierarchy_{matching,merge,universe,page}.py` |
| Not done: 1,815 ETFs (7.6% of dollars) have no hierarchy label. The owner says an ETF buy is a sector pick and the ETF-heavy funds stay in the list: 66 of the 100 funds have held an ETF, 12 hold half or more of their current book in ETFs, 4 hold 90% or more (e.g. PPSC Investment Service Corp, rank 15 since start). A model classed the biggest 400 ETFs once (90 single-sector, $29bn bought, commit 1fecf4b) and it was removed in bf901e0 on a misunderstanding. One top-100 fund, International Assets Investment Management (rank 66, $1.7bn book), shows $718bn bought and 4,122 stocks ever, and $458bn of Berkshire A alone; it looks like trading-desk flow, not picks, and may not belong in a top list. `positions.json` covers a fund's current tracking segment only | Listed so the next session does not rediscover them | `pipeline/orca/hierarchy/README.md` |

## 2026-11-16 — Sector hierarchy source committed (`pipeline/orca/hierarchy/`)

| What changed | Why | Files |
|---|---|---|
| New `labels.txt`: a three-level hierarchy (12 sectors, 71 industries, 244 industry verticals). 1,292 stocks placed by name, 11 name rules, a default for each of Damodaran's 94 industry groups, extra labels for multi-business companies (Alphabet 5, Amazon 3, CVS 3, Vistra 2), one umbrella (Automotive) | The owner wants funds scored as sector allocators vs stock pickers (ROADMAP F5, D7), and SIC and GICS are too coarse or licensed (Micron, Nvidia and AMD are all SIC 3674). Built and reviewed in a private Claude artifact over 2026-11-15/16 (chat); committed so it is not lost with the session | `pipeline/orca/hierarchy/labels.txt` |
| `model.py`: parser and labeller (standard library only), reports every problem in `labels.txt` at once | The file is the source of truth, so CI should reject a bad edit | `pipeline/orca/hierarchy/model.py`, `__init__.py` |
| `tools/`: fetch the three public inputs, label the 4,014 listed stocks, build the review page. Rebuilding gives byte-for-byte the data the owner reviewed | The review page is how the owner edits the hierarchy; the tools make it reproducible | `pipeline/orca/hierarchy/tools/` |
| 20 tests: every Damodaran group has a default, no unused vertical, the owner's examples hold (Micron, Vistra, Alphabet, Palantir, Leidos, CVS, Tesla, Berkshire) | Decisions made in chat should fail a test if a later edit breaks them | `pipeline/tests/test_hierarchy.py` |
| DECISIONS entry; ROADMAP D7 and S4 and F5 point at the hierarchy; backlog item 7; ARCHITECTURE module table; CLAUDE.md read-X table and repo map | The change made the old D7 text stale ("SIC → sub-sector → ETF table") | `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-11-13-idea-backlog-and-order.md`, `CLAUDE.md` |
| Not done: nothing reads the hierarchy yet. No `stock_id` mapping, no `pipeline/contract.md` change, no benchmark table. Rules R2–R10 on the review page are recommendations the owner has not confirmed. 188 of 244 verticals have under 10 stocks above $1bn, and 2,620 stocks carry only their Damodaran group default | Listed so the next session starts from the open items, not from the chat | `pipeline/orca/hierarchy/README.md` |

## 2026-11-15 — Famous funds: Moat investing, Family offices, Sovereign & pension funds, stopped filers

| What changed | Why | Files |
|---|---|---|
| New lists: Moat investing (Pershing Square, TCI, Fundsmith ×2, Akre, Lindsell Train, Dorsey), Family offices (Duquesne, Soros, Moore, BlueCrest ×2, Cooperman, Paulson, Appaloosa, Gates Foundation Trust), Sovereign & pension funds (49: 7 sovereign, 2 central banks, 40 pensions incl. Canada's big 8 + IMCO, 15 US, AustralianSuper, UniSuper, Aware Super, Cbus, Korea NPS, Malaysia EPF, Swedish AP1–4). "Other" is gone (Fisher and Glenview → Value); Berkshire is no longer under Big companies | Owner (chat). Not filing a 13F: GIC, QIA, ADIA, KIA, Future Fund, NZ Super (13D/G only), CIC (one 2009 filing), Tencent (13D/G only, CIK 1293451) | `pipeline/orca/famous.csv`, `famous.py` (`FAMOUS_GROUPS`), `web/src/pages/Home.tsx` |
| Funds that stopped filing are listed: an inactive fund's periods now end at its last quarter (`compute._snapshot`, was the deadline quarter, so it had no period but "since start"); famous rows add `until_q` and the web prints "filed until Qn YYYY". Inactive funds stay out of every other list (`excluded`) | Owner: show them (e.g. BlueCrest, filed to 2018) | `pipeline/orca/run/compute.py`, `home.py`, `contract.md`, `Home.tsx` |
| Open: the stored snapshots of inactive funds predate this, so they need one Pipeline run with `full` (~2.5 h) before stopped funds show for 1y/3y/5y/10y. Owner, 2026-11-17: not needed, skip it (stopped funds may show only "since start") | | |
| Answer: GV and CapitalG file no 13F of their own; they are "other included managers" on Alphabet's one 13F (CIK 1652044), so the Alphabet row holds their listed stakes | Owner asked | none |

## 2026-11-15 — Famous funds: one list per style, VC and Big companies

| What changed | Why | Files |
|---|---|---|
| The tab shows 9 lists, one per style, each under its own heading and line, 10 funds a page with its own page buttons; the one period switch drives them all. Rows carry `group`; a CIK can be in two lists | Owner (chat) | `web/src/pages/Home.tsx` (`FAMOUS_GROUPS`, `FamousGroup`, `ListTable pageSize/pagerAbove`), `home.css` (`.fam`), `pipeline/orca/famous.py` (`FAMOUS_GROUPS`), `home.py`, `contract.md` |
| New Venture capital list: 87 rows (Sequoia's US, growth, Global Equities, HongShan, Neil Shen and Peak XV filers; a16z, Kleiner, Accel, Greylock, Founders Fund, General Catalyst, NEA, Insight, Ribbit, TCV, BOND and more). Many VCs file one 13F per fund; stale ones list nothing. GV, CapitalG, Intel Capital and Qualcomm Ventures file inside their parent's 13F. Not found: Benchmark, Lux, Khosla (13F-NT only), YC, Sutter Hill | Owner asked for VC funds incl. Sequoia's offices | `pipeline/orca/famous.csv` |
| New Big companies list: 25 companies filing their own 13F (Berkshire, Alphabet, NVIDIA, SoftBank, Loews, Uber, Amazon, Toyota, Gilead … Regeneron); only 26 were found, not 30. Research says SpaceX listed on 2026-06-12 (SPCX) and is now most of Alphabet's 13F (not checked here) | Owner asked for big companies with big 13F books (e.g. Google/SpaceX) | same |
| Ackman (Pershing Square) moved from Activists to Value; BlueCrest (Michael Platt, CIKs 1363542 and 1610880) added under Macro, but it filed only until 2018, so it lists nothing (a famous row needs a current performance). TCI was already listed | Owner | same |
| Possible next list (not built): sovereign funds that file 13F (Norges Bank, Swiss National Bank, Korea Investment Corp, Saudi PIF, Temasek, Mubadala, ADIC; CIKs in the session research) | | |

## 2026-11-15 — Famous funds tab

| What changed | Why | Files |
|---|---|---|
| New home tab "Famous funds" beside Top funds: same columns and period chips (the period is shared), each row links to the fund page, the manager's name under the fund name | Owner asked for a list of famous funds, with key attention on Tiger cubs and popular tech funds (chat) | `web/src/pages/Home.tsx`, `web/src/data/types.ts` |
| `top_{period}.json` gains `famous` rows (Top funds' row plus `manager`) for the 105 CIKs of `famous.csv`, skipping the Top funds rules but keeping the data checks (perf for the period, ≥ 80% priced, no flag) and a match word on the filer name so a wrong CIK lists nothing | Famous funds are often small, young or concentrated; one file per period keeps it one fetch | `pipeline/orca/famous.py`, `famous.csv`, `home.py`, `publish.py`, `run/publish_step.py`, `run/sources.py`, `run/weekly.py`, `demo.py`, `contract.md` |
| List researched by a subagent with web search (Wikipedia, Dataroma-style superinvestor lists, EDGAR 13F-HR links): 10 Tiger cubs + Tiger Management, 5 grand-cubs, 22 tech & growth, 39 value, 11 activist, 5 macro, 7 quant/multi-strategy, 6 other. Left out as unconfirmed: Valinor, Joho, Sequoia, Lux, Stripes, Long Pond. sec.gov and data.orcaetf.com were blocked from the session, so no CIK was checked against our own data | | |
| Open: until the next pipeline run, production files have no `famous` key and the tab says the list arrives with the next data update. After it, check the tab for missing names (a CIK whose filer stopped or changed, e.g. Fundsmith 1569205 vs 1868537, Elliott, Hound, ICONIQ) | | |
| Checked: pipeline tests, web typecheck and unit tests (3 new tests each side), screenshots at 1280 and 400 px on demo data | | |

## 2026-11-15 — Security: web dependencies upgraded, npm audit clean

| What changed | Why | Files |
|---|---|---|
| vitest 2.1.9 → 4.1.12, vite 5.4.21 → 7.3.7, @vitejs/plugin-react 4.7.0 → 5.2.0 | GitHub listed 17 Dependabot alerts (3 critical, 1 high, 12 moderate, 1 low). The critical ones (tinypool prototype-pollution RCE gadgets, Vitest UI file read) and the high one (launch-editor in vite) are all dev / test tooling, not code shipped to visitors, but they run on developer machines and in CI. Versions picked are a few weeks old rather than the newest, to limit supply-chain risk. Vite 7 rather than 8 to stay on esbuild/Rollup (smaller change) (chat) | `web/package.json`, `web/package-lock.json` |
| react-router-dom 6.30.6 → react-router 7.18.5 (v7's own package; `react-router-dom` is only a re-export shim). Imports changed in 15 files; the `future` v7 flags on `BrowserRouter` / `MemoryRouter` and the test-setup filter for their console notices are gone (both behaviours are the v7 default, and the app already had them on) | Two moderate advisories with no v6 fix: open redirect via a backslash in `<Link>` / `useNavigate`, and an SSR-only deserialisation issue (not used here). This is the one in the shipped site | `web/src/`, `web/tests/`, `web/package.json` |
| Trade-off: main bundle 341 → 358 kB (gzip 113.6 → 119.6 kB), from react-router 7 | | |
| Pipeline: `pip-audit` on `uv.lock` found no known vulnerabilities | | none |
| Checked: `npm audit` 0 vulnerabilities, `npm ci` on npm 10, typecheck, 940 unit tests, build + prerender, 48 Playwright smoke tests | | |
| The lockfile was written with npm 11 (npm 10.9 crashes resolving vitest's optional peers); noted under Gotchas in `CLAUDE.md` | | `CLAUDE.md` |

## 2026-11-15 — Tab underline: real width instead of a scaled 1px bar

| What changed | Why | Files |
|---|---|---|
| The 2px bar under the open tab (`.tabs .ind`, Home and fund page) now gets its size from `width: var(--w)` and only moves with `translateX`; before it was a 1px box stretched by `scaleX(--w)`. Its slide animates `transform` and `width` | Owner: under Top funds the bar was shorter than the tab at 100% zoom and fixed itself after zooming in and out (chat). Chrome paints a scaled layer once and stretches that picture, so the bar's ends could be off until a zoom forced a repaint. Measured in Chromium before / after (painted bar end vs the tab's right edge, 132 px): 131.3–131.5 → 132 at 1.5×–2× pixel ratios | `web/src/styles.css`, `web/src/fund/returns.css`, `web/src/components/Tabs.tsx`, `web/src/fund/FundHeader.tsx` |
| The bar also re-measures when any tab button changes size (ResizeObserver on each tab), not only when the strip does | The strip keeps its width when the web font swaps in, but the tabs inside it grow (code) | same |
| Smoke test for the home head now checks the description names hedge fund holdings and SEC, not "13F" | It failed on `main` since #31 changed the description to "Hedge fund stock holdings and analysis based on SEC data." (owner wording kept) | `web/e2e/smoke.spec.ts` |
| Checked: typecheck, 940 unit tests, 48 Playwright smoke tests | | |

## 2026-11-15 — Google result: title, description, site icon

| What changed | Why | Files |
|---|---|---|
| Home title is now "Orca: Hedge fund holdings" and the description "Hedge fund stock holdings and analysis based on SEC data."; the home og:title follows the `<title>` | Owner: Google still showed "Orca" with the old text for "orca etf" (chat) | `web/index.html`, `web/src/lib/format.ts` (`HOME_TITLE`), `web/scripts/prerender.mjs` |
| Added `favicon.ico` (16/32/48), `favicon-48.png`, `favicon-192.png` (from `icon-512.png`) and listed them as icons. Google wants a multiple of 48 px and asks for `/favicon.ico` by default; it showed a globe | Same | `web/public/`, `docs/brand/` |
| Search Console steps (verify, inspect, request indexing, sitemap) are the owner's; Google takes days to weeks to re-crawl | Same | none |

## 2026-11-14 — Home lists: longer fund names, steady columns across pages

| What changed | Why | Files |
|---|---|---|
| Fund names on the home lists show about 8 more characters before the "…": the cap is 19em (was 15em for Top funds, 14em for the fund cell in the other tabs), about 37 characters of Instrument Sans 600 at 13 px (≈ 6.6 px a character). Phones keep 10em; the Big wins & losses pair keeps 9em on phones | Owner: names were cut off while the column had room to spare (chat) | `web/src/pages/home.css` (`--nm-w`, `--stk-w`), `Home.tsx` (`stk fund`) |
| Paged home lists (Top funds, Conviction moves) and Index giants lay out fixed: the Fund column is the name cap plus padding (275 px at 1280, was ~440 px of mostly empty space), Stock is its 14em cap plus padding, and the other columns share the rest equally, never under `--col-min` (8.5em, the "Max Drawdown" heading with its chevron) | Owner: the columns changed width from page to page (auto layout sized them to each page's rows: Fund went 440 → 200 → 446 px on a test list) | `web/src/components/DataTable.tsx` (`fixed`, `Column.width`), `styles.css`, `Home.tsx` (`FUND_W`, `STOCK_W`, `ListTable fixed`) |
| Trade-off: on a 400 px phone the Top funds table is now 703 px wide (was ~520) because every number column gets the same floor; it still scrolls sideways with the Fund column pinned | | |
| Checked: typecheck, 940 unit tests (1 new, 1 extended), 48 Playwright smoke tests; measured with a 250-row list in Chromium at 1280 and 400 px: identical column widths on pages 1–3 | | |

## 2026-11-14 — Official logo ("Lune", v1.1) on the site

| What changed | Why | Files |
|---|---|---|
| Logo made official: Lune with a short, wide, swept-back fin (was a tall blade) | Owner chose Lune after a round comparing it with Surface and Zero-line O, and asked for a stubbier, more orca-like fin (chat) | `docs/brand/` |
| Black and white is the primary logo. New colour version: body in gain blue #267CAA, eye patch in loss orange #D4561F (#F48D60 on dark), with colour lockups. App icon is now the paper mark on an ink tile, plus a colour icon on paper | Owner: a version in the site's positive/negative colours, black and white as the main logo (chat) | `docs/brand/` (README, SVGs, PNGs, brand-sheet.png) |
| Website: the header shows the new mark (inline `-16` cut, `currentColor`, so it follows the theme) in place of the placeholder rounded square. The data-URI favicon is replaced by `/favicon.svg` (ink on light tabs, light on dark tabs), `/favicon-32.png` and `/apple-touch-icon.png`. CSP unchanged (`img-src 'self'`) | Owner: change it on the website (chat) | `web/src/App.tsx`, `web/index.html`, `web/public/` |
| Checked: typecheck, 932 unit tests, build (icons in dist and in the pre-rendered fund pages), 44 Playwright smoke tests, icons served 200 by `vite preview` | | |
| Colour version, final: the solid mark with only the eye patch in dark orange #A84118 (no blue; darker than the site's loss orange, "because it's a killer whale"). Body is `currentColor`, so the `-dark` colour files are gone. Colour icon: ink orca, orange eye, paper tile. (An outline version, blue body and orange eye lines, came first the same day and was replaced.) | Owner (chat) | `docs/brand/orca-*-color.svg`, README, brand-sheet.png |
| Link-preview card line is now "Hedge Fund returns and holdings" (was "Estimated fund returns from SEC 13F filings") | Owner (chat) | `docs/brand/og-image.png`, `web/public/og-default.png` |
| The logo is used where it fits: the header is now the outlined lockup (mark + name as drawn, not live text) at 18 px, the Not found page shows the mark in place of the inbox icon, and the footer line starts with a 16 px mark in ink3. New `Logo` / `Mark` components and `docs/brand/orca-lockup-16.svg`. Lockup viewBoxes were tightened to the short fin (they still had the tall fin's height: 17% empty band on top); the link-preview card was re-rendered | Owner: use the black-and-white logo and its lettering where possible (chat) | `web/src/components/Logo.tsx` (new), `App.tsx`, `NotFound.tsx`, `styles.css`, `pages/state.css`, `docs/brand/` |
| Link previews: the logo card (`docs/brand/og-image.png`) ships as `web/public/og-default.png`, the file `main`'s prerender already looks for: with `SITE_URL` it adds `og:image` and `twitter:card` summary_large_image to the shell and every fund page. This branch's own og-tag code in `prerender.mjs` and its static og tags in `index.html` were dropped when merging `main` (#28), which had built the same thing | Owner: wire in the OG image (chat) | `web/public/og-default.png` |
| Checked after merging `main`: see the line below the table | | |
- Checked after the merge: typecheck, web unit tests, Playwright smoke, and a `SITE_URL` build whose fund page has `og:image` = `…/og-default.png`.

## 2026-11-14 — SEO: keyword titles, real text in fund pages; logo round 5; popular-funds idea

| What changed | Why | Files |
|---|---|---|
| Fund pages: title "{name} 13F holdings and returns · Orca" (one text, `fundTitle()` in `format.ts`, used by prerender and the app, so the tab does not change when the app loads). Home title "Hedge fund holdings and returns from 13F filings · Orca" (`HOME_TITLE`; `index.html` repeats it and cannot import it) and a keyword description | Owner: be found for "13F filings", "hedge fund holdings", "hedge fund positions" (chat) | `web/src/lib/format.ts`, `index.html`, `Fund.tsx`, `Home.tsx`, tests, `e2e/smoke.spec.ts` |
| Pre-built fund pages now carry real text inside `<div id="root">` (the app replaces it on mount): an h1, a sentence with the latest 13F quarter, filing date, positions, book and Orca's estimated annual return, a table of the ten largest positions at the latest prices (weights, labelled an Orca estimate), and links to the eight funds next in size. The 500 largest funds (`PRERENDER_RICH`, default 500, 0 = off) read `fund/{id}/summary.json`, `securities.json` and `latest_prices.json` from the data site at build time; every other fund, and any fund whose file cannot be read, gets the basic text (name and book) and the build never fails. A bare `PRERENDER_FUNDS` file gets no holdings text. The meta description names the quarter, positions, book and top three tickers. The noscript line is now only the "turn on JavaScript" note | Before, the HTML held one sentence and everything else loaded in the browser, so search engines saw little (code) | `web/scripts/prerender.mjs`, `web/tests/prerender.test.ts` (5 new tests) |
| `og:site_name` is "OrcaETF.com"; the shell has a JSON-LD `WebSite` block with `alternateName` ["OrcaETF.com", "OrcaETF"]; fund `WebPage` blocks link to it | Owner wants ETF capitalised wherever the domain name is shown. A browser's address bar and Google's URL line always show a domain in lower case; only text we write can use the capitals (chat) | `prerender.mjs` |
| Logo round 5: five variations of f5 (upright blue fin, head patch moved, blue tile, ink tile), made with the design-superpowers creative skill | Owner asked for variations of f5 (chat) | `docs/superpowers/logo-drafts/round5/` |
| "Popular funds" tab added to the idea backlog as item 2b | Owner (chat) | `docs/superpowers/specs/2026-11-13-idea-backlog-and-order.md` |
| Merged `claude/cool-goldberg-izesd8` (7 commits, not yet in `main`) into this branch by fast-forward; PR [#27](https://github.com/Cannibara/Orca/pull/27) opens it into `main` | Owner: PR it so work can build on it (chat) | |

- Checked: 938 web tests, typecheck, a build with `SITE_URL` (a built demo page was read), Playwright smoke. Stock (position) pages `/fund/:id/stock/:stockId` are single-page-app routes: one pre-built file per fund only, because one per fund-stock pair would be millions of files (Pages allows 20,000).
- Same day, second pass: the production Web build passes `PRERENDER_FUNDS` (the curl'd funds.json), and the first version of the holdings text skipped itself in that case, so it would not have appeared live. It now reads the other files from `VITE_DATA_URL` whatever supplies the fund list (test: "the production shape"). The sitemap gets `lastmod` (manifest `built`). Playwright now reads the raw pre-built fund file and the home head. Owner steps for Search Console and Bing are in `docs/domain-and-data-hosting.md`.
- Also fixed: the e2e title test expected "Orca" on Home, which was stale after the 2026-11-13 title change; it now expects `HOME_TITLE`.
- Open: the real-data build has not run (the data site is not reachable from this session): 500 summary fetches add build time, so check the first Web run. Home page HTML is still the empty shell (the app renders its links after load, which Google does run). A "latest quarter" page, a `/funds` directory route, icon files and `og-default.png`, and the owner's Search Console steps are still to do. The owner has not picked a logo.

## 2026-11-13 — AUM outflow outline heavier; idea backlog spec; SEO plan

| What changed | Why | Files |
|---|---|---|
| AUM net outflows were already an orange dashed outline (no fill). The outline is now 1.75px with dashes `4 3` (was 1.25px, `3 3`), and the legend swatch border is 2px. Checked in the browser on demo funds 9100001–9100003; 932 web tests pass | Owner: outflows must be an orange dashed outline (chat) | `web/src/fund/aum.css` |
| New short spec ranking the owner's 12 ideas by effort and value, with build order | Owner asked for a spec in the repo (chat) | `docs/superpowers/specs/2026-11-13-idea-backlog-and-order.md` |
| New plan for SEO and logo (not built) | Owner (chat) | `docs/superpowers/plans/2026-11-13-seo-and-logo.md` |
| Owner says Tiingo is now a commercial licence. Tiingo's docs say that tier is still internal-use only, so it needs confirming in writing that it covers showing prices on the site. ROADMAP L1 stays open until then | | |

## 2026-11-13 — SEO started; logo drafts; database decision

| What changed | Why | Files |
|---|---|---|
| Home title is "Hedge fund search and holdings" with a new description (index.html and `useTitle` on Home) | SEO plan step 1, draft copy for the owner to edit (chat) | `web/index.html`, `web/src/pages/Home.tsx`, `web/tests/app.test.tsx` |
| With `SITE_URL` set, prerender adds Open Graph and Twitter tags to every fund page and to the shared shell (the shell has no `og:url`, since it serves every route), plus JSON-LD on fund pages (`<` escaped). `og:image` and `summary_large_image` appear only when `og-default.png` is in the build, so no broken image link | SEO plan steps 3–4 | `web/scripts/prerender.mjs`, `web/tests/prerender.test.ts` |
| Five draft logos and a preview sheet, made by one design agent. Recommended C (fluke on blue), second A (the current mark made bolder). Not wired into the site | Owner asked for low-effort drafts (chat) | `docs/superpowers/logo-drafts/` |
| Spec gained a "when to add a database" decision | Owner (chat) | `docs/superpowers/specs/2026-11-13-idea-backlog-and-order.md` |

## 2026-11-11 — Table view: same height as the chart, renamed; selected-row shading

| What changed | Why | Files |
|---|---|---|
| "Show the numbers" / "Show the chart" are now "Table view" / "Chart view" on Annual returns, Return constituents and AUM. "Return Constituents" is "Return constituents" everywhere | Owner (chat) | the three panels, tests, `e2e/smoke.spec.ts`, `docs/PRODUCT.md` |
| Switching views no longer changes the panel's height (it moved by −24 to +40 px before). The chart stays mounted but hidden (`ChartSlot`: `visibility:hidden`, `inert`, `aria-hidden`) and holds the height; the table fills the same box (`.tview`, absolute, `inset:0`) and scrolls inside it with a sticky heading, so the whole list is reachable. Measured before / after in the browser: Annual returns 432 / 432 and 430 / 430, Return constituents 521.6 and 519.1, AUM 521 and 514, at 1280 and 400 px. The scrolling box is keyboard-focusable and labelled "…, scrollable". `max-height:340px` on `.tbl-box` is gone | Owner: tables as big as the graph, showing more rows (chat); designed and measured by an agent | `web/src/fund/ChartSlot.tsx` (new), `base.css`, `ReturnsPanel.tsx`, `DrivePanel.tsx`, `AumPanel.tsx`, three test files |
| Annual returns table: the selected row's band now covers the row header cell too (it painted only the data cells, so the year cell looked unshaded next to its neighbour), and the Part year tag no longer makes its row taller than the others | Owner: inconsistent shading on the part-year row (chat) | `web/src/fund/base.css` |
| Risk: a tooltip opened from the keyboard on the hidden chart could stay on screen; not seen, no fix | | |

## 2026-11-11 — Part years count in Years positive; AUM gains bar edge

| What changed | Why | Files |
|---|---|---|
| How it actually was: a part year's bar was already its return to date (the quarters compounded, never annualised), and its quarters were already inside the annualised return, growth of $1, volatility, drawdown and "% of quarters positive" of any span that included it. What it was left out of: the "Years positive X of N" tile (full years only), the best / worst year highlight, and the numbers table's "Counted / Not counted" column. So the old subtitle "Part years are shown but not counted" was wrong for the headline figures and right only for those three | Owner asked why, and whether the commentary or the numbers were wrong (chat) | |
| Years positive now counts every year with a return, part years included (demo fund: "6 of 13", was "6 of 11"), and its tick picture has a tick per year. `spanKpi` keeps `up` / `nFull` (full years, the workbook's definition and the parity test) and adds `upAll` / `nAll` for the tile. The "In annual figures" column is gone from the numbers table. Best / worst highlighting still skips part years (a label aid, not a count). Not changed: the published `metrics.years_pos` / `years_total` / `best_year` / `worst_year`, the turnover over full years, and the workbook's range tiles all stay full-year | Owner: part years should count (chat) | `web/src/fund/series.ts`, `KpiStrip.tsx`, `ReturnsPanel.tsx`, tests incl. new `web/tests/fund-partyear.test.ts` |
| AUM: the gains bar gets a 1px edge in its own colour like the bars beneath it, so it is no longer narrower | Owner (chat) | `web/src/fund/aum.css` |

## 2026-11-11 — Fewer explanations on the fund page

| What changed | Why | Files |
|---|---|---|
| Removed the line under Overview / Positions ("The first four tiles follow the Annual returns bracket…"), the subtitles under Annual returns, Return constituents and AUM, and the footnote under the What-if table (mid-quarter IRR, "1y after", "$ missed / dodged", last change). The KPI caption stays in the page as screen-reader-only text (`vh`), so the tiles' span is still announced. The What-if subtitle and the other panels are unchanged. Unused `fullYears` deleted | Owner: users don't need everything explained (chat) | `web/src/fund/KpiStrip.tsx`, `ReturnsPanel.tsx`, `DrivePanel.tsx`, `AumPanel.tsx`, `WhatIfPanel.tsx`, five test files |
| Note: with the Annual returns subtitle gone, "estimate" is carried by the page footer ("Every figure is an Orca estimate…"), not by that panel | CLAUDE.md says every figure is labelled as an estimate | |

## 2026-11-11 — Return constituents: solid total, lighter parts; period pill keeps its black on hover

| What changed | Why | Files |
|---|---|---|
| Return constituents waterfall: the Total bar is solid `--gain` (solid `--loss` when the total is negative, as in the demo's 2025 for fund 9100003); the bars that add up to it use new tokens `--gain-soft` / `--loss-soft` (light theme: 55% of the colour over the paper; dark: 62% over the ink, so they read lighter) with a 1px full-colour edge, since a tint alone is under 3:1 on the light panel. Tooltip swatches match. Scoped to `.viz.wf`; other charts' bars are unchanged | Owner: Total should be the main blue, the parts lighter blues (chat) | `web/src/fund/drive.css`, `drive.ts`, `web/src/tokens.css` |
| Positions period selector: the chosen (black) pill no longer changes colour on hover. The cause was base.css's `.fp .stepper button:hover:not(:disabled):not([aria-disabled])` (0,5,1), which beat `.pi.on`; the override repeats that selector with `.pi.on` so it outranks it. Unchosen pills keep their hover tint. Checked in the browser: computed colours identical before and after hover | Owner (chat) | `web/src/fund/positions.css` |

## 2026-11-11 — Tab underline sits on the hairline, spans the tab exactly

| What changed | Why | Files |
|---|---|---|
| One shared tab strip: `.tabs` has 1px bottom padding so the hairline and the 2px dark bar (`.ind`) both sit inside its scroll box (the bar used to be clipped to 1px above the line); the fund page's own `.fp .tabs` rules are deleted and its buttons use `.tab`; Home's `.tabrow` hairline is an inset shadow on the same pixel. The bar's `--x` / `--w` come from `getBoundingClientRect` (fractional) instead of `offsetLeft` / `offsetWidth` (rounded, bar ~0.2px too wide). Measured: bar bottom = strip bottom, bar span = tab span, on Home and the fund page at 1280 and 400 px. Touch devices now get the 44px `.tab` height on the fund tabs too | Owner: the underline under Top funds / Overview was not aligned (chat); diagnosed by a design agent | `web/src/styles.css`, `web/src/fund/returns.css`, `web/src/fund/FundHeader.tsx`, `web/src/components/Tabs.tsx`, `web/src/pages/home.css` |

## 2026-11-11 — Web deploy failed on a data-site error; fetch step retries harder

| What changed | Why | Files |
|---|---|---|
| Run 125 (merge of #25) failed in the deploy job's "Fetch funds.json from the data site" step: `data.orcaetf.com` answered 502, then dropped the HTTP/2 stream (curl exit 92). The tests job and the PR run of the same code passed, and the host was back at 200 minutes later, so it was transient. The failed job was re-run. The step now uses `--retry 5 --retry-all-errors --retry-delay 15 --max-time 60` (plain `--retry` skips an error like exit 92) | Owner: deploy failed, find out why (chat) | `.github/workflows/web.yml` |

## 2026-11-11 — Dark mode: lighter greys, one blue in both modes; switch resized

| What changed | Why | Files |
|---|---|---|
| Dark tokens, both blocks kept identical: page `#181512`, panels, table rows and chart areas (`--surface`) `#28241F` (was `#1C1814`), table headings and opened row (`--sunken`) `#1F1B17` (was equal to the page), hover `#322D27`, band `#38322B`, raised `#302B25`, lines, `--control` and `--ink2` / `--ink3` lightened. All text pairs stay ≥ 4.5:1 (computed). `meta theme-color` (dark) `#28241F` | Owner: lighter grey for graph and table areas in dark mode (chat); values from a design agent | `web/src/tokens.css`, `web/index.html` |
| `--gain` is one blue, `#267CAA`, in light and dark (light was `#0E658C`, dark `#3A8FC2`, and signed text mixed another blue). Fills, strokes and swatches use `--gain`; blue text uses the new `--up-text` (`#0E658C` light, `#5BA3CE` dark); text on a blue box uses the new `--gain-fg` (`#FFFCF8`, since the dark `--invfg` gave only 4.1:1). The dark `--up` colour-mix is gone. Orange unchanged | Owner: the annual-gains blue must stay the same in dark mode (chat). Note it moved the light blue a little lighter (4.5:1 on the paper, was 6.3:1) | `tokens.css`, `styles.css`, `positions.css`, `whatif.css`, `position.css` |
| Theme switch 72×38 with a rounded-rectangle track and knob (was a 60×32 pill); on the fund page 8px lower | Owner (chat) | `styles.css`, `returns.css` |
| Open: the tinted fills (`.bar.corp`, step-chart area, `.pill.buy`) still mix `--gain` with the surface, so they look a touch different per mode | | |

## 2026-11-11 — Day / night slider; opened-row colours the other way round

| What changed | Why | Files |
|---|---|---|
| The theme button is now a slider (`role="switch"`, name "Dark mode"): a sun on the left, a moon on the right, a knob that slides to the side in force | Owner: a single button was silly (chat) | `web/src/components/ThemeToggle.tsx`, `web/src/styles.css`, `web/tests/theme.test.tsx` |
| Opened stock (Positions and What-if): the chart and the area behind it are the lighter paper (`--surface`); the darker paper (`--sunken`) is on the opened stock's own row and on the trade list's column headings. Before: the panel was sunken and the row banded. Supersedes the fill change two entries down, which only made the trade list's rows lighter | Owner meant this when asking for consistent table colours (chat) | `web/src/fund/positions.css`, `web/src/fund/whatif.css` |

## 2026-11-11 — Light / dark switch back, search moved to the tab row

| What changed | Why | Files |
|---|---|---|
| A square icon button (`ThemeToggle`) switches light and dark at the top right of every page: level with the fund's name on the fund page, level with the heading on the position page, in the hero where the search was on Home, and above the card on the not-found page. The pick is kept in this browser (`localStorage` key `orca-theme`) and applied in `main.tsx` before the first render; with no pick the device's setting rules, as before (`tokens.css` already read `<html data-theme>`) | Owner asked for it (chat); DECISIONS line 125 had left the theme switch out of the fund page | `web/src/lib/theme.ts`, `web/src/components/ThemeToggle.tsx`, `main.tsx`, `FundHeader.tsx`, `Home.tsx`, `Position.tsx`, `NotFound.tsx`, `styles.css`, `returns.css`, `home.css`, `position.css`, `state.css` |
| Home: the fund search moved down into the tab row, at the right, level with Top funds / Conviction moves …; its label is visually hidden (still its accessible name). On narrow screens the search stacks above the tabs. The tab order is now tabs, then search, then the page | Owner (chat) | `web/src/pages/Home.tsx`, `home.css`, `web/tests/home.test.tsx` |
| Known: a visitor with a saved dark pick sees a short light flash on first paint, since the strict CSP rules out an inline script in `index.html` | | |

## 2026-11-11 — Opened-row trade list matches the fund page's tables

| What changed | Why | Files |
|---|---|---|
| The trade list under an opened row (Positions and What-if share `.xtbl`): rows are on the surface fill, 38px, with the light rule and the hover tint (were sunken, so they blended into the sunken opened row); heading type is the tables' 12px/1 muted; the grey action box is back to the same 9% grey as the other tables | Owner: the table's fill and heading style differed from the other fund-page tables (chat) | `web/src/fund/positions.css` |

## 2026-11-11 — Position panel (row click): filled action boxes, % cut labels

| What changed | Why | Files |
|---|---|---|
| The trade list's Action is a filled box like the What-if Status and the Position page: blue for New/Added, grey for Trimmed and Sold all (was an outlined neutral tag with a +/− icon) | Owner: the panel did not look like the other graphs and tables; Trimmed should be a grey filled box (chat) | `web/src/fund/StockPanel.tsx`, `web/src/fund/positions.css` |
| Each sale on the price chart carries a small label under its triangle: shares sold as % of the shares held at the end of the quarter before (`sharesAfter − delta`); "−100%" for a sale of everything, "−<1%" under 1%. A legend note says so | Owner (chat) | same, `web/tests/fund-stockpanel.test.tsx` |
| Open: the sell triangles on the chart stay orange (as on the Position page), while the Trimmed box is grey; not changed, no answer yet | | |

## 2026-11-11 — Conviction moves: one Weight column like the Positions table

| What changed | Why | Files |
|---|---|---|
| The Move and Weight now / Weight after columns are replaced by one "Weight" column: "was → now" over the Positions table's bar (solid grey for the weight before, striped blue/orange for the change). Before = `weight_after` less `change_pts`; exits end at 0%; the tooltip adds the change in % of AUM. Sorts by the signed change, biggest buy first. The `.wcell` bar CSS is copied under `.tbl-wrap` | Owner asked for it (chat); also closes the open question on matching the two views' Weight columns (both views now have the same column) | `web/src/pages/Home.tsx`, `web/src/styles.css`, `web/tests/home.test.tsx` |

## 2026-11-11 — Panel titles 30% smaller

| What changed | Why | Files |
|---|---|---|
| Panel titles on the fund page (`.fp .pt`) and the Position page (`.pos-page .pt`): 28px → 19.6px (line height 26px), no separate phone size | Owner found 28px too big; asked for 30% smaller (chat) | `web/src/fund/base.css`, `web/src/pages/position.css` |

## 2026-11-11 — Positions columns: Weight left-aligned, even gaps

| What changed | Why | Files |
|---|---|---|
| Weight heading left-aligned like its cells (`.wk`); Held 68px, Weight 92px, Stock 150px fixed; the nine figure columns have no width and share the rest equally (table min width 1026px) | The gaps between columns looked uneven, and Held to Weight too wide: a fixed table stretches every column in proportion, so the wide Held column got wider (chat) | `fund/PositionsTable.tsx`, `fund/positions.css` |

## 2026-11-11 — Weight bar: solid and striped parts flush

| What changed | Why | Files |
|---|---|---|
| The striped part sits directly against the solid one (the 1px gap is gone) and the join is square; only the outer ends are rounded | Owner (chat) | `web/src/fund/positions.css` |

## 2026-11-11 — Position page titles bigger; smoke test follows the rename

| What changed | Why | Files |
|---|---|---|
| Position page panel titles (`.pos-page .pt`) 16px → 28px (22px under 640px), like the fund page | Owner (chat) | `web/src/pages/position.css` |
| Playwright smoke test looked for "What drove": now "Return Constituents". PR #15's Web run failed on it and the deploy was skipped; I had run only vitest. Run `npx playwright test` before merging UI text changes | CI red (code) | `web/e2e/smoke.spec.ts` |

## 2026-11-11 — Positions: no Last change column; bigger panel titles; Return Constituents

| What changed | Why | Files |
|---|---|---|
| Positions table: Last change column removed (12 columns, min width 1096 → 960px, `mode` prop and the `last` sort key gone, dead `.lc` CSS removed). The What-if table keeps its Last change | Weight's was → now carries the movement (chat) | `fund/PositionsTable.tsx`, `fund/PositionsPanel.tsx`, `fund/positions.ts`, `fund/positions.css`, tests |
| Panel titles (`.fp .pt`: Annual returns, Return Constituents, AUM, Positions, What if) 16px → 28px, the size of the key-figure tiles' numbers; 22px under 640px wide. The Position page's own `.pos-page .pt` is unchanged | Owner wanted titles as large as the tile figures (chat) | `fund/base.css` |
| "What drove 2023 to 2025" → "Return Constituents 2023 to 2025" (no years: "Return Constituents") | Owner's wording (chat) | `fund/DrivePanel.tsx`, tests |

## 2026-11-11 — Positions table: Weight shows was → now

| What changed | Why | Files |
|---|---|---|
| Weight cell reads "was% → now%" where the fund traded in the period (sold out: "was% → 0%"); bar = old weight solid grey, then a striped extension (blue if larger, orange if smaller; the striped part is the weight added or given up). New `PosRow.wPrev` (weight before, at the period's end prices). Weight column 72 → 104px, table min width 1064 → 1096px | Fold Last change into Weight (chat) | `fund/PositionsTable.tsx`, `fund/positions.ts`, `fund/positions.css`, `fund/whatif.ts`, tests |

- Last change box and column kept, `dw` unchanged (the Excel workbook uses the same formula; parity test). `dw` isolates the stock's own trade, while was → now are the book's real weights, so they can differ by a point or two when other stocks traded too (code).

## 2026-11-11 — Positions tab count = holdings now

| What changed | Why | Files |
|---|---|---|
| The number on the Positions tab is `summary.n_holdings` (positions held in the newest quarter), was every position ever (sold ones included) | It disagreed with "N holdings now" in the line above (chat) | `web/src/fund/FundHeader.tsx`, tests |

## 2026-11-11 — What-if Last change: orange only for Sold all

| What changed | Why | Files |
|---|---|---|
| Last change: "Trimmed" back to the grey box; only "Sold all" is orange (What-if only) | Owner wants the full sale to stand out, not trims (chat) | `fund/WhatIfPanel.tsx`, `tests/fund-whatif-ui.test.tsx` |

## 2026-11-11 — What-if table: status, last change, value sold

| What changed | Why | Files |
|---|---|---|
| Status pill is the grey "Sold all" box for both Trimmed and Sold all, regular weight (was bold, orange for Trimmed) | Status needn't repeat the colour; Last change carries it (chat) | `fund/WhatIfPanel.tsx`, `fund/whatif.css` |
| Last change: "Sold all" now orange like "Trimmed" (What-if only; Positions table unchanged) | A full sale is a cut too (chat) | `fund/WhatIfPanel.tsx` |
| "Shares sold" column → "Sale proceeds" (`sold_usd`, whole $m, key `usd`) | Dollars compare across stocks; shares don't (chat) | `fund/WhatIfPanel.tsx`, `fund/whatif.ts`, tests |

## 2026-11-11 — Last-change boxes smaller

| What changed | Why | Files |
|---|---|---|
| Last-change boxes (`.lc`) and What-if status pills (`.st`): padding 1px 6px (was 3px 8px), 3px radius, word 11px, figure 12.5px (was 14px); `.st` 11.5px | The solid colour made them overwhelming next to 13px table text (chat) | `web/src/styles.css`, `fund/positions.css`, `fund/whatif.css`, `pages/position.css` |

## 2026-11-11 — Last-change boxes in solid gain and loss colours

| What changed | Why | Files |
|---|---|---|
| New/Added/Trimmed boxes (`.lc.add`, `.lc.trim`, What-if `.st`) are solid blue (`--gain`) and orange (`--loss`) with `--invfg` text, the bar chart's colours; "Sold all" stays grey | The light tints looked inconsistent with the bars (chat) | `web/src/styles.css`, `fund/positions.css`, `fund/whatif.css`, `pages/position.css` |

- Light theme: `--invfg` on `--loss` is about 4:1, a little under AA for the 11.5px word (code, computed).

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
