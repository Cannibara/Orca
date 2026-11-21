# Home Famous funds ranked return chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the home page's Famous funds tables with one ranked, fitted-scale return bar chart per list (Most searched + 15 style lists), with the S&P 500 total return as a dotted reference, and keep today's table one switch away.

**Architecture:** The pipeline adds a top-level `spx` object (SPY total return over the period's window) to each `home/top_{period}.json`. The web gets pure helpers (names, labels, colour ramp, fitted-scale maths) with vitest tests, an eased-scroll hook, and a `FamousChart` component that `Home.tsx`'s `FamousFunds` renders beside today's `ListTable` behind a Chart | Table switch.

**Tech Stack:** Python 3.13 / Polars / pytest (pipeline); React 18 + TypeScript + Vite, vitest + jsdom, Playwright (web).

**Spec:** `docs/superpowers/specs/2026-11-20-home-famous-chart-design.md` (read it whole; section numbers below are its §s). Mock-ups: `docs/superpowers/specs/2026-11-20-home-famous-chart-mock/desktop.dc.html` (JS for the scale and glide at lines ~360–480).

## Global Constraints

- One gain colour (blue) and one loss colour (orange); always a printed sign and a real minus `−` (U+2212).
- Every figure labelled as an estimate; missing values show "—" (`DASH`), never NaN.
- Quarters `q = (year−2013)*4 + (quarter−1)`; in TS use `qOfYear`/`qLabel` (`web/src/lib/format.ts`), never `q % 4`.
- Respect `prefers-reduced-motion` and `<html data-motion="reduce">` (`reducedMotion()` in `web/src/fund/hooks.ts`).
- jsdom has no IntersectionObserver/ResizeObserver/real rAF timing: hooks must degrade.
- No new npm or Python dependencies.
- Published JSON follows `pipeline/contract.md` exactly; change the contract first.
- Commits: `area: what changed` + a body saying why; end with the session's attribution lines.
- Fund-page/home CSS is scoped under `.fp`; tokens live in `web/src/tokens.css`.

## Review Focus

- A list whose rows are all losses, or where the S&P is above every fund: `hi = max(0, S&P, rets)` keeps zero and the S&P line in view; no NaN geometry (test in Task 2 `rawDomain`).
- Extreme returns (Max period: −66% to +128%; style lists to −42.7%): tick candidates must span the whole domain, not ±50 (test in Task 2 `ticksFor`); phone label room checked in Task 4.
- An old file with no `spx` key (production until the post-merge run): no S&P line, no axis label, no "beat" clause, no "vs S&P" tooltip row (test in Task 3).
- Changing period while a style list that has no fund for the new period is selected: falls back to Most searched (test in Task 3).
- A fund with neither a photo nor a manager: initials of its short name on `--sunken` (test in Task 3).

---

### Task 1: Pipeline — publish `spx` in the home top files

**Files:**
- Modify: `pipeline/contract.md` (Home → `top_{period}.json`)
- Modify: `pipeline/orca/home.py` (new function), `pipeline/orca/publish.py` (`HomeLists`, `publish_shared`), `pipeline/orca/run/publish_step.py` (`publish_shared_files`)
- Test: `pipeline/tests/test_home.py`, `pipeline/tests/test_publish.py`
- Regenerate: `web/public/demo-data/` (and any golden files the pipeline tests compare)
- Modify: `web/src/data/types.ts` (+ `web/tests/contract-types.test.ts` if it pins keys)

**Interfaces:**
- Produces (Python): `spx_window(spy_px: Mapping[int, QuarterPx], latest_q: int, period: str) -> dict | None` in `orca/home.py`. `None` for `"max"`; otherwise `{"ann_return": float | None, "from_q": latest_q - n, "to_q": latest_q}` with `n = config.PERIODS[period]`.
- Produces (Python): `HomeLists.spx: Mapping[str, dict | None]` (default empty → `null` in the file).
- Produces (TS): `export type SpxWindow = { ann_return: number | null; from_q: number; to_q: number };` and `TopList.spx?: SpxWindow | null`.

- [ ] Step 1: Contract first: add `"spx"` to the `top_{period}.json` description (§3.5 wording: SPY total return, dividends reinvested, annualised over the same window as the fund figures; `from_q` = the base close's quarter; `null` for `max`; `ann_return: null` when SPY lacks a close or quarter in the window; files built before 2026-11-21 have no `spx`).
- [ ] Step 2: Failing tests in `test_home.py`: a hand-built SPY `QuarterPx` series → `spx_window(px, 54, "5y")` equals `growth ** (4/20) − 1` of `r_q = (close_q + div_ps_q)/close_{q−1} − 1` for q = 35…54, with `from_q == 34`, `to_q == 54`; a hand-checked 1y case with numbers worked out in the test's comment (e.g. closes 100→110 with 1.0 dividends each quarter); `"max"` → `None`; a missing close at q=40 → `ann_return is None` with `from_q`/`to_q` still set. In `test_publish.py`: every `home/top_{p}.json` has `spx` equal to `home.spx.get(p)` (and `null` when `HomeLists` is built without it).
- [ ] Step 3: Run `cd pipeline && uv run pytest tests/test_home.py tests/test_publish.py -m "not network"` → the new tests FAIL.
- [ ] Step 4: Implement `spx_window`, the `HomeLists.spx` field (`field(default_factory=dict)`), `"spx": home.spx.get(period)` in `publish_shared`. In `publish_shared_files`: `if ctx.spy_id is not None: ctx.load([ctx.spy_id])`; `spy_px = ctx.px.get(ctx.spy_id, {})`; `spx={p: spx_window(spy_px, last_q, p) for p in PERIODS}` (all `None`/null-return when there is no SPY). Do not look SPY up by ticker.
- [ ] Step 5: `cd pipeline && uv run pytest -m "not network"` → all PASS (update goldens only where `spx` is the sole diff).
- [ ] Step 6: `uv run python -m orca.run demo --plain --out ../web/public/demo-data`; check `web/public/demo-data/home/top_5y.json` has a plausible `spx.ann_return` and `top_max.json` has `"spx": null`.
- [ ] Step 7: `web/src/data/types.ts` types; `cd web && npm run typecheck && npm test` PASS.
- [ ] Step 8: Commit (`pipeline: S&P 500 total return over each home period (spx)`).

### Task 2: Web pure helpers

**Files:**
- Create: `web/src/lib/famousNames.ts`, `web/src/home/famousChart.ts`
- Modify: `web/src/lib/format.ts` (add `fundShortName`)
- Test: `web/tests/famous-names.test.ts`, `web/tests/famous-chart.test.ts`

**Interfaces (Produces — exact names Task 3 imports):**
- `format.ts`: `fundShortName(name: string): string` — §3.3 rules 1–5 (no fund-id exceptions).
- `famousNames.ts`:
  - `SHORT_NAME: Record<number, string>` keyed by `fund_id` (§3.3.6 cases; find the ids in production `home/top_max.json` + `top_5y.json` `famous` rows: `curl -s --compressed https://data.orcaetf.com/home/top_max.json`; every filer whose raw name matches a case gets the entry).
  - `MANAGER_LINE: Record<string, string | null>` — Appendix B verbatim (`null` = no line).
  - `PHONE_SHORT: Record<string, string>` keyed by the desktop short name (§3.3.7: Duquesne Family Office → Duquesne, Pershing Square Capital → Pershing Square, Renaissance Technologies → Renaissance).
  - `shortNameOf(fundId: number, name: string): string` = `SHORT_NAME[fundId] ?? fundShortName(name)`.
  - `phoneNameOf(short: string): string` = `PHONE_SHORT[short] ?? short`.
  - `managerLine(manager: string | null | undefined, short: string): string | null` — §3.4: map hit → its value; plain person's name (2–3 capitalised words, no brackets/slashes/digits) → as is; equal to `short` → null; else null.
- `famousChart.ts` (domains are in percentage points; returns are fractions):
  - `aumLabel(book: number | null | undefined): string` — `$X.XB`, one decimal in billions (`304.2e9 → "$304.2B"`, `0.3e9 → "$0.3B"`); missing → `DASH`.
  - `retLabel(r: number | null): string` = `pct(r, 1)`; `vsLabel(r: number, spx: number): string` = `pp((r − spx) * 100)`.
  - `shadeFor(ret: number, dark: boolean): string` — §6 ramps, `f = min(|ret|/0.30, 1)`, `t = 0.15 + 0.85·f`, linear RGB mix 0→0.5→1, lowercase `#rrggbb`.
  - `type Dom = { lo: number; hi: number }`; `type Track = { raw: Dom[]; smooth: Dom[] }`.
  - `rawDomain(rets: number[], spx: number | null, innerW: number, room: number): Dom` — §7.3: `lo = min(0, …)`, `hi = max(0, spx?, …)`, min span 20 (raise `hi`), then if `lo < 0`: `lo −= room·(hi − lo)/max(200, innerW − room)`.
  - `windowDomains(rets: number[], vis: number, spx: number | null, innerW: number, room: number): Track` — `rets` sorted best first; `K = max(1, n − vis + 1)` windows; smooth = triangular weights 1..4..1 over ±3, clamped to never narrower than `raw[k]`.
  - `domainAt(track: Track, p: number): Dom` — Catmull-Rom on `smooth` at fractional `p` (clamped to `[0, K−1]`), then `min(lo, lerp(raw lo))` / `max(hi, lerp(raw hi))` (mock `domAt`).
  - `ticksFor(dom: Dom, phone: boolean): number[]` — §6 tick choice; always includes 0; ascending; candidates span the whole domain.
  - `periodPhrase(period: string): string` — "over the last year" (1y), "over the last 3 years" … "over the last 15 years", "since each fund's first filing" (max).
  - `standfirst(period: string, spx: number | null, view: "chart" | "table"): string` — §4.2 / §9.
  - `leadLine(rows: { name: string; ret: number }[], spx: number | null): string` — rows best first; `"Duquesne leads with +30.3% a year. 36 of the 50 beat the S&P 500; 14 lost money."`, `"; none lost money."`; with `spx` null: `"… a year. 14 of the 50 lost money."` / `"None of the 50 lost money."`.
  - `sourceLine(spx: { ann_return: number | null; from_q: number; to_q: number } | null | undefined): string` — `"Source: SEC 13F filings; Orca estimates. S&P 500: SPY total return, Q3 2021 to Q3 2026."` (via `qLabel`), S&P sentence dropped when `spx` or its `ann_return` is null.
  - `captionText(first: number, last: number, n: number, scrolls: boolean): string` — `"Showing 1–15 of 50 · scale fits the funds in view"` (en dash); when `!scrolls`: `"Showing all 12 funds"` (`"Showing 1 fund"` for one).
  - `initials(s: string): string` — first letters of the first two words of letters, upper-case (`"Battery Ventures" → "BV"`).
  - `rowLabel(o: { i: number; n: number; name: string; manager: string | null; book: number; ret: number; spx: number | null }): string` — §5 aria-label: `"3 of 50. Bridgewater, Ray Dalio, AUM $22.1B: gain of 12.0% a year (estimate), behind the S&P 500"`; `"loss of"` for a negative; `"ahead of"` when `ret > spx`; the S&P clause dropped when `spx` null; row 1 adds `", best in this list"`.

- [ ] Step 1: Failing tests. Names: every §3.3.6 and §3.3.7 case; Appendix B spot checks (`"8VC (Joe Lonsdale)" → "Joe Lonsdale"`, `"Sequoia Fund" → "Bill Ruane"`, `"Google" → null`); rules (`"GREENLIGHT CAPITAL INC" → "Greenlight Capital"`, `"AQR CAPITAL MANAGEMENT LLC" → "AQR Capital"`, `"TCI FUND MANAGEMENT LTD"` handled, never empty). Chart: `aumLabel(304.2e9) === "$304.2B"`, `aumLabel(0.3e9) === "$0.3B"`; `shadeFor` endpoints (`shadeFor(0.30,false) === "#0b4a72"`, `shadeFor(0,false)` = mix at 0.15, a loss uses the loss ramp, dark flips); `rawDomain([0.06],0.12,864,50)` → `{lo:0, hi:20}`; all-loss + S&P above all; `windowDomains` of 50 Appendix-A-like returns: window 0 `lo === 0`, last window `lo < 0`; `domainAt` continuous (|Δ| small between p and p+0.01) and always covers the rows in view; `ticksFor({lo:0,hi:30},false)` → `[0,10,20]` (span 30 → step 10, 30 excluded by the 0.5 margin), phone `{lo:0,hi:30}` → `[0,20]`, `{lo:-66,hi:128}` includes −60 and +120 (step 20); `leadLine`, `sourceLine`, `standfirst`, `captionText`, `rowLabel` exact strings above.
- [ ] Step 2: `cd web && npx vitest run tests/famous-names.test.ts tests/famous-chart.test.ts` → FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Same command → PASS; `npm run typecheck` PASS.
- [ ] Step 5: Commit (`web: Famous chart helpers — short names, manager line, fitted scale`).

### Task 3: The chart, the switches and the table view

**Files:**
- Create: `web/src/home/FamousChart.tsx`, `web/src/home/famousChart.css`, `web/src/home/useEasedScroll.ts`, `web/tests/fixtures/famous-top5y.json`, `web/tests/home-famous-chart.test.tsx`
- Modify: `web/src/components/Choice.tsx` (optional `icon` per option → `Seg`), `web/src/pages/Home.tsx` (`FamousFunds`, state in `Home`), `web/src/pages/home.css`, `web/src/tokens.css` (`--zero`), `web/tests/home.test.tsx` (famous tests: default view is now the chart, one list at a time)

**Interfaces:**
- Consumes: everything Task 2 produces; `TopList.spx` from Task 1.
- Produces: `FamousChart({ name, rows, spx, period, run }: { name: string; rows: TopRow[]; spx: number | null; period: string; run: number })`; `useEasedScroll(box: RefObject<HTMLElement>, rowH: number, onPos: (p: number) => void): { glide(toTop: number): void; stop(): void }`.

- [ ] Step 1: Fixture: production `home/top_5y.json` trimmed to top-level fields + `famous`, plus `"spx": {"ann_return": 0.135, "from_q": 34, "to_q": 54}`.
- [ ] Step 2: Failing tests (fixture via the loader mock the home tests use): Most searched shows 50 chart rows best first; first window's zero line at `left: 0%`; a loss row's label sits left of its bar; caption text after scrolling the box (`scrollTop` + `scroll` event) changes; no S&P line/label when `spx` missing; list switch shows a style list's every fund ("of 87"-style count); a period change with a missing list falls back to Most searched; Chart | Table round-trips to today's table (Most searched in popularity order, `f.name` links); initials when no photo and no manager.
- [ ] Step 3: Implement static chart (§4, §5, §6), then the 15/10-row window + fitted scale (§7.1, §7.3), then `useEasedScroll` (§7.2), then grow-in (§8); the switches (§3.1, §4.3, §9) in `Home.tsx` with list/view state lifted to `Home`.
- [ ] Step 4: `cd web && npm test && npm run typecheck` PASS.
- [ ] Step 5: Commit (`home: Famous funds as one ranked return chart per list`).

### Task 4: Phone, dark, motion, e2e and docs

**Files:**
- Modify: `web/e2e/smoke.spec.ts`, `web/src/lib/famousNames.ts` (`PHONE_SHORT` additions), `docs/PRODUCT.md`, `docs/WORKLOG.md`, the spec's status line, `CLAUDE.md` row if stale

- [ ] Step 1: Playwright: demo data (no scroll box); fixture via `page.route("**/home/top_5y.json")` (period set to 5y): rows render, scrolling updates the caption, zero at the left edge on the first window, no horizontal page scroll at 400px; 1280/400 × light/dark.
- [ ] Step 2: One 400px pass over every list on production data; add names that ellipsise to `PHONE_SHORT`.
- [ ] Step 3: `cd web && PW_CHROMIUM=/opt/pw-browsers/chromium npx playwright test --trace off` PASS; `npm run build` PASS.
- [ ] Step 4: Docs; commit (`docs: Famous funds chart — product, worklog, spec status`).
- [ ] Step 5: Whole-branch review (superpowers:requesting-code-review), fix, push.
