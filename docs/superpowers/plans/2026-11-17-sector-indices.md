# Sector indices and the allocator vs picker score: full plan and handoff

Status: phases 1–3 built on 2026-11-17 (`hierarchy/assign.py`, `shares_hist.py`, `engine/sectors.py`, `run/sectors_step.py`); phase 4 waits on the owner's Actions run. Work continues on branch `claude/gifted-cannon-e5ihyh`, which is not merged to `main`. The decision log is in `docs/DECISIONS.md` (entries dated 2026-11-16 and 2026-11-17).

## 1. Terms
- Hierarchy label: any one sector, industry or industry vertical: 12 + 71 + 244 = 327 in all. The owner also calls a vertical a "sub-industry". In the code it is `Node` (`pipeline/orca/hierarchy/model.py`).
- Tier 1 = sector, tier 2 = industry, tier 3 = vertical.
- Main label: the one vertical a stock belongs to. A stock also belongs to that vertical's industry and sector.
- Extra labels: peer sets for companies with more than one business. They never change which index a stock is in.
- Shadow: a fund's real dollar flows replayed into an index instead of the stock or ETF it bought.

## 2. What the user will see
Each fund gets two IRR-based scores. The default tier is industry, and the user can toggle to sector or vertical.
- Stock picking: did the fund's picks beat their own hierarchy label? Score = fund IRR − IRR of the same flows put into each pick's own index. Example: Micron vs Memory (tier 3), vs Semiconductors (tier 2), vs Technology (tier 1).
- Sector allocation: did the hierarchy labels it chose beat the other hierarchy labels? Score = IRR of the flows in the chosen labels' indices − IRR of the same flows in the market index. A per-position view also ranks the chosen label against every other label at that tier by IRR.

ETF picks (owner, 2026-11-17). A fund buying a single-sector ETF made a bet on that ETF's hierarchy label, at the ETF's own tier. SOXX, for example, sits at Technology > Semiconductors with no vertical. Two metrics:
1. Picking (less useful, still needed): the ETF's own return (price + dividends) vs our index for its hierarchy label. At a finer tier than the ETF's own, the toggle shows the ETF's tier and says so.
2. Allocation (the useful one, shown to the user per ETF position): the ETF's flows replayed through every other hierarchy label at that tier, by IRR. The question it answers: did Semiconductors beat the other industries over the fund's holding?

Broad, international, bond, cash, commodity, crypto, leveraged and theme ETFs are neutral: they get no sector score, but they count in coverage. Conglomerates (`@nosector`) score against SPY with dividends.

## 3. Fixed decisions (owner)
- Hierarchy: `pipeline/orca/hierarchy/labels.txt` defines the tree and its rules.
- A hierarchy label's index holds every stock whose main label sits under it, so each tier partitions the market.
- Indices are our own for all 327 hierarchy labels, at all three tiers. No ETF stands in for an index, and nothing is spot-checked against ETFs.
- Indices are market-cap weighted with no cap on any stock, rebalanced each quarter, and measured as total return with dividends.
- Thin verticals are not widened. 188 of 244 have fewer than 10 stocks above $1bn. Show the real vertical index with a warning giving the stock count and the biggest weight; silently swapping in the industry would show one index under another's name.
- Share counts come from a history table (`shares_hist`), not today's single figure.
- Accuracy of about 90% is enough. Shortcuts are fine.
- The labels may be committed to the public repo; they derive from Damodaran's public file. Licensing is parked until something is commercial.
- The 13F quarterly data and its 45-day lag are accepted: trades inside a quarter are invisible and priced at the quarter average.
- Fund 1818604 (International Assets Investment Management) is excluded from the top-100 labelling universe.

## 4. Where stock labels live: one CSV, easy to edit
- `pipeline/orca/hierarchy/data/stock_nodes.csv` is the source of truth for which hierarchy label each security has.
  - One row per stock_id. Columns: stock_id, ticker, kind, vertical, extras, how, conf.
  - The pipeline reads only this file and `labels.txt` (for the tree).
  - To move a stock, edit its `vertical` cell (Excel is fine) and set `how=owner`.
- `how` values, highest priority first:
  - `owner`: a manual edit. Never overwritten by a tool.
  - `placed`: listed by ticker in `labels.txt`.
  - `rule`: matched a rule in `labels.txt`.
  - `model`: a model's answer.
  - `default`: a Damodaran group default.
  - `sic`: the SIC fallback.
- Tools that regenerate the CSV keep `owner` rows. A `placed` ticker in `labels.txt` overrides `model`, `default` and `sic`. Phase 1 adds a test that the two files agree.
- `data/etf_nodes.csv` gives each classed ETF: stock_id, ticker, class, level (sector|industry|vertical), node (the hierarchy label path), leverage, conf. It can be edited the same way.
- `data/batches/` holds the model's batch inputs and answers, keyed by stock id. `make_batches.py --missing` and `etf_batches.py make --missing` only ask about new names.
- Current state:
  - 5,111 securities are labelled: 4,857 stocks, plus 254 bonds labelled to their issuer.
  - 462 ETFs are classed, 98 of them single-sector.
  - Coverage is the 7,025 securities the top 100 funds ever held, 95.3% of their stock dollars.
  - Owner moves on 2026-11-17: SKHY and WDC to Memory (Memory = MU SNDK RMBS MRAM SKHY WDC).
