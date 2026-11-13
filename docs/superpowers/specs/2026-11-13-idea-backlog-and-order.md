# Idea backlog: ranking and build order

Last verified: 2026-11-13
Status: proposal. The owner has not approved items 2–12. Item 1 is done.
Source: owner's idea list (chat, 2026-11-13). Effort: S = 1 LLM session, M = 2–4, L = 1–2 weeks.
Reads with: `docs/ROADMAP.md` (F1–F5, risks) and `docs/DECISIONS.md`.

## Facts that change the order
- Owner says they now hold a Tiingo commercial licence (chat, 2026-11-13). Tiingo's docs say self-serve plans are internal-use only, so confirm in writing that it allows showing prices and derived returns on a public site and in a paid download. Until then, treat ROADMAP L1 as open.
- `ORCA_SCHEDULE_ENABLED=true` must be set before the 2026-11-16 run (status unknown).

## Ranking
| # | Idea | Effort | User value | Notes |
|---|---|---|---|---|
| 1 | AUM net outflows: orange dashed outline | S | low | Done 2026-11-13. It was already drawn in `web/src/fund/aum.css`; made the dash heavier (1.75px, `4 3`) |
| 2 | SEO, titles/descriptions, logo | S–M | high | Plan: `docs/superpowers/plans/2026-11-13-seo-and-logo.md` |
| 3 | Big winners marked on the AUM chart | S–M | medium | Use top contributing stocks per year (already published). 13F cannot show real investor money into a fund, and "net inflows" here is net buying |
| 4 | Excel workbook formatting | S–M | low until sold | `pipeline/orca/workbook/`, isolated |
| 5 | Fund types: super, sovereign wealth, corporates | M | high | 13F has no type field. SIC code of the filer + name rules + a hand-checked list of the top ~300; new field in `funds.json`; home filters |
| 6 | Sector rotation charts | M | high | Quarterly 13F flows by sector first; price momentum needs the weekly price job (ROADMAP S6) |
| 7 | Sector allocator vs stock picker; funds by sub-sector | L | highest | Brinson-style split (ROADMAP F5). Needs: sector map, one benchmark table, survivorship fix, faster rebuilds. Rank on a shrunk score with error bars (13,000 funds, top of a raw ranking is mostly luck) |
| 8a | Insider buys and sells (Form 4) | M | high | SEC quarterly data sets, free, same SEC client |
| 8b | Congress trades | L | medium | No clean free source (House PDFs, Senate web form). Pick a licensed source first |
| 9 | Other public data | S–M each | medium | 13D/13G (5%+ stakes), N-PORT (fund and ETF holdings), Form D, XBRL fundamentals: all SEC. FRED macro is cheap but low value. Commodities do not fit |
| 10 | VC / PE | M | low | No public holdings or returns. Only Form ADV (adviser size, private fund assets), Form D raises and public stakes after IPO. Cannot show VC/PE returns |
| 11 | Social content (YouTube, Instagram) | S per batch | high for reach | Pipeline renders chart cards each quarter. Say "most bought", never "picks" (ROADMAP L3) |
| 12 | Clone-able ETF / follow via broker | L+ | high | Biggest legal risk. A real ETF needs an issuer; copy-trading may need an AFSL (AU) or adviser registration (US). Get a legal view first. Safe phase 1: a hypothetical model portfolio, tracked from filing dates, labelled. Backtest needs the survivorship fix from 7 |

## Build order
A. Web only: 1, 2, 3.
B. Classification tables (contract first): 5 and the stock sector map.
C. Benchmark table, survivorship fix, parallel compute, then 6, then 7.
D. SEC add-ons: 8a, then 9 (13D/G, N-PORT).
E. 11, automated from published data.
F. 12, after licence confirmation, a legal view and 7.
4, 8b and 10 fit anywhere as single sessions.

## Architecture rule for every item
Compute in the pipeline and publish static JSON (ROADMAP S1). Order of work per feature: contract change in `pipeline/contract.md` → pipeline → `orca/demo.py` data → web panel → tests. One area per session; agents one after another, not in parallel.
