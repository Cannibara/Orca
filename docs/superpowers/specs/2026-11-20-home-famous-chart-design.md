# Home page: Famous funds as one ranked return chart (design spec)

Last verified: 2026-11-21 (checked against `main` after #55, the owner's famous_rank.csv) · Status: built (branch claude/tender-keller-89qnf1), awaiting merge.
Approved by the owner, all questions answered.
Owner sign-off happened in a design session on 2026-11-20; this file is meant to be read cold.
Reference mock-ups (working, interactive): `2026-11-20-home-famous-chart-mock/desktop.dc.html` and
`phone.dc.html` in this folder (claude.ai Design canvas files; the `/_blob/…` photo URLs only resolve on the
canvas at https://claude.ai/artifact/RBrW19wJQpU4mToFrVpG8B, boards "v4 Desktop" and "v4 Phone").
Where this text and the mock disagree, this text wins.

> **Start here (new session).** Paste this into a fresh Claude Code session on this repo:
> "Read `CLAUDE.md`, then `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md`, and build it,
> following §14 (Build checklist) in order. The owner has approved the design and answered every open
> question (§11). Ask me only if something in the spec conflicts with the code."
> Everything needed is in this file, the code it names, and the two mock files; no earlier chat is required.

---

## 1. What this is and why

Orca (orcaetf.com) estimates hedge-fund returns from SEC 13F filings for amateur investors. The home page opens on
the **Famous funds** tab (`web/src/pages/Home.tsx`, `FamousFunds`). Today that tab is a set of tables (one per
style list, 10 rows a page, ordered by popularity).

The owner's goal: **make the home page simpler and more visual, built around a colourful return bar chart**.
After several rounds (v2 3D bars → v3 flat → v4 editorial) the approved design is:

- **One** horizontal bar chart across the page per list (not two side by side).
- Each row is a fund: photo, short name, AUM, manager, and a bar of its **estimated annualised return** for the
  chosen period, **sorted best first**.
- An honest scale: bars grow from a **zero line**, gains right (blue), losses left (orange).
- The **S&P 500** over the same window is a dotted reference line.
- A **scrolling window** (15 rows desktop, 10 phone) over the list's funds (Most searched: 50; a style list: all
  of its funds, e.g. 87 for Venture capital), with a **scale that fits the funds in
  view** and glides as you scroll.
- Motion and details borrowed from the fund page's **Annual returns** chart (`web/src/fund/ReturnsPanel.tsx`,
  `returns.css`, `fund/base.css .viz`), so the site feels like one system.
- Visual reference: FT / WSJ graphics (direct labels, few lines, a statement headline, a source line).

## 2. Hard rules from the codebase (do not break)

- One gain colour (blue) and one loss colour (orange), always a printed sign and a real minus `−` (U+2212).
  Tokens: `web/src/tokens.css` (`--gain #267CAA`, `--loss #D4561F` light / `#F48D60` dark, `--band`, `--ink*`,
  `--line*`, `--ease-out: cubic-bezier(.2,.7,.2,1)`, `--d-grow: 600ms`, `--d-label: 300ms`).
