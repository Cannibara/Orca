# Fund page tabs and holdings tree map: build spec

Last verified: 2026-11-19. Status: approved by the owner on 2026-11-19 (chat), from the interactive draft at
https://claude.ai/artifact/3J9eYBogzVdLTv6ipm5VGx (version 4). The draft's source is the reference for behaviour
and look: `scratchpad/ui/build/index.src.html` of the session that built it. A copy is committed at
`docs/superpowers/specs/2026-11-19-fund-tabs-draft.html`; it is reference only and is never served.

## What changes

1. The fund page becomes three tabs under the fund header: **Holdings** (the default, with the holdings-now count badge),
   **Analysis**, **About**. They replace the header's Overview / Positions tabs and use the same tab-strip style
   (`.tabs/.tab/.ind`, WAI-ARIA tabs, arrows/Home/End). The URL hash picks the tab: `#holdings`, `#analysis`, `#about`;
   no hash = Holdings. Only the selected tab's panels are mounted or shown.
2. **Holdings** holds exactly two panels: the new Holdings panel (period picker + tree map + legend + caption), then the
   Positions panel (unchanged table; its picker moved up into the Holdings panel; one picker drives both).
3. **Analysis**: KPI strip, Annual returns, Return constituents, What if they'd kept it, in that order, unchanged.
4. **About**: a new About panel (SEC facts only), then the Assets under management panel, unchanged.
5. The source note (`.fp-foot`) stays at the foot of every tab.
6. Existing charts, tables and panels keep their design and behaviour. Only two things change in them: their tab, and
   the money format (item 8).
7. **Period picker** (`fund/PeriodPicker.tsx`): modes are **Quarter | Year**; Custom is removed from this picker
   (`PeriodStrip` stays for Return constituents).
   - Quarter mode is unchanged.
   - Year mode adds a Q1/Q2/Q3/Q4 control in the same seg style, shown only in Year mode. It defaults to the newest
     quarter's Q.
   - In Year mode the pills are the quarter-ends with that Q, labelled like "Q3 ’26". Arrows, wheel, select list and
     jiggle step four quarters at a time. Changing Q keeps the calendar year, clamped to the range.
   - A Year period is the 12 months ending at that quarter: qs = qe − 3. The as-of line reads "12 months to 30 Sep
     2026"; the newest quarter keeps "… as of {latest prices date}".
   - Switching Quarter → Year starts on the same calendar year; Year → Quarter starts on the Year pill's quarter.
   - Port two fixes from the draft's review:
     - Pills and the active pill's select get an inset focus ring, because the window clips outside rings.
     - The mouse wheel steps periods only from rest: within 300 ms of a page scroll it lets the page keep scrolling.
8. **Money format**: every money figure in a table or panel uses the site's `money()` (lib/format): "$80.2B",
   "+$116.1B", "−$3.13B", "$0". This replaces `fMm` ("$80,207m") in the Positions table, the What-if table, the
   Position page's trade values and anywhere else it is used. Per-share prices (`fPx`, "$39") are unchanged.

## Holdings tree map (new: `fund/HoldingsPanel.tsx`, `fund/treemap.ts`, `fund/holdings.css`)

- **Data**: the positions held at the end of the selected period's end quarter qe.
  - value = shares × price(qe). price(qe) is the latest price for the newest quarter (today's prices, as the
    Positions table already does) and the quarter-end close for older quarters (see the Contract section).
  - The values come from the same model as the table (`positions.ts` `priceAt`/`asOf`), so the tiles, the table and
    the header agree: an older quarter sums to `summary.quarters.end` and the newest to the table's value at today's
    prices.
  - Holdings under 1% of the total go into one "Other stocks" tile ("N stocks · x.x%"). A single small holding is shown
    as itself.
- **Layout**: squarified tree map, sorted by value with Other stocks last, 2px gaps, rounded 2px. Height is 440px, or
  340px when the panel is under 600px wide. It re-lays out on resize. Write the squarify in `treemap.ts` as pure,
  unit-tested code: no new npm dependency.
