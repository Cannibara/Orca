# Published JSON contract

The single source of truth for every file the pipeline publishes. The writer produces exactly this and the
website builds its TypeScript types from it. Change this file first, then the writer.

## Conventions

- All keys are snake_case. Money is in dollars. Shares and prices are plain numbers.
- `null` means missing (unknown, not applicable, or not computable). NaN and infinity are never published.
- Arrays are column-oriented: `{"col": [...]}`, and all columns of one block have the same length, row `i`
  being the `i`-th entry of each. The home lists are the exception: small row-oriented lists (see Home).
- Quarters are integers: `q = (year − 2013) × 4 + (quarter − 1)`, so Q1 2013 is 0 and Q2 2026 is 53.
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
- `fund/{id}/summary.json`: `{"id", "name", "cik", "period_q", "filed", "book", "n_holdings", "priced_pct", "tracked_since_q", "inactive", "metrics": {"ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "best_year": {"label", "ret"}, "worst_year": {"label", "ret"}, "years_pos", "years_total", "quarters_pos_pct", "turnover", "hold_all", "hold_sold", "first_year", "last_year"}, "years": {"label": [], "ret": [], "start": [], "end": [], "gains": [], "inflows": [], "dividends": [], "approx_ret": []}, "quarters": {"q": [], "ret": [], "start": [], "end": [], "market_move": [], "net_buying": [], "trade_gains": [], "dividends": []}, "holdings_now": {"stock_id": [], "shares": [], "cost": []}}`
- `fund/{id}/positions.json`: `{"stock_id": [], "from_q": [], "to_q": [], "avg_cost": [], "avg_exit": [], "invested": [], "realised": [], "dividends": [], "shares_now": [], "cost_now": [], "last_q": [], "last_type": [], "last_pct": [], "last_usd": [], "trades": [[[q, delta, px, low, high, shares_after], ...], ...]}`
- `fund/{id}/contrib.json`: `{"years": [label...], "by_year": {label: {"stock_id": [], "points": [], "pnl": []}}}`
- `fund/{id}/exits.json`: `{"rows": {"stock_id": [], "status": [], "sold_shares": [], "sold_usd": [], "avg_exit": [], "last_sale_q": [], "one_y": [], "spy_one_y": []}, "summary": {"buys_12m": number|null, "sells_12m": number|null, "beat_spy_pct": number|null}}`
- `stock/{stock_id}/weekly.json`: `{"start": "YYYY-MM-DD", "close": []}` (weekly Friday closes, split-adjusted; `close` is `(number | null)[]`)
- `home/top_{1y|3y|5y|10y|15y|max}.json`, `home/conviction.json`, `home/wins_losses.json`, `home/just_filed.json`, `home/crowded.json`, `home/calls_q.json`, `home/calls_y.json`: row lists described under Home.
- `manifest.json` at the bucket root: `{"version": "...", "built": "...", "files": {path: sha256}}`; `health.json`: `{"filings_parsed", "unmapped_cusips", "coverage_median", "funds_recomputed", "flags": [...]}`.

## Field notes

### `funds.json`, `securities.json`, `latest_prices.json`

- `funds.json`: the search index, one entry per fund, ordered by `id`. `n` is the number of holdings now.
  `v` is the format version.
- `securities.json`: one entry per stock, ordered by `stock_id`. `sector` is a string.
- `latest_prices.json`: each stock's latest stored close, ordered by `stock_id`. `price` is the close and `date`
  (ISO) the day of it; both are `null` for a stock without one. `asof` is the latest `date` of all. Every week the
  pipeline refreshes the stocks held in the latest quarter and those sold out within the last 8 quarters (the
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
  day has no file.

### Home

Each file is an object with `latest_q`, the quarter the lists are about. `name` in every row below is the
fund's name.

- `top_{period}.json` (`1y`, `3y`, `5y`, `10y`, `15y`, `max`): `{"latest_q", "period", "eligible": [...], "giants": [...]}`,
  best annualised return first. Row: `{"fund_id", "name", "book", "n_positions", "ann_return", "max_dd",
  "sharpe"}`.
- `conviction.json`: `{"latest_q", "rows": [...]}`. Row: `{"fund_id", "name", "stock_id", "move", "weight_now",
  "change_pts", "est_price", "q"}` (`move` is `"new"`, `"add"` or `"exit"`).
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
- The moves in `conviction.json`, `crowded.json` and the calls lists leave out a fund's first report (the first
  quarter of its tracking) and a holding valued for the first time: those are positions entering the book, not
  buys of that quarter.

### `manifest.json` and `health.json`

- `manifest.json`: `version` is the run id, `built` the UTC time of the build (`YYYY-MM-DDTHH:MM:SSZ`), `files`
  maps the path of every published file (except `manifest.json`) to the sha256 of its bytes as stored.
- `health.json`: `filings_parsed` and `funds_recomputed` are counts for the run, `unmapped_cusips` is a count of
  securities that could not be mapped (the CUSIPs themselves are never published), `coverage_median` is the
  median `priced_pct` (or `null`), and `flags` is a list of strings or objects describing data-quality
  findings; each names funds and stocks by id.
