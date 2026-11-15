# Worklog

Last verified: 2026-11-14

Reverse-chronological. Tags: (chat) = said in a working session, (code) = checked in the code,
(git) = from commit history. "PR #n" = github.com/Cannibara/Orca/pull/n. Append new entries at the top.

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
