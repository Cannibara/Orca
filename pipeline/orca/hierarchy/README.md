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
| `model.py` | `parse` and `load` check `labels.txt` and report every problem at once; `Hierarchy.label(ticker, group, name)` returns the main label, the extra labels and how the main label was found. Standard library only. |
| `tools/fetch_inputs.sh` | Downloads the three public inputs below. |
| `tools/build_hierarchy.py` | Labels every listed stock and writes the JSON the review page reads. Needs `openpyxl` (a dev dependency). |
| `matching.py` | Matches Orca's security names (Bloomberg style, cut at 28 characters, garbled tickers) to Damodaran's global company list by distinctive words, not by ticker. Standard library only. |
| `tools/label_securities.py` | Labels Orca's `securities.json`, or a list of stock ids, through that match. Tier `auto` = strong match to a US-listed company or a same-ticker cross-listing; `verify` = an ADR under another ticker or a partial match; `none` = nothing close. |
| `tools/top_funds_universe.py` | Lists every security the best funds ever held (the public `top_<period>.json`, `securities.json` and each fund's `positions.json`), with dollars bought and which funds held it. |
| `tools/export_labels.py` | Writes the labelled stocks as a private CSV for the owner. |
| `tools/make_batches.py`, `tools/model_prompt.md`, `tools/merge_batches.py` | The stocks the match cannot settle go to a model in batches, with a blind audit sample of already-labelled stocks mixed in; the answers are merged back and the audit reports how often the model agrees. |
| `tools/make_review_page.py`, `tools/review_page.html` | Builds the review page (one HTML file). With `--final` it also shows the stocks a set of funds owned: held dollars, a sort by them, and a tab for what has no label (ETFs, funds, bonds). |
| `../../tests/test_hierarchy*.py` | Guard `labels.txt` (every Damodaran group has a default, no unused vertical, the owner's examples hold), the name matching, the merge of model answers, the universe and the page data. |

## Label the stocks the top funds held
Result on 2026-11-16, for the 100 best funds by return since start (`home/top_max.json`): they ever held 7,702 securities and bought $2.2tn of them.

| Outcome | Stocks | Share of dollars bought |
|---|---|---|
| Labelled from Damodaran's list, placed by name or rule | 1,457 | 64% |
| Labelled from Damodaran's list, group default (876 agreed with a blind model label, 1,282 unchecked) | 2,158 | 17% |
| Model's first pass from the name (1,671 sure, 75 less sure; 224 of the sure ones replaced a group default) | 1,746 | 12% |
| ETFs, not labelled yet: a fund's ETF buy is a sector pick, so each needs a node (owner, chat 2026-11-16) | 1,815 | 7.6% |
| Funds, SPACs and unidentifiable lines, not labelled | 526 | 0.2% |

Labelled stocks cover 92% of the dollars. By fund: the labelled share of each fund's current book (cost basis) has a median of 99.9%; 65 of the 100 funds are at 95% or more, and the rest are mostly ETF-heavy funds.

Blind audit: the model labelled 840 default-labelled stocks without seeing their label. It agreed with the group default on 73% of verticals (88% of industries, 94% of sectors), and with the labels placed by name on 97% (58 stocks). Where it disagreed it was usually right (tankers under Pipelines, Qorvo under Other Semiconductors, battery makers under Automation), so a model that knows the company now replaces a default.

From `pipeline/`, with the three inputs from `tools/fetch_inputs.sh` in `/tmp/hier-inputs`:
```bash
T=/tmp/top
uv run python orca/hierarchy/tools/top_funds_universe.py --period max --top 100 --out $T
uv run python orca/hierarchy/tools/label_securities.py --securities $T/raw/securities.json --refs /tmp/hier-inputs/indname.xlsx --stocks $T/universe.json --out $T/labelled.json
uv run python orca/hierarchy/tools/make_batches.py --labelled $T/labelled.json --universe $T/universe.json --caps /tmp/hier-inputs/hierarchy.json --out $T/batches
# one Claude agent per batch (3 at a time): "Read $T/batches/prompt.md and follow it exactly for batch number NN"
uv run python orca/hierarchy/tools/make_batches.py --labelled $T/labelled.json --universe $T/universe.json --out $T/batches --recheck 600 --first 10   # then agents for the new batches
uv run python orca/hierarchy/tools/merge_batches.py --labelled $T/labelled.json --batches $T/batches --universe $T/universe.json --out $T/final.json
uv run python orca/hierarchy/tools/make_review_page.py /tmp/hier-inputs/hierarchy.json --out $T/review.html --final $T/final.json --universe $T/universe.json --funds $T/raw/home/top_max.json
uv run python orca/hierarchy/tools/export_labels.py --final $T/final.json --universe $T/universe.json --out $T/labels.csv
```
A model run costs about 200,000 tokens per batch of 295 stocks (11 batches here). The outputs (`labelled.json`, `final.json`, the review page) hold Damodaran-derived labels: the repo is public, so they are not committed (rule R10).

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
- Rules R2–R10 on the review page are recommendations, not decisions. Only R11 (Automotive umbrella, no fourth level) is decided.
- 188 of 244 verticals have fewer than 10 stocks above $1bn. A stock picker's peers widen to the industry in that case (rule R4).
- 1,282 small default-labelled stocks that the top funds held (under 1% of the dollars) and the default-labelled stocks nobody holds are not checked by name; 39 small business-service stocks sit in "Other Business Services".
- Only the stocks the 100 best funds ever held (and, from Damodaran's file, the US-listed ones) have labels. Orca prices about 22,800 stocks, so other funds' stocks are unlabelled; the same tools label them. R8 now says a model's first pass, not the SIC code.
- ETFs have no node yet. The owner says a fund's ETF buy is a sector pick (chat, 2026-11-16), so each needs one; the ETF-heavy funds stay in the list (66 of the 100 funds have held an ETF; 12 hold half or more of their current book in ETFs, 4 hold 90% or more, such as PPSC Investment Service Corp, rank 15). A model classed the biggest 400 ETFs once (90 single-sector, $29bn bought; `etf_batches.py`, commit 1fecf4b) and the tool was removed in bf901e0 on a misunderstanding: restore it from git. How sectors are compared with each other (indices built from the hierarchy, ETFs as cross-checks) is open: ROADMAP S4, F5, L5.
- Not wired in: no `stock_id` mapping, no change to `pipeline/contract.md` (change it first), no benchmark table (ROADMAP S4), nothing published.

## Next steps
1. The owner reviews stocks per industry vertical on the Browse tab (now sorted by what the top funds bought), the Not labelled tab, and answers the Rules tab (R8 changed).
2. Settle the licence question (R10), then export `ticker → main label, extra labels` as a CSV next to `labels.txt`.
3. Change `pipeline/contract.md` (`securities.json` has one `sector` string from SIC today), then the pipeline, then the benchmark table (ROADMAP S4) that F4 and F5 share.
