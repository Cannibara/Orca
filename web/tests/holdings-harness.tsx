// The Holdings tab as tests mount it, with the state the fund page keeps (useHoldingsState). TableOnly leaves
// the tree map out: its colours ask for weekly files of their own, which the tests of the table's loading and
// of the background prefetch must not see. Holdings is the whole tab, as Fund.tsx mounts it.
import type { Stock } from "../src/data/api";
import type { PositionRow, Summary } from "../src/data/types";
import { fmtLong } from "../src/fund/fmt";
import { HoldingsTab } from "../src/fund/HoldingsTab";
import { PeriodPicker } from "../src/fund/PeriodPicker";
import { PositionsPanel } from "../src/fund/PositionsPanel";
import { endDate, periodAsOf, periodOf } from "../src/fund/positions";
import { WeeklyStoreContext, useHoldingsState, usePositionData } from "../src/fund/usePositionData";

export type HarnessProps = {
  fundId: number;
  summary: Summary;
  positions: PositionRow[];
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  asof: string;
};

function TableOnlyInner({ fundId, summary, positions, prices, stocks, asof }: HarnessProps) {
  const h = useHoldingsState(summary, positions, prices, asof);
  const { qs, qe } = periodOf(h.period);
  const data = usePositionData({ positions: h.positions, tl: h.tl, prices, stocks, qs, qe, store: h.store });
  return (
    <WeeklyStoreContext.Provider value={h.store}>
      <section className="panel" id="holdPanel" aria-labelledby="holdTitle">
        <PeriodPicker state={h.period} onChange={h.setPeriod} tl={h.tl} title="Holdings" titleId="holdTitle" asOf={periodAsOf(h.period, h.tl)} />
      </section>
      <PositionsPanel fundId={fundId} data={data} asOf={"Positions and prices as of " + fmtLong(endDate(h.tl, qe))} latest={prices} />
    </WeeklyStoreContext.Provider>
  );
}

/** The picker and the Positions table on one state, keyed by fund like the page. */
export function TableOnly(props: HarnessProps) {
  return <TableOnlyInner key={props.fundId} {...props} />;
}

function HoldingsInner({ fundId, summary, positions, prices, stocks, asof }: HarnessProps) {
  const h = useHoldingsState(summary, positions, prices, asof);
  return (
    <WeeklyStoreContext.Provider value={h.store}>
      <HoldingsTab fundId={fundId} h={h} prices={prices} stocks={stocks} />
    </WeeklyStoreContext.Provider>
  );
}

/** The whole Holdings tab, keyed by fund like the page. */
export function Holdings(props: HarnessProps) {
  return <HoldingsInner key={props.fundId} {...props} />;
}