- **Colour** = the fund's own return on that holding over the period. This is the app's usual measure:
  - shares held at the period start are valued at the start quarter-end close, price(qs − 1);
  - buys and sells in the quarters qs..qe count at the trade `px` (the quarter's VWAP);
  - dividends are those received in the period (`dividendsAsOf(qe) − dividendsAsOf(qs − 1)`);
  - the holding at the end is valued at price(qe).
  - ret = (end + sales + dividends − start − buys) ÷ (start + buys). It is null when the denominator ≤ 0 or a needed
    price is missing.
  - Diverging scale, clamped at ±25% (Quarter) or ±50% (Year), interpolated in Lab: red ← grey → green.
  - New tokens in `tokens.css`, defined for both themes:
    - `--tm-gain: #00A47C`
    - `--tm-loss: #F7172E`
    - `--tm-mid`: #AFB4BA in light, #4A4F57 in dark
  - Null → a hollow tile: the panel colour inside a dashed `--control` outline, labelled "No price data" in the legend.
  - Other stocks → hatched `--band`/`--line2`.
  - The tree map only uses green/red. The site keeps blue/orange everywhere else, and there is no palette toggle in
    the build.
- **Labels**: ticker (mono, 600 13px); weight %; on tiles ≥ 96×54 also " · $80.2B" and the tidied name (ellipsised).
  - Show a label only if it fits.
  - Label ink is the text token with more contrast, falling back to pure black/white so every label is ≥ 4.5:1.
- **Tooltip**: use the shared `#tip` (charts/Tooltip). Rows:
  - ticker · name
  - Value
  - Weight
  - "Fund's return, quarter" or "Fund's return, 12 months"
  - "Share price, quarter" or "Share price, 12 months", for reference
  - Held since
  Other stocks lists its first 8 tickers.
- **Legend**: "Colour: the fund's return on each holding, Q2 ’26 → Q3 ’26". The end is "17 Nov 2026" (the latest
  prices date) for the newest quarter, and the start is a year back in Year mode. It also has the gradient with
  −25%/0%/+25% (or ±50%) ticks, and the No price data and Other stocks keys.
- **Caption**: "$312.8B at prices of 17 Nov 2026 across 30 holdings · 16 under 1% grouped as Other stocks"; older
  quarters say "at quarter-end prices".
- **Animation** on a period change (600 ms, `--ease-out`):
  - persisting tiles tween rect and colour;
  - new tiles grow from their centre and fade in;
  - leaving tiles shrink to their centre and fade out;
  - labels that fit throughout the move ride along, the others fade out and back in.
  Rapid stepping interrupts and continues from the current state. `prefers-reduced-motion` → no tween.
- **Loading**: older quarters need weekly files (the existing `usePositionData` store and prefetch). Until a tile's
  prices are in, draw it as the previous layout or a neutral placeholder, then tween in. Never show NaN.
- **A11y**: the tree map is one Tab stop. Arrow keys and Home/End move between tiles, each tile has an aria-label,
  and focus shows a visible ring with an inner light line.
- **Mobile**: full width; no horizontal page scroll at 400px.

## About panel (new: `fund/AboutPanel.tsx`)

- From `summary.about`; the panel says "No SEC details yet" when it is null.
- One description sentence built from the facts, e.g. "Berkshire Hathaway Inc is an institutional investment manager
  based in Omaha, Nebraska. The SEC classes it under Fire, Marine & Casualty Insurance, and its shares trade on the
  NYSE as BRK-A and BRK-B. Its latest 13F, for the quarter to 30 Sep 2026, reports $304.2B across 30 holdings."
  Leave out each clause whose fact is missing.
- Label/value rows, each shown only when present:
  - Headquarters (city, state, street)
  - 13F signed by (name, title, date)
  - Other managers in the report: the first 4, then "Show all N"
  - Incorporated in
  - Former names
  - SEC CIK, linking to EDGAR's 13F-HR list for the CIK (new tab)
- A muted caption: "From SEC EDGAR: the filer's record and its latest 13F cover page."

## Contract changes (`pipeline/contract.md` first, then writer and reader)

1. `stock/{stock_id}/weekly.json` gains `"q0": int | null, "qclose": [number | null]`.
   - `qclose[i]` is the stock's close for quarter `q0 + i`: the quarter's last close, else the last close before it.
     This is the price the engine values the book with, on the same share basis as `close`.
   - It runs from the stock's first quarter with a priced day to its last.
   - `q0` is null and `qclose` is [] when the stock has no prices.
   - Readers fall back to the weekly closes when the fields are absent (older files).
2. `fund/{id}/summary.json` gains `"about"`, null when nothing is known:
   `{"name", "street", "city", "state", "signer", "signer_title", "signed": "YYYY-MM-DD", "other_managers": [names],
   "incorporated", "former_names": [{"name", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}], "sic", "tickers": [],
   "exchanges": []}`.
   - Every field is nullable or [] when unknown.
   - `state` is the SEC two-letter code. The reader prints US states in full ("NE" → "Nebraska").

## Pipeline

- `publish.weekly_closes` adds `q0`/`qclose`, using the engine's quarter-close rule. Test that Σ shares × qclose over a
  fund's holdings at q equals `summary.quarters.end` at q: the demo fund and a hand case with a quarter ending
  mid-week.
- SEC facts: a new lake table `fund_about`, one row per CIK.
  - It is filled by an incremental, budgeted step in the monthly run, like `shares_hist`: missing or out-of-date first,
    a per-run call cap, and a failure flags but never stops the run.
  - Per fund it makes two SEC calls:
    1. `data.sec.gov/submissions/CIK##########.json` for the business address, `stateOfIncorporation`, `formerNames`,
       `sicDescription`, `tickers`, `exchanges` and the latest 13F-HR accession.
    2. That filing's `primary_doc.xml` for the signature block (name, title, date) and the other included managers.
  - A row is out of date when the fund's latest filed accession differs from the stored one.
  - Use the pipeline's existing SEC client: its User-Agent, rate limit and retries.
- The publisher writes `about` into each fund's summary.json. `orca.run demo` gives demo funds plausible about blocks
  (and qclose), and `web/public/demo-data` is regenerated.

## Not in scope

- Executive lists beyond the 13F signer, and descriptions from outside SEC data.
- A palette toggle.
- Sector colouring of the tree map.
- A "Now" period: the newest quarter already uses today's prices.
