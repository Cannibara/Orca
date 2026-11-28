# Decisions (ADR log)

Last verified: 2026-11-28

Newest first. Tags: (chat) session conversation, (code) checked in code, (git) commit history.
Earlier build rulings R1–R33 (pipeline and website, 2026-10-30/31) are in
`docs/superpowers/2026-10-31-orca-rulings-and-backlog.md`; they are not repeated here.

## 2026-11-28 — Landscape follow-ups (owner: "5 fix recommendations sound good")
- A firm filing under several names is one tile per type of investor (`investor_parents.csv`, by hand: Vanguard's ten filers, Capital Group's six, Susquehanna, the Japanese and Canadian bank groups, Sequoia's seven, ...), its books added and its returns weighted by book; the tile opens its largest filer. A firm's filers of different types stay apart (UBS's bank and its asset manager).
- Market makers and trading firms (Jane Street, Susquehanna, Optiver, Virtu, HRT, ...) are Hedge funds > Quant & multi-strategy, not Banks & brokers (owner: "label them as quant firms").
- Hedge fund styles beyond the famous list: ~180 more by hand, and an "Other hedge funds" filer gets one from its holdings at run time (`investors.refine_hedge`): 60%+ of the book in health care, or in tech and communication, makes a specialist; 400+ priced positions a quant or multi-strategy fund.
- Colours stay the holdings tree map's green/red (owner), the one exception to the blue/orange rule. Custodian money in banks' 13Fs is not separated (owner: few will analyse it).
- The adviser-register snapshot is refreshed each quarter by a workflow (`investor-types.yml`) that opens a pull request; a merge and the next run publish it.

## 2026-11-26 — Home Landscape: every 13F filer by type of investor; index firms kept as ETF providers (owner)
- Decision (chat): a tree map of all current 13F filers on the home page, grouped by type of investor, with the period switch Famous funds uses. Hierarchy (owner): top level Hedge funds, Asset managers, Banks & brokers, Insurers (no sub-types), Pension funds, Sovereign wealth & central banks, Endowments & foundations, Family offices, Private equity & VC, Companies; hedge funds split by the Famous funds styles; asset managers into ETF providers, Mutual funds and Wealth managers (owner), plus Institutional managers (build: Wellington, Arrowstreet, GMO run institutions' money, not funds). "Not yet classified" holds the rest (about 2% of the money).
- ETFs and index funds: ETFs do not file 13Fs, but the firms that run them do, and one 13F mixes a firm's index and active money. The owner chose to keep them, as Asset managers > ETF providers (Vanguard, BlackRock, State Street, Geode, and the mixed Invesco, Northern Trust, Schwab, Dimensional, First Trust, VanEck), and not to strip ETF shares out of other filers' books ("confuses things and is not a solution"). The double counting (ETF money in the provider's 13F and again in the 13F of any filer holding the ETF) is said on the page, and the ETF providers' total bounds it.
- How filers are typed (`pipeline/orca/investors.py`; 13Fs carry no type): hand labels (`investor_types.csv`, the ~300 largest: holding companies, banks, pensions and sovereign funds are not in the adviser register) > the famous lists (a style list is the hedge fund style unless the register calls the firm an asset manager) > an ETF firm by name > the SEC's monthly adviser register (Form ADV: where an adviser's assets come from, Item 5.D, and its private funds, Item 7.B; `scripts/investor_types.py` writes `investor_types_adv.csv`, refreshed by hand like the Google Trends snapshot) > the SEC industry code (banks, brokers, insurers; any non-financial code is a company, e.g. Nvidia, Alphabet) > words of the name. At Q3 2026: hand 64% of the money, register 20%, names 8%, famous 6%, unclassified 2%.
- Why a snapshot file and not a pipeline fetch: the register is two zips a month, its typing needs review against the hand labels, and new filers fall back to the industry code and name rules at run time.
- Also: Perigee Private Management (Q2 1999) showed a $266 trillion book: its text table ran two columns together into 3.5 trillion-share rows. Rows of more than 50 billion shares (no listed company has as many) are now dropped at parse and at build, and the next ordinary run removes those already in the lake and recomputes their funds (`ingest.purge_misread_holdings`).

## 2026-11-26 — Before the data starts, every series is flat (owner: "assume it's the same year to year")
- Decision (chat): a position held when the 13F data starts (1998 Q4) is scored, not dropped. A stock's own series and every index series that begin with the data are flat (level 1.0) from 1998 Q4 to their first quarter (code `engine/skill._flat_start`). Fund and index side start from the same point, so picking and allocation gain nothing from it; the cost is that the first quarter or two of such a position count as no move on either side.

## 2026-11-26 — Wrong-company prices on the fund pages: the vendor ticker is rejected (owner: "As long as its an efficient fix, then yes")
- Decision (chat): the fund pages use the same check as the indices. Where 80%+ of a stock's quarters with a 13F price (4+ quarters) are 5x+ off the median price its holders report (`engine/sectors.mispriced`'s rules, the held-share guard; without a count on record, 20+ holders), the sectors step rejects its vendor ticker (lake table `vendor_rejects`). The next run's ticker lookup skips it and tries the next candidate (the SEC ticker of the same name, OpenFIGI's delisted US ticker); the existing path then drops the stored bars, refetches, recomputes the holders' funds and deletes the stock's chart. A stock with no other ticker is valued at the funds' reported prices (the engine's fallback).
- Also (run 53): where the vendor's prices are another company's but in the same range (Exact Sciences under EXK, Endeavour Silver's; Juniper Networks under JNP), the 5x rule finds only half the quarters. Their moves give them away: over 8+ pairs of consecutive quarters, the median gap between our quarter-on-quarter price change and the holders' is 15% or more (log terms); the same company's is a few percent.
- Why this, not a per-quarter price override: it reuses the ticker machinery that already handles reused tickers, with no new path through the fund engine or the charts. A stock right for part of its history (Mechanics Bancorp after the 2025 merger) loses the right part too and falls back to reported prices there.
- Guards: at most 300 new rejections a run (more is a broken input, flagged `vendor_rejects_held`); a rejection is kept for good (the prices it named are gone).

## 2026-11-24 — Sector indices: market caps from SEC counts made consistent, ADR ratios read from 20-Fs (owner: "keep iterating")
- Decision (chat): fix the indices by patterns, not stock by stock. The owner approved each fix and run (PRs #63–#73) and then asked to "keep iterating by discovering patterns of issues and plugging them with scalable solutions".
- What the runs showed (WORKLOG runs 39–45): a market cap is a price times an SEC cover-page count, and four kinds of error put single stocks at 5–99% of the market: (1) the price and the count on different sides of a split; (2) counts scaled 1,000x or 1,000,000x, most in the first XBRL filings of 2009–11; (3) ADRs counted in ordinary shares; (4) before a company's first count, today's count, or a slipped first count, standing in.
- Now (code `engine/sectors.todays_counts`, `market_caps`): every count goes to today's share basis with the splits after its date. 1,000^k jumps between counts as reported with no split between them are divided out. Counts 5x off the 9 around them are dropped. Before a company's first count, its earliest clean count stands in. ADR ratios are read from each filer's latest 20-F (`sec/adr.py`, lake table `adr_ratios`: 63 of 64 known ratios read right, none wrong), with `share_overrides.csv` on top for hand corrections. The guards (15% of the market, count jumps, +300% quarters) stay as a last net, and every run logs the stocks at 4%+ of the market.
- A fifth kind (run 45): a price history that is another security's. Mechanics Bancorp (once HomeStreet) took the ticker MCHB from Mechanics Bank, whose OTC shares cost $10,800–36,500, and the vendor's history under the ticker is that bank's up to the 2025 merger: $875bn in 2017. Now (code `engine/sectors.mispriced`, `run/sectors_step.reported_prices`): each stock-quarter's as-traded close is checked against the median price its 13F holders report (value over shares) for the CUSIP mapped to it that they hold the most dollars of (run 47 took all its CUSIPs and read BlackRock at the $10 of the BlackRock funds the CUSIP map also gives its id), where the funds hold 25–150% of the company's shares in it (run 49: Honeywell's and Accenture's most-held CUSIP was some other security mapped to them); 5x or more off, with 3 or more funds reporting, the close is set aside for the indices and for the fund scores' stock series (`stock_quarters`). Fund returns on the other pages still use the vendor's close: a separate decision.
- Before a company's first SEC count (none exist before 2009; Lloyds' first is 2017), its earliest stands in, far off for a company that issued many shares in between (Citigroup's 2009 count is 4.6x its 2007 one, Lloyds' 13x). Now (code `engine/sectors.held_scales`): there, the earliest count is scaled by the stock's 13F-held shares then over those at the count, against the market's same move (a chained index of the median stock's quarter-on-quarter change), where 10+ funds hold it, at least a tenth as many as at the count; the scale is the median over the company's first 8 filed counts (run 48: in Sept 2009 the government held a third of Citigroup, unreported in any 13F, so one anchor left it unscaled), on held shares smoothed over 5 quarters; only scales of 0.5 or less are used (a higher one is more often institutions leaving a distressed stock, like AIG's in 2009, than a buyback), so a stock is only ever read smaller.
- Known limit: the scale is a proxy. A company whose institutional ownership rose much faster than the market's reads too small before its first count, and Citigroup's 2009 count includes the government's 7.7bn shares, which no 13F reports, so it likely stays somewhat too big.

## 2026-11-23 — Licensing for the sector panels: approved (owner)
- Decision (chat): the owner is "Ok with licensing" for showing figures built from Tiingo prices (L1) and Damodaran's industry lists (R10) on the site, the gate DECISIONS 2026-11-16 deferred "until something is shown on the site" and 2026-11-21 left open. PR #61 (the Specialization tab and the sector files) may merge.

## 2026-11-22 — Fund page: the sector panels get their own tab, Specialization (owner)
- Decision (chat): the four sector choice vs stock choice panels are not on Analysis. A new tab, **Specialization**, right of Analysis (Holdings, Analysis, Specialization, About), holds them in this order: the map, the Annual return stacked graph (with its Lines view), Sector mix over time, Which decisions made the gap. Analysis keeps its key figures, Assets under management, Return constituents and What if. Replaces the 2026-11-21 placement (below) (code `fund/FundHeader.tsx`, `pages/Fund.tsx`, `fund/SkillPanels.tsx`).
- Consequences: the KPI strip no longer sits between the map and the stacked graph; a fund without a sector file shows "Not scored yet" on the tab instead of the panels being absent; the tabs are tighter under 420px so four fit at 360px.

## 2026-11-22 — Sector files: how the yearly split is measured, and what the build chose (build)
- Decision (code `engine/skill_detail.py`): the replays' quarterly returns are time-weighted at the trade, not modified Dietz as the spec said. A replay trades at the quarter's average level, so the return chains the move from the last quarter end to the trades with the move from the trades to the quarter end. Money in or out then never moves a return; modified Dietz inflated a year with a big sale (selling all of $100 for $110 mid-quarter read as +22%, not +10%). The yearly identity market + sector choice + stock choice = fund still holds exactly. The contract says so.
- Decision (code): the publish part replays the trades again rather than reading new lake tables from the scores step, so the scores (14 min in run 31) cannot be lost to a longer step; a local 640,000-trade chunk took 2.6x the scores' time, so its step has 90 minutes.
- Decision (code `run/publish_step.is_sector_path`): the monthly run treats `sectors/*` and `fund/{id}/skill.json` as the sector step's: never owed in `_reconcile_published` (else every scored fund would be recomputed each month) and carried over into its manifest.
- Decision (code): the demo builds its sector files with the real sector step on the demo lake, not made-up numbers; its 24-stock market makes every demo fund's sector choice negative.
- Built as the spec's defaults: tier switch on Industry; "never rotated" not built (`v_never` published as null; spec §6.9 optional).
- Licensing sign-off: given 2026-11-23 (entry above).

## 2026-11-21 — Top funds as the Famous funds chart; Index giants not shown
- Decision: Top funds takes the Famous funds design: chart first with a Chart | Table switch, no card (page background for chart and table), the same heading structure, photo or initials before a short name, a 20-row window (phone 10) and 80 funds a page with a Next button. The Index giants list is no longer shown (owner, chat 2026-11-21) (chat)(code `web/src/pages/Home.tsx` TopFunds, `web/src/home/FamousChart.tsx` `offset`/`total`/`foot`).
- Context: Top funds has ~1,500 funds; one chart of them all would put #1 and #1,500 on one scale and one 1,500-row window. Each page of 80 has its own scale ("one scale for this page" in the caption), so bars are comparable within a page, not across pages. The person and photo come from the same file's famous rows (by fund_id); no contract change. `giants` is still published (contract unchanged) (code).

## 2026-11-21 — Fund page: how sector choice vs stock choice is shown (owner)
- Decision (chat): four new panels on the Analysis tab, above the existing ones: "What kind of investor?" (a map of stock choice across, sector choice up, peers from the fund's famous-funds list), "Annual return stacked graph" (each year = market + sector choice + stock choice, in the Assets under management chart's style, switching to Lines), "Sector mix over time" (mix only, Sector / Industry / Sub-industry), "Which decisions made the gap" (stocks vs their sector, sectors vs market, with the share of money as a bar and an Adds column). Approved over five drafts of claude.ai artifact BvTgoeVpWCPrmwDhXF55Wz (v5); the build spec is `docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md`.
- Decision (chat): the Annual returns bar chart stays on Holdings, unchanged; the new chart is named "Annual return stacked graph" so the two are not confused.
- Decision (chat): the Lines view shows the S&P 500 (SPY total return) as a reference line. This overrides R23 ("no SPY benchmark on fund pages") for that line only; the split is always measured against Orca's whole-market index, because the sector indices add up to it.
- Decision (chat): readers see "sub-industry" for the third hierarchy level; code and docs keep "vertical" / "industry vertical".
- Default (spec, owner may override): one shared Sector / Industry / Sub-industry switch, default Industry, as R9 says; the drafts were drawn at sector level without one.
- Open: licensing (Tiingo L1, Damodaran R10) was deferred on 2026-11-16 "until something is shown on the site"; the owner must confirm before this is merged to `main`. Also resolves part of the 2026-11-10 conflict list (R23; "luck vs skill" stays out of the wording, with a "too close to call" band on the map).

## 2026-11-20 — Fund page: tiles split 4 and 4; Annual returns on Holdings, AUM on Analysis
- Decision: Holdings = four tiles (annualised return, max drawdown, turnover per year, average hold length), Holdings tree map, Annual returns, Positions. Analysis = four tiles (years positive, volatility, risk-adjusted return, positions profitable), Assets under management, Return constituents, What if they'd kept it. About = About only. Panels, titles, details and formatting unchanged; only their place moved (owner approved draft claude.ai artifact HqU6sXjkXUy91FNa9GoN64, v4) (chat)(code `web/src/pages/Fund.tsx`, `fund/KpiStrip.tsx` `group`, `fund/HoldingsTab.tsx`).
- Context: the window (15 years / Max), selected year and bracket stay page state, so Analysis' span tiles, AUM and Return constituents follow what was picked on Holdings' Annual returns; Analysis has no control for them except Return constituents' own strip and stepper (chat).
- Consequences: on phones (< 560 px) the risk-adjusted and positions-profitable tiles still take a full row; the rule now names `.kpi-prof` instead of `:last-child`, so Holdings' four tiles sit 2×2 (code `fund/returns.css`).
- Open: a year picker on Analysis, and clicking a year on Holdings to set the tree map period, were raised in the draft and not built (chat).

## 2026-11-20 — Tree map tiles print the fund's return for the period beside the weight and value
- Decision: the second row of a tile reads `12.3% · $80.2B · +4.1%`: weight, value, and the fund's return on the holding over the period (a quarter, or 12 months in Year mode). Where the row is too narrow it drops the weight first, then the return (value, then return, then weight); a short tile puts value and return at the right end of the ticker's row. The figure is the one that already coloured the tile: shares held at the start of the period from the previous quarter's last close to the period-end price, shares bought in it from the quarter's VWAP to the period-end price (today's price for the newest quarter, the quarter's last close for an older one), sales at their VWAP, dividends received added. A hollow tile and Other stocks print no return (owner, chat 2026-11-20) (chat)(code).
- Context: the Positions table's Return column is the whole life of a position (total P&L over everything invested), so a stake held for years shows a different figure there. For a position that began in the period the two are the same number, and a test holds that on every demo fund; a separate test rebuilds the return from the owner's four rules (carried shares start to end, bought shares VWAP to end) and compares. Open: a "Qtr return" column in the table would put the per-period figure next to the lifetime one (not built; owner to say) (code).

## 2026-11-19 — Tree map motion: boxes only, colours never animated, words in by the midway point, a dollar value on every tile
- Decision: only the tree map's boxes animate (they grow from their centres on landing and move between periods, 600 ms on the Analysis bars' curve). A tile has its final red or green from its first frame; nothing is drawn until every tile's weekly prices are in, so there is no neutral stage and no colour tween (a red tile fading into a green one passes through brown). A word that changes goes out in 70 ms and the new one is fully in at 250 ms (the box has then covered ~89% of its way); one that does not change stays. Every labelled tile shows its dollar value: the second row is `12.3% · $80.2B`, then the value alone, then the weight; a tile under 39 px tall puts the value at the right end of the ticker's row (owner, chat 2026-11-19) (chat)(code).
- Context: the earlier version took 900 ms and showed the words only after the move; the next one showed them at once but its first grow-in was cut short in a real browser: the box is first drawn at the 600 px fallback width and measured a moment later, and that re-measure was treated as a resize (redrawn in place, no animation). Tests could not see it because jsdom never measures. The first draw now waits for the measured size and a redraw within 750 ms of landing joins the landing. The deferred-table idea (render the table after the tiles) was tried and gave no gain: start lag 91-133 ms vs 86-124 ms at 4x CPU slowdown (code).
- Consequence: on a slow connection the tree map is blank under "Loading prices…" until the weekly files of its tiles arrive (they were drawn in a neutral colour before). If that wait is too long, the alternative is to draw the boxes at once in a neutral colour and accept a colour change, which the owner ruled out (chat).

## 2026-11-19 — Fund page in three tabs; holdings tree map coloured by the fund's return
- Decision: the fund page is Holdings | Analysis | About. Holdings = an animated tree map of the holdings plus the Positions table, driven by one Quarter | Year picker (Year = the 12 months to a chosen quarter-end, stepping a year at a time; Custom removed). Tile colour is the fund's own return on each holding over the period (start value at the start quarter-end close, buys and sells at the quarter's VWAP, end at the period-end price, today's prices for the newest quarter), green/red through grey, on the tree map only. Every table prints money as $80.2B. About shows SEC facts only (owner approved draft v4, chat 2026-11-19; spec `docs/superpowers/specs/2026-11-19-fund-tabs-design.md`) (chat)(code).
- Context: the tiles, the table and the header disagreed by up to ~4% for past quarters because the table priced quarter ends from the Friday close before them; weekly.json now carries each stock's quarter-end close (`q0`/`qclose`), the engine's valuation price, so past quarters equal `summary.quarters.end`. The newest quarter stays at today's prices by the owner's choice, so it differs from the header's filed book and is labelled (code).

## 2026-11-19 — Photos of the people behind the famous funds
- Decision (chat): show a round photo before the fund name on the Famous funds lists, from Wikimedia Commons under public domain, CC0, CC BY or CC BY-SA, with credits on `/photo-credits`; a fund with no free photo shows no circle (owner chose "blank space" over an initials badge) (chat)(code).
- Why files in `src/assets/people/` and not `public/`: the owner replaces photos by hand; bundled files get a new URL when replaced, so no cache serves the old one, and the file name alone is the link (no list to edit) (code).
- Rejected: strict public domain only (few photos of living people are, so most funds would show none); photos of institutions (logos are trademarks, and the lists show a person) (chat).
- Consequence: replacing a photo means also editing or deleting its entry in `credits.json`, or the credits page names the old photographer.

## 2026-11-17 — Pre-2013 13F history read from the old text filings
- Decision: read every 13F-HR and 13F-HR/A filed on EDGAR from 1999 to the XML switch in mid-2013 (source `legacy`), find each row by its CUSIP check digit, and store a filing only if its table agrees with the filer's own declared entry count or value total (or declares none); prices and T-bills go back to 1999 (owner: "fully utilise pre-2013 SEC 13F data"; spec `docs/superpowers/specs/2026-11-17-pre-2013-13f-design.md`) (chat)(code).
- Context: the bulk data sets start with 2013 Q2 filings, so even Q1 2013 was missing (Berkshire's history began Q2 2013). On a 607-filing sample, 89.8% of text filings are stored: 77.3% agree with the filer's totals and 12.5% declare none to check (code `sec/legacy.py`).
- Companies that died before today are kept: a CUSIP first held before 2013 that OpenFIGI does not find is asked again with delisted securities included, and is never matched by name (old GM vs new GM); without that, old books lose their losers and old returns read too high (code `run/market.map_new_cusips`).
- A stock also held since 2013 keeps today's ticker rule over its 2013+ span only, so the older history cannot cost it its prices (code `run/market.held_spans`).
- Rejected: a full price refetch from 1999 (re-downloads every 2013+ bar); storing near-miss tables (wrong numbers are worse than less history); carrying unreadable quarters as filed (stale books) (chat).
- Measured before merge (2026-11-18, 140 funds): unreadable filings carried at most two quarters in a row rather than cutting a history; splits of stocks without vendor data read from the filings (two holders agreeing, before 2013 only); a delisted company never takes a vendor line still trading. Share-count typos not repaired: rare (none over 5% of a book in 100 random funds) and present in the XML era too (chat)(code).
- Consequences: a backfill run (`backfill` input) before the next ordinary run; a fund with two unreadable filings in a row shows only its history after them; run time and lake size grow (chat).

## 2026-11-17 — Sector return series: market-cap weighted, no cap, with dividends (owner)
- Decision (chat): the sector, industry and industry-vertical indices are market-cap weighted with no cap on any stock (R5), rebalanced each quarter. They are a measurement benchmark like the S&P 500 or MSCI, whose indices carry no cap; sector ETFs cap their biggest holdings to meet fund diversification rules, which does not apply here. Consequence: Apple, NVIDIA, Microsoft, Alphabet and Amazon are 58% of our Technology index.
- Decision (chat): total return with dividends from the start, no price-only first look. So the build lives in the pipeline, where the lake holds daily dividends and SEC share counts. The engine's `quarter_px` already gives each stock's quarterly close and dividends per share.
- Decision (chat): use an existing ETF as a hierarchy label's index where a good cap-weighted one exists (semiconductors: SOXX or SMH, no test against our own). Build our own for the 12 broad sectors (our definitions differ from GICS: about 25% of our Technology value sits in names XLK does not hold), for hierarchy labels with no ETF, and to back-fill an ETF's history before its launch where more than about 15% of the funds' buying predates it (memory ETF: 62%; cybersecurity 9%; airlines 22%).
- Confirmed (chat): scoring is at industry level (tier 2, 71 industries, R9); sector (12) and industry vertical (244) are toggles, and all three are computed in one pass. Verticals are thin (188 of 244 have under 10 stocks above $1bn), so they widen to the industry (R4). Assumed: a hierarchy label's index holds the stocks whose main label is in it, so the hierarchy labels partition the market; extra labels only choose which index a pick is compared with.
- Decision (chat, later the same day): an index is needed at every tier, and the toggle compares a stock with its vertical, industry or sector index (Micron vs Memory, vs Semiconductors/SOXX, vs Technology). ETFs must be labelled at the tier they track (SOXX industry, DRAM vertical, XLK sector).
- Decision (chat): committing the stock → hierarchy label and ETF → hierarchy label mapping to the public repo is fine (Damodaran's file is public). Committed in `pipeline/orca/hierarchy/data/`.
- Reviewed (architecture review, 2026-11-17): share counts need a history (`shares_hist` from the SEC data the code already downloads), sells replay as a fraction of the position, hierarchy labels need a quarter-average and a quarter-end level, and scoring runs in the pipeline. Plan and open questions: `docs/superpowers/plans/2026-11-17-sector-indices.md`.
- Decision (chat): conglomerates (`@nosector`) score against SPY; share counts get a history table (`shares_hist`).
- Decision (chat): a fund's single-sector ETF buy gets two metrics: picking (the ETF vs our index for its hierarchy label) and allocation (its flows through every other hierarchy label at that tier, by IRR), the second shown to the user per ETF position.
- Decision (chat): stock labels are edited in one CSV (`data/stock_nodes.csv`, `how=owner` rows are never overwritten). SKHY and WDC moved to Memory.
- Decision (chat, supersedes R4 for indices): thin verticals are not widened to the industry. The vertical toggle shows the real vertical index with a warning (stock count, biggest weight).
- Decision (chat): relabelling must be cheap: `labels.txt` wins over the committed CSV at run time, and a `sectors` recompute mode rebuilds indices and scores without ingest.
- Decision (chat, supersedes the ETF stand-in above): our own index for every hierarchy label at all three tiers, no ETF stand-ins and no spot check against ETFs. Once the calculation exists it is less work than choosing and splicing ETFs, children add up to their parent, and ETF fees do not flatter funds.
- Open: not built. Dividends and share counts live in the private lake, so the first real numbers come from a pipeline run.

## 2026-11-16 — How a fund's sector picks are scored (owner)
- Decision (chat): a fund's ETF buy is a sector pick. A single-sector or single-industry ETF is placed on its hierarchy label (SOXX → Technology › Semiconductors); broad-market, international, bond, commodity, leveraged and cross-sector theme ETFs have no sector and count as neutral (R12). ETF-heavy funds stay in the top 100.
- Decision (chat): the sector score is about IRR (R13). Each buy and sell is replayed through every other sector's return series (total return, with dividends) and the IRRs are compared. It needs one return series per sector and no benchmark weights.
- Decision (chat): allocation is judged at industry level (71) by default, with a toggle to sector (12) or industry vertical (244) (R9).
- Decision (chat): International Assets Investment Management (rank 66, $718bn bought on a $1.7bn book) is dropped from the top 100.
- Accepted (chat): 13F is quarterly with a 45-day lag, so a buy and a sell inside one quarter are invisible and trades are priced at the quarter's average.
- Deferred (chat): licensing (Tiingo L1, Damodaran R10) can wait until something is commercial. Revisit before anything is shown on the site.
- Context: the return series come from indices built from the hierarchy (ROADMAP S4), computed where the daily dividends are (the public weekly price files have none), with ETFs as labelled cross-checks (L5). The 30 biggest funds outside the top 100 hold 93.9% labelled stocks, 5.7% ETFs and 0.4% unlabelled stocks by value, so no large labelling job is needed first.
- Open: nothing is built. Next is a prototype of the 12 sector indices against the Select Sector ETFs.

## 2026-11-16 — Labelling the stocks funds hold: name match, then a model (proposed, owner to confirm R8)
- Decision (chat): classify every stock the 100 best funds ever held in the hierarchy. The window (since start) is my choice; the owner has not said which ranking they meant.
- Decision (mine, open for the owner): match Orca's names to Damodaran's global company file by words, not by ticker, because Orca's tickers are often garbled and his file also holds ADRs and foreign lines. For stocks it does not cover, a model reads the name and picks a vertical, tagged and with a confidence (R8 changed from "SEC SIC code" to this). A model that knows a company replaces a Damodaran group default, because a blind audit found the defaults wrong on 27% of verticals and 6% of sectors while the model matched the owner's hand placements 97% of the time.
- Rejected: SEC SIC codes for the rest (needs a CIK per stock, which Orca's public data does not carry; too coarse for verticals); trusting group defaults unchecked.
- Decision (chat): a fund's ETF buy is a sector pick, so ETF-heavy funds stay in the top 100 (12 of the 100 hold half or more of their book in ETFs). Each ETF needs a hierarchy label; a single-sector ETF maps to its sector, industry or vertical, a broad or bond ETF to none. Built: a model classed the biggest ETFs (`etf_batches.py`; removed in bf901e0 by mistake, restored in e192f74). Open: how sectors are compared with each other (indices built from the hierarchy, ETFs as labelled cross-checks), ROADMAP S4, F5 and L5.
- Consequences: the labelled outputs stay out of the repo while it is public and Damodaran's licence is unclear (R10). A fund page cannot show a label until the owner reviews it and the contract changes.

## 2026-11-16 — Sector hierarchy for the sector-picker / stock-picker metric (owner)
- Decision (chat): classify every stock in three levels, Sector → Industry → Industry vertical ("industry vertical" is the owner's name for the third level; "sub-industry" was recommended and "specialty" suggested, neither chosen). Start from Damodaran's 94 US industry groups, cross-check with Fama-French 48, hand-place the stocks that matter, and give every group a default for the rest. Sectors: Technology, Communication, Consumer, Healthcare, Financials, Business Services, Industrials, Defence, Materials, Energy, Utilities, Property.
- Decision (chat): a stock has one main label (scoring) and any number of extra labels (comparisons), so one pick can be compared with different peer sets: Micron against all Semiconductors or only Memory; Vistra as a nuclear play against nuclear stocks and against gas power producers. Alphabet carries five labels: Search & Advertising (main); Cloud Infrastructure Provider, Consumer Services and Entertainment under Software; Streaming & Studios.
- Decision (chat): Defence is its own sector (Leidos: Defence › Technology › Autonomous Systems; Palantir: Technology › Software › Defence Systems Software; "Government IT services" scrapped because those firms serve many customers). Pharmacies sit in Consumer › Retail. Vistra and NRG carry Natural Gas and Nuclear "Power Producers". Every oil producer is labelled Production. Autos are Industrials › Manufacturing, with carmakers and auto parts as separate main labels and Automotive as an umbrella extra label; no fourth level. Visa, Mastercard, Amex and Uber are technology.
- Context: ROADMAP D7 and F5. GICS is licensed. SIC is too coarse: Micron, Nvidia and AMD are all SIC 3674, and Uber, Visa and Mastercard are filed as transport and business services. Damodaran's file (S&P Capital IQ and Bloomberg data) gives 94 groups for free; 25% of US firms differ from the group's usual Fama-French group, which is why named stocks override the default.
- Rejected (chat): GICS (licensed); RBICS and BICS (no public price, display rights unknown); classifying from 10-K text with an LLM (owner expects too many manual edits; parked); merging thin groups (the owner rejected 5 merges, so thin verticals stay and benchmarks widen to the industry instead); an Exploration vertical (no stock left in it once all producers are Production); a fourth level for Automotive.
- Open: the rules on the review page are recommendations until the owner answers (R4: a comparison needs at least 10 peers above $1bn, else widen to the industry; R5: cap each stock at 10% of a peer index; R9: allocation is judged between industries, with a toggle to sector or vertical). Damodaran's file has no formal licence: publish only our own labels, and ask him first (R10).
- Consequences: `pipeline/orca/hierarchy/` holds the source, tools and tests (draft, not wired into the pipeline). Changing a published JSON file needs `pipeline/contract.md` first. F5 uses these labels for peer groups and for the allocation effect, so R23 and the "luck vs skill" conflict listed below still need the owner's answer.

## 2026-11-10 — Planned features conflict with earlier positions
Planned features F1–F5 (`docs/ROADMAP.md`, proposals until the owner approves) cut across earlier decisions. Resolve each with the owner before building:
- "No database server" (2026-10-30 architecture): F2 saved views across devices need accounts, so some server-side state.
- "No market-flow estimates" (spec 1 scope): F4 sector volume is a flow-like measure.
- R23 "no SPY benchmark on fund pages" (rulings doc): F5 rankings need benchmarks.
- The rejected "luck vs skill" idea (2026-10-30): F5 reopens it.
- Related, already recorded: the parked Excel export (2026-11-09) is superseded by F1 (2026-11-10 workbook entry).

## 2026-11-10 — Workbook phase 1: implementation rulings that changed the design
Built (`pipeline/orca/workbook/`, `orca.run workbook`, the Workbook Action). Where the build departs from the spec as first written, the spec now says what was built:
- Year cells reference the year's contiguous quarter range directly (`SUM`, `MIN`, the last or first quarter's cell), not `SUMIF` on the Year row. Equivalent, simpler, and `MINIFS` is not in Excel 2016.
- Calculation cells are blank after the last filing (`end_q`) because they are not written. The two cash-flow rows (C17, C18) hold 0 there, since those flows are truly 0 and Excel's XIRR with empty cells in its range is unverified.
- Years chain through a running-growth row ("Year-to-date growth"), with no `LN` anywhere: `LN` gives `#NUM!` for a quarterly return of −100% or less, where the engine still returns a number.
- Difference scale (R21): dollar and share differences divide by `MAX(1,|Orca|,scale)`, the scale computed in Excel from the same tab (a quarter's `MAX(|Start|,|End|,Buys+Sells)`, a stock's peak of |Value|, |Cost|, Invested); returns and ratios divide by `MAX(1,|Orca|)`. One tolerance, 1e-9, serves both; quarters, counts and text must be equal.
- Each XIRR range starts at the position's first trade, not the first quarter column: after years of leading zeros LibreOffice stopped at a spurious root (14,220% against the site's −28%).
- On Outputs the cut's "All other positions" is a labelled input block below the Total row, not a row of the stock table.
- The block index sits just below the frozen header rows (above them, about 43 rows would be frozen).
- Shares sold and $ sold are blank, not 0, when nothing was sold (Orca's exits fields are empty there).
- A never-priced stock holds only a value-0 filed row: the engine prices any positive filed value through the reported-value fallback. The spec's claim that its filed value counts in % priced was corrected.
- The CLI validates each fund's inputs, writes them, reads them back and requires equality before it writes anything. Demo data cannot prove that every value of a real fund serialises.
- Known gaps: Excel itself has never opened these files (only LibreOffice 24.2); the Tiingo licence blocks any sale.

## 2026-11-10 — Per-fund Excel workbook: paid tier, built on demand
- Supersedes R10 (`docs/superpowers/2026-10-31-orca-rulings-and-backlog.md`, the quarter-step IRR clock `tradeT = q/4 + 0.125`): the site now dates trades mid-quarter and divides days by 365, as Excel's XIRR does.
- Decision (owner, chat):
  - The workbook is a paid-tier feature.
  - Raw data is quarterly: 13F shares and value as filed, plus per stock per quarter the close, VWAP, dividends per share and split factor. No daily bars.
  - Funds with more than 500 positions keep their 500 largest, ranked by peak quarter-end value. One "All other positions" line, taken from Orca's own totals, keeps the fund figures exact.
  - The site's IRR moves to Excel's XIRR convention: mid-quarter dates, days ÷ 365.
  - Workbooks are built only when a user asks for one, never pre-built.
- How it runs:
  - Phase 1 (now): a Python builder (xlsxwriter) takes one fund's input file, written from exactly what the engine used. A manual Action builds workbooks for chosen funds into the private bucket.
  - Phase 2 (own spec): the monthly run writes small private input files for every fund. A Worker checks the user has paid, then a Cloudflare Container builds the workbook (estimated ~1 s for a median fund, ~20 s for one capped at 500 positions) and keeps it until the next run. Login and payments are part of phase 2.
- Rejected:
  - Built in the browser: the raw data would have to be public, so nothing could be sold.
  - Built in a Worker: CPU limits, and a second implementation in JS.
  - Python Workers: 128 MB memory cap.
  - GitHub Actions on click: GitHub's terms bar Actions "as part of a serverless application", the logs are public, and jobs can wait in a queue.
  - Pre-building every workbook monthly: xlsxwriter measured ~1,255 stock-quarter rows/s per core; a 120-fund sample extrapolates to ~43M rows, so ~9.5 h on one core or ~2.5 h on the runner's 4 cores each month.
  - Blocking "index funds" by size: the 627 funds with 1,000+ holdings include Citadel, Renaissance, Two Sigma and D. E. Shaw. Only ~26 look like index managers.
- Scaling rule: GitHub Actions are only for tests, deploys and the monthly batch. Anything a user triggers runs on Cloudflare (Workers, Containers). Escape hatch: package the pipeline in the same Container image as the workbook builder, so the monthly run can move to a Container on a monthly timer if Actions limits or terms ever bite (estimated ~$1/month; Container time and disk limits for a 2–3 h run not verified).
- Measured (2026-11-10):
  - IRR, site method vs XIRR: median gap 0.011 pp (Berkshire) and 0.015 pp (Vanguard); 95% of positions under 0.18 pp; maximum 0.9 pp and 11.8 pp, all on very short holds.
  - Vanguard has 6,177 positions and 166,891 trades. Its top 500 by peak value cover 81.5% of value in 22,438 stock-quarter rows.
  - 1,343 funds hold more than 500 positions now.
- Consequences:
  - Supersedes "Excel/paid downloads parked" (2026-11-09).
  - Tiingo's redistribution licence is needed before charging.
  - The download path needs Workers Paid ($5/month), and Container time is included up to 375 vCPU-minutes a month.

## 2026-11-09 — Excel/paid downloads parked
- Decision: no Excel export for now (chat).
- Context: owner may want a gated paid feature. Every published JSON file is public, so anything built client-side cannot be gated (chat).
- Rejected: client-side export now; pipeline-generated .xlsx per fund (thousands of files, stale prices) (chat).
- Consequences: a gated version needs login plus a server step and the data moved behind it. Check the price vendor's redistribution terms before exporting prices. Guard against formula injection (`=`, `+`, `-`, `@`) (chat).

## 2026-11-11 — Home page on white with paper panels
- Decision: home page uses a white page and content box, paper-80 top bar and heading row, paper-50 panel and tab strip, paper-30 cells (chat)(code `web/src/pages/home.css`, `web/src/tokens.css`).
- Context: the #FAF3EA page colour was too dominant; eight options were compared and one chosen (chat).
- Rejected: all-paper variants where page, table and heading share one shade (chat).
- Consequences: other pages keep the old paper page colour until restyled. Tokens `--home-*` map the roles and carry dark values.

## 2026-11-11 — Home page back on the fund page's look; How it works removed
- Decision: the home page drops its paper look and uses the fund page's colours: cream page, `--surface` panels and header bar, `--sunken` heading row and toggle trough, `--line`/`--line2` borders, secondary (surface plus `--line2`) buttons, the fund page's 34px heading. The How it works page, its nav link, footer link, route and sitemap entry are deleted (chat)(code).
- Context: the owner reviewed fund pages closely and is happy with them; home should match them in colour, buttons and borders. Users need no 13F education (chat).
- Supersedes: "Home page on white with paper panels" above. `--home-*`, `--paper-*`, `--white`, `--sand-border` tokens are gone.
- Consequences: no top nav (the logo links home). `/how-it-works` now shows Not found. The Position page's "How it works" link is gone.

## 2026-11-09 — HSTS, noindex on pages.dev, sitemap/robots/canonical (PR #3, merged as a2a1554)
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

## 2026-11-15 — Cloudflare Web Analytics on, allowed in the CSP
- Decision: keep Web Analytics switched on in the Pages project (Cloudflare injects its beacon) and allow it in the CSP: `script-src` adds `https://static.cloudflareinsights.com`, `connect-src` adds `https://cloudflareinsights.com` (code `web/scripts/prerender.mjs`). Supersedes "must stay off" below (owner, chat).
- Why: the owner wants visit, page, referrer and speed figures; it is free, cookieless, collects no personal data. It had been switched on while the CSP blocked it, so nothing was counted and every page logged an error (chat).
- Rejected for now: a hand-added snippet (ROADMAP U5) needs the site token in the code for the same result; a custom event counter for clicks inside pages (later, if needed).

## 2026-11-09 — CSP generated at build, fonts self-hosted
- Decision: `dist/_headers` written by `web/scripts/prerender.mjs` with `connect-src 'self' <origin of VITE_DATA_URL>`; strict `style-src 'self'` (React sets styles through the CSSOM); Instrument Sans + Geist Mono woff2 in `web/src/assets/fonts` (code).
- Rejected: static `public/_headers` (cannot name the data origin); switching to system fonts (would lose the approved look) (chat).
- Consequences: any new third-party script/host (analytics, embeds) is blocked until added to the CSP; Cloudflare Web Analytics must stay off (chat)(code). (Superseded 2026-11-15: on, and allowed in the CSP.)

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
- Decision: the fund page matches the artifact from the fund-name heading down. Guidebook parts are left out (command palette, crumbs, Compare/Watch, Trades/Filings tabs) (chat).
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
- Context: on 2026-11-06 the owner had asked the build session for a McKinsey-slide formatting template; its Design System artifact (claude.ai/artifact/8heHsqsdaEsj9CN4mj9cMH) was never filled (chat).

## 2026-11-07 — Domain name (left open in the build session)
- Decision: none taken in the build session; `orca13f.com` was recommended. A later session chose `orcaetf.com`, reasoning UNKNOWN (chat).
- Context: "Orca" because orcas hunt whales and WhaleWisdom is the main 13F site (owner). The name is crowded (Orca Security, many apps), which risks search and trademark clashes (chat).
- Rejected: names with "whale" (confusable with WhaleWisdom's mark); taken `.com`s such as orcafunds, getorca, orcahq (chat, RDAP check 2026-11-07).
- Consequences: check trademarks (IP Australia, USPTO) before commercialising (chat).

## 2026-11-06 — Best & worst calls keep the build-time 50 + 50 cut
- Decision: keep the file as is: the 50 best and 50 worst buys chosen at quarter-end prices, re-ranked live by the site (owner: "keep it as is, that makes sense") (chat)(ruling R7).
- Context: "Best" showed losers from row 12 down (median of the 100 −23.6% while SPY rose) because prices moved after the cut (chat).
- Rejected: publish every qualifying buy and take the live top and bottom 50 (bigger file, needs a home-only run) (chat).
- Consequences: "Best" can show losses and the two views overlap (chat).

## 2026-11-06 — Drop the Just filed tab, keep its file
- Decision: the tab is gone; `home/just_filed.json` is still built and published (chat)(code `pipeline/orca/publish.py`, `pipeline/orca/home.py` `just_filed`).
- Consequences: the EDGAR daily-index ingest that fed it (spec) still runs; removing the file needs a contract change (code).

## 2026-11-06 — Fit wide tables by cutting names (superseded)
- Decision: at ≥ 1180 px no table scrolls sideways: names and tickers cut with "…" and a hover title, wrapped headers, two-line cells, 13 px text (chat)(git 85ec00a).
- Rejected: fitting at 1024 px or on phones (10+ columns; phones scroll inside the table) (chat).
- Consequences: PR #1 rebuilt the pages; `.trunc` and `.two-line` remain in `web/src/styles.css` with no users (code). CONFLICT: whether the new UI still fits at 1180 px is UNKNOWN.

## 2026-11-03..05 — Conviction moves v2 → v3 (git)
- Decision: a move is dollars traded in one stock over the fund's AUM (a buy over end AUM, a sale over start AUM). Adds and trims lose their pro-rata share of the quarter's net flow first. Listed when ≥ 3% of AUM, ≥ 2× the usual move (biggest of the 4 quarters before, floor 1%) and ≥ ½ the largest holding at the start. Ranked by `score` (git 5122d70, 79d8628; `pipeline/contract.md`).
- Rejected: v1/v2 rules (moves vs largest holding; sized on last quarter's book) (git 0377f16).
- How it got there (chat), each step the owner's call:
  - 11-03 owner: drop funds with > 33% in one stock; find moves "disproportional to how they've acted in the past"; compare with last quarter only. Raised: a fund that did nothing last quarter divides by zero → 1% floor ("Quiet"); a carried (unfiled) quarter has no trades → such funds are skipped (`filed_pair`).
  - 11-03 owner added: the move must also be large against the fund's largest holding (measured before the move), and the baseline is the last 4 quarters, not 1.
  - 11-04 owner: IPOs and spin-offs stay in ("TCI bought GE Aerospace … massively profitable"); ETFs out (the page is for stock picks); exits count like buys; pensions in.
  - 11-04 owner corrected the metric: move ÷ this quarter's AUM against the largest single-stock move of the previous quarters, each on its own AUM (example: usual 3% vs a new 10% bet is substantial; if earlier quarters had 5% and 7%, it is less so).
  - 11-04 rejected: dividing by the larger of start and end AUM (owner: "don't complicate it", the figure is only for ranking, never shown); showing "vs largest holding" / "vs usual move" columns (removed; users see only the order).
  - 11-04 kept: skip a quarter whose AUM more than doubled or halved (Woodbridge $737M → $25.2bn read as a 3,499% move); cost: real funds that doubled drop (Shannon River 2.14×). Tighter ⅔–1.5× left 22 rows and was rejected.
  - 11-05 owner: "isolate money in and out"; "sell quantum should be compared to last quarter" → flow adjustment back in, sales sized on start AUM.
- Consequences: in-kind client transfers at wealth managers still look like trades; spin-off receipts look like new buys; both cannot be told apart in 13F data (chat). Open: ≥ 30% ETF-share rule and common-stock-only (asked, unanswered) (chat).

## 2026-11-04 — Conviction inputs stored per fund, rules applied at publish
- Decision: each fund snapshot stores `ConvictionQuarter` records for its last 8 quarters; `home.conviction_moves` applies the thresholds when the home lists are built; `python -m orca.run home` republishes them without fetching or recomputing, and refuses if the deadline quarter moved or anything is owed (code `pipeline/orca/run/weekly.py` `run_home`).
- Context: each rule change had needed a ~2 h rebuild of 13,317 funds (chat).
- Rejected: storing ready-made ratios per fund (any rule tweak means a rebuild) (chat).
- Consequences: about 40 MB more lake state (estimate, chat); retired snapshot fields are dropped on decode (`run/state.py` `_RETIRED`).

## 2026-11-04 — Pension and retirement funds count on the home lists
- Decision: `PENSION` and `RETIREMENT SYSTEM` removed from `EXCLUDE_NAME_WORDS`; banks, insurers, trust companies and brokers stay excluded (code `pipeline/orca/config.py`).
- Context: owner: provident, mutual and retirement funds have professional management teams; endowments (Yale, Harvard, MIT) were never excluded (chat).
- Consequences: affects Top funds and every other home list, not only Conviction (chat).

## 2026-11-04 — Run safety: rclone timeouts, restore retries, stop a leftover pipeline
- Decision: rclone gives up a stalled transfer after 60 s (`RCLONE_TIMEOUT`, `RCLONE_CONTIMEOUT=15s`) and logs progress every 30 s; the restore retries 3× under `timeout 15m`; the save step kills a still-running `orca.run` before saving (code `.github/workflows/pipeline.yml`, `.github/actions/restore-r2/action.yml`).
- Context: one restore took 41–42 min against 15–32 s before with the same data size; a cancelled run kept writing the lake during the save (chat).
- Rejected (not built): parallel fund compute on the runner's 4 cores (est. 48 → 17–20 min) (chat)(code).

## 2026-11-03 — Home page review rulings
- Decision: eyebrow "Quarterly 13F Data from SEC.gov", h1 "Fund Manager Research", no subtitle or rule line, columns "AUM" and "Max Drawdown", every column sortable on every home list, 100 rows per page, periods 10y and 15y added (chat)(git 2a30794; code `PERIODS`).
- Context: the owner's 9 comments on a commentable artifact copy of the live site (chat).
- Consequences: the 15y tab was empty until 2028 (data started in 2013); since the pre-2013 history (2026-11-17) it is not (chat).

## 2026-11-02 — Pipeline runs monthly on the 16th (git 49e3a54)
- Context: the 16th falls after each 13F deadline (Feb 14, May 15, Aug 14, Nov 14).
- Rejected: weekly runs.
- Owner's reasoning (chat): asked why weekly when 13F is quarterly. Weekly kept late filings, the Just filed list and prices fresh, and cost nothing (public repo, no Claude tokens). Owner: "perhaps just monthly is fine". Also rejected: weekly in the 8 weeks after each quarter end plus monthly otherwise (chat).
- Consequences: a filing can take up to a month to appear, and latest prices can be up to a month old (chat). The job is still named `weekly` (code).

## 2026-11-02 — Site and data in one Cloudflare account
- Decision: the Pages project lives in the account that holds the R2 buckets; the site moved from `orca-eiq.pages.dev` (the account tied to the owner's GitHub login) to `orca-88p.pages.dev` (chat).
- Context: the first deploy went to the other account; cross-account CORS works, but managing two logins was confusing and the dashboard showed "Get started with R2" (chat).
- Rejected: moving the data instead (new R2 billing setup and a full re-upload) (chat).
- Consequences: the address got the `-88p` suffix because `orca` was taken; the old `orca-eiq` project and its token should be deleted (status UNKNOWN) (chat).

## 2026-11-01 — Repository made public
- Decision: `Cannibara/Orca` is public (chat).
- Context: the private repo's 8 GB runner was killed (out of memory, then a shutdown signal); public repos get free minutes and a 16 GB / 4-core runner (chat).
- Consequences: run logs are public (secrets masked); fork PR workflows need approval; secrets are scoped to the `production` environment on `main` (chat). Checked first: no keys in history, commits authored noreply (chat).

## 2026-11-01 — Deploy and keys only from `main`
- Decision: `main` is the default branch; the `production` environment (secrets) allows only `main`; API keys go only into GitHub secrets, never into chat (chat)(code `.github/workflows/*.yml` `environment: production`).
- Context: the work was on `claude/whale-wisdom-13f-clone-wapyqz`; GitHub had no `main` until 2026-11-01 (chat).
- Consequences: scheduled runs and deploys fail if the default branch is changed (chat).

## 2026-11-01 — Price only what the vendor lists (git 8155ed7)
- Decision: resolve each stock's vendor ticker from Tiingo's supported-tickers list (table `vendor_tickers`).
- Context: 19,222 of 40,268 tickers came back empty (delisted stocks mapped to foreign tickers by OpenFIGI).
- Detail (code `pipeline/orca/vendor.py`): a currency suffix is stripped (`XLNXEUR` → `XLNX`, `CURRENCY_SUFFIXES`); a candidate counts only if the vendor lists it over dates that overlap the stock's held span (a reused ticker like `FB` is not Facebook). Stocks with no candidate are skipped.
- Rejected (chat): weekly price bars (Tiingo returns a stock's whole history per request either way, and daily bars feed VWAP, dividends and splits); pricing only stocks held in the last ~2 years (loses older fund history); raising `TIINGO_RATE_PER_SEC` (the plan's limit is ~10,000/hour).
- Consequences: price requests per run fell from ~23,666 to ~1,188 (run 11); the price stage keeps `PRICES_RESERVE_MIN = 90` min for the funds and asks stalest first (code `run/market.py`).

## 2026-11-01 — Tiingo personal plan for now
- Decision: the owner bought Tiingo's paid personal plan and will move to business when commercialising (chat).
- Context: the free plan's 50 requests/hour stopped run 7 at 48 stocks (chat).
- Consequences: risk: a public site showing Tiingo prices needs a separate redistribution licence. Correction 2026-11-10: moving to the business plan is not enough. Tiingo's docs say every self-serve plan, the commercial one included, is internal-use only; showing prices on a public site or app needs a redistribution licence (email sales@tiingo.com; source https://api.tiingo.com/documentation) (chat).

## 2026-11-01 — Invalid CUSIPs are not repaired
- Decision: about 29,000 CUSIPs in filings that OpenFIGI rejects (often a dropped leading zero) stay unmapped and out of returns (chat)(code `securities.py`: an OpenFIGI error gets method "error").
- Rejected: guessing repairs (could attach the wrong stock) (chat).

## 2026-10-31 — Build rulings taken without the owner
- Decision: conflicts and gaps in plans A and B were settled by the controller and logged (R1–R33 and the unnumbered pipeline rulings, each with its reason and cost if wrong) (chat)(git b8c9864).
- Context: subagent-driven execution ran unattended; the owner was only asked about permissions and usage limits (chat).
- Consequences: no per-ruling owner reasoning exists; the reasons are the ones recorded in `docs/superpowers/2026-10-31-orca-rulings-and-backlog.md` (chat). The two the controller flagged as mattering: no `_redirects` file (R12) and pre-rendering only the 15,000 largest funds (R13) (chat).

## 2026-10-30 — Build plans: Polars only, a few files per fund, live values in the browser
- Decision: DuckDB dropped (Polars covers everything); each fund's trades and contributions bundled into ~5 files instead of thousands; anything that depends on today's price is computed in the browser (chat)(git a89449b).
- Context: owner chose subagent-driven execution of plans A (15 tasks) and B (8 tasks) (chat).

## 2026-10-30 — Fund page contents (owner)
- Decision (chat): gains vs net inflows by year as a chart only (no headline numbers); top tiles turnover per year (min(buys, sells) ÷ average book) and average hold length, then Sharpe, Sortino, volatility, max drawdown, Calmar, best/worst year, years positive; annual returns without SPY; clicking a year shows each stock's contribution as a sideways bar chart sorted by contribution; positions with avg cost (= avg entry), current price, avg exit, return %, IRR, last change % and $, no dividends or sector column; "what if they'd kept it" for exited stocks (IRR and return if held), which WhaleWisdom lacks.
- Rejected: SPY comparisons on the fund page; a "below the whales' cost" home tab (chat).
- Consequences: the mockup (claude.ai/artifact/YbADtEdgNYE7NUm3L7vSUF, `docs/superpowers/specs/2026-10-30-orca-mockups.html`) was the visual reference until the 2026-11-08 redesign (chat).

## 2026-10-30 — Home page lists and who qualifies (owner)
- Decision: the home page shows more than a search box, aimed at people who don't know fund names: Top funds ranked by return among larger funds, so a tiny fund with 50,000% on 3 stocks can't win; conviction moves by concentrated funds; big wins and losses; crowded buys; best and worst calls (stocks that jumped after a fund bought) (chat).
- Rules (code `pipeline/orca/config.py`): Top funds need a book ≥ $1B, ≥ 12 quarters filed, ≥ 4 positions (owner lowered it from 10), ≥ 80% priced; banks, insurers and brokers excluded by name; ≥ 1,000 positions = "Index giants" tab. Concentrated funds 4–60 positions, ≥ $500M. Calls: new/add ≥ 1% of book, market cap ≥ $300M, price ≥ $1. Crowded: ≥ 3 funds.
- Rejected (chat): more brainstormed ideas (manager-name search, stock page "who holds X", copy-test backtest, luck vs skill); a vs-SPY column on Top funds.

## 2026-10-30 — Trade price: quarter VWAP of the daily typical price
- Decision: all of a quarter's buys and sells are assumed at Σ(typical × volume) ÷ Σ volume over the quarter, typical = (high + low + close) ÷ 3; monthly VWAPs stored for later (chat)(code `pipeline/orca/quarter_px.py`).
- Context: owner asked for VWAP over a plain mean close (chat).
- Rejected: a one-month window (13F does not say which month the trade happened); true intraday VWAP (costly data) (chat).

## 2026-10-30 — Updates are incremental (weekly, later monthly)
- Decision: a scheduled batch, not nightly: only new SEC ZIPs (manifest by name + checksum), only new price days, only changed funds recomputed and only changed files uploaded (chat)(spec).
- Context: owner: "why not weekly?" and "find a way to only look at differences instead of rebuilding everything" (chat).
- Consequences: superseded on cadence by the 2026-11-02 monthly schedule.

## 2026-10-30 — Data sources; CUSIPs never published
- Decision: holdings only from SEC filings; CUSIP → ticker via OpenFIGI, with SEC name match as backup; own stock ids; CUSIPs stay in the private lake and are never shown; prices from Tiingo; sectors from SEC SIC codes; risk-free rate from FRED DTB3 (chat)(code `CusipLeakError`, `publish_step.cusip_leaks`).
- Context: the owner does not want to use WhaleWisdom or other third-party 13F apps doing the same thing. CUSIP Global Services may claim fees for commercial use of CUSIPs (quoted $10.5k–$518k/yr). WhaleWisdom's API also never returns CUSIPs (chat).
- Rejected (chat): WhaleWisdom/sec-api.io data (repackaged SEC data, no resale); Yahoo Finance (no CUSIP search, drops delisted stocks, terms ban paid use); a CGS licence; GICS (licensed); FINRA OTC retail data at launch (API terms non-commercial).
- Consequences: get a legal view on CUSIP use before charging (chat).

## 2026-10-30 — Scope, audience and business model
- Decision: spec 1 = data backend + fund P&L; spec 2 skill scores; spec 3 sector rotation; market flows optional (owner's order) (chat).
- Context: owner wants a paid product eventually: "$10/person per month for the highest tier, but mostly everything free for now"; hobbyist precision, "take as many shortcuts as necessary" (chat).
- Consequences: the cheap stack below; price data with display rights is the one unavoidable cost (~$3k/yr at Tiingo's business tier, estimate); break-even estimated at ~37–80 subscribers at $10/month (chat).

## 2026-10-30 — Architecture: static site + published JSON (git aaff236; spec)
- Decision: Python pipeline on GitHub Actions → private R2 lake (holds CUSIPs) → public R2 bucket of brotli JSON (`pipeline/contract.md`) → static React site on Cloudflare Pages that computes live values in the browser.
- Rejected: always-on server, database server, 13F competitors as data sources (spec §1).
- Consequences: no server-side gating; publishing uses stable paths with `manifest.json` last (ruling T13, overriding the spec's version folders).
- Owner's words and the options compared (chat): "fast and cheap … hobbyist level of precision … take as many shortcuts as necessary". A) precompute everything, as WhaleWisdom does (chosen). B) compute when a page opens, from a fast database. C) a rented server + Postgres ($5–20/month). "No always-on server" was explained as nothing of Orca's running while users visit; login and paywall need an add-on later.
- Rejected later in planning: DuckDB (Polars alone), DuckDB-Wasm queries in the browser (not built) (chat).
