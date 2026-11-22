# Fund page, Analysis tab: sector choice vs stock choice (design spec)

Last verified: 2026-11-22 · Status: **built** on branch `claude/blissful-mayer-p2wwi0` (2026-11-22); first checked against `main` at 859f45f.
Built differently (DECISIONS 2026-11-22): quarterly returns are time-weighted at the trade, not modified Dietz (§6.2);
the per-quarter detail is in `engine/skill_detail.py`, recomputed by the publish part rather than stored by the scores step;
`sector_returns` already had `cap` (§6.5); "never rotated" (§6.9) is not built (`v_never` null); the panels share one
`fund/skill.css` and `fund/SkillPanels.tsx` loads the data.
Owner sign-off happened in a design session on 2026-11-21 over five drafts of a private claude.ai artifact
(https://claude.ai/artifact/BvTgoeVpWCPrmwDhXF55Wz, version 5 = approved). A copy of the approved draft is
committed beside this file: `2026-11-21-sector-stock-choice-draft.html`. Open it in a browser; it runs on
made-up data from one simulated fund and is reference only, never served. Where this text and the draft
disagree, this text wins.

> **Start here (new session).** Paste this into a fresh Claude Code session on this repo:
> "Read `CLAUDE.md`, then `docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md`, and build it,
> phase by phase, with tests first. Open `2026-11-21-sector-stock-choice-draft.html` beside it for the look.
> Commit and push after each phase. Stop before merging to `main` and before any Actions run, and tell me
> what to run. If something this spec does not cover needs a decision, ask me first."

---

## 1. What this is and why

Orca already scores every fund two ways (`pipeline/orca/engine/skill.py`, built 2026-11-17, run on real data in
run 31, nothing published yet). The fund's real buys and sells are replayed three times:

1. in the stocks it bought (each stock's own total-return series): **their stocks**, the fund itself;
2. in the index of each stock's own hierarchy label (sector, industry or sub-industry): **their sectors**;
3. in Orca's index of the whole US market: **whole market**.

From those: **sector choice** = IRR of (2) − IRR of (3) (`allocation`); **stock choice** = IRR of (1) − IRR of
(2) (`picking`). They add up: market + sector choice + stock choice = fund.

The owner wants amateur investors to *see* this, not read a statistic. This spec turns the scores into four
panels on the fund page's Analysis tab, adds the pipeline outputs they need, and publishes them. It is phase 6
of `docs/superpowers/plans/2026-11-17-sector-indices.md` (contract, publish, web), extended with what the owner
approved on 2026-11-21.

## 2. Terms (use these words in the UI)

| Term | Meaning |
|---|---|
| Tier | 1 = sector (12), 2 = industry (71), 3 = sub-industry (244). In code the third level is a "vertical" (`labels.txt`, `Node`); **readers always see "sub-industry"** (owner, 2026-11-21). |
| Tier word | sector / industry / sub-industry; plural sectors / industries / sub-industries. Every UI string below written with "sector" takes the tier word of the selected tier (§5.0). |
| Replay | The fund's own flows pushed through a return series (plan §7, `skill.replay`). |
| Whole market | Orca's cap-weighted index of every US stock it prices (`sector_returns` label `Market`). The split is always measured against it, because the label indices add up to it. |
| S&P 500 | SPY's total-return series. Shown for reference only, never used in the split. |
| pts | Percentage points. "+3 pts" = 3% a year more, e.g. 15% instead of 12%. |
| Adds | share of their money × how much it beat its benchmark by, in pts a year: roughly what one decision added to the whole fund. Always printed with "≈" on totals. |

## 3. Owner decisions (2026-11-21, chat) — do not re-litigate

1. Four new panels go on the **Analysis** tab, in this order, above the existing ones (§5).
2. The existing **Annual returns** bar chart stays on **Holdings**, unchanged. The new chart is a separate panel
   named **"Annual return stacked graph"** so the two are never confused.
3. The stacked graph is drawn **exactly in the style of the Assets under management (AUM) chart**
   (`web/src/fund/AumPanel.tsx`, `aum.ts`, `aum.css`): same header, three figures, legend strip, bar look, hover
   band, pinned tooltip, Table view and grow-in. No rows of numbers under the axis.
4. The stacked graph switches to **Lines**. All lines are drawn at once (no step-by-step reveal), and the
   **S&P 500** is one of them. This overrides ruling R23 ("no SPY benchmark on fund pages") for this reference
   line only; the split still uses the whole market. DECISIONS.md records it.
5. The **map** ("What kind of investor?") is a must-have and goes at the top. Its peers are the funds in the same
   famous-funds list (Tiger cubs, Tech & growth …).
6. **Sector mix over time** shows the mix only (no "vs market" view), with a Sector | Industry | Sub-industry
   switch.
7. **Which decisions made the gap**: keep both views. "Sectors vs market" leaves stock picks out on purpose. The
   money put in is drawn as a bar (not words), with an "Adds" column (share × beat by) and a total row.
8. Readers see "sub-industry", never "vertical".
9. Units must be explained in plain words on every panel (a short foot line), because readers are amateurs.

Defaults this spec chooses (the owner may override; none blocks the build):
- **Tier switch.** R9 (2026-11-16) says allocation is judged at industry level by default with a toggle to sector or
  sub-industry. The drafts were drawn at sector level with no toggle. This spec adds one shared
  **Sector | Industry | Sub-industry** switch in the map panel's header, **default Industry** (R9). It drives
  panels 1, 2 and 4; panel 3 keeps its own level switch.
- "Never rotated" line (draft checkbox in Lines): built last, optional (§6.9). Drop it if it costs more than
  10 minutes of run time.

Gate before merging to `main` (merging deploys production): DECISIONS 2026-11-16 deferred licensing (Tiingo L1,
Damodaran R10) "until something is shown on the site". This shows it. The owner must confirm before the merge.

## 4. Hard rules from the codebase (do not break)

- Change `pipeline/contract.md` **first**, then the writer, then `web/src/data/types.ts` (CLAUDE.md).
- One gain colour (blue `--gain`) and one loss colour (orange `--loss`), always with a printed sign and a real
  minus `−`. Missing values show "–". Every figure is labelled an estimate.
- Quarters before 2013 are negative: use `qOfYear` in TypeScript, never `q % 4`.
- No new npm or Python dependencies. Comments explain why.
- Fund-page CSS is scoped under `.fp`; tokens live in `web/src/tokens.css` (light and dark).
- Reuse, don't copy: `charts/Tooltip` (`useTooltip`, `{ place: { pin } }`), `fund/ChartSlot` (Table view),
  `fund/Seg`, `fund/hooks` (`useGrowOnce`, `useWidth`), `fund/geometry` (`slots`, `endRound`, `xLabels`,
  `xLabelItems`, `textW`), `fund/fmt`, `lib/format`.
- The sector steps must never cost the monthly run: they run after it is published and saved, with
  `continue-on-error` (`pipeline.yml`, WORKLOG 2026-11-18). Keep it that way.
- Demo fund IDs 9100001–9100012 exist only in demo data; the demo must produce every new file (§7.6).
- Wording avoids "skill" and "luck" anywhere a reader sees it (DECISIONS 2026-11-10, rejected idea).

## 5. What the reader sees (Analysis tab)

New order of the Analysis tab (`web/src/pages/Fund.tsx`):

1. **What kind of investor?** (new, map)
2. KPI strip (existing, `group="analysis"`)
3. **Annual return stacked graph** (new)
4. **Sector mix over time** (new)
5. **Which decisions made the gap** (new)
6. Assets under management, Return constituents, What if they'd kept it (existing, unchanged)

Panels 1, 3, 4, 5 mount only when `fund/{id}/skill.json` loads. On a 404 they are absent (no empty panels), and
the tab looks as it does today. While loading, show the site's skeleton (`.sk`, `.skbars`).

### 5.0 Shared tier switch

Page state `tier` (1 | 2 | 3, default 2) lives in `Fund.tsx`, like `win` and `sel` do. The switch (a `Seg`,
labels "Sector", "Industry", "Sub-industry", aria-label "Judge choices at") sits in the map panel's header. It
drives panels 1, 3 and 5. Tier words per tier:

| Tier | noun / plural | choice | picker corner | "their …" line | stock view tab | bets view tab |
|---|---|---|---|---|---|---|
| 1 | sector / sectors | Sector choice | Sector picker | Their sectors | Stocks vs their sector | Sectors vs market |
| 2 | industry / industries | Industry choice | Industry picker | Their industries | Stocks vs their industry | Industries vs market |
| 3 | sub-industry / sub-industries | Sub-industry choice | Sub-industry picker | Their sub-industries | Stocks vs their sub-industry | Sub-industries vs market |

At tier 3, if the fund's biggest bets sit in thin sub-indices (`sectors/labels.json` `n` < 10 or `top_weight`
≥ 0.5, plan §10), show one muted line under the panel's figures: "Some sub-industries have few stocks, so their
index leans on one or two companies."

### 5.1 Panel 1 — What kind of investor? (map)

Draft: section "1. The map, at the top".

- **Header**: title "What kind of investor?"; sub "Yearly points gained vs the market, split in two · since
  {first year} · estimate"; controls: the tier switch (§5.0), a list switch (Seg) when the fund is in 2+ famous
  lists, and a checkbox "Show its path".
- **Sentence** (`.say`-style, 17px): "Among the {N} {list name}, {short name} is in the **{corner}** corner: its
  stocks beat their {tier plural} by **{pick}** a year and its {tier plural} beat the market by **{alloc}**.
  {K} other(s) made it there." `pick` in gain/loss colour; `alloc` in the same.
- **Chart** (SVG, 880 × 460 viewBox in the draft; build it responsive with `useWidth`):
  - x = stock choice (`picking`), y = sector choice (`allocation`), both in pts a year, symmetric about 0.
    Domain ±lim, lim = max(4 pts, ceil((max |value| shown) / 2 pts) × 2 pts + 1 pt). Ticks every 2 pts (every 4
    when lim > 7), labelled "+2", "0", "−2".
  - A grey cross (`--band`) of half-width 0.8 pts on both axes: "too close to call".
  - Corner labels (14px, 700, `--ink3`): top-left "{Tier} picker", top-right "Both", bottom-left "Neither, so
    far", bottom-right "Stock picker".
  - Axis titles: "Stock choice → beating their own {tier plural}, pts a year" and "{Tier} choice → {tier plural}
    vs market".
  - Peers: grey dots (`--line2` fill, `--control` stroke), radius 4 + √n / 2.4 (n = picks), with their short name
    beside (11.5px, `--ink3`). This fund: a 10px `--gain` dot with a surface ring and its name in bold.
  - Hover/focus a dot: tooltip "{name} · Stock choice {±x.x pts} a year · {Tier} choice {±x.x pts} a year ·
    {n} picks".
  - "Show its path": rolling 3-year windows ending each Q4 and the latest quarter (§7.3 `rollingPath`), drawn
    as a dashed `--gain` line with small hollow dots, fading in from oldest to newest; year labels on the first,
    last and every third point. Tooltip "3 years to {Qn ’yy}".
- **Peers** (`§7.3 peersFor`): the funds sharing a famous list with this fund (`home/top_max.json` → `famous`
  rows, field `group`). A fund in two lists gets a switch, ordered as `FAMOUS_GROUPS`. Peers must be eligible
  (below) and have a row in `sectors/scores.json` at the tier. If the fund is in no list, or fewer than 3
  eligible peers remain, use "funds of a similar size": the 12 eligible funds nearest in `book`
  (`funds.json`), and say so in the sentence ("Among 12 funds of a similar size, …").
- **Eligibility** (ROADMAP F5): `span_q` ≥ 12 quarters, `n` ≥ 20 picks, `coverage` ≥ 0.8. If this fund is not
  eligible, the panel shows `State`: "Too early to tell. The map needs 3 years of trades and 20 picks; this fund
  has {span} quarters and {n} picks." The tier switch still shows (it drives panels 3 and 5).
- **Foot**: "Units. "pts a year" means percentage points of yearly return: +2 pts = 2% a year more, e.g. 12% a
  year instead of 10%. Measured on every dollar they put in since {first year}. Across: how much its stocks beat
  their own {tier plural}. Up: how much its {tier plural} beat the whole market. The grey cross near zero is "too
  close to call": a gap that small is often chance. Dot size = number of picks."

### 5.2 Panel 3 — Annual return stacked graph

Draft: section "2. Annual return stacked graph". Built as a twin of `AumPanel`: copy its structure
(`.panel` > `.ph` + `.stats` + `.strip` + `.pb` > `.chart`), its CSS conventions and its helpers. Files:
`fund/StackedPanel.tsx`, `fund/stacked.ts` (pure layout, unit-tested), `fund/stacked.css`.

- **Header**: title "Annual return stacked graph". Controls, left to right: (Lines only, optional §6.9) checkbox
  "If they had never rotated"; Seg "Stacked | Lines" (default Stacked); the AUM "Table view" / "Chart view"
  button with the same icon.
- **Three figures** (`.stats`, exactly AUM's): "Whole market, {span}" → "{irr_mkt} a year"; "{Tier} choice,
  {span}" → "{allocation as ±x.x pts} a year"; "Stock choice, {span}" → "{picking} a year". `span` = "{first
  year label} to {last year label}". These are the IRR figures (whole history); the foot says why they differ a
  little from the yearly bars.
- **Stacked view**:
  - One bar per calendar year of `skill.years` (labels exactly as published, e.g. "2014 Q2–Q4", "2026 9M").
  - Bar parts, the **AUM rule** (`stackParts`, §7.3): the solid bar always ends at the fund's return for that
    year. Parts that pushed the same way as the result are stacked from zero in the order market, {tier}
    choice, stock choice. A part that pushed the other way is taken off the outer end (stock choice first, then
    {tier} choice, then market) and drawn beyond it as a dashed box, exactly as AUM draws losses and outflows.
  - Looks (copy `aum.css`): market = AUM `.corp` (tint 34% + 1px stroke); {tier} choice = AUM `.fin` (hatch
    pattern + 1.25px stroke); stock choice = AUM `.gain` (solid); dashed box = AUM `.rm-loss` (16% tint, 1.25px
    dashed 3 3). Colour by the part's sign: blue when it added, orange when it took away. So a down year's
    market part is orange, and a choice that softened a fall is a blue dashed box below the bar.
  - The outermost solid part gets the 3px rounded end (`endRound`). Value label (`.blab`) beyond the outer end of
    the bar including its boxes: the fund's return for the year, signed, one decimal ("+15.3%"). Down years put
    it below. Never let it overlap the x labels (place it above zero instead).
  - Axis: `niceTicks` in % (step 10% or 20%), zero line `.zero`, x labels via `xLabels`/`xLabelItems`.
  - Hover/focus: AUM's hover band and pinned tooltip: title = year label; rows (coloured dash by sign):
    "Whole market ±x.x%", "{Tier} choice ±x.x pts", "Stock choice ±x.x pts"; sum row "Fund ±x.x%"; a muted
    last row "S&P 500, for reference ±x.x%". Keyboard: arrows/Home/End move between years (copy AUM `onKey`).
  - Legend (`.legend .lg`, AUM swatches): "Whole market", "{Tier} choice", "Stock choice", "Gave back" (orange
    dashed); add "Cushioned a fall" (blue dashed) only when one is drawn.
  - Foot (`.pf`): "Each bar is one calendar year. Light = what the whole market returned, hatched = what their
    {tier} choices added, solid = what their stock choices added; a dashed box is a choice that went the other
    way. pts = percentage points: 15% when the market made 12% is +3 pts. The three figures above count all the
    money they put in, so they differ a little from the yearly bars."
- **Lines view**:
  - Same panel shell, same three figures. Chart: the quarter-end value of each replay (`skill.quarters` values),
    drawn all at once: "Their stocks" (`--gain`, 2.5px), "Their {tier plural}" (gain tint 50%, 2.25px), "Whole
    market" (`--ink3`, 1.75px), "S&P 500" (`--ink3`, 1.5px, dashed 4 3), optional "Never rotated" (gain tint
    50%, dotted 1 4). Lines draw in (stroke-dashoffset, 900ms) when the view opens; respect reduced motion.
  - Money axis ("$0", "$500M", "$1B", "$2B"), x labels every 2 years. End values (`.blab`) at the right, nudged
    apart by ≥ 15px so they never overlap.
  - Hover: a vertical guide and the pinned tooltip (always top-left, because the lines climb to the right):
    title "Qn ’yy", one row per line with its value, a muted row "Put in that quarter $x".
  - Legend: line swatches with the names above.
  - Foot: "What the money they put in would be worth, with the same buys and sells on the same dates. Whole
    market = Orca's index of every US stock it prices. S&P 500 for reference only."
- **Table view** (ChartSlot, like AUM): Stacked → columns Year, Whole market, {Tier} choice, Stock choice, Fund,
  S&P 500. Lines → Quarter end (each Q4 and the latest), Their stocks, Their {tier plural}, Whole market, S&P
  500.
- The panel ignores the Holdings window (`win`): it always covers the replay's whole span, which the figures'
  labels state.

### 5.3 Panel 4 — Sector mix over time

Draft: section "3. Sector mix over time". Files: `fund/MixPanel.tsx`, `fund/mix.ts`, `fund/mix.css`.

- **Header**: title "{Level} mix over time" (Sector / Industry / Sub-industry); sub "Share of the portfolio by
  {level}, each quarter · estimate"; Seg "Sector | Industry | Sub-industry" (its own state, default Sector).
- **Chips**: one per sector present (swatch + name). Tapping a chip or a band picks that sector out (others turn
  `--line2` at 45%); tapping again clears it; the sub adds "· {Sector} picked out, tap again to clear".
- **Chart**: 100% stacked areas by quarter from `skill.mix`, summed to the chosen level (§7.3 `mixSeries`).
  Order: sectors in a fixed order (largest average share first), children inside their sector, largest first.
  Colour: the sector's token (`--sec-*`, §7.5); finer levels keep the sector's hue, lighter for smaller parts
  (fill-opacity 1 → 0.38 across the sector's children). "Not classified" (neutral ETFs, unlabelled stocks) is
  `--line2`, always last. Y axis 100% at the top; x labels every 2 years; labels at the right edge for bands
  ≥ 4% (sector), 4.5% (industry), 5% (sub-industry) at the last quarter, "{name} {share}%".
- **Rotations**: numbered markers (1, 2, …) at the quarters `rotations()` finds (§7.3), as dashed vertical lines
  with a numbered dot under the axis, and a list under the chart: "① Q1 ’17 Into Technology and Communication,
  out of Energy and Financials".
- Tooltip on a band: "{name} · {Sector › Industry › Sub-industry} · {Qn ’yy}: x.x% of the fund".
- **Foot**: "Shares use quarter-end values. Numbered lines are the big switches listed above." (+ at finer levels:
  "Each band keeps its sector's colour; lighter shades are its smaller parts.") (+ at sub-industry: "A
  sub-industry with only a few stocks would carry a warning.")

### 5.4 Panel 5 — Which decisions made the gap

Draft: section "4. Which decisions made the gap". Files: `fund/DecisionsPanel.tsx`, `fund/decisions.ts`.

- **Header**: title "Which decisions made the gap"; Seg "{Stocks vs their sector} | {Sectors vs market}" (tier
  words, §5.0).
- **Sentence**:
  - stock view: "**{won} of {n}** picks beat their own {tier}. **{best}** added the most, about {+x.x pts} a year
    to the whole fund; **{worst}** cost the most ({−x.x pts})."
  - bets view: "{share}% of their money went to **{label}**, where the market holds {mkt}%. That {tier} beat the
    market by {±x.x pts} a year, so this one bet added about {±x.x pts} a year. All {tier} bets together: about
    {±x.x pts}."
- **Rows** (one per pick or per label), columns left to right:
  1. Name: ticker (mono, 600) with "Name · {label name}" under it (stock view); label name with "market holds
     x%" under it (bets view).
  2. **Share of their money**: a horizontal bar (`--ink3` at 70%), width ∝ share, with "x%" after it. Bets view
     adds a 2px `--ink` tick at the market's share on the same scale ("a bar past its tick is a bet on that
     {tier}").
  3. **Return a year**: a dumbbell. Hollow dot = the benchmark (stock view: the label index with the same
     trades; bets view: the whole market with that label's trades — each row has its own dates, so its own
     market figure); filled dot = the choice (the stock; the label index). The bar between is blue if the choice
     won, orange if not. Shared x scale for all rows; ticks every 5 or 10%.
  4. **Beat by** (pts): signed, gain/loss colour.
  5. **Adds** (pts a year): share × beat by, signed, bold.
- Sort: stock view by Adds (largest first; "All other picks" last); bets view by share of money. Bets view at
  tier 1 also lists sectors they never bought, faded to 45%, with 0% share, the market tick, no dumbbell, Adds
  "0". Tiers 2–3 list bought labels only.
- **Total row**: "All picks" / "All {tier plural}" · "{money} put in" · "≈ {±x.x}" in Adds.
- Tooltips as in the draft (money put in, share, both returns, beat by, adds).
- **Foot** (stock view): "Share of their money = dollars put into that stock ÷ all dollars they put in. ○ the
  {tier} index with the same buys and sells, ● what the stock returned for them. Beat by = the gap in yearly
  return, in percentage points. Adds ≈ share × beat by: roughly how many points a year it added to the whole
  fund (≈ because money went in at different times)." (bets view): "Bar = share of their money; black tick = the
  market's share of the same {tier} when they were buying, so a bar past its tick is a bet on that {tier}. ○ the
  whole market with the same trades, ● the {tier}'s whole index bought and sold on their dates (their stock
  picks are left out). Adds ≈ share × beat by."
- Phone (< 560 px): the chart scrolls sideways inside its box (min-width 640), as the draft does; the page body
  never scrolls sideways.

## 6. Pipeline: what to compute

All in `pipeline/orca/engine/skill.py` (pure, polars) and `pipeline/orca/run/sectors_step.py` (I/O). Keep the
existing chunking by trades (`trade_chunks`, 300,000 trades) and peak-memory logging. Everything below is per
fund (`cik`), and per tier where it says so. Reuse `replay()`; extend it rather than writing a second replay.

### 6.1 Replay values and cash flows per quarter
`replay()` returns each position's dated cash flows and its end value. Add, per (cik, tier, variant, q):
- `v`: the replay's value at quarter end q = Σ positions u_q × `level_end(key, q)`, where u_q is the position's
  units after quarter q's trade, carried forward to later quarters until the next trade, and 0 after the
  position is gone.
- `cf`: the replay's net money in during q = Σ buy dollars − Σ sell proceeds (sell proceeds as `replay()` already
  computes them: fraction f × units × `level_avg`).
Compute it without materialising every position × every quarter for all funds at once: build each position's
unit intervals [q_from, q_to) and join them to the series quarters inside the chunk loop, then aggregate to
(cik, tier, variant, q) before concatenating chunks. Positions in `dropped` stay out of every variant, as today.

### 6.2 Quarterly and yearly returns
- Quarterly return (modified Dietz, flows at mid-quarter, matching `trade_years`):
  r_q = (v_q − v_{q−1} − cf_q) / (v_{q−1} + 0.5 × cf_q); null when the denominator ≤ 0.
- Variants: `fund` and `mkt` and `spy` are the same at every tier (compute once, from tier 1); `label` is per
  tier.
- Yearly return = Π(1 + r_q) − 1 over the quarters of the calendar year with a non-null r, labelled with
  `engine/fund._year_label` (same labels as `summary.json` years). By construction, every year:
  market + (label − market) + (fund − label) = fund.

### 6.3 S&P 500 replay
A fourth variant `spy` with key `s{spy_id}` (SPY's own total-return series from `own_series`, as conglomerates
already use). Gives `irr_spy`, quarterly values and returns. If SPY has no series, publish nulls.

### 6.4 Per-position IRRs (stock view)
For each fund and tier: its 30 largest positions by dollars bought get their own IRRs, `irr_own` (variant fund)
and `irr_label` (variant label), via `irr_by(..., ["cik", "tier", "variant", "stock_id"])` on the per-position
flows before they are collapsed. All other positions are summed into one row with `stock_id` null ("All other
picks"). `bought` = Σ buy dollars of the row; `label` = the row's hierarchy label at that tier (null for the
others row).

### 6.5 Per-label bets (bets view)
For each fund, tier and label the fund bought: `bought`; `irr` = IRR of the flows of all its positions in that
label, replayed in the label index (variant label grouped by label); `irr_mkt` = the same flows replayed in the
market (variant mkt grouped by label). `mkt_share` = Σ_q bought_q × cap(label, q) / cap(Market, q) ÷ Σ_q
bought_q: the market's share of that label at the times they were buying. This needs a `cap` column (Σ member
caps at the quarter's start, already the weights' denominator) added to `sector_returns` in
`engine/sectors.index_returns`. At tier 1, also emit the sectors the fund never bought (bought 0, irr null,
irr_mkt null, mkt_share weighted by the fund's total buying by quarter).

### 6.6 Mix over time
Per fund and quarter from its first trade to `last_q`: holdings = `shares_after` carried forward from
`fund_flows` × `stock_quarters.close` at quarter end. Group by tier-3 path ("Sector > Industry > Sub-industry")
and divide by the quarter's total. Special rows, so every path has exactly three parts:
- a single-sector ETF at tier 2 → "{Sector} > {Industry} > (ETFs)"; at tier 1 → "{Sector} > (ETFs) > (ETFs)";
- neutral ETFs and unlabelled stocks → "(Not classified) > (Not classified) > (Not classified)";
- a conglomerate (`@nosector`) → its own main label (it has one; only its score uses SPY);
- any path whose share never reaches 0.2% in any quarter is added into "{Sector} > (Smaller holdings) >
  (Smaller holdings)".
Shares rounded to 4 decimals. A quarter with no priced holdings is left out.

### 6.7 Scores index for the map
One row per scored fund and tier: `picking`, `allocation`, `n`, `coverage`, plus `span_q` = `last_q` − first
trade quarter + 1. Published as `sectors/scores.json` (§7.1).

### 6.8 Label list
`sectors/labels.json` from `labels.txt` and `sector_returns` at `last_q`: path, tier, parent, display name,
`n` (stocks in the index), `top_weight` (the largest stock's weight).

### 6.9 Optional, build last: "Never rotated"
Per fund and tier, one extra shadow: every quarter's total buy dollars go into the label indices in the
proportions of the fund's label mix of dollars bought over its first four quarters with buys; every quarter's
sells take from the shadow the same fraction of its value as the fund's sell proceeds were of the fund
replay's value before the sells. Publish its quarter-end values as `v_never`. If the sectors step grows by more
than 10 minutes, drop this, publish `null`, and hide the checkbox.

### 6.10 Tests (pytest, `pipeline/tests/test_skill.py` and friends, offline)
- Values: a single buy-and-hold position replayed through a hand-made series has v_q = units × level_end, and
  its quarterly returns chain to the series' own return.
- Identity: for a two-label fund, each year's mkt + (label − mkt) + (fund − label) equals fund exactly.
- A fund holding a label's whole index scores per-position `irr_own` = `irr_label` (picking 0).
- Bets: two labels, one beats the market; `irr`, `irr_mkt`, `mkt_share` by hand.
- Mix: shares sum to 1 every quarter; ETF and not-classified paths; the 0.2% roll-up.
- Sell fraction and `dropped` behave as today (existing tests stay green).
- Memory: a 720,000-trade synthetic chunk stays under the existing peak (WORKLOG 2026-11-18: 1.7 GB).

## 7. Contract, publish and web

### 7.1 Contract (add to `pipeline/contract.md` first, in its style)

Files list:
- `sectors/labels.json`: `{"last_q", "label": [], "tier": [], "parent": [], "name": [], "n": [], "top_weight": []}`
- `sectors/scores.json`: `{"last_q", "fund_id": [], "tier": [], "picking": [], "allocation": [], "n": [], "coverage": [], "span_q": []}`
- `fund/{id}/skill.json`:
```
{"last_q", "first_q",
 "quarters": {"q": [], "bought": [], "fund": [], "mkt": [], "spy": [], "v_fund": [], "v_mkt": [], "v_spy": []},
 "years": {"name": [], "fund": [], "mkt": [], "spy": []},
 "tiers": {"1": TIER, "2": TIER, "3": TIER},
 "mix": {"q": [], "label": [], "share": [[...], ...]}}
TIER = {"irr_fund", "irr_label", "irr_mkt", "irr_spy", "picking", "allocation", "coverage", "n",
        "quarters": {"label": [], "v_label": [], "v_never": [] | null},
        "years": {"label": []},
        "picks": {"stock_id": [], "label": [], "bought": [], "irr_own": [], "irr_label": []},
        "bets": {"label": [], "bought": [], "irr": [], "irr_mkt": [], "mkt_share": []}}
```
Field notes to write:
- `label` everywhere is a full hierarchy path joined by " > " (`engine/sectors.SEP`); `Market` is the whole
  market. Paths in parentheses (mix only) are groupings, not labels (§6.6).
- `quarters.fund|mkt|spy` and `tiers.t.quarters.label` are quarterly returns (fractions, modified Dietz, §6.2),
  aligned with `quarters.q`; `v_*` the replay's value at quarter end in dollars; `bought` the dollars bought in
  the quarter. `years.name` uses the `summary.json` year labels; `years.fund|mkt|spy` and
  `tiers.t.years.label` are chained from the quarters.
- `picks`: up to 30 rows by `bought`, then one row with `stock_id` null for all other positions. `bets`: one row
  per label bought at that tier; tier 1 lists all 12 sectors (unbought ones with `bought` 0 and null IRRs).
- `mix.share[i]` is the `i`-th label's share of the priced long book in each quarter of `mix.q`; every quarter's
  shares sum to 1 (± rounding).
- All IRRs and scores are null where the IRR has no root in [−0.99, 10]. `fund_id` maps from `cik` the way the
  fund files already do.
- These files exist only after a sectors step has run; a reader must treat a 404 as "not scored".

### 7.2 Publish (`orca.run sectors --part publish`)
- New part `publish` in `run/cli.py` / `sectors_step.py`, run after `scores` in the same workflow job (and inside
  `sectors_only`). It reads the lake tables, writes the files above into a staging folder with the shared writer
  (minified, sorted keys, brotli, as every file), runs the existing CUSIP leak check (`cusip_leaks`), and
  updates `manifest.json`: read the manifest just published by the monthly run (or download it from the site
  bucket in a `sectors_only` run), add or replace the new paths' sha256, write it.
- Workflow (`pipeline.yml`): a step "Publish the sector files" after "Save the score tables",
  `if: steps.scores.outcome == 'success'`, `continue-on-error: true`: `rclone copy` the staged files to the site
  bucket with the same headers the main upload uses, then the manifest last, then the existing Cloudflare purge
  (purge everything, as the main step does). A failure here never touches the monthly run's files.
- Sizes to log: total bytes of `skill.json` files and the largest one (expect ~10–40 KB each, brotli).

### 7.3 Web: types, loaders and pure models
- `web/src/data/types.ts`: `Skill`, `SkillTier`, `SectorLabels`, `SectorScores` mirroring §7.1.
- `web/src/data/api.ts`: `loadSkill(id)` (404 → null, the way `isListedFund` treats a missing file),
  `loadSectorLabels()`, `loadSectorScores()`.
- `web/src/fund/skill.ts` (pure, each function unit-tested in `web/tests/skill.test.ts`):
  - `tierWords(tier)` → the §5.0 table.
  - `stackParts({m, alloc, pick, f})` → `{dir, solid: [{k, sign, a, b}], boxes: [...], gross}` (the AUM rule;
    tests: all positive; a negative choice in an up year; a down market with a positive choice; f = 0).
  - `yearRows(skill, tier)` → `{name, m, alloc, pick, f, spy}`, where alloc = label − mkt, pick = fund − label.
  - `rollingPath(skill, tier)` → windows of 12 quarters ending each Q4 (use `qOfYear`) and the latest quarter;
    `pick` = ann(fund) − ann(label), `alloc` = ann(label) − ann(mkt), ann = (Π(1+r))^(1/3) − 1; skip a window
    with any null return.
  - `quadrant(pick, alloc, band = 0.008)` → "both" | "stock" | "sector" | "neither" (inside the band counts as
    not positive).
  - `peersFor(fundId, tier, home, scores, funds)` → `{lists: [{name, peers}], similar: boolean}` per §5.1.
  - `isEligible(row)` → span_q ≥ 12 && n ≥ 20 && coverage ≥ 0.8.
- `web/src/fund/mix.ts`: `mixSeries(mix, level)` sums paths to the level (split on " > ", strip parentheses for
  display); `rotations(series1)`: per quarter q ≥ 4, turn(q) = ½ Σ_sectors |share(q) − share(q−4)|; a rotation
  at q when turn ≥ 0.15, it is the largest turn within ±4 quarters, it is ≥ 6 quarters after the previous one;
  keep the 5 largest, in time order. Text "Into {top gainer}[ and {second gainer if ≥ 5 pts}], out of {top
  loser}[ and {second loser if ≥ 5 pts}]". Tests: a scripted mix with two switches.
- `web/src/fund/decisions.ts`: rows with share = bought / Σ bought, beat = choice − benchmark, adds = share ×
  beat; sorting; totals; tier-1 unbought sectors. Tests by hand.

### 7.4 Web: components
- `fund/SkillMapPanel.tsx` (+ `skillmap.css`), `fund/StackedPanel.tsx` (+ `stacked.ts`, `stacked.css`),
  `fund/MixPanel.tsx` (+ `mix.css`), `fund/DecisionsPanel.tsx` (+ `decisions.css`). All CSS under `.fp`.
- Charts use the shared `#tip` via `useTooltip` (pinned for panel 3, like AUM), keyboard focus on every
  hit target, `role`/`aria-label` per bar or dot, and a Table view where §5 says so (panel 3). Panels 1, 4, 5
  get an accessible table too, behind the same Table view button (map: Fund, Stock choice, {Tier} choice,
  Picks; mix: Quarter end × labels at the level; decisions: the rows as a table).
- Motion: AUM's grow-in (`useGrowOnce`) for panel 3 bars; line draw-in for Lines; no other animation. Respect
  `prefers-reduced-motion` and `data-motion="reduce"`.
- `pages/Fund.tsx`: load `skill.json` (and, for the map, `sectors/scores.json`, `home/top_max.json`,
  `funds.json`, all cached by `api.ts`) only when the Analysis tab opens; tier state default 2; the order in §5.

### 7.5 Tokens (`web/src/tokens.css`, light and dark)
Twelve sector colours, muted, kept away from `--gain` blue and `--loss` orange, each readable on `--surface` in
both themes, plus `--sec-none` = `var(--line2)`. Suggested starting values from the draft (check them with the
dataviz palette validator and adjust): Technology `#7A5FA8`/`#A58FD0`, Healthcare `#3E8E87`/`#5FB5AD`,
Financials `#B5667A`/`#D58A9D`, Energy `#8A8F3C`/`#B3B862`, Consumer `#C4A35A`/`#D9BC74`, Communication
`#6B7B8C`/`#93A3B5`, Industrials `#8C6A4F`/`#B48E70`, Materials `#5E8C5A`/`#86B381`, Utilities `#9C5FA0`/`#C58AC9`,
Property `#7F8A6E`/`#A7B295`, Business Services `#8A7F9E`/`#B1A7C4`, Defence `#5B6B4E`/`#8A9A7B`. Name them
`--sec-technology` etc. (lowercase, hyphens).

### 7.6 Demo data
`orca.run demo --plain` must also write `sectors/labels.json`, `sectors/scores.json` and `fund/{id}/skill.json`
for every demo fund (deterministic, synthetic, a few sectors, at least two rotations, one down year, one
negative choice per tier), so `npm run dev`, vitest and Playwright see the panels without the lake. Regenerate
`web/public/demo-data`.

## 8. Build phases and checklist (in order; tests first; commit and push after each)

| # | Phase | Done when |
|---|---|---|
| 0 | Read CLAUDE.md, this spec, the draft HTML, `skill.py`, `sectors_step.py`, `AumPanel.tsx`/`aum.ts`/`aum.css`, `Fund.tsx`. | You can say where each §6 item plugs in. |
| 1 | `contract.md` (§7.1). | Contract reviewed; no code yet. |
| 2 | Pipeline maths §6.1–6.8 with the §6.10 tests. | `uv run pytest -m "not network"` green; a local `sectors` run on the test lake logs peak memory within today's bounds. |
| 3 | Publish part §7.2 + workflow step + demo data §7.6. | Local `orca.run sectors --part publish` writes valid files (a JSON-schema-like check in tests); the demo writes them; `manifest.json` lists them; CUSIP check passes. |
| 4 | Web types, loaders, pure models §7.3 with tests. | `npm test` and `npm run typecheck` green. |
| 5 | Panel 3 (stacked graph) first, since it is the closest copy of AUM. Then panels 1, 4, 5. Tokens §7.5. | On `npm run dev`, `/fund/9100001#analysis` matches the draft's panels with demo data, light and dark, at 1280 and 400 px; no horizontal page scroll; every chart has a Table view; keyboard reaches every bar/dot. |
| 6 | Playwright smoke: Analysis tab shows the four panels for a demo fund (1280/400, light/dark); a fund without `skill.json` shows today's tab. | `PW_CHROMIUM=/opt/pw-browsers/chromium npx playwright test` green. |
| 7 | Optional §6.9 "never rotated". | Either built within the 10-minute budget, or nulls published and the checkbox hidden. |
| 8 | Docs: `docs/PRODUCT.md` (Analysis tab), `docs/ARCHITECTURE.md` (sectors publish part and files), plan §9 phase 6 marked built, `docs/ROADMAP.md` F5 status, `docs/WORKLOG.md` entry, `Last verified` dates. | Docs match the code. |
| 9 | Stop. Tell the owner: run Actions > Pipeline with `sectors_only` on the branch's merge to check real files (the step is `continue-on-error`), and get the licensing go-ahead (§3 gate) before merging to `main`. | Owner has the run instructions and the gate. |

Verification after the owner's run (report each): files published and listed in the manifest; Berkshire
(`/fund/1067983`) shows the four panels; for 5 funds, yearly bars add up (market + choices = fund); the map's
dot equals `sectors/scores.json`; the sum of "Adds" is within ~1 pt of `picking`/`allocation`; no NaN, no
"vertical" in any string; Lighthouse/CLS not worse than before on the Analysis tab.

## 9. Known limits (say them, don't hide them)

- The stacked graph's "Fund" is the replay of the fund's trades (dividends reinvested), so a year can differ a
  little from the Annual returns chart on Holdings. The tooltip and table call it an estimate.
- In Lines, the dollar gap today and the pts-a-year gap can tell different stories: the replays sell different
  dollar amounts, so the gap in value and the gap in yearly return need not agree. Keep the foot line; if
  readers trip on it, add a one-line "Why don't these match?" tip.
- Like AUM, a year with a gain and a loss nets them: +3 stock and −1 sector shows 2 solid plus a 1-pt dashed box.
  The tooltip and table carry the exact split.
- Uncapped cap weights: a Technology picking score largely says whether a fund owned NVIDIA (plan §11).
- With ~2,800 scored funds, some extreme dots are chance; the grey cross and eligibility rules are the only
  guard on the fund page. Rankings (ROADMAP F5) need a shrunk score and n shown.
- 13F data is quarterly with a 45-day lag; trades inside a quarter are invisible.

## 10. Where the decisions came from

Design session 2026-11-21 (chat), drafts v1–v5 of claude.ai artifact BvTgoeVpWCPrmwDhXF55Wz:
v1 four options (staircase, three-way replay, pick by pick, map); v2 map at top with famous-list peers and path,
annual split, rotation band, mix panel; v3 one chart Returns → Split → Growth; v4 owner: Annual returns stays on
Holdings, separate "Annual return stacked graph" with Lines incl. S&P 500, mix only with three levels, money
bars and Adds in the decisions panel, "sub-industry" wording; v5 owner: stacked graph in the AUM chart's style,
no numbers under the axis — "Wonderful".
