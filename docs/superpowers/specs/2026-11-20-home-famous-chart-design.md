# Home page: Famous funds as one ranked return chart (design spec)

Last verified: 2026-11-20 · Status: approved by the owner as a mock-up, not built.
Owner sign-off happened in a design session on 2026-11-20; this file is meant to be read cold.
Reference mock-ups (working, interactive): `2026-11-20-home-famous-chart-mock/desktop.dc.html` and
`phone.dc.html` in this folder (claude.ai Design canvas files; the `/_blob/…` photo URLs only resolve on the
canvas at https://claude.ai/artifact/RBrW19wJQpU4mToFrVpG8B, boards "v4 Desktop" and "v4 Phone").
Where this text and the mock disagree, this text wins.

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
- A **scrolling window** (15 rows desktop, 10 phone) over up to 50 funds, with a **scale that fits the funds in
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
search, fame`. Top level: `latest_q`, `period`, `search_asof`.

### 3.1 Lists
- **Most searched** (first, default): famous rows with a non-null `search`, highest first, one row per
  `fund_id`, the **top 50**. Display order is then **by `ann_return`, best first** (see §11, open question 2).
- **Style lists** (`group`, order of `FAMOUS_GROUPS` in `pipeline/orca/famous.py`): Buffett inspired, Moat
  investing, Value, Tiger cubs, … each sorted by `ann_return` desc. The mock only shows Most searched and
  Buffett inspired; the rest join the same list switch.
- A fund can appear in several lists; that is fine.

### 3.2 Per-row fields shown
| Field | From | Format |
|---|---|---|
| Short name | `name` → short-name rules §3.3 | text |
| AUM | `book` (dollars) | `$X.XB` always one decimal in billions: `$304.2B`, `$13.7B`, `$0.3B` |
| Manager | `manager` → manager rules §3.4 | text, may be absent |
| Photo | `web/src/assets/people/people.json` maps the manager string → `<slug>.jpg` | 28–32px circle; no photo → initials of manager (or fund) on a sand circle |
| Return | `ann_return` (fraction) | `+30.2%` / `−22.6%`, one decimal, sign always |
| vs S&P 500 | `ann_return − SPX` | `+18.0 pts` (tooltip, table only) |

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
6. Hand exceptions (a `short_name` column in `pipeline/orca/famous.csv` is the intended home):
   ICAHN CARL C → Carl Icahn · SC US (TTGP) → Sequoia Capital · HSG Holding → HongShan · Galileo (PTC) → DST
   Global · GATES FOUNDATION TRUST → Gates Foundation · Insight Holdings Group → Insight Partners · BATTERY
   MANAGEMENT CORP. → Battery Ventures · BAMCO → Baron Capital · Fisher Asset Management → Fisher Investments ·
   COOPERMAN LEON G → Leon Cooperman · APPALOOSA LP → Appaloosa · PAULSON & CO. → Paulson & Co. ·
   BAKER BROS. ADVISORS → Baker Bros. · Gotham Asset Management → Gotham · TCI FUND MANAGEMENT → TCI.
7. **Phone only**, where the 136px name column is too narrow: Duquesne Family Office → Duquesne, Pershing Square
   Capital → Pershing Square, Renaissance Technologies → Renaissance. Measure, don't guess: any name that would
   ellipsis on phone gets a spoken short form.

### 3.4 Manager line
The person people associate with the fund (founder/star, not today's CEO), first + last name only. Strip
parentheticals (`Bill Gates (Cascade)` → Bill Gates). Firm-as-manager (venture firms: Sequoia, Insight, General
Catalyst, Summit, Battery, NEA) → no manager line. Same as the fund name (Carl Icahn, Leon Cooperman) → no
manager line, but still use that person's photo. Exceptions seen: Thrive Capital → Josh Kushner; DST Global →
Yuri Milner; HongShan → Neil Shen; Ruane, Cunniff & Goldfarb → Bill Ruane.

### 3.5 S&P 500 reference
Annualised **price** return of SPY (`stock_id` 98 in `securities.json`) over the **same window as the fund
figures**: quarter-end closes from `stock/98/weekly.json` (`q0`, `qclose`), from the quarter-end `period` years
before `latest_q` to `latest_q`. For 5y with `latest_q` = 54 (Q3 2026): 429.14 → 762.63 = **+12.2% a year**.
Compute it per period in the client (or publish it). Open question: whether fund estimates include dividends
(§11.1); if they do, the S&P figure should too (~+1.3 pts a year).

## 4. Page structure

Desktop (max width 1232px, 24px side padding, page background `--page`):
1. Home tabs (unchanged component; Famous funds active).
2. Header: H2 "Famous funds" (30/34px, 700, −0.03em). Standfirst 15/22px `--ink2`:
   "Estimated return a year over the last 5 years, best first. The dotted line is the S&P 500 (+12.2%)."
3. Controls row: **list switch** (segmented control: Most searched | Buffett inspired | …) on the left;
   **period** segmented control (1y | 5y | Max — the owner cut it to three) and a **Chart | Table** segmented
   switch (icon + word, same icons as Annual returns' table toggle) on the right. Chart is the default.
4. The chart module (no card, no border; FT style):
   - A 40×4px ink bar above the title (`.rule::before`).
   - H3 list name (20/26px 700) with the count on the right ("50 FUNDS", 12px `--ink3`).
   - **Lead line** that states the finding, computed: "`{top fund}` leads with `{+x.x%}` a year. `{b}` of the `{n}`
     beat the S&P 500; `{l}` lost money." (or "; none lost money.").
   - Axis header (46px): S&P label + ▼ notch on top, tick labels below (§6).
   - The scrolling window of rows (§5, §7).
   - Caption under it (12px `--ink3`, `aria-live="polite"`): "Showing 1–15 of 50 · scale fits the funds in view".
   - Source line above a `--line2` rule: "Source: SEC 13F filings; Orca estimates. S&P 500: SPY price return,
     Q3 2021 to Q3 2026."

Phone (designed at 400×844; everything fits one screen so only the list scrolls, never the page):
1. H2 "Famous funds" 24/28px. 2. List switch (full width, 38px tall buttons). 3. Period switch.
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
- **Lines drawn through the chart: only two.** The zero line (1px `--zero` = `#6A635A` light / `#AEA498` dark) and
  the **S&P 500 dotted line** (1px, `repeating-linear-gradient` 1.5px dash / 3.5px gap in `--ink3`, 75% opacity).
  No gridlines at +10%, +20% etc. (owner removed them).
- Axis header: the S&P label "S&P 500 +12.2%" (11px 600 `--ink`, phone "S&P +12.2%") centred over a 10×6px ▼
  notch pointing at the dotted line; tick labels on the lower line (11px `--ink3`, phone 10.5px), printed like
  Annual returns' `axisPct`: `0%`, `+10%`, `−20%`.
- **Tick choice**: 0% is always labelled. Others are multiples of the step that sit inside the domain with a
  margin (≥ 1 pt from the low end, ≥ 0.5 pt from the high end). Desktop step: 5 if span < 25 pts, 10 if span ≤ 60,
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
| Fund | photo (26–28px), short name (600), sub line "manager · filed until Qn YYYY" (the table keeps `until_q`) | link to the fund page; full legal name on hover |
| Search interest | `search` — **Most searched only** | `fSearch` (`100`, `4.8`, `<1`, `—`) |
| AUM | `book` | `fBook` (`$304.2B`, `$250m`) — note: the table keeps the site's `$…m` below $1B; the chart uses `$X.XB` |
| Positions | `n_positions` | `count` |
| Return / yr | `ann_return` | `pct(x, 0)` in `Signed` colours (blue up / orange down), `+12%` |
| Max Drawdown | `max_dd` | `pct(x, 0, false)` (`−20%`) |
| Sharpe | `sharpe` | `ratio` (`0.57`, `−0.33`) |

- Every heading sorts (button inside the `th`, `aria-sort`); a new column starts high-to-low, the same column
  flips. **Fund** steps through A–Z, Z–A and **most popular** (Google Trends `fame`, then AUM), shown as
  "Fund · most popular". Opening order: Most searched by search interest, other lists most popular first (as
  today).
- 10 funds a page with "1–10 of 50" and Previous / Next (as today's `FAMOUS_PAGE`). A new sort or a new list
  goes back to page 1.
- Phone: the same columns in a sideways-scrolling box (table ≥ 640px), the Fund column sticky on the left
  (168px). Row 44px; desktop 52px.
- The chart's lead line and the source line stay above/below in both views; the desktop standfirst changes to
  "Estimated figures over the last 5 years. Select a heading to sort; Fund steps through A–Z, Z–A and most
  popular." in table view. Switching back to Chart replays the grow-in.
- Build note: reuse the existing `ListTable` + `FamousGroup` for this view rather than re-implementing it; the
  switch only chooses which of the two renders.

## 10. Dark mode
Tokens as `tokens.css` dark (`--page #181512`, `--ink #F3ECE3`, `--band #38322B`, `--zero #AEA498`, inverted pill
uses `--inv #F3ECE3` / `--invfg #1B1916`). Bars use the dark ramps in §6.

## 11. Open questions for the owner
1. Do the fund return estimates include dividends? If yes, the S&P 500 figure should be total return.
2. `docs/PRODUCT.md` records the owner's 2026-11-18 rule "every famous list opens with its most popular fund
   first". This design sorts by return. Confirm, then update PRODUCT.md.
3. Lists with extreme returns (some style lists reach −42.7%): the fitted scale handles them, but check the
   phone label room on a narrow plot.
4. The "Search interest" column of Most searched has no place in the chart; drop it or put it in the tooltip.

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
  Table view. Reuse `Seg` for the switches, the shared Tooltip (`useTooltip`), `qOfYear`, `fmt` helpers.
- Pure, testable functions (put them in a `.ts` with vitest tests): `fundShortName`, `managerLine`,
  `aumLabel` (`$X.XB`), `shadeFor(ret, dark)`, `windowDomains(rows, VIS, innerW)` (§7.3 smoothing),
  `domainAt(p, …)` (Catmull-Rom), `ticksFor(domain, isPhone)`, `leadLine(rows, spx)`, `spyReturn(weekly, q0, q1)`.
- The glide (§7.2) as a small hook (`useEasedScroll(ref, onPosition)`) with rAF; it must no-op cleanly in jsdom
  (stub `requestAnimationFrame`, as `web/tests/idle.ts` does for idle callbacks).
- Measure the plot width with `ResizeObserver` where available, falling back to the box's `clientWidth` on
  scroll (jsdom has none).
- Playwright smoke (1280 / 400 px, light / dark): rows render, scrolling the box updates the caption, the zero
  line stays at the left edge on the first window, no horizontal page scroll at 400 px.

## Appendix A: sample data (Most searched, 5y to Q3 2026, as shown in the mock)
Sorted best first. `name | manager | 5y return a year | AUM`. S&P 500 +12.2%.

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
