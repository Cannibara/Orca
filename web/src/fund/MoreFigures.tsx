// The figures the old fund page led with that the new design does not show in its four tiles: risk ratios,
// best and worst year, and how the fund trades. Kept below the new panels so no published number disappears.
import { Tile, Tiles } from "../components/Tiles";
import type { Summary } from "../data/types";
import { DASH, pct, ratio } from "../lib/format";

const yrs = (x: number | null): string => (x == null || !Number.isFinite(x) ? DASH : `${x.toFixed(1)} yrs`);

export function MoreFigures({ summary, profitable }: { summary: Summary; profitable: number | null }) {
  const m = summary.metrics;
  const bestWorst = m.best_year && m.worst_year ? { best: m.best_year, worst: m.worst_year } : null;
  return (
    <section className="sec" aria-labelledby="fund-more">
      <div className="sec-head">
        <h2 id="fund-more">More figures</h2>
      </div>
      <Tiles label="Risk and return">
        <Tile label="Sharpe ratio" value={ratio(m.sharpe)} sub="return above T-bills ÷ volatility" />
        <Tile label="Sortino ratio" value={ratio(m.sortino)} sub="same, counting only downside swings" />
        <Tile label="Calmar ratio" value={ratio(m.calmar)} sub="return per year ÷ max drawdown" />
        <Tile
          label="Best / worst year"
          value={bestWorst ? `${pct(bestWorst.best.ret, 0)} / ${pct(bestWorst.worst.ret, 0)}` : DASH}
          sub={bestWorst ? `${bestWorst.best.label} / ${bestWorst.worst.label}` : undefined}
        />
      </Tiles>
      <Tiles label="How they trade">
        <Tile label="Turnover per year" value={pct(m.turnover, 0, false)} sub="of fund size · lesser of buys or sells" />
        <Tile label="Avg hold length" value={yrs(m.hold_all)} sub={`sold positions only: ${yrs(m.hold_sold)}`} />
        <Tile label="Positions profitable" value={pct(profitable, 0, false)} sub="of stocks ever held, at latest prices" />
      </Tiles>
      <p className="cap">
        All figures are 13F estimates built from quarter-end holdings, so risk numbers understate swings inside a quarter.
        Sharpe and Sortino use 3-month T-bill rates as the risk-free rate.
      </p>
    </section>
  );
}
