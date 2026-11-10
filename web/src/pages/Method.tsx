// "How it works": what a 13F covers and the formulas behind every estimate. Static text, no data.
// The wording and formulas are the approved mockup's; the page ends with the not-advice line.
import { useTitle } from "../lib/useTitle";
import "./method.css";

// The formulas keep their line breaks and alignment (the .formula box is white-space: pre).
const TRADE_PRICE = `typical price = (high + low + close) ÷ 3
quarter VWAP  = Σ(typical price × volume) ÷ Σ volume`;

const PNL = `buy:  cost += shares bought × VWAP
sell: realised += shares sold × (VWAP − avg cost)
unrealised = shares held × latest price − cost
total = realised + unrealised + dividends`;

const RETURNS = `quarter return = (end value − start value − net buying + dividends)
                 ÷ (start value + ½ × net buying)
year = the four quarters chained`;

export default function Method() {
  useTitle("How it works · Orca");
  return (
    <div className="method-page">
      <div className="prose">
        <header className="m-head">
          <p className="m-eyebrow">Methodology</p>
          <h1>How Orca estimates fund results</h1>
          <p className="m-lede">
            Everything comes from public 13F filings plus daily stock prices. 13Fs only show what a fund held on the last
            day of each quarter, so trade prices, P&amp;L and returns are estimates.
          </p>
        </header>
        <section>
          <h2>What a 13F covers</h2>
          <ul>
            <li>Long positions in US-listed stocks, ETFs and some options, as of quarter end.</li>
            <li>No short positions, cash, bonds, non-US stocks or private holdings.</li>
            <li>Filed up to 45 days after the quarter ends.</li>
          </ul>
          <p>So a fund's real return can differ a lot from the return of its 13F book.</p>
        </section>
        <section>
          <h2>Trade prices</h2>
          <p>
            We can't see trade dates, only the change in shares between quarter ends. All of a quarter's buying or selling
            is assumed to happen at that quarter's volume-weighted average price:
          </p>
          <div className="formula" tabIndex={0}>{TRADE_PRICE}</div>
          <p>The quarter's low and high are shown next to every estimate.</p>
        </section>
        <section>
          <h2>P&amp;L per stock</h2>
          <div className="formula" tabIndex={0}>{PNL}</div>
        </section>
        <section>
          <h2>Fund returns</h2>
          <div className="formula" tabIndex={0}>{RETURNS}</div>
        </section>
        <section>
          <h2>What if they'd kept it</h2>
          <p>
            For every sale we track the stock's return from the estimated sale price to today and over the next 12 months,
            against SPY. "IRR if held" keeps the same buys but values every share bought at today's price.
            IRR dates trades mid-quarter and counts years of 365 days, as Excel's XIRR does.
          </p>
        </section>
        <section>
          <h2>Not investment advice</h2>
          <p>Orca is research software. Nothing here is a recommendation to buy or sell anything.</p>
        </section>
      </div>
    </div>
  );
}