- Stock ids are a local counter in the lake. The ticker column is a guard: the pipeline flags any id whose ticker no longer matches.

## 5. Relabelling must be cheap (owner)
- One edit (a CSV cell, or a line in `labels.txt`) and one run must re-compute everything.
- Nothing caches a label: the index pass and the score replay read the labels fresh on each run, and fund snapshots store no labels.
- Recompute mode `orca.run sectors` (with an Actions input `sectors_only`). It skips ingest and the 48-min fund compute:
  - it rebuilds the index table from lake prices and `shares_hist`;
  - it replays each fund's flows from `fund_flows`;
  - it republishes the sector files.
  - Target: under 15 min.
- `tools/relabel_check.py` shows what an edit moves before you run: the stocks, the dollars the top funds bought, and the hierarchy labels affected.
- Test: moving one stock changes only its old and new hierarchy labels' series (and their parents) and only the funds that held it.

## 6. Code facts (checked 2026-11-17)
- `prices_daily` in the lake holds raw daily bars with `dividend` and `split_factor` from Tiingo, for stocks and ETFs alike (`pipeline/orca/prices.py:26-105`, `run/market.py:512-541`).
- `pipeline/orca/quarter_px.py:16-79` gives per quarter: close (on the last trading day that has one), VWAP, low, high, `div_ps` and `monthly_vwap`. Closes and dividends are split-adjusted the same way; nothing is dividend-adjusted.
- `securities.shares_out` is one figure: the latest `dei:EntityCommonStockSharesOutstanding` from SEC companyconcept, summed over share classes (`securities.py:234-260`). It is overwritten on a split refresh (`market.py:192-256,614-656`) and is null when there is no CIK. That same JSON holds the full history.
- SPY is the only benchmark today (`market.py:47`, `Context.spy_id` in `run/compute.py:160`). No benchmark series is published.
- Prices are refreshed only for stocks held in the latest quarter, exits within 6 quarters, and SPY. 18,728 stocks have no vendor ticker (ROADMAP D4).
- Publishing: `publish.py:379-449` (`publish_shared`, the `docs` dict) and `run/publish_step.py:103-172`. The run order is in `run/weekly.py:307-415`; a new step fits next to `publish_shared_files` (about line 352). CLI: `run/cli.py:62-73`.
- The browser's `irr(flows)` is at `web/src/lib/live.ts:52`. It solves by bisection on [−0.99, 10]. Flows are dated mid-quarter (`tradeYears`), priced at the quarter VWAP, and leave out dividends.
- `pipeline.yml` holds the R2 and API secrets; tests run only in `ci.yml`. A monthly run takes ~80 min against a 270-min budget. The runner has 16 GB and 4 cores; the fund compute takes ~48 min on 1 core.
- Why it runs in the pipeline: the lake keys are GitHub secrets, so dev sandboxes cannot read it. The Actions job can. It publishes ready-made series and scores as JSON, and the site only displays them. Scores cover ~13,000 funds, too many for the browser.

## 7. Method
Index per hierarchy label h and quarter q:
- Weights are fixed at the start of q: wᵢ = capᵢ / Σ cap, where capᵢ = raw unadjusted close at the end of q−1 × the latest `shares_hist` count filed by then.
  - Fallback: today's `shares_out` × the split-adjusted close, tagged.
  - Last resort: the stock is left out.
- ret_q(h) = Σ wᵢ × (closeᵢ,q + divᵢ,q) / closeᵢ,q−1 − 1, using split-adjusted closes and dividends.
- level_end(h,q) = level_end(h,q−1) × (1 + ret_q).
- level_avg(h,q) = level_end(h,q−1) × Σ wᵢ × vwapᵢ,q / closeᵢ,q−1, matching how fund trades are priced.
- One pass over stocks builds the verticals; industries, sectors and the market are sums of their children, so children add up to their parent.
- A stale price is one whose close is more than ~5 trading days before the quarter end.
  - If the stock has a later price, it is left out of that quarter.
  - If not, it is treated as delisted: it earns its return up to its last close, then cash.
  - Report the value affected.
- Unlabelled priced stocks:
  1. Extend coverage cheaply first: run `tools/label_securities.py` over all of `securities.json`. The name match plus Damodaran group defaults need no model.
  2. The rest go through a SIC → industry fallback table derived from the SIC codes in Damodaran's file, into an industry's "Other" vertical, with `how=sic`.
- Share-count overrides: a small committed table for ADR ratios (TSM: 1 ADR = 5 shares; SKHY ratio to check) and dual-class companies. Check the ~300 biggest names against a reference market cap.

Shadow replay per fund, tier and position:
- A buy of $X puts $X into the index at the quarter's level_avg.
- A sell of a fraction f of the position's shares sells the same fraction f of the shadow's units. Matching the dollars could drive the shadow negative.
- Score the fund and its shadows to the same last quarter end. The site's live IRR runs to the latest price, so it is a different number.

