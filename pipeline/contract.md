# Published JSON contract

The single source of truth for every file the pipeline publishes. The writer produces exactly this and the
website builds its TypeScript types from it. Change this file first, then the writer.

## Conventions

- All keys are snake_case. Money is in dollars. Shares and prices are plain numbers.
- `null` means missing (unknown, not applicable, or not computable). NaN and infinity are never published.
- Arrays are column-oriented: `{"col": [...]}`, and all columns of one block have the same length, row `i`
  being the `i`-th entry of each. The home lists are the exception: small row-oriented lists (see Home).
- Quarters are integers: `q = (year − 2013) × 4 + (quarter − 1)`, so Q1 2013 is 0 and Q2 2026 is 53. Quarters
  before 2013 are negative: the history starts at Q1 1999 (−56), from the SEC's pre-2013 text filings. A
  reader must use floor division and a non-negative remainder (`((q % 4) + 4) % 4` in JavaScript).
- Dates are ISO `YYYY-MM-DD` strings. Returns and percentages are fractions (`0.12` is 12%), except
  `points` (percentage points of the fund's book) and `change_pts` / `headline_change_pts` (percentage points).
- Funds are identified by `fund_id`, stocks by `stock_id`. No CUSIP appears in any file.
- Every figure is an estimate built from 13F filings, not a fund's real return.
- Every file is minified JSON with sorted keys, brotli compressed, stored under the plain path listed here (no
  `.br` suffix) and served with `Content-Encoding: br` and `Content-Type: application/json`.
- Paths are stable: a new run overwrites the same paths. `manifest.json` is uploaded last; a reader that
  fetches it sees every file it lists already in place.
- Prices (`px`, `low`, `high`, `latest_prices.json`, `weekly.json`) are rounded to 4 decimal places. Dollar
  amounts, share counts and averages are not rounded.
- Rows are ordered by `stock_id` (positions, holdings, exits, securities) or by time (years, quarters), unless
  stated otherwise, so the same input gives the same bytes.

## Files

- `funds.json`: `{"v": 1, "id": [], "name": [], "book": [], "n": []}`
- `securities.json`: `{"stock_id": [], "ticker": [], "name": [], "sector": []}`
- `latest_prices.json`: `{"asof": "YYYY-MM-DD", "stock_id": [], "price": [], "date": []}`
- `fund/{id}/summary.json`: `{"id", "name", "cik", "period_q", "filed", "book", "n_holdings", "priced_pct", "tracked_since_q", "inactive", "metrics": {"ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "best_year": {"label", "ret"}, "worst_year": {"label", "ret"}, "years_pos", "years_total", "quarters_pos_pct", "turnover", "hold_all", "hold_sold", "first_year", "last_year"}, "years": {"label": [], "ret": [], "start": [], "end": [], "gains": [], "inflows": [], "dividends": [], "approx_ret": []}, "quarters": {"q": [], "ret": [], "start": [], "end": [], "market_move": [], "net_buying": [], "trade_gains": [], "dividends": []}, "holdings_now": {"stock_id": [], "shares": [], "cost": []}, "about": {"name", "street", "city", "state", "signer", "signer_title", "signed", "other_managers": [], "incorporated", "former_names": [{"name", "from", "to"}], "sic", "tickers": [], "exchanges": []} | null}`
- `fund/{id}/positions.json`: `{"stock_id": [], "from_q": [], "to_q": [], "avg_cost": [], "avg_exit": [], "invested": [], "realised": [], "dividends": [], "shares_now": [], "cost_now": [], "last_q": [], "last_type": [], "last_pct": [], "last_usd": [], "trades": [[[q, delta, px, low, high, shares_after], ...], ...]}`
- `fund/{id}/contrib.json`: `{"years": [label...], "by_year": {label: {"stock_id": [], "points": [], "pnl": []}}}`
- `fund/{id}/exits.json`: `{"rows": {"stock_id": [], "status": [], "sold_shares": [], "sold_usd": [], "avg_exit": [], "last_sale_q": [], "one_y": [], "spy_one_y": []}, "summary": {"buys_12m": number|null, "sells_12m": number|null, "beat_spy_pct": number|null}}`
- `stock/{stock_id}/weekly.json`: `{"start": "YYYY-MM-DD", "close": [], "q0": int | null, "qclose": []}` (weekly Friday closes and quarter-end closes, split-adjusted; `close` and `qclose` are `(number | null)[]`)
- `home/top_{1y|3y|5y|10y|15y|max}.json`, `home/conviction_q.json`, `home/conviction_y.json`, `home/wins_losses.json`, `home/just_filed.json`, `home/crowded.json`, `home/calls_q.json`, `home/calls_y.json`: row lists described under Home.
- `sectors/labels.json`: `{"last_q", "label": [], "tier": [], "parent": [], "name": [], "n": [], "top_weight": []}`
- `sectors/scores.json`: `{"last_q", "fund_id": [], "tier": [], "picking": [], "allocation": [], "n": [], "coverage": [], "span_q": []}`
- `fund/{id}/skill.json`: `{"last_q", "first_q", "quarters": {"q": [], "bought": [], "fund": [], "mkt": [], "spy": [], "v_fund": [], "v_mkt": [], "v_spy": []}, "years": {"name": [], "fund": [], "mkt": [], "spy": []}, "tiers": {"1": TIER, "2": TIER, "3": TIER}, "mix": {"q": [], "label": [], "share": [[...], ...]}}`, where TIER is `{"irr_fund", "irr_label", "irr_mkt", "irr_spy", "picking", "allocation", "coverage", "n", "quarters": {"label": [], "v_label": [], "v_never": [] | null}, "years": {"label": []}, "picks": {"stock_id": [], "label": [], "bought": [], "irr_own": [], "irr_label": []}, "bets": {"label": [], "bought": [], "irr": [], "irr_mkt": [], "mkt_share": []}}`
- `manifest.json` at the bucket root: `{"version": "...", "built": "...", "files": {path: sha256}}`; `health.json`: `{"filings_parsed", "unmapped_cusips", "coverage_median", "funds_recomputed", "flags": [...]}`.

## Field notes

### `funds.json`, `securities.json`, `latest_prices.json`

- `funds.json`: the search index, one entry per fund, ordered by `id`. `n` is the number of holdings now.
  `v` is the format version.
- `securities.json`: one entry per stock, ordered by `stock_id`. `sector` is a string.
- `latest_prices.json`: each stock's latest stored close, ordered by `stock_id`. `price` is the close and `date`
  (ISO) the day of it; both are `null` for a stock without one. `asof` is the latest `date` of all. Every month the
  pipeline refreshes the stocks held in the latest quarter and those sold out within the last 6 quarters (the
  benchmark too); a stock sold out longer ago, or delisted, keeps its last close, and its `date` says how old
  that is. Show a price as current only when its `date` is recent.

### `fund/{id}/summary.json`

- `id` is the fund id (also the `{id}` of the path). `cik` is the SEC CIK (integer). `period_q` is the latest
  quarter the fund filed and `filed` the date of that filing. `book` is the priced long book in dollars,
  `n_holdings` the number of positions held now (the length of `holdings_now`), `priced_pct` the share of the reported book that is priced
  (0 to 1). `tracked_since_q` is the first quarter of the fund's current tracking segment. `inactive` is true
  when the fund filed nothing in the latest two quarters.
- `metrics`: annualised figures from the quarterly returns. `ann_return`, `sharpe`,
  `sortino`, `vol`, `max_dd` (≤ 0), `calmar` and `quarters_pos_pct` are `null` below four quarterly returns
  (and Sharpe, Sortino, Calmar where their denominator is zero). `turnover` is the mean over full years of
  min(buys, sells) ÷ mean book over the same full years (below), `null` without one. `hold_all` / `hold_sold` are mean holding periods in years
  over all positions / over positions sold out (`hold_sold` is `null` when none was).
- `metrics` year figures count **full years** only: a calendar year of four quarters, each with a return. The
  year that holds the segment's first quarter has no return for that quarter and is not a full year. `best_year`
  and `worst_year` are `{"label": "2016", "ret": 0.3}` (ties go to the earlier year), `years_pos` is the number
  of full years with a gain out of `years_total`, `first_year` / `last_year` are the first and last full year as
  integers. All six are `null` when there is no full year.
- `years`: one entry per calendar year the fund was tracked, oldest first. `label` is `"2025"` for a full year
  and otherwise names the quarters covered (`"2026 Q1"`, `"2026 H1"`, `"2014 H2"`, `"2026 9M"`,
  `"2014 Q2–Q4"`). `ret` chains the quarterly returns (`null` when none); `start` / `end` are the book at the
  start of the first and the end of the last quarter; `gains` = market move + trade gains; `inflows` = net
  buying; `approx_ret` = (gains + dividends) ÷ (start + inflows ÷ 2), `null` when that denominator is not
  positive.
- `quarters`: one entry per tracked quarter, oldest first. `ret` is `null` for the first quarter and wherever the
  quarter's start value or denominator is not positive. `start` / `end` are the book in dollars. The bridge:
  `end = start + market_move + net_buying + trade_gains`. `net_buying` = buys − sells.
- `holdings_now`: positions with shares now, ordered by `stock_id`; `shares` and `cost` (cost basis, dollars).
- `about`: what SEC EDGAR says about the filer, for the About tab; `null` when nothing is known (not looked
  up yet, or the SEC does not know the CIK). It comes from the filer's record (`data.sec.gov/submissions`) and the
  cover page of its latest 13F-HR or 13F-HR/A. Every string field is `null` and every list `[]` when unknown;
  names are as the SEC gives them (often in capitals), with HTML entities decoded.
  - `name`: the filer's name on its record. `street` (first line), `city` and `state` are its business address:
    street and city in title case (the SEC stores capitals), `state` the SEC's two-letter code, a US state or
    territory ("NE") or the SEC's code for another country ("X0" is the United Kingdom). `incorporated` is the
    SEC's code of the state (or country) of incorporation.
  - `signer`, `signer_title` and `signed` (ISO date) are the cover page's signature block; `other_managers` the
    names of the other managers included in the report (its summary page), in filing order.
  - `former_names`: the filer's earlier names, oldest first, each with the ISO dates it was used `from` and
    `to` (`null` when the SEC gives none).
  - `sic`: the SEC's description of the filer's industry code. `tickers` and `exchanges`: the filer's own listed
    shares, `exchanges[i]` being where `tickers[i]` trades (an exchange may be `null`); empty for most managers.
  - Files built before 2026-11-19 have no `about` key.

### `fund/{id}/positions.json`

One entry per stock the fund ever held in its current tracking segment, ordered by `stock_id`.

- `from_q`: first quarter held. `to_q`: the quarter of the final exit, `null` while still held.
- `avg_cost` = invested ÷ shares bought. `avg_exit` = dollars sold ÷ shares sold, `null` if never sold.
- `invested`: dollars bought. `realised`: realised P&L. `dividends`: dividends received. `shares_now` /
  `cost_now`: the holding and its cost basis now (0 once sold out).
- `last_q`, `last_type`, `last_pct`, `last_usd` describe the position's last trade. `last_type` is one of
  `"new"`, `"add"`, `"trim"`, `"exit"`. `last_pct` is the change in shares ÷ shares held before the trade
  (negative for a trim), `null` for `"new"` and `"exit"`. `last_usd` is the trade's dollars, signed (buys
  positive, sales negative).
