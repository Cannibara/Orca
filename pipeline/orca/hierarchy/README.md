# Sector → Industry → Industry vertical hierarchy

Last verified: 2026-11-16 (from `labels.txt`, the tests, and a build against Damodaran's January 2026 file)

Status: **draft.** Reviewed by the owner in a private Claude artifact (2026-11-15/16). Not used by the pipeline or the site yet.

## What it is
Three levels: 12 sectors, 71 industries, 244 industry verticals ("industry vertical" is the owner's name for the third level). Every US-listed stock gets:
- one **main label**, used for scoring (a fund's weights by sector, industry and vertical must add to 100%), and
- any number of **extra labels**, used to choose the peer set for one holding. Examples: Micron against all Semiconductors or only Memory; Vistra as a nuclear play against nuclear stocks and against gas power producers.

The starting point is Damodaran's 94 US industry groups. Each group has a default main label (`@default` lines). Named stocks and name rules override it. Of 4,014 US-listed stocks (NYSE, Nasdaq, NYSE American, NYSE Arca): 1,292 are placed by name, 102 by a name rule (REITs by property type, BDCs), 2,620 take their group's default. Why it is built this way, and what was rejected: `docs/DECISIONS.md`, 2026-11-16.

## Files
| File | What |
|---|---|
| `labels.txt` | The source of truth. Edit this, nothing else. |
| `assign.py` | What the pipeline reads: each stock's label from `data/stock_nodes.csv` (a `how=placed` row follows a move in `labels.txt`; set `how=owner` to keep a manual edit), then the SIC table; each ETF's class, tier and label. Labels are read fresh each run. |
| `data/stock_nodes.csv` | Stock → vertical, one row per stock_id (7,552 rows: the top 100 funds' holdings plus every stock the name match settles). Edit the `vertical` cell to move a stock. Orca reuses delisted tickers (stock 611 "AMT" is TD Ameritrade), so rows are keyed by id, and the ticker is only a guard. |
| `data/etf_nodes.csv` | ETF → class, tier and hierarchy label (462 ETFs; a leveraged ETF counts as neutral). |
| `data/sic_nodes.csv` | SIC code (4, 3 or 2 digits) → the vertical most of Damodaran's companies with that code have; the fallback for stocks the CSV does not cover. Built by `tools/build_sic_table.py`. |
| `data/batches/` | The model's batch inputs and answers, keyed by stock id, so `--missing` runs only ask about new names. |
| `tools/extend_labels.py`, `tools/relabel_check.py` | Add the stocks the name match settles to the CSV; show what an edit moves (stocks, hierarchy labels) against git HEAD before a run. |
| `model.py` | `parse` and `load` check `labels.txt` and report every problem at once; `Hierarchy.label(ticker, group, name)` returns the main label, the extra labels and how the main label was found. Standard library only. |
| `tools/fetch_inputs.sh` | Downloads the three public inputs below. |
| `tools/build_hierarchy.py` | Labels every listed stock and writes the JSON the review page reads. Needs `openpyxl` (a dev dependency). |
| `matching.py` | Matches Orca's security names (Bloomberg style, cut at 28 characters, garbled tickers) to Damodaran's global company list by distinctive words, not by ticker. Standard library only. |
| `tools/label_securities.py` | Labels Orca's `securities.json`, or a list of stock ids, through that match. Tier `auto` = strong match to a US-listed company or a same-ticker cross-listing; `verify` = an ADR under another ticker or a partial match; `none` = nothing close. |
| `tools/top_funds_universe.py` | Lists every security the best funds ever held (the public `top_<period>.json`, `securities.json` and each fund's `positions.json`), with dollars bought and which funds held it. |
| `tools/etf_batches.py`, `tools/etf_prompt.md` | The same for ETFs: a model says what each big ETF holds (broad, international, bond, cash, commodity, crypto, theme, mixed) or, for a single-sector ETF, which hierarchy label and at what level. |
| `tools/export_labels.py` | Writes the labelled stocks as a private CSV for the owner. |
| `tools/make_batches.py`, `tools/model_prompt.md`, `tools/merge_batches.py` | The stocks the match cannot settle go to a model in batches, with a blind audit sample of already-labelled stocks mixed in; the answers are merged back and the audit reports how often the model agrees. |
| `tools/make_review_page.py`, `tools/review_page.html` | Builds the review page (one HTML file). With `--final` it also shows the stocks a set of funds owned: held dollars, a sort by them, and a tab for what has no label (ETFs, funds, bonds). |
| `../../tests/test_hierarchy*.py` | Guard `labels.txt` (every Damodaran group has a default, no unused vertical, the owner's examples hold), the name matching, the merge of model answers, the universe and the page data. |

## Label the stocks the top funds held
Result on 2026-11-16 (the published data's latest quarter is 54, Q3 2026), for the 100 best funds by return since start (`home/top_max.json`), with International Assets Investment Management left out (rank 66; $718bn bought on a $1.7bn book, desk flow; owner's call). They ever held 7,025 securities and bought $2.1tn of them.

| Outcome | Stocks | Share of dollars bought |
|---|---|---|
| Labelled from Damodaran's list, placed by name or rule | 1,480 | 58% |
| Labelled from Damodaran's list, group default (910 agreed with a blind model label, 1,034 unchecked) | 1,944 | 22% |
| Model's first pass from the name (1,606 sure, 81 less sure; 234 of the sure ones replaced a group default) | 1,687 | 15.7% |
| ETFs (below) | 1,481 | 4.6% |
| Funds, SPACs and unidentifiable lines, not labelled | 433 | 0.1% |

Labelled stocks cover 95% of the dollars. By fund, the share of the current book (cost basis) in labelled stocks plus single-sector ETFs has a median of 100%; 65 of the 100 funds are at 95% or more.

ETFs: a fund's ETF buy is a sector pick (owner, chat 2026-11-16). A model classed the 462 biggest. 98 single-sector ETFs ($17bn bought, 0.8% of all dollars: SOXX, XLF, XBI, GDX, KRE) go on their sector, industry or vertical. Broad US (131), international (77), bond (87), cash (15), commodity (19), crypto (4), leveraged or mixed (16) and cross-sector theme (15) ETFs get no sector and count as neutral. The other 1,019 ETFs are small and unclassed.

Blind audit: the model labelled 880 default-labelled stocks without seeing their label. It agreed with the group default on 73% of verticals (89% of industries, 94% of sectors), and with the labels placed by name on 97% (57 stocks). Where it disagreed it was usually right (tankers under Pipelines, Qorvo under Other Semiconductors, battery makers under Automation), so a model that knows the company now replaces a default.

Is this enough to build sector indices? A sector index needs every stock in the sector tagged. The 30 biggest funds outside the top 100 (Vanguard, BlackRock, State Street, FMR and others) hold 93.9% labelled stocks, 5.7% ETFs and only 0.4% stocks we have not labelled, by value (2026-11-16). So a size-weighted index is already about 99.6% covered; equal-weighted or thin industries, and delisted names in earlier years, need more.

From `pipeline/`, with the three inputs from `tools/fetch_inputs.sh` in `/tmp/hier-inputs`:
```bash
T=/tmp/top
uv run python orca/hierarchy/tools/top_funds_universe.py --period max --top 100 --exclude 1818604 --out $T
uv run python orca/hierarchy/tools/label_securities.py --securities $T/raw/securities.json --refs /tmp/hier-inputs/indname.xlsx --stocks $T/universe.json --out $T/labelled.json
uv run python orca/hierarchy/tools/make_batches.py --labelled $T/labelled.json --universe $T/universe.json --caps /tmp/hier-inputs/hierarchy.json --out $T/batches
# one Claude agent per batch (3 at a time): "Read $T/batches/prompt.md and follow it exactly for batch number NN"
uv run python orca/hierarchy/tools/make_batches.py --labelled $T/labelled.json --universe $T/universe.json --out $T/batches --recheck 600 --first 10   # then agents for the new batches
uv run python orca/hierarchy/tools/merge_batches.py --labelled $T/labelled.json --batches $T/batches --universe $T/universe.json --out $T/final.json
uv run python orca/hierarchy/tools/etf_batches.py make --final $T/final.json --out $T/batches --top 400   # then agents with etf_prompt.md
uv run python orca/hierarchy/tools/etf_batches.py merge --final $T/final.json --batches $T/batches --out $T/final_etf.json
uv run python orca/hierarchy/tools/make_review_page.py /tmp/hier-inputs/hierarchy.json --out $T/review.html --final $T/final_etf.json --universe $T/universe.json --funds $T/raw/home/top_max.json
uv run python orca/hierarchy/tools/export_labels.py --final $T/final_etf.json --universe $T/universe.json --out $T/labels.csv
```
When a monthly run changes the published data, re-run the first two commands, then `make_batches.py ... --missing --first 12 --recheck-min 80` and `etf_batches.py make ... --missing --first 3` write batches for only what no earlier batch answered (answers are keyed by stock id and stay valid). A model run costs about 200,000 tokens per batch of 295 stocks (12 stock batches and 3 ETF batches here). The outputs (`labelled.json`, `final.json`, the review page) hold Damodaran-derived labels: the repo is public, so they are not committed (rule R10).

## `labels.txt` format
```
## Technology > Semiconductors # optional one-line description of the industry
Memory: MU SNDK RMBS MRAM                 main label for these tickers (declares the vertical)
+GPUs & AI Accelerators: AMD              extra label
+ Technology > Software > Infrastructure & Data Software: AVGO    extra label in another branch (full path)
@default Semiconductor => Technology > Semiconductors > Other Semiconductors     for stocks of a Damodaran group that no line places
@rule R.E.I.T. /apartment|residential/ => Property > REITs > Residential REITs   name regex, first match wins, beats the default
@umbrella Industrials > Manufacturing > Automotive <= Industrials > Manufacturing > Carmakers ; Industrials > Manufacturing > Auto Parts
@nosector Industrials > Conglomerates > Diversified Conglomerates                 scored against the whole market
```
- File order is display order. A stock has one main label; a second one is an error. Tickers use Damodaran's spelling (`BRK.A`).
- Order of precedence for a stock's main label: named in a section, then `@rule`, then `@default`.
- `@umbrella X <= Y ; Z`: every stock whose main label is Y or Z also gets the extra label X.

## Rebuild the review page
From `pipeline/`:
```bash
bash orca/hierarchy/tools/fetch_inputs.sh /tmp/hier-inputs
uv run python orca/hierarchy/tools/build_hierarchy.py /tmp/hier-inputs --out /tmp/hier-inputs/hierarchy.json
uv run python orca/hierarchy/tools/make_review_page.py /tmp/hier-inputs/hierarchy.json --out /tmp/hier-inputs/review.html
uv run pytest tests/test_hierarchy.py
```
Publish `review.html` as a Claude artifact with the `db` capability. The page saves the owner's calls in the collection `review`; a Claude Code session reads them with the ArtifactData tool:
- `s_<TICKER>`: a stock call. `v` is `ok`, `move` or `unsure`; `t` is the new main label as a path; `x` lists extra labels added; `rx` lists labels removed; `c` is a comment.
- `h_<path>`: a decision on a sector, industry or vertical (`v` is `ok`, `change` or `unsure`; `t` is the note).
- `n_<id>`: a label the owner created (`k: "node"`, `sector`, `industry`, `sub`, `note`).
- `r_<Rn>`: a decision on a rule (`v` is `agree`, `discuss` or `disagree`; `t` is the note).

The built HTML embeds Nasdaq market caps and Damodaran-derived defaults. Keep it private: do not commit it or publish it on the site.

## Data sources and licences
Nothing below is committed.
- **Damodaran**, `pages.stern.nyu.edu/~adamodar/pc/datasets/indname.xlsx` (January 2026): 5,994 US firms with industry group, SIC code and exchange:ticker. Built from S&P Capital IQ and Bloomberg. No formal licence; he invites reuse. Whether a paid site may show a company list derived from it is unknown: publish only our own labels, and ask him first (rule R10).
- **Nasdaq screener**: market caps, used only to rank and size stocks in the review. Non-commercial terms. Never published.
- **Fama-French 48** SIC ranges, from the WRDS macro page: a cross-check label shown beside each stock. Copyright Kenneth French.

## What is not done
- Decided by the owner: R9 (industry level by default, toggle to sector or vertical), R11 (Automotive umbrella), R12 (a single-sector ETF counts as a bet on its hierarchy label, other ETFs have no sector) and R13 (the sector score is the IRR of each call replayed through every other sector). R2–R8 and R10 are recommendations; the owner said licensing can wait until something is commercial.
- 188 of 244 verticals have fewer than 10 stocks above $1bn. A stock picker's peers widen to the industry in that case (rule R4).
- 1,034 small default-labelled stocks that the top funds held (0.8% of the dollars) and the default-labelled stocks nobody holds are not checked by name; 39 small business-service stocks sit in "Other Business Services".
- Only the stocks the 100 best funds ever held (and, from Damodaran's file, the US-listed ones) have labels. Orca prices about 22,800 stocks. The 30 biggest funds outside the top 100 already have 99.6% of their value (stocks and ETFs) covered, so the long tail is small; the same tools label more. R8 says a model's first pass, not the SIC code.
- ETFs: the 1,019 small ETFs are unclassed. Nothing scores ETFs yet.
- Not wired in: the `stock_id` mapping is committed (`data/`) but the pipeline does not read it; no change to `pipeline/contract.md` (change it first), no benchmark table (ROADMAP S4), nothing published.

## Next steps
1. The owner reviews stocks per industry vertical on the Browse tab (sorted by what the top funds bought) and the Not labelled tab, and answers R2–R8.
2. Follow `docs/superpowers/plans/2026-11-17-sector-indices.md`. In short, build the sector return table (ROADMAP S4) in the pipeline: per hierarchy label and quarter, a market-cap weighted (no cap, rebalanced each quarter) total return from the engine's `quarter_px` closes and dividends per share and the SEC share counts, for all three tiers; our own index for every hierarchy label, no ETF stand-ins (DECISIONS 2026-11-17). Then settle the licence question (R10) before anything is shown on the site.
3. Change `pipeline/contract.md` (`securities.json` has one `sector` string from SIC today), then the pipeline, then the benchmark table (ROADMAP S4) that F4 and F5 share.
