# Classify ETFs

You classify ETFs that hedge funds held. Work only from your own knowledge: do not search the web, run code, or read any file except the three below.

Files (D is the folder this prompt sits in):
- `D/menu.txt`: the stock hierarchy. Lines `id|vertical|example tickers`, grouped under `## Sector > Industry`.
- `D/etf_in_NN.txt`: your input, one ETF per line: `stock_id|ticker|name|$m bought`.
- `D/etf_out_NN.jsonl`: your output (NN is your batch number).

Names are Bloomberg-style short names, often cut at 28 characters ("SS TECHNOLOGY SELECT SECTOR" is the State Street Technology Select Sector SPDR; "ISHARES US TECHNOLOGY ETF"). Some funds are closed, renamed or leveraged.

## Output
One JSON object per input line, same order, nothing else in the file:
`{"id":<stock_id>,"k":"<class>","c":<0-3>}`
plus, only when they apply: `"lv":"sector"|"industry"|"vertical"` and `"v":<vertical id>` (class sector only), `"lev":"2x"|"3x"|"-1x"|"-2x"|"-3x"` (leveraged or inverse), `"n":"<=8 words"` (when c is 1 or 2).

class k:
- `broad`: diversified US equity (S&P 500, total market, Russell, Nasdaq-100, Dow, size, style, factor, dividend or ESG screens of the whole US market).
- `intl`: diversified equity outside the US, or global (EAFE, emerging markets, one country or region, world).
- `bond`: fixed income of any kind (treasuries, MBS, corporate, high yield, municipal, TIPS, preferreds, loans, aggregate).
- `cash`: money market, ultra-short, T-bills.
- `commodity`: gold, silver, oil, broad commodities, currencies.
- `crypto`: bitcoin, ether or other crypto, spot or futures.
- `sector`: an equity ETF whose holdings sit in ONE node of the menu: a sector, an industry or an industry vertical. Examples: financials (sector), semiconductors (industry), gold miners (vertical Precious Metals Mining), biotech (vertical Biotechnology), homebuilders (vertical Homebuilding).
- `theme`: an equity ETF about a theme that cuts across several menu nodes (clean energy, AI and robotics, infrastructure, China internet, cannabis): no single node, so no label.
- `multi`: allocation, target-date, buy-write or option income, buffer, volatility, or anything that mixes asset classes.
- `other`: you cannot tell what it holds.

For class `sector` give `lv` (how narrow it is: `sector` for a whole sector such as Technology or Financials, `industry` for one industry such as Semiconductors, `vertical` for one industry vertical) and `v` (ANY vertical id inside that node; for a sector or an industry pick one of its verticals, it only names the node). A leveraged or inverse ETF of one node is still class `sector`, with `lev`. Use `c`: 3 = I know this fund, 2 = inferred from the name, 1 = a guess, 0 = no idea (then class `other`).

## How to work
1. Read `D/menu.txt`, then `D/etf_in_NN.txt`.
2. Write the whole output file with ONE Write call, in input order, one JSON object per line, ids exactly as given.
3. Check that the output has as many lines as the input. Fix any gap.
4. Reply with one line only: `etf batch NN: <lines> lines, <count of c=0 or c=1> unsure`.
