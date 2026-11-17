# Classify companies into a fixed hierarchy

You label stocks that hedge funds held. Work only from your own knowledge: do not search the web, run code, or read any file except the three below.

Files (D is the folder this prompt sits in):
- `D/menu.txt`: the hierarchy. Lines `id|vertical|example tickers`, grouped under `## Sector > Industry`. The examples show what belongs in a vertical.
- `D/in_NN.txt`: your input, one stock per line: `stock_id|ticker|name|$m held|n funds` and, for some lines, `|MATCH? candidate (exchange:ticker, country) [Damodaran industry group] => proposed vertical id`.
- `D/out_NN.jsonl`: your output (NN is your batch number).

Names are Bloomberg-style short names, often cut at 28 characters, with garbled or old tickers. Many companies are delisted, acquired or renamed (Twitter, Activision, Time Warner, Splunk): classify the business as it was.

## Output
One JSON object per input line, same order, nothing else in the file:
`{"id":<stock_id>,"k":"<kind>","v":<vertical id>,"c":<0-3>}`
plus, only when they apply: `"m":0|1` (lines with MATCH?), `"x":[vertical ids]`, `"n":"<=8 words"` (when c is 1 or 2).

- k (kind): `stock` = operating company (banks, REITs, ADRs, royalty trusts and MLPs included); `spac` = blank-check shell; `fund` = mutual fund, closed-end fund, interval fund, or a trust holding gold, silver or crypto; `bond` = note, bond, treasury, agency or muni with no operating-company issuer; `other` = currency, index, cash, or cannot be identified. A convertible-note line such as "CCI 4-5 11-01-16 A" with a company issuer is `stock`: label the issuer's business.
- v: for `stock` only, ONE vertical id: where the company earns most of its operating profit (today, or last before it vanished). Pick the most specific sensible vertical; use an "Other ..." vertical only as a last resort; a conglomerate with no dominant business goes to Diversified Conglomerates. Use 0 for every other kind.
- x: extra vertical ids, only for a clear second business line (for example a utility that also owns nuclear plants). Usually omit.
- m (MATCH? lines only): 1 if the candidate is the same company (an ADR of it, or a renamed or cross-listed line, counts as the same); 0 if it is a different company. Even when m is 0 give your own v. Do not just accept the proposed id: judge the company yourself.
- c (confidence): 3 = I know this company; 2 = inferred from the name; 1 = a guess; 0 = no idea what it does (then v is 0).

## How to work
1. Read `D/menu.txt`, then `D/in_NN.txt`.
2. Write the whole output file with ONE Write call, in input order, one JSON object per line, ids exactly as given.
3. Check that the output has as many lines as the input. Fix any gap.
4. Reply with one line only: `batch NN: <lines> lines, <count of c=0 or c=1> unsure`.
