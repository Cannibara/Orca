# Sector indices and allocator vs picker score: plan and handoff

Status: plan, reviewed 2026-11-17 by an architecture review and a code check. Nothing is built yet. Owner decisions are in `docs/DECISIONS.md` (2026-11-16, 2026-11-17).

## Goal
For each 13F fund, split its result into two parts by IRR:
- picking = fund IRR − IRR of the same flows put into each stock's own node index;
- allocation = node-shadow IRR − IRR of the same flows put into the market index.
The default comparison level is industry (tier 2, 71 nodes). The user can flick to sector (tier 1, 12 nodes) or industry vertical (tier 3, 244 nodes). Example: Micron vs Memory/DRAM (tier 3), vs Semiconductors/SOXX (tier 2), vs Technology (tier 1).

## Fixed decisions (owner)
- Hierarchy is `pipeline/orca/hierarchy/labels.txt`. Each stock has one main label (a vertical). A node's index holds every stock whose main label sits under it, so each tier partitions the market. Extra labels only choose comparisons.
- Indices are market-cap weighted, with no cap on any stock, rebalanced each quarter, and measured as total return with dividends.
- Accuracy of about 90% is enough. Shortcuts are fine.
- A good existing cap-weighted ETF stands in for a node, at any tier. We build our own index for the 12 broad sectors, for nodes with no ETF, and to back-fill an ETF's history before launch.
- A fund buying a single-sector ETF is a sector pick at that ETF's node and level. Broad, bond, international, leveraged and theme ETFs are neutral. So ETFs must be labelled at the right tier: SOXX is the Semiconductors industry, DRAM is the Memory vertical, XLK is the Technology sector.
- The labels may be committed to the public repo. They derive from Damodaran's public file; licensing is parked.
- The 13F quarterly data and its 45-day lag are accepted.

## What exists (commit with this plan)
- `pipeline/orca/hierarchy/data/stock_nodes.csv` holds 5,111 labelled securities (4,857 stocks, plus 254 bonds labelled to their issuer). Columns: stock_id, ticker, kind, vertical, extras, how (placed|rule|default|model), conf.
- `pipeline/orca/hierarchy/data/etf_nodes.csv` holds 462 classed ETFs. Columns: stock_id, ticker, class, level, node, leverage, conf. 98 of them are single-sector.
- `pipeline/orca/hierarchy/data/batches/` holds the model batch inputs and answers, keyed by stock id. With them, `make_batches.py --missing` and `etf_batches.py make --missing` only ask about new names.
- Coverage is limited to the securities the top 100 funds ever held: 7,025 securities, 95.3% of their stock dollars labelled. That is still only part of the ~22,800 priced stocks.
- Stock ids are a local counter in the lake. The ticker column is a guard: flag any id whose ticker no longer matches.

## Code facts (checked 2026-11-17)
- `prices_daily` in the lake has raw daily bars with `dividend` and `split_factor` from Tiingo, for stocks and ETFs alike (`pipeline/orca/prices.py:26-105`, `run/market.py:512-541`).
- `quarter_px.py:16-79` gives each quarter's close (the last trading day that has one), VWAP, low, high, `div_ps` and `monthly_vwap`. Closes and dividends are split-adjusted the same way; nothing is dividend-adjusted.
- `securities.shares_out` is one figure per security: the latest `dei:EntityCommonStockSharesOutstanding`. It is overwritten when a split triggers a refresh (`securities.py:234-260`, `market.py:192-256,614-656`). It is null when the security has no CIK. No share history is kept.
- SPY is the only benchmark (`market.py:47`). No benchmark series file is published.
- Publishing goes through `publish.py:379-449` (`publish_shared`, the `docs` dict) and `run/publish_step.py:103-172`. The run sequence is `run/weekly.py:307-415`. A new step fits next to `publish_shared_files` (about line 352).
- The browser's `irr(flows)` is at `web/src/lib/live.ts:52`. Flows are mid-quarter dated, priced at the quarter VWAP, and leave out dividends.
- `pipeline.yml` has the R2 and API secrets; tests run only in `ci.yml`. A monthly run takes about 80 min against a 270-min budget. The runner has 16 GB of memory and 4 cores.

## Why it runs in the pipeline
- Dividends and history live only in the private lake. Its keys are GitHub secrets, so dev sandboxes cannot read it.
- The code runs inside the monthly GitHub Actions job, which can. It publishes ready-made series and scores as JSON, and the site only displays them.
- Scores are an aggregate over ~13,000 funds, so they cannot be computed in the browser.

## Problems the review found, and fixes
1. Share counts. Today's count × a split-adjusted past price is not that date's market cap: Apple's count fell ~40% since 2013. The SEC companyconcept JSON the code already downloads holds the whole history, so keep it. A new lake table `shares_hist` (stock_id, period_end, filed, shares). Market cap at a quarter's start = raw unadjusted close × the latest count filed by then.
   - Fallback: today's `shares_out` × split-adjusted close, tagged.
   - Last resort: leave the stock out.
   - A small committed override table covers ADR ratios (TSM: 1 ADR = 5 shares) and dual-class companies.
   - Check the ~300 biggest names against a reference market cap.
   - One-off fetch: ~15k CIKs at 8/s ≈ 30–40 min.