Scores per fund and tier:
- IRR_fund, IRR_label (shadow in each pick's own index), IRR_mkt (shadow in the market index).
- picking = IRR_fund − IRR_label; allocation = IRR_label − IRR_mkt.
- A KS-PME ratio alongside, which is stable when an IRR has no root.
- Coverage of dollars, number of picks.
- Raw figures go in the snapshots; thresholds are applied at publish.

Per ETF position and per stock position (allocation view): the label's IRR rank among all hierarchy labels at that tier.

## 8. Architecture
```
data/stock_nodes.csv + labels.txt ─┐
shares_hist (lake, new) ───────────┼─> engine/sectors.py (pure) ──> sector_returns (lake)
prices_daily → quarter_px ─────────┘                │
fund compute ──> fund_flows (lake, new) ──> engine/skill.py: shadow replay + XIRR ──> fund_skill (lake)
                                                     │
publish: sectors/labels.json, sectors/returns.json, fund/{id}/skill.json, home/skill_{tier}.json
web: shows the numbers; tier toggle sector | industry | vertical; thin-vertical warning
```
- Change `pipeline/contract.md` before adding any file.
- Rough shapes:
  - `sectors/labels.json`: id, path, tier, parent, n, top_weight.
  - `sectors/returns.json`: q[], plus per label ret[], level_end[], level_avg[], n[].
  - `fund/{id}/skill.json`: per tier picking, allocation, the IRRs, coverage; per position the label and its IRR rank.
- Health flags: unlabelled index value, unlabelled fund dollars, fallback share counts, stale-price value, ticker-guard mismatches.

## 9. Phases (TDD; each phase ends with tests green, a commit and a push)
1. Labels in the pipeline.
   - A loader for the CSVs.
   - Tests: every vertical resolves in `labels.txt`; `labels.txt` placements agree with the CSV; `owner` rows survive regeneration; the ticker guard works.
   - Review the 98 sector ETFs' tier and hierarchy label.
   - Extend coverage with `label_securities.py` over all of `securities.json` (this needs a fresh public download).
   - Add the SIC fallback and `tools/relabel_check.py`.
2. `shares_hist` and its fetch step.
   - A one-off backfill of ~15k CIKs at 8/s ≈ 30–40 min, within the time budget, then only new filers.
   - Tests: offline fixture JSON with share classes, a split, and the ADR override.
3. `engine/sectors.py`.
   - Hand-computed tests: two stocks, a dividend, a mid-quarter delisting, a stale price, an IPO, children adding up to the parent, and the relabel test.
   - Demo-data output.
4. Owner run 1, private.
   - Write `sector_returns` to the lake and report the health flags.
   - Sanity read: does the Technology index look like large-cap tech, and Energy like oil?
5. `fund_flows`, `engine/skill.py` (shadow replay, Python XIRR, KS-PME, ETF picks) and the `sectors` recompute mode.
   - Tests: parity with `live.ts` `irr`; a fund holding a label's whole index scores picking = 0; the sell-fraction rule; a SOXX pick scores both metrics.
6. Contract change, publish step, then the web view.
   - The view appears only when the file exists, has the tier toggle and shows the thin warning.
   - Owner run 2 gives the first real numbers.

## 9a. Built differently from the plan (2026-11-17)
- The SIC fallback gives the most common vertical for the code (not an industry's "Other" vertical): more accurate and no new verticals.
- `labels.txt` overrides only rows with `how=placed`, because Orca reuses delisted tickers. To move any other stock, edit the CSV.
- The index build runs as a stage of the monthly run (`sectors`, after `rf`) and writes only the lake. The `orca.run sectors` recompute mode comes with phase 5.
- Leveraged sector ETFs are neutral.

## 10. Defaults chosen (the owner can override)
- Unlabelled stocks: a SIC → industry "Other" vertical, tagged `sic`.
- Stale-price window: 5 trading days.
- Thin-vertical warning: fewer than 10 stocks above $1bn, or one stock at ≥50% of the index.

## 11. Risks
- With no cap, Technology's top five are 58% of its index, so a Technology picking score mostly says whether a fund owned NVIDIA.
- Before anything public: the Tiingo and Damodaran licences (ROADMAP L1, R10), advice rules (L3), and ranking by a shrunk score with n shown.
- Survivorship: bankrupt stocks with no prices are missing from both the funds and the indices.
- Later: point-in-time labels (a company that changes business), and the one-core compute time (S3).

## 12. Cost
- Phases 1–3: ~2–3M tokens. Phases 5–6: about the same.
- Owner Actions runs: ~80 min each, plus ~40 min one-off for the share backfill.

## 13. Prompt to continue
> Read CLAUDE.md, then docs/superpowers/plans/2026-11-17-sector-indices.md and follow it. Work on branch claude/gifted-cannon-e5ihyh. Do phases 1–3 with TDD, committing and pushing after each. Keep to ~90% accuracy and take shortcuts. Stop before phase 4 and tell me which Actions run to start. If a step needs a decision the plan doesn't cover, ask me first.