- Every figure is labelled as an estimate. Missing values show "–", never NaN.
- Quarters: `q = (year−2013)*4 + (quarter−1)`; use `qOfYear` in TS, never `q % 4` (pre-2013 quarters are negative).
- Respect `prefers-reduced-motion` (and the site's `data-motion="reduce"`).
- jsdom has no IntersectionObserver/ResizeObserver: hooks must degrade (see `web/src/fund/hooks.ts`).
- No new npm dependencies.

## 3. Data

Source file: `home/top_{1y|3y|5y|10y|15y|max}.json` on `https://data.orcaetf.com` (shape in
`pipeline/contract.md`, types `TopRow` in `web/src/data/types.ts`). The `famous` array has one row per
(fund, style list): `fund_id, name, book, n_positions, ann_return, max_dd, sharpe, manager, group, until_q,
search, fame, rank` (`rank` = the owner's hand order from `pipeline/orca/famous_rank.csv`, 1 = first). Top level: `latest_q`, `period`, `search_asof`.

### 3.1 Lists
- **Each list's chart is sorted by `ann_return`, best first** (owner, 2026-11-21: "sort by return of each
  sublist"); the Table view keeps today's popularity order (§9).
- **Most searched** (first, default): exactly the funds today's site puts in it — reuse `mostSearched(rows, rank)`
  and `popularity(rows)` in `web/src/pages/Home.tsx`: rows with `search` set (not null; 0 is allowed for an
  owner-ranked fund with no Google score), one per `fund_id`, in **popularity order** (owner's `rank` ascending,
  then `fame` descending, then AUM descending), the **top 50** (`MOST_SEARCHED_MAX`). The popularity order picks
  *which* 50; the chart then displays them **by `ann_return`, best first**.
- **Style lists show every fund in the list** (owner, 2026-11-21), not a top 50: the window scrolls through all of
  them and the caption reads e.g. "Showing 1–15 of 87".
- **Style lists** (`group`, the order of `FAMOUS_GROUPS` in `Home.tsx` / `pipeline/orca/famous.py`, 15 since
  2026-11-20): Buffett inspired, Moat investing, Value, Tiger cubs, Fundamental long/short, Healthcare
  specialists, Tech & growth, Venture capital, Activists, Macro, Credit & event-driven, Family offices, Quant &
  multi-strategy, Big companies, Sovereign & pension funds. Each is charted by `ann_return` desc. The mock only
  wires Most searched and Buffett inspired; the rest join the same list switch: one row that **scrolls
  sideways** on desktop and phone (do not wrap it: `Seg`'s sliding thumb measures `offsetLeft` on one row),
  44px touch targets on phone.
- The existing per-list `about` lines (e.g. "The famous funds investors look up most.") are not shown in this
  design; the computed lead line (§4) replaces them. Keep them as the list section's accessible description.
- A fund can appear in several lists; that is fine.

### 3.2 Per-row fields shown
| Field | From | Format |
|---|---|---|
| Short name | `name` → short-name rules §3.3 | text |
| AUM | `book` (dollars) | `$X.XB` always one decimal in billions: `$304.2B`, `$13.7B`, `$0.3B` |
| Manager | `manager` → manager rules §3.4 | text, may be absent |
| Photo | `components/Face.tsx` (`photoOf(manager)` from `people.json`) | 28–32px circle; no photo → initials of manager (or fund) on `--sunken` |
| Return | `ann_return` (fraction) | `+30.2%` / `−22.6%`, one decimal, sign always |
| vs S&P 500 | `ann_return − SPX` | `+18.0 pts` (chart tooltip and screen-reader label only) |

Do **not** show "filed until Qn YYYY" (`until_q`) on this page (owner: not needed here). Keep it in the
screen-reader label only if cheap; the mock drops it.

### 3.3 Short names (to build as `fundShortName` in `web/src/lib/format.ts`)
1. ALL-CAPS → Title Case (keep short acronyms such as AQR, TCI, NEA, AKO, DST).
2. Strip legal endings from the end: Inc, Corp, Co, LLC, LP, L.P., LLP, Ltd, Limited, PLC, SA, AG, NV, GmbH,
   `/DE`, `/CAN`, `/NY/`, `/MA`, roman numerals I / II, trailing commas.
3. Strip generic tails: Management, Mgmt, Asset/Investment Management, Group, Holdings, Associates, Advisors,
   Advisers, Investments, Fund, Trust.
4. Keep brand words: Capital, Partners, Family Office, Foundation.
5. Never strip to nothing. Full legal name on hover/tooltip and on the fund page.
6. Hand exceptions live in the web for now, in a new `web/src/lib/famousNames.ts` (`SHORT_NAME`, keyed by
   `fund_id`, plus `MANAGER_LINE` and `PHONE_SHORT`, §3.4/§3.3.7); no contract change. Known cases:
   ICAHN CARL C → Carl Icahn · SC US (TTGP) → Sequoia Capital · HSG Holding → HongShan · Galileo (PTC) → DST
   Global · GATES FOUNDATION TRUST → Gates Foundation · Insight Holdings Group → Insight Partners · BATTERY
   MANAGEMENT CORP. → Battery Ventures · BAMCO → Baron Capital · Fisher Asset Management → Fisher Investments ·
   COOPERMAN LEON G → Leon Cooperman · APPALOOSA LP → Appaloosa · PAULSON & CO. → Paulson & Co. ·
   BAKER BROS. ADVISORS → Baker Bros. · Gotham Asset Management → Gotham · TCI FUND MANAGEMENT → TCI.
7. **Phone only**, displayed (not just in the label) where the 136px name column is too narrow:
   `PHONE_SHORT` = Duquesne Family Office → Duquesne, Pershing Square Capital → Pershing Square, Renaissance
   Technologies → Renaissance. During the build, run one Playwright pass at 400px over every list on production
   data, add any other name that ellipsises to this fixed map, and list them in the PR. Anything not in the map
   ellipsises (full name in the `aria-label`).

### 3.4 Manager line
The person people associate with the fund, as famous.csv's `manager` gives it (founder/star). The raw `manager`
string still drives the photo (`photoOf` in `web/src/lib/people.ts`, via `components/Face.tsx`); only the
**displayed line** changes:
- A plain person's name (2–3 capitalised words, no brackets) → shown as is.
- The 160 other values are mapped explicitly in **Appendix B** (`MANAGER_LINE` in `famousNames.ts`, generated
  from famous.csv on 2026-11-21): 32 become a person or pair ("8VC (Joe Lonsdale)" → Joe Lonsdale, "Paul Black /
  Mike Trigg" → Paul Black & Mike Trigg, "Sequoia Fund" → Bill Ruane); the rest are institutions or descriptions
  (pensions, sovereign funds, venture firms, "Google") → **no manager line**.
- A manager equal to the short fund name (Carl Icahn, Leon Cooperman) → no line, photo still shown.
- A value not in the map and not a plain name (a future famous.csv row) → no line; add it to the map.

### 3.5 S&P 500 reference (total return, from the pipeline)
Owner, 2026-11-21: fund estimates include dividends, so the S&P 500 line must too. The line is SPY's
**total return** (dividends reinvested) annualised over **the same window as the fund figures**:
- Fund `ann_return` = `growth ** (4 / n) − 1` over the fund's last `n` quarterly returns (`n` = 4, 12, 20, 40, 60
  for 1y…15y, `config.PERIODS`; `engine/metrics.performance`), ending at the list's `latest_q`.
- SPY quarter return `r_q = (close_q + div_ps_q) / close_{q−1} − 1` from `QuarterPx` (`pipeline/orca/quarter_px.py`:
  `close`, `div_ps`), for `q` in `latest_q − n + 1 … latest_q`; then `growth ** (4 / n) − 1`. The pipeline already
  loads SPY: `ctx.spy_id` / `ctx.px[ctx.spy_id]` in `pipeline/orca/run/compute.py` (do not look SPY up by
  ticker: `securities.json` has a second, unrelated "SPY", Bragg Gaming, stock_id 24664; the ETF is 98).
- Publish it (contract change — edit `pipeline/contract.md` first, then `web/src/data/types.ts`): a top-level
  `"spx": {"ann_return": number | null, "from_q": int, "to_q": int} | null` in each `home/top_{period}.json`.
  `to_q` = `latest_q`; `from_q` = `latest_q − n`, the quarter whose **close is the base** (Q3 2021 for 5y to Q3
  2026, so the returns run Q4 2021 … Q3 2026). For `max` the whole `spx` is `null` (no shared window);
  for a fixed period where SPY lacks a close or a quarter, `spx` is present with `ann_return: null`.
  Where: `pipeline/orca/run/publish_step.py` `publish_shared_files` builds `HomeLists` and
  `publish.publish_shared` writes the files. A `home_only` run starts with a fresh context, so call
  `ctx.load([ctx.spy_id])` there (it currently loads only `candidates`) before reading `ctx.px[ctx.spy_id]`.
  Add a pipeline test with a hand-checked SPY series. The demo runs this same path, so it emits `spx` once the
  demo price data includes SPY dividends; then regenerate `web/public/demo-data`.
- The web reads `spx.ann_return`. When it is null (Max, or an old file without `spx`): no S&P line, no axis label,
  no "beat the S&P 500" clause in the lead line, no "vs S&P 500" in tooltips, and the scale rules (§7.3) drop the
  S&P term.
- Sanity value: 5y to Q3 2026 SPY price return is +12.2% a year (quarter-end closes 429.14 → 762.63 on
  `stock/98/weekly.json`); with dividends expect roughly +13.5% (yield ~1.3–1.5%). The mock hard-codes the
  price-only +12.2%; the pipeline figure wins.
- A fund that stopped filing (`until_q`) is measured to its own last quarter; it is still compared with the list's
  S&P figure. Accepted (owner did not ask for per-fund benchmarks).

## 4. Page structure

Desktop (max width 1232px, 24px side padding, page background `--page`):
1. Home tabs (unchanged component; Famous funds active).
2. Header: H2 "Famous funds" (30/34px, 700, −0.03em). Standfirst 15/22px `--ink2`:
   "Estimated return a year {over}, best first. The dotted line is the S&P 500 ({spx})." `{over}` comes from one
   helper used everywhere: "over the last year" (1y), "over the last 3 / 5 / 10 / 15 years", "since each fund's
   first filing" (Max). `{spx}` = `spx.ann_return` formatted `+13.5%`; drop the second sentence when it is null.
3. Controls row: **list switch** (segmented control: Most searched | Buffett inspired | …) on the left;
   **period** control = **today's `Choice` with all six periods (1y 3y 5y 10y 15y Max), shared with Top funds,
   opening on 3y** (owner, 2026-11-21; the mock's 1y | 5y | Max and its 5y default are superseded), and a
   **Chart | Table** segmented
   switch (icon + word, same icons as Annual returns' table toggle) on the right. Chart is the default.
4. The chart module (no card, no border; FT style):
   - A 40×4px ink bar above the title (`.rule::before`).
   - H3 list name (20/26px 700) with the count on the right ("50 FUNDS", 12px `--ink3`).
   - **Lead line** that states the finding, computed: "`{top fund}` leads with `{+x.x%}` a year. `{b}` of the `{n}`
     beat the S&P 500; `{l}` lost money." (or "; none lost money.").
   - Axis header (46px): S&P label + ▼ notch on top, tick labels below (§6).
   - The scrolling window of rows (§5, §7).
   - Caption under it (12px `--ink3`, `aria-live="polite"`): "Showing 1–15 of 50 · scale fits the funds in view".
   - Source line above a `--line2` rule: "Source: SEC 13F filings; Orca estimates. S&P 500: SPY total return,
     {from} to {to}." (`from`/`to` = `spx.from_q`/`to_q` as "Q3 2021"; drop the S&P sentence when `spx` or
     `spx.ann_return` is null).

Phone (designed at 400×844 for the Famous funds module below the home header and tabs; the page scrolls
normally to bring the module into view, then the list scrolls inside its window):
1. H2 "Famous funds" 24/28px. 2. List switch (scrolls sideways, 38px tall buttons). 3. Period switch (the six
   shared periods, as on desktop; scrolls sideways if it does not fit).
4. Rule + H3 + count + lead line (13/18px). 5. Axis header (36px). 6. Window of **10 rows**.
7. Caption and source (11–12px). No tooltip (tap opens the fund page). The Chart | Table switch sits beside
   the period switch as two 44px icon-only buttons (`aria-label` "Chart" / "Table").

## 5. The row

### Desktop (row 46px)
Grid: `32px | 252px | 1fr`, column gap 14px. Plot inner area: left inset **0**, right inset **56px** (room for
the return label at the right end). The zero line therefore sits right against the name column when no loss is
in view (owner: "start the axis even more on the left").
- Photo 32px circle, `object-position: 50% 20%`. **Greyscale until hover** (Tweak; owner kept it): colour only on
  row hover/focus, so blue and orange are the only colours on the page.
- Name block: line 1 = short name (14/18px 600, ellipsis) + a 3px `--control` dot + AUM (13px `--ink3`,
  tabular); line 2 = manager (12.5/16px `--ink3`, ellipsis).
- Bar: 18px tall, vertically centred (top 14px). **Square at zero, 3px radius at the tip** (gain: `0 3px 3px 0`;
  loss: `3px 0 0 3px`), as the Annual returns bars (`endRound`).
- Return label: at the bar's tip, **right of a gain, left of a loss**, 6px gap, 12.5px 600 `--ink`, tabular, with
  a page-colour halo (`text-shadow` ×3) so a line never cuts it (Annual returns `.blab`).
- **Leader** (row 1): its label sits in the inverted pill (`--inv` background, `--invfg` text, 700, 22px tall,
  4px radius), as the Annual returns selected-year pill.
- Hover/focus: the Annual returns hover band (`--band` at 60% opacity, 6px radius, 80ms fade, extends 8px past
  the row each side). Row is an `<a>` to the fund page with a full `aria-label`
  ("3 of 50. Bridgewater, Ray Dalio, AUM $22.1B: gain of 12.0% a year (estimate), behind the S&P 500").
- Tooltip on hover/focus (the site's dark `#tip.tip` look, max 260px): title = full legal name; rows = Return a
  year (with a 10×3px swatch in the bar colour), vs S&P 500 (pts), AUM. Placed above the row at the plot start;
  for the first two visible rows place it below so the scroll box does not clip it.

### Phone (row 48px)
Grid: `28px | 136px | 1fr`, gap 8px. Plot inner: left 0, right **50px** (so the leader pill fits).
Name block **left of the bar** (owner: not above it): line 1 name (12.5/16px 600, −0.005em, ellipsis);
line 2 "AUM · manager" (11/14px `--ink3`: AUM, 3px dot, manager with ellipsis). Bar 14px, 2px tip radius.
Label 11.5px 600. Leader pill 20px tall, 3px radius.

## 6. Colour, lines and axis

- **Bar colour = shaded by size** (owner's pick: "I like the colour fade"). Strength `f = min(|ret| / 30%, 1)`,
  then `0.15 + 0.85·f` into a three-stop ramp (linear RGB mix, 0→0.5→1):
  - Light gain `#9CC8E2 → #267CAA → #0B4A72`; light loss `#F2B08F → #C64A14 → #8A3208`.
  - Dark mode flips so big = brightest: gain `#1F5F86 → #3D93C2 → #8CCBEE`; loss `#7E3714 → #D9622B → #F7A882`.
  - A "Solid" option (site `--gain` / `--loss`) exists as a design Tweak only.
- **Lines drawn through the chart: only two.** The zero line (1px; add a `--zero` token to `web/src/tokens.css`
  equal to `--ink3`: `#6A635A` light / `#AEA498` dark) and
  the **S&P 500 dotted line** (1px, `repeating-linear-gradient` 1.5px dash / 3.5px gap in `--ink3`, 75% opacity).
  No gridlines at +10%, +20% etc. (owner removed them).
- Axis header: the S&P label "S&P 500 {spx}" (11px 600 `--ink`, phone "S&P {spx}") centred over a 10×6px ▼
  notch pointing at the dotted line; tick labels on the lower line (11px `--ink3`, phone 10.5px), printed like
  Annual returns' `axisPct`: `0%`, `+10%`, `−20%`.
- **Tick choice**: 0% is always labelled. Others are multiples of the step that sit inside the domain with a
  margin (desktop ≥ 1 pt from the low end and ≥ 0.5 pt from the high end; phone ≥ 2 pts and ≥ 1 pt). Desktop step: 5 if span < 25 pts, 10 if span ≤ 60,
  else 20. **Phone: few labels** (owner): step 10 if span ≤ 25, else 20, so 0% plus one or two numbers.
  Ticks that turn on/off fade over 200ms; their positions follow the scale every frame (no transition on `left`).
- AUM-inside-the-bar (white text) was tried as an alternative and is a Tweak only; default is AUM next to the name.

## 7. The scrolling window and the fitted scale

### 7.1 Window
- Desktop shows **15 rows** (690px), phone **10 rows** (480px). Lists with ≤ that many rows don't scroll.
- Free scrolling (no scroll-snap; snap felt jumpy). Thin native scrollbar (`scrollbar-width: thin`,
  `--line2`). 24px (phone 20px) page-coloured fades at the top/bottom edges, shown only when more rows exist
  that way. Phone box uses `overscroll-behavior: contain`.
- The box is focusable (`tabindex=0`, `role=region`, `aria-label="Funds 1 to 15 of 50, scrollable"`,
  visible focus ring). Keys: ↑/↓ one row, PgUp/PgDn 14 rows (phone 9), Home/End.
- No minimap (tried; owner removed it). The caption carries the "scale fits the funds in view" message.

### 7.2 Eased scrolling (wheel and keys)
The owner wanted each scroll to start slow, reach full speed, then slow and settle, with the axis moving at the
same pace. Implementation (per 60fps frame, `dt` = frame time / 16.667, capped at 2):
1. A non-passive `wheel` listener on the box (React's `onWheel` is passive, so attach with
   `addEventListener(..., { passive: false })`). Normalise `deltaMode` (line = 16px, page = box height). At the top
   or bottom, don't `preventDefault`: let the page scroll on. Ignore `ctrlKey` (pinch zoom).
2. The wheel/keys move a **target** `T` (clamped to the scroll range).
3. A smoothed target `T2 += (T − T2) · min(1, 0.2·dt)` (this gives the slow start).
4. A critically damped spring follows `T2`: `a = (T2 − C)·0.05 − v·2√0.05`; `v += a·dt`; `C += v·dt`.
   Stop when `|T − C| < 0.4px` and `|v| < 0.05`. Set `scrollTop = C` each frame and recompute the scale from
   `p = C / rowHeight`. One wheel notch (100px) takes ~0.55–0.8s with an S-shaped profile, no overshoot.
5. A scroll the spring did not cause (scrollbar drag, touch): sync `T = T2 = C = scrollTop`, `v = 0`, and just
   follow it. **Touch keeps the device's own momentum** (no custom easing on phones).
6. Reduced motion: jump straight to the target.

### 7.3 The fitted scale (domain in percentage points)
The scale is a smooth function of the fractional scroll position `p` (rows from the top). The owner chose a
version that **starts moving slightly before a loss comes into view**, because it reads smoother than one that
moves only when strictly needed (both were built; the look-ahead one was kept).

For each whole-row window `k` (rows `k … k+VIS−1`):
- `lo = min(0, returns)`, `hi = max(0, S&P, returns)` — zero and the S&P line are always in view.
- Minimum span 20 pts: if `hi − lo < 20`, raise `hi` to `lo + 20` (so a +6% bar never fills the chart).
- Label room for losses: if `lo < 0`, push it out by `ROOM · (hi − lo) / (innerW − ROOM)` pts, where `ROOM` is
  50px desktop / 48px phone and `innerW` is the measured plot width (plot width − right inset).
Then:
- Smooth the per-window ends with a triangular moving average over ±3 windows (weights 1,2,3,4,3,2,1),
  but never narrower than that window's own `lo/hi`.
- Interpolate between windows at fractional `p` with a **Catmull-Rom** curve (no kinks as rows pass), and again
  take `min(lo, linear-interp of raw lo)` / `max(hi, …)` so the rows in view always fit.
- Bars are positioned from this domain every frame (`left`/`width` in % of the plot inner area); no CSS
  transitions on geometry (they lag behind the scroll). A bar that runs past the edge mid-scroll is clipped and
  drawn "broken": a 3px page-coloured slash, skewed −20°, 6–7px from the edge; its label keeps the true value.
- Worked example (Most searched, 5y): rows 1–15 → about 0 to +30%, zero at the left edge; rows 36–50 → about
  −25% to +12.5% with zero ~two-thirds across.
- A design Tweak "Same for the whole list" (one fixed domain) exists for comparison only.

## 8. Motion (same family as Annual returns)
- **Load / list switch / period switch**: bars grow from the zero line with `transform: scaleX(0 → 1)`
  (`transform-origin` = the zero side), 600ms `cubic-bezier(.2,.7,.2,1)`, staggered 40ms per row over the first
  screen (rows beyond it start with the last one). Labels fade in 300ms starting 450ms after their bar. This is
  `stepFor(n) = min(40, 450/(n−1))` from `web/src/fund/geometry.ts` capped to the visible rows.
- Switching list: stop any glide, `scrollTop = 0`, replay the grow-in.
- Row hover band 80ms; photo greyscale → colour 160ms.
- Reduced motion: no grow-in, no glide, ticks swap instantly.

## 9. Table view: the existing detailed table, one switch away
Owner: "a button to go from the proposed view back to the old detailed table view (existing columns)".
The **Table** side of the Chart | Table switch shows today's Famous funds table for the same list, unchanged in
substance (columns from `TOP_COLUMNS` / `famousColumns` / `searchedColumns` in `web/src/pages/Home.tsx`):

| Column | Value | Format (today's helpers) |
|---|---|---|
| Fund | exactly today's cell (`famousColumns`): photo, the fund's name as today (`FundLink`, full `name`), sub line "manager · filed until Qn YYYY" | unchanged, so `web/tests/home.test.tsx` keeps matching `f.name` |
| AUM | `book` | `fBook` (`$304.2B`, `$250m`) — note: the table keeps the site's `$…m` below $1B; the chart uses `$X.XB` |
| Positions | `n_positions` | `count` |
| Return / yr | `ann_return` | `pct(x, 0)` in `Signed` colours (blue up / orange down), `+12%` |
| Max Drawdown | `max_dd` | `pct(x, 0, false)` (`−20%`) |
| Sharpe | `sharpe` | `ratio` (`0.57`, `−0.33`) |

- Every heading sorts (button inside the `th`, `aria-sort`); a new column starts high-to-low, the same column
  flips. **Fund** steps through A–Z, Z–A and **most popular** (`popularity()`: owner's `rank`, then `fame`, then
  AUM), shown as "Fund · most popular". Every list, Most searched included, opens most popular first (as
  today since #55). There is **no Search interest column** (removed on main in #55: "users need the right funds,
  not the score").
- 10 funds a page with "1–10 of 50" and Previous / Next (as today's `FAMOUS_PAGE`). A new sort or a new list
  goes back to page 1.
- Phone: the same columns in a sideways-scrolling box (table ≥ 640px), the Fund column sticky on the left
  (168px). Row 44px; desktop 52px.
- The chart's lead line and the source line stay above/below in both views; the desktop standfirst changes to
  "Estimated figures {over}. Select a heading to sort; Fund steps through A–Z, Z–A and most popular." in table
  view (`{over}` from the §4 helper). Switching back to Chart replays the grow-in.
- The Chart | Table switch needs icons: extend `Choice` with an optional `icon` per option, passed through to `Seg`.
- Build note: reuse the existing `ListTable` + `FamousGroup` for this view rather than re-implementing it; the
  switch only chooses which of the two renders.

## 10. Dark mode
Use the dark values already in `tokens.css` (they win over any hex quoted here, e.g. dark `--invfg` is `#14110E`),
plus the new `--zero`. Bars use the dark ramps in §6.

## 11. Owner's answers (2026-11-21) — no open questions
1. Fund return estimates include dividends → the S&P 500 line is SPY **total** return (§3.5).
2. Each list's chart is sorted by return, best first; the Table view keeps the popularity order. Update the
   Famous funds row of `docs/PRODUCT.md` accordingly in the build PR (it currently says every list opens most
   popular first — still true of the Table view).
3. Lists with extreme returns (some style lists reach −42.7%): handled by the fitted scale; check the phone label
   room on such a list during the build.
4. No search score anywhere (main #55).

## 12. Decisions taken along the way (so they are not re-litigated)
| Tried | Outcome | Why |
|---|---|---|
| 3D glossy tube bars, name inside the bar (v2) | Dropped | Dated; forced a 38% head start on every bar so a −14.6% loss looked longer than a +9.7% gain |
| All bars pointing right, length = |return| | Dropped | Misread as "longer = better"; now a zero line with gains right, losses left |
| Unsorted rows | Dropped | Sorted best first so the bar ends form a staircase |
| Return in a separate right-hand column | Dropped | Direct labels at the bar tip (FT/WSJ and Annual returns) |
| Average line | Dropped by owner | The S&P line is the meaningful reference |
| AUM inside the bar | Tweak only | Owner preferred AUM next to the name |
| Replacing the table outright | Kept as a Table view | Owner wants the old detailed columns one click away |
| Search interest column / Trends caption | Removed (main #55, owner) | Users need the right funds, not the score |
| S&P 500 as price return | Total return (owner, 2026-11-21) | Fund estimates include dividends |
| Popularity order on the chart | Return order (owner, 2026-11-21) | "Sort by return of each sublist"; Table keeps popularity |
| Famous funds' own 1y / 5y / Max switch | Kept today's six shared periods, opening on 3y (owner, 2026-11-21) | No surprise when moving between tabs |
| Capping style lists at 50 | Every fund shown (owner, 2026-11-21) | The scrolling window handles long lists |
| Two lists side by side | Dropped | One chart across the page; lists via a switch |
| 50 rows on the page | Dropped | A 15-row (phone 10) scrolling window |
| Scale that waits until scrolling stops, then animates | Dropped | Felt jumpy |
| Scroll-snap to rows | Dropped | Tugged at the end of each scroll |
| Minimap of the whole list | Dropped by owner | Not needed |
| Scale that moves strictly only when a loss is on screen | Built, then reverted by owner | The slight look-ahead reads smoother |
| Gridlines at every tick | Dropped by owner | Only zero and S&P lines remain |
| "Filed to Qn" tags | Dropped by owner | Not needed on the home page |

## 13. Building it in this codebase (suggested)
- New component in `web/src/pages/Home.tsx` (or `web/src/home/FamousChart.tsx` + `famousChart.css` scoped
  like the rest of the home page) replacing `FamousGroup`'s table for the chart view; keep the table as the
  Table view. Reuse `Choice` (`web/src/components/Choice.tsx`, the home page's segmented control, a wrapper of `fund/Seg.tsx`) for the list, period and Chart | Table switches, the shared Tooltip (`useTooltip`, `web/src/charts/Tooltip.tsx`), `qOfYear` and the `lib/format.ts` / `pages/homeFmt.ts` helpers.
- Pure, testable functions (put them in a `.ts` with vitest tests): `fundShortName`, `managerLine`,
  `aumLabel` (`$X.XB`), `shadeFor(ret, dark)`, `windowDomains(rows, VIS, innerW)` (§7.3 smoothing),
  `domainAt(p, …)` (Catmull-Rom), `ticksFor(domain, isPhone)`, `leadLine(rows, spx)`, `periodPhrase(period)`.
- The glide (§7.2) as a small hook (`useEasedScroll(ref, onPosition)`) with rAF; it must no-op cleanly in jsdom
  (stub `requestAnimationFrame`, as `web/tests/idle.ts` does for idle callbacks).
- Measure the plot width with `ResizeObserver` where available, falling back to the box's `clientWidth` on
  scroll (jsdom has none).
- Playwright smoke (1280 / 400 px, light / dark): rows render; with the fixture (§14 step 2), scrolling the box
  updates the caption and the zero line stays at the left edge on the first window; no horizontal page scroll at
  400 px.

## 14. Build checklist (in order) and done-when
1. Read `CLAUDE.md`, this file, `pipeline/contract.md` (home files) and `web/src/pages/Home.tsx` (`FamousFunds`,
   `FamousGroup`, `famousColumns`, `popularity`, `mostSearched`, `FAMOUS_GROUPS`). Open the two mock files to see
   the behaviour.
2. Pipeline first (§3.5): contract.md → `spx` in `home/top_{period}.json` → pipeline code + test →
   `cd pipeline && uv run pytest -m "not network"` → demo generator + regenerate demo data
   (`uv run python -m orca.run demo --plain --out ../web/public/demo-data`) → `web/src/data/types.ts`.
   Leave the demo funds as they are (12 synthetic funds; Most searched there has fewer than 15 rows, so the
   chart simply does not scroll in the demo — that is the "≤ VIS rows" path and must work).
   For scrolling and losses, add a **test fixture**: `web/tests/fixtures/famous-top5y.json`, a copy of
   production's `home/top_5y.json` trimmed to its `famous` rows plus top-level fields (`curl -s --compressed
   https://data.orcaetf.com/home/top_5y.json`), with an `spx` object added by hand
   (`{"ann_return": 0.135, "from_q": 34, "to_q": 54}`) until the pipeline publishes one.
3. Pure helpers + vitest tests (§13): short names, manager line, `$X.XB`, shade ramp, window domains and
   Catmull-Rom domain, ticks (desktop/phone), lead line, period phrase, `SHORT_NAME` / `MANAGER_LINE` /
   `PHONE_SHORT` (Appendix B).
4. The chart view component for one list (rows, bars, labels, leader pill, zero + S&P lines, axis header, caption,
   source), static first (no scroll), then the 15/10-row window with the fitted scale (§7.3), then the eased
   wheel/keys glide (§7.2), then the grow-in (§8).
5. The list switch (Most searched + the 15 style lists), today's shared period switch (six periods), the Chart | Table
   switch with today's table behind Table (§9).
6. Dark mode, reduced motion, phone layout (§5 phone, §6 phone ticks, §7.1 phone window).
7. Docs in the same change: `docs/PRODUCT.md` (Famous funds row: chart, sort by return, table view), the
   `docs/WORKLOG.md` entry, and this file's status line.

Done when:
- `cd web && npm test` and `npm run typecheck` pass; new helpers have tests; existing `web/tests/home.test.tsx`
  still passes (update it where the default view changed).
- `npx playwright test` smoke passes at 1280 and 400 px, light and dark (demo data, plus the fixture-backed test
  above); no horizontal page scroll at 400 px.
- Vitest renders the chart from the fixture and checks: 50 rows in Most searched, the first window's zero at the
  plot's left edge, the caption after scrolling the box, a loss row's label on the left of its bar. Playwright
  serves the fixture for `home/top_5y.json` with `page.route` and checks the same at 1280 and 400 px.
- With demo data (`npm run dev`): the short lists render without a scroll box. With production data
  (`VITE_DATA_URL=https://data.orcaetf.com`, reachable from cloud sessions):
  Most searched shows the same 50 funds as the Table view; the first window has the zero line at the plot's left
  edge; scrolling to the bottom brings the losses in with zero moving right smoothly; the S&P line sits at the
  published `spx.ann_return` (before merge: checked by the pipeline test and on demo data; production has no
  `spx` until the post-merge pipeline run); Max shows no S&P line; Chart | Table
  round-trips; reduced motion removes the grow-in and the glide.
- After merge: production data gets `spx` only after a pipeline run (Actions > Pipeline > Run workflow,
  `home_only`); until then the site must render without the S&P line (old files have no `spx`).

## Appendix A: sample data (Most searched, 5y to Q3 2026, as shown in the mock)
A snapshot of the live file on 2026-11-20, for sizing and checking the design only. Membership now follows
`famous_rank.csv` (seeded from the same Trends scores, so it matched on that day); always read the live data.
Sorted best first. `name | manager | 5y return a year | AUM`. (S&P 500 over the window: +12.2% price only;
the built page uses the pipeline's total-return figure, about +13.5%.)

Duquesne Family Office | Stanley Druckenmiller | +30.3% | $3.6B
Greenlight Capital | David Einhorn | +28.0% | $1.7B
Appaloosa | David Tepper | +24.2% | $7.5B
Greenoaks | Neil Mehta | +15.3% | $2.4B
Baker Bros. | Felix & Julian Baker | +14.7% | $20.8B
First Eagle | — | +13.8% | $59.7B
Leon Cooperman | — | +13.7% | $3.0B
Paulson & Co. | John Paulson | +13.5% | $2.9B
Bridgewater | Ray Dalio | +12.0% | $22.1B
Fisher Investments | Ken Fisher | +11.9% | $334.1B
Berkshire Hathaway | Warren Buffett | +11.5% | $304.2B
ValueAct | Mason Morfit | +11.5% | $6.2B
AQR Capital | Cliff Asness | +11.4% | $325.0B
Himalaya Capital | Li Lu | +11.3% | $3.8B
Gates Foundation | Bill Gates | +11.2% | $29.9B
GAMCO | Mario Gabelli | +10.6% | $9.9B
Gotham | Joel Greenblatt | +10.3% | $49.7B
Pershing Square Capital | Bill Ackman | +9.7% | $13.7B
Renaissance Technologies | Jim Simons | +9.7% | $71.5B
Coatue | Philippe Laffont | +9.6% | $53.9B
Dodge & Cox | — | +9.1% | $171.5B
Marshall Wace | Paul Marshall & Ian Wace | +9.1% | $102.6B
TCI | Christopher Hohn | +9.0% | $48.5B
Markel | Tom Gayner | +9.0% | $12.8B
Trian | Nelson Peltz | +8.5% | $2.6B
AKO Capital | Nicolai Tangen | +7.9% | $2.6B
Fairfax Financial | Prem Watsa | +7.9% | $2.6B
Daily Journal | Charlie Munger | +7.1% | $0.3B
Third Point | Dan Loeb | +7.1% | $4.3B
Discovery Capital | Rob Citrone | +6.5% | $1.8B
Two Sigma | John Overdeck & David Siegel | +6.4% | $127.8B
Dalal Street | Mohnish Pabrai | +5.5% | $0.4B
Fundsmith | Terry Smith | +4.4% | $12.9B
Biglari Capital | Sardar Biglari | +4.1% | $1.0B
Altimeter Capital | Brad Gerstner | +4.0% | $9.8B
Tiger Global | Chase Coleman | +3.6% | $19.9B
NEA | — | −0.5% | $1.3B
Baron Capital | Ron Baron | −1.4% | $57.2B
Baupost | Seth Klarman | −1.8% | $5.0B
Carl Icahn | — | −3.9% | $9.4B
DST Global | Yuri Milner | −4.6% | $4.0B
ARK Investment | Cathie Wood | −4.6% | $16.5B
Thrive Capital | Josh Kushner | −8.6% | $7.5B
Insight Partners | — | −10.4% | $1.2B
Dragoneer | Marc Stad | −10.5% | $5.9B
General Catalyst | — | −11.8% | $0.5B
Sequoia Capital | — | −14.6% | $25.5B
Summit Partners | — | −16.7% | $0.5B
HongShan | Neil Shen | −18.1% | $1.2B
Battery Ventures | — | −22.6% | $0.3B

## Appendix B: manager line for every non-plain `manager` in famous.csv (2026-11-21)
`MANAGER_LINE` in `web/src/lib/famousNames.ts`. Left: famous.csv `manager`; right: the line shown.

8VC (Joe Lonsdale) → Joe Lonsdale
Abu Dhabi sovereign fund (Mubadala unit) → (no manager line)
Abu Dhabi sovereign investor → (no manager line)
Accel (Accel X) → (no manager line)
Accel (Accel XI) → (no manager line)
Accel (Growth Fund V) → (no manager line)
Accel (Leaders 4 growth fund) → (no manager line)
Alaska's oil fund → (no manager line)
Alberta's pension manager (AIMCo) → (no manager line)
Andreessen Horowitz (a16z) → (no manager line)
Arizona public pension → (no manager line)
Arnold Van Den Berg → Arnold Van Den Berg
Australia's largest super fund → (no manager line)
Australian public-sector super fund → (no manager line)
Australian universities' super fund → (no manager line)
BOND (Mary Meeker) → Mary Meeker
Bain Capital (Brookside) → (no manager line)
Battery Ventures → (no manager line)
Bessemer Venture Partners → (no manager line)
Bijan Modanlou & Jay Kodali (co-founders) → Bijan Modanlou & Jay Kodali
Bill Gates (Cascade) → Bill Gates
British Columbia's pension manager (BCI) → (no manager line)
CalPERS, largest US public pension → (no manager line)
CalSTRS, California teachers' pension → (no manager line)
Canaan Partners (VII) → (no manager line)
Canaan Partners (X) → (no manager line)
Canaan Partners (XI) → (no manager line)
Canada Pension Plan (CPP Investments) → (no manager line)
Canada's federal public-service pension (PSP) → (no manager line)
Cbus, Australian construction workers' super → (no manager line)
DST Global (Yuri Milner) → Yuri Milner
DST Global (Yuri Milner), early entity → Yuri Milner
DST Global / Yuri Milner trust vehicle → Yuri Milner
Denmark's national pension (ATP) → (no manager line)
Dutch civil servants' pension (ABP) → (no manager line)
Dutch healthcare workers' pension → (no manager line)
Felix & Julian Baker → Felix & Julian Baker
First Round Capital → (no manager line)
Founders Fund (Growth) → (no manager line)
Founders Fund (II) → (no manager line)
Founders Fund (IV) → (no manager line)
Founders Fund (VI) → (no manager line)
Founders Fund (VII) → (no manager line)
Foundry Group → (no manager line)
Foundry Group (Next) → (no manager line)
GGV Capital → (no manager line)
General Atlantic (growth equity) → (no manager line)
George Fraise / Gordon Marchand → George Fraise & Gordon Marchand
Google → (no manager line)
Greylock (15) → (no manager line)
Greylock (XI) → (no manager line)
Greylock (XII) → (no manager line)
Greylock (XIII) → (no manager line)
Greylock (XIV) → (no manager line)
Hamish Douglass (to 2022) → Hamish Douglass
HongShan (formerly Sequoia Capital China) → (no manager line)
IVP (XIII) → (no manager line)
IVP (XIV) → (no manager line)
IVP (XV) → (no manager line)
IVP (XVI) → (no manager line)
Index Ventures (III) → (no manager line)
Index Ventures (IV) → (no manager line)
Index Ventures (V) → (no manager line)
Insight Partners → (no manager line)
Irving Kahn (Graham's assistant) → Irving Kahn
Jerome Lande & Matt Sirovich → Jerome Lande & Matt Sirovich
John Overdeck & David Siegel → John Overdeck & David Siegel
John S. Clark II → John S. Clark
Kleiner Perkins (KPCB XII) → (no manager line)
Kleiner Perkins (KPCB XIII) → (no manager line)
Kleiner Perkins (KPCB XIV) → (no manager line)
Kleiner Perkins (KPCB XV) → (no manager line)
Kleiner Perkins Digital Growth Fund II → (no manager line)
Korea's national pension → (no manager line)
Korea's sovereign wealth fund → (no manager line)
Lightspeed Venture Partners (Opportunity Fund) → (no manager line)
Lou Simpson (GEICO) → Lou Simpson
Malaysia's national pension (EPF) → (no manager line)
Mark Arnold / Jason Orthman → Mark Arnold & Jason Orthman
Matrix Partners (VII) → (no manager line)
Matrix Partners (now Matrix) → (no manager line)
Mayfield (XII) → (no manager line)
Menlo Ventures → (no manager line)
Michael Rockefeller & Karl Kroeker → Michael Rockefeller & Karl Kroeker
Michigan public pensions → (no manager line)
Neil Shen (founder of HongShan / Sequoia China) → Neil Shen
New Enterprise Associates (NEA) → (no manager line)
New Jersey state pension (equity fund) → (no manager line)
New York State's pension fund → (no manager line)
New York teachers' pension → (no manager line)
Nick Sleep & Qais Zakaria → Nick Sleep & Qais Zakaria
North Carolina state pension → (no manager line)
Norway's largest pension company (KLP) → (no manager line)
Norway's oil fund → (no manager line)
Norwest Venture Partners (VIII) → (no manager line)
Norwest Venture Partners (XI) → (no manager line)
Norwest Venture Partners (XIII) → (no manager line)
Norwest Venture Partners (XIV) → (no manager line)
Notable Capital (formerly GGV Capital US) → (no manager line)
Novo Nordisk Foundation → (no manager line)
Ohio public employees' pension (OPERS) → (no manager line)
Ohio teachers' pension → (no manager line)
Ontario Teachers' Pension Plan → (no manager line)
Ontario hospital workers' pension (HOOPP) → (no manager line)
Ontario municipal workers' pension → (no manager line)
Ontario public pension manager (IMCO) → (no manager line)
Oregon public pension → (no manager line)
Pantera Capital (crypto) → (no manager line)
Paradigm (crypto VC) → (no manager line)
Paul Black / Mike Trigg → Paul Black & Mike Trigg
Paul Marshall & Ian Wace → Paul Marshall & Ian Wace
Paul Ruddock & Steven Heinz (founders) → Paul Ruddock & Steven Heinz
Peak XV Partners (formerly Sequoia Capital India) → (no manager line)
Phil Town (Rule #1) → Phil Town
Quebec's pension manager (CDPQ) → (no manager line)
Redpoint Ventures → (no manager line)
Ribbit Capital → (no manager line)
Ribbit Capital (GP II) → (no manager line)
Ribbit Capital (GP IV) → (no manager line)
Richard Rooney / Tony Arrell → Richard Rooney & Tony Arrell
Sam Isaly / Carl Gordon → Sam Isaly & Carl Gordon
Saudi Arabia's central bank (SAMA) → (no manager line)
Saudi Arabia's sovereign wealth fund → (no manager line)
Sequoia Capital (US Venture X) → (no manager line)
Sequoia Capital (US Venture XI) → (no manager line)
Sequoia Capital (US Venture XII) → (no manager line)
Sequoia Capital (US growth / TTGP) → (no manager line)
Sequoia Capital China public equities (HongShan) → (no manager line)
Sequoia Capital Global Equities → (no manager line)
Sequoia Capital Growth Fund (GenPar) → (no manager line)
Sequoia Capital Growth Fund III → (no manager line)
Sequoia Fund → Bill Ruane
Singapore's state investor → (no manager line)
Social Capital (Chamath Palihapitiya) → Chamath Palihapitiya
SoftBank Vision Fund (SB Investment Advisers) → (no manager line)
Spark Capital (Growth) → (no manager line)
Spark Capital (II) → (no manager line)
Spark Capital (III) → (no manager line)
Summit Partners (growth equity) → (no manager line)
Swedish state pension fund AP1 → (no manager line)
Swedish state pension fund AP2 → (no manager line)
Swedish state pension fund AP3 → (no manager line)
Swedish state pension fund AP4 → (no manager line)
Switzerland's central bank → (no manager line)
TCV (IX) → (no manager line)
TCV (VIII) → (no manager line)
TCV (X) → (no manager line)
TCV (XI) → (no manager line)
Ted Kellner (founder) → Ted Kellner
Texas teachers' pension → (no manager line)
Thrive Capital (Josh Kushner) → Josh Kushner
Tom Steyer / Andrew Spokes → Tom Steyer & Andrew Spokes
UK railway workers' pension (Railpen) → (no manager line)
UK universities' pension (USS) → (no manager line)
Union Square Ventures (2004 fund) → (no manager line)
Union Square Ventures (2008 fund) → (no manager line)
Union Square Ventures (Opportunity) → (no manager line)
Valor Equity Partners → (no manager line)
William von Mueffling → William von Mueffling
Wisconsin's pension manager (SWIB) → (no manager line)