- `trades[i]` lists the `i`-th position's trades oldest first, each row `[q, delta, px, low, high,
  shares_after]`: the quarter, the signed change in shares, `px`, the quarter's low and high price (`null` when
  the stock has none in the quarter) and the shares held after. `px` is the estimated trade price: the
  quarter's volume-weighted average price, the quarter's close for a position's first report, or, when the
  stock has no prices in the quarter, the last close before it or the price implied by the fund's reported
  value.

### `fund/{id}/contrib.json`

- `years` are the labels of `summary.years`, in order; `by_year[label]` has one entry per position held in that
  year, largest `points` first (ties by `stock_id`). `pnl` is dollars (market move + trade gains + dividends),
  `points` is `pnl` ÷ (year start + inflows ÷ 2) × 100. A year without a positive denominator has empty columns.

### `fund/{id}/exits.json`

- `rows`: one entry per position with at least one sale, ordered by `stock_id`. `status` is `"trimmed"` or
  `"sold_all"`. `sold_shares`, `sold_usd`, `avg_exit` cover all its sales. `last_sale_q` is the quarter of the
  last sale. `one_y` is the stock's return from the last sale's price to its close four quarters later and
  `spy_one_y` SPY's return over the same span; each is `null` without that later close.
- `summary`: `buys_12m` / `sells_12m` are the mean one-year-after returns of the fund's buys (new, add) and
  sales (trim, exit), `beat_spy_pct` the share of rows with both returns whose `one_y` beats `spy_one_y`;
  each `null` when there is nothing to average.

### `stock/{stock_id}/weekly.json`

- `start` is the Friday (ISO date) of the stock's first week with a priced day. `close` has one entry per
  calendar week from that week through the stock's last week with a priced day: `close[i]` is the last close of
  the week (Monday to Friday) ending on `start + 7 i` days, on today's share basis (split-adjusted, not
  dividend-adjusted). It is `null` for a week in between with no priced day (a trading halt or a data gap); the
  previous close is not carried forward. A day without a close is not priced. A stock without a single priced
  day has no file; a published file is deleted when its stock loses every priced day.
- `q0` and `qclose` are the quarter-end closes: `qclose[i]` is the close of quarter `q0 + i`, the close of the
  quarter's last priced day, else (a quarter without one) the last close before it. This is the price the engine
  values a fund's book with at a quarter end, on the same share basis as `close` and as the shares of
  `positions.json` `trades`, so shares × `qclose` summed over a fund's holdings at quarter `q` is that quarter's
  `summary.quarters.end` (to the rounding of the prices). Only a stock without any close up to the quarter (before
  `q0`) is valued otherwise: at the fund's reported value per share, which no file publishes.
  - `qclose` runs from the stock's first quarter with a priced day to its last, with no gaps (a quarter without a
    priced day carries the close before it), so no entry is `null` today. A quarter after the last entry (a stock
    that stopped trading) is valued at the last entry; a quarter before `q0` has no close. The entry of the
    quarter in progress is its latest close so far.
  - `q0` is `null` and `qclose` is `[]` when the stock has no priced day.
  - Files built before 2026-11-19 have neither: a reader then falls back to the weekly closes.

### Home

Each file is an object with `latest_q`, the quarter the lists are about. `name` in every row below is the
fund's name.

- `top_{period}.json` (`1y`, `3y`, `5y`, `10y`, `15y`, `max`): `{"latest_q", "period", "eligible": [...], "giants": [...],
  "famous": [...], "search_asof", "spx"}`, each best annualised return first. Row: `{"fund_id", "name", "book", "n_positions", "ann_return",
  "max_dd", "sharpe"}`. `famous` lists the funds of `pipeline/orca/famous.csv` (hand-kept) whatever the Top funds
  rules say, when they have a performance for the period, ≥ 80% of the book priced and a name holding the list's
  match word; its rows add `"manager"` (string or `null`) and `"group"` (the style list it is shown in, one of
  `FAMOUS_GROUPS` in `pipeline/orca/famous.py`; a fund in two lists has a row for each) and `"until_q"`: for a fund
  that stopped filing, its last quarter, and then its figures cover the period up to that quarter; `null` while it
  still files, and `"search"`: the Google Trends score of the fund's search keyword (its manager or founder, or the
  firm for venture firms; famous.csv `search`), Warren Buffett = 100, worldwide over the 12 months to `search_asof`; set on
  one fund per keyword (the filer still filing with the biggest book) and on each of its rows, `null` on every
  other row, and `"fame"`: the same score on every row of the keyword (Sequoia's seven filers all have it), for the
  site to order each list by popularity; `null` without a score, and `"rank"`: the owner's place for the fund in
  `pipeline/orca/famous_rank.csv` (1 = first; every filer of a ranked keyword shares it), which orders Most searched
  and each list ahead of any score; `null` when not listed. A ranked fund with no score still has `"search"` (`0`) on
  its one filer, so it has a place in Most searched. The site shows neither score. Funds that stopped filing appear in no other list. `"search_asof"` (top level): the date of the
  Google Trends snapshot (`pipeline/orca/famous_search.csv`), `null` without one. Files built before 2026-11-15
  have no `famous` key; before 2026-11-17 no `search` or `search_asof`; before 2026-11-18 no `fame`; before 2026-11-20 no `rank`.
  `spx` is the S&P 500 reference: `{"ann_return", "from_q", "to_q"}`, SPY's total return (dividends reinvested)
  annualised over the same window as the fund figures (the period's `n` quarters ending at `latest_q`); `to_q` =
  `latest_q`, `from_q` = the quarter whose close is the base (`latest_q − n`). `ann_return` is `null` when SPY lacks
  a close or quarter in the window. The whole `spx` is `null` for `max`. Files built before 2026-11-21 have no `spx`.
- `conviction_q.json` (the latest quarter), `conviction_y.json` (each of the last four quarters): `{"latest_q",
  "rows": [...]}`, moves that are large for the fund that made them, the most unusual first, at most 200. Row:
  `{"fund_id", "name", "stock_id", "q", "move", "usd", "weight_after", "change_pts", "est_price", "score"}`. `move`
  is `"new"`, `"add"`, `"trim"` or `"exit"`; `usd` the dollars traded (negative: sold); `weight_after` the stock's
  weight at the end of quarter `q`; `score` orders the rows and is not meant for display. A move's size is the
  dollars traded over the fund's AUM: a buy over the AUM at the end of the quarter, a sale over the AUM at its start.
  An add or a trim first loses its pro-rata share of the quarter's money in or out (the net dollars of all the
  fund's trades times the stock's weight at the start), never more than the move; new positions and exits count as
  traded. The usual move is the biggest single move of the four quarters before, measured the same way (under 1%
  counts as 1%). A move is listed when it is 3% or more of the AUM,
  at least twice the usual move and at least half the fund's largest holding at the start of the quarter; `score`
  is the move over the usual one. Funds of $500M or more that filed the quarter and the one before, whose AUM
  neither more than doubled nor more than halved in it, whose largest holding at its start was 33% or less, and
  that are no index giant, bank, insurer or broker. ETFs are neither listed nor set a usual move.
- `wins_losses.json`: `{"latest_q", "wins": [...], "losses": [...]}`. Row: `{"fund_id", "name", "stock_id",
  "pnl"}`.
- `just_filed.json`: `{"latest_q", "rows": [...]}`. Row: `{"fund_id", "name", "filed", "period_q", "book",
  "headline_stock_id", "headline_change_pts"}`.
- `crowded.json`: `{"latest_q", "rows": [...]}`. Row: `{"stock_id", "funds_buying", "total_bought",
  "avg_weight_after"}`.
- `calls_q.json` (last quarter), `calls_y.json` (last four quarters): `{"latest_q", "rows": [...]}`, ordered by
  the stock's move since the estimated buy, best first, and cut to the 50 best followed by the 50 worst when there
  are more than 100 (the middle is left out). Row: `{"stock_id", "fund_id", "name", "q", "est_price",
  "price_on_filed", "filed"}`.
- The moves in the conviction lists, `crowded.json` and the calls lists leave out a fund's first report (the first
  quarter of its tracking) and a holding valued for the first time: those are positions entering the book, not
  buys of that quarter.

### Sector files (`sectors/labels.json`, `sectors/scores.json`, `fund/{id}/skill.json`)

Written by the sector step (`orca.run sectors --part publish`, `run/sectors_step.py`) after the monthly run is
published, from the lake's `fund_flows`, `stock_quarters` and `sector_returns`. They exist only after a sector
step has run, and only for funds it scored: a reader treats a 404 as "not scored". The method is
`engine/skill.py`: a fund's real trades are replayed three times, through each stock's own total-return series
(`fund`, the fund itself), through the index of each stock's hierarchy label (`label`) and through Orca's index of
the whole market (`mkt`); a fourth replay through SPY's total-return series (`spy`) is for reference only.
`picking` = IRR(fund) − IRR(label) and `allocation` = IRR(label) − IRR(mkt).

- `label` everywhere is a full hierarchy path joined by `" > "` ("Technology > Semiconductors"); `"Market"` is the
  whole market. Tier 1 is the sector, 2 the industry, 3 the vertical (the site calls it a sub-industry).
- All IRRs and scores are fractions a year, `null` where the IRR has no root in [−0.99, 10]. `fund_id` is the CIK,
  as in every fund file. `last_q` is the quarter the replays are valued at.
- `sectors/labels.json`: one entry per label of the indices at `last_q` (tiers 1–3), ordered by `label`.
  `parent` is the label one tier up (`null` for a sector), `name` its last part, `n` the stocks in its index in
  `last_q` and `top_weight` the largest stock's weight in it (0 to 1).
- `sectors/scores.json`: one entry per scored fund and tier, ordered by `fund_id`, then `tier`. `n` is the number
  of positions scored, `coverage` the share of the fund's buying (dollars) they hold, `span_q` = `last_q` − the
  quarter of the fund's first trade + 1.
- `fund/{id}/skill.json`:
  - `first_q` is the quarter of the fund's first scored trade. `quarters` has one entry per quarter from `first_q`
    to `last_q`. `bought` is the dollars bought in the quarter; `v_fund`, `v_mkt`, `v_spy` the replay's value at
    the quarter end in dollars; `fund`, `mkt`, `spy` its quarterly return, time-weighted: the replay trades at the quarter's
    average level, so the return chains the move from the last quarter end to the trades with the move from the
    trades to the quarter end, and money in or out never moves it; `null` where the replay held nothing in the
    quarter. A quarter's figures are as of its end, even the quarter in progress (`last_q`).
  - `years`: one entry per calendar year from `first_q` to `last_q`, `name` labelled as `summary.json` years
    (`"2025"`, `"2026 9M"`, `"2014 Q2–Q4"`); the returns chain the quarterly ones (`null` when none). Each year,
    market + (label − market) + (fund − label) = fund, exactly.
  - `tiers.t.quarters.label` / `v_label` and `tiers.t.years.label` are the same for the label replay at tier t,
    aligned with `quarters.q` and `years.name`. `v_never` is reserved for a "never rotated" replay; `null` today.
  - `tiers.t.picks`: the fund's 30 largest positions by dollars bought, largest first, then one entry with
    `stock_id` `null` for all its other scored positions. `label` is the position's label at tier t (`null` on the
    last entry), `irr_own` the IRR of its trades replayed in the stock, `irr_label` in that label's index.
  - `tiers.t.bets`: one entry per label at tier t the fund bought, most money first; at tier 1 every sector is
    listed, and the unbought ones have `bought` 0 and `null` IRRs. `irr` is the IRR of all its trades in that label
    replayed in the label's index, `irr_mkt` the same trades replayed in the market. `mkt_share` is the market's
    share of that label when they were buying: Σ over quarters of dollars bought × (the label's market value ÷ the
    market's) at the quarter's start, ÷ the dollars bought (for an unbought sector, weighted by all the fund's
    buying).
  - `mix`: the fund's book by vertical, each quarter from `first_q` to `last_q` it held priced stocks: `label` is
    a path of three parts; groupings that are not labels are in parentheses: `"(Not classified) > (Not
    classified) > (Not classified)"` (broad ETFs and stocks without a label), `"Technology > (ETFs) > (ETFs)"` (a
    sector ETF; an industry ETF keeps its industry) and `"Technology > (Smaller holdings) > (Smaller holdings)"`
    (verticals of the sector that never reach 0.2% of the book). `share[i]` is the `i`-th label's share of the
    priced long book (shares × quarter-end close) in each quarter of `mix.q`, rounded to 4 decimals; each quarter
    sums to 1 (± rounding). Rows are ordered by `label`.

### `manifest.json` and `health.json`

- `manifest.json`: `version` is the run id, `built` the UTC time of the build (`YYYY-MM-DDTHH:MM:SSZ`), `files`
  maps the path of every published file (except `manifest.json`) to the sha256 of its bytes as stored.
- `health.json`: `filings_parsed` and `funds_recomputed` are counts for the run, `unmapped_cusips` is a count of
  securities that could not be mapped (the CUSIPs themselves are never published), `coverage_median` is the
  median `priced_pct` of the active funds (or `null`), and `flags` is a list of strings or objects describing data-quality
  findings; each names funds and stocks by id.