2. Sells in the replay. Matching sell dollars can drive a shadow position negative. Instead, buys put the same dollars into the index, and a sell sells the same fraction of the shadow's units as of the position's shares.
3. Timing. Fund trades are priced at the quarter VWAP and dated mid-quarter. Each node therefore needs a quarter-average level (`level_avg`) as well as a quarter-end level (`level_end`). Weekly data adds nothing.
4. Stale prices. Only held stocks are refreshed. Use a stock's close only if it falls within ~5 trading days of the quarter end.
   - Stock has a later price: leave it out of that quarter.
   - Stock has no later price: treat it as delisted; it earns its return up to its last close, then cash.
   - Report the share of value affected. Survivorship is ROADMAP D4: 18,728 stocks have no vendor ticker.
5. Unlabelled stocks. They would break the partition. Fall back to a SIC → industry table derived from the SIC codes in Damodaran's file, and put them in an "Other" bucket of that industry, tagged. Labelling new names stays an offline agent job, prompted by a health flag.
6. `@nosector` (Diversified Conglomerates). It sits in the Industrials index so the partition holds, but its picks score against the market.
7. ETF stand-ins.
   - They break "children add up to the parent", so picking + allocation won't sum exactly. Say so.
   - Their fees of 0.35–0.5% a year flatter funds.
   - Splice by chaining returns at the ETF's first full quarter, using the ETF's own lake bars with dividends.
8. End date. Score the fund and its shadows to the same quarter end. The live IRR on the site runs to the latest price, so it is a different number.

## Architecture
```
labels (committed CSVs) ─┐
shares_hist (lake, new) ─┼─> engine/sectors.py (pure) ──> node_returns (lake)
prices_daily → quarter_px┘        │                           │
                                  ▼                           ▼
                     fund compute: shadow replay      publish: sectors/nodes.json
                     per tier (XIRR in Python)                 sectors/returns.json
                                  │                            fund/{id}/skill.json
                                  └──────────────────────────> home/skill_{tier}.json
web: shows the numbers, tier toggle (sector | industry | vertical)
```
- `engine/sectors.py` makes one pass over stocks and adds them up to all three tiers plus the market.
  - Per node and quarter: `ret_q` = Σ wᵢ (closeᵢ,q + divᵢ,q) / closeᵢ,q−1 − 1, with weights fixed at the quarter's start.
  - It also gives `level_end`, `level_avg`, `n` and coverage.
  - It builds an own series for every node.
  - A committed `preferred` table picks own, ETF, or splice for each node.
- Fund scoring runs inside the fund compute, next to `compute_position`.
  - Per tier: IRR_fund, IRR_node, IRR_mkt, picking, allocation, a KS-PME ratio (stable when an IRR has no root), coverage and number of picks.
  - Raw figures go in snapshots; thresholds are applied at publish.
- Change `pipeline/contract.md` before adding any file.

## Phases
1. Mapping, in the repo.
   - Load the CSVs. Every vertical must resolve in `labels.txt`. Test the ticker guard against a `securities.json` snapshot.
   - Review the 98 sector ETFs' levels and nodes, and list the candidate ETF for each node (31 of 327 nodes have one today).
   - Add the SIC fallback table.
2. `shares_hist` and its fetch step: a one-off backfill under the time budget. Test offline with fixture JSON (share classes, a split, the ADR override).
3. `engine/sectors.py`. Test with hand-computed indices: two stocks, a dividend, a mid-quarter delisting, a stale price, an IPO, the splice, and children adding up to the parent. Add demo output.
4. Owner run 1 (private).
   - Write the series to the lake and a private CSV comparing our indices with XLK, XLF, SOXX and SPY.
   - Pass: quarterly-return correlation above 0.95 and drift under ~2% a year for sectors.
   - Then fill the `preferred` table.
5. Shadow replay and a Python XIRR in the engine. Test parity with `live.ts` `irr`, and that a fund holding its node's whole index scores picking = 0.
6. Contract change, publish step, then the web view, shown only when the file exists. Owner run 2 gives the first real numbers.

## Decided after review (owner, 2026-11-17)
- `@nosector` (conglomerates) picks score against SPY (total return, from its lake bars with dividends).
- Share counts: build `shares_hist` as designed.

## Open owner decisions
- Which ETFs count as "good" stand-ins. Proposal: cap-weighted, at least $500m in assets, tracking our node's definition, and passing the correlation test in phase 4.
- Thin verticals: 188 of 244 have fewer than 10 stocks above $1bn. Widen to the industry (R4)?
- Fallback for unlabelled stocks. Proposal: SIC → industry "Other", tagged.

## Risks
- With no cap, Technology's top five are 58% of it, so a Technology picking score largely says whether a fund owned NVIDIA.
- Before anything public: Tiingo and Damodaran licences (ROADMAP L1, R10), advice rules (L3), and ranking by a shrunk score with n shown.
- Health flags to add: unlabelled index value, unlabelled fund dollars, fallback share counts.
- Revisit later: point-in-time labels (a company that changes business), one-core compute time (S3), and whether to keep ETF stand-ins once our own indices pass.

## Cost estimate
Phases 1–3 ≈ 1 fresh chat (~2–3M tokens); phases 5–6 ≈ another. Owner runs: 2 Actions runs (~80 min each, plus ~40 min one-off for the share backfill).

## Paste-ready prompt for a fresh chat
> Read CLAUDE.md, then docs/superpowers/plans/2026-11-17-sector-indices.md and follow it. Start with phase 1 (load and test the committed mappings in pipeline/orca/hierarchy/data/, review the 98 sector ETFs' levels/nodes against labels.txt, add the SIC fallback), then phases 2–3 with TDD. Keep to ~90% accuracy, take shortcuts, stop before phase 4 and tell me what Actions run to start. Ask me the open owner decisions listed in the plan before you hard-code any of them.
