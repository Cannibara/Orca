import { useMemo, useState } from "react";
import type { Stock } from "../data/api";
import type { PositionRow, Summary } from "../data/types";
import { fmtLong } from "./fmt";
import { PeriodPicker } from "./PeriodPicker";
import { PositionsTable } from "./PositionsTable";
import { defaultPeriod, endDate, periodOf, withSortedTrades, type Timeline } from "./positions";
import { WeeklyStoreContext, usePositionData, useWeeklyStore } from "./usePositionData";
import "./positions.css";

export type PositionsPanelProps = {
  fundId: number;
  summary: Summary;
  /** positions.json, trades parsed. */
  positions: PositionRow[];
  /** Latest close of every stock that has one: "now" for the newest period. */
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  /** Date of those prices (latest_prices.json `asof`). */
  asof: string;
};

/**
 * Every position of the fund as it stood at the end of a chosen period (a quarter, a year or a custom
 * run of quarters): the 13-column table, with a price chart and the trades under an opened row.
 * The newest quarter is the default and needs only the latest prices; an earlier period reads each
 * stock's weekly series for the prices at its end. Once the page has landed and the browser is idle, the
 * weekly series of every position are fetched quietly in the background (see usePositionData), so stepping
 * back through the quarters is instant; a step taken before they are in asks for the files it needs first.
 */
export function PositionsPanel(props: PositionsPanelProps) {
  // A new fund starts again from its newest quarter.
  return <Panel key={props.fundId} {...props} />;
}

function Panel({ fundId, summary, positions, prices, stocks, asof }: PositionsPanelProps) {
  const tl = useMemo<Timeline>(
    () => ({ qmin: summary.tracked_since_q, latest: summary.period_q, asof }),
    [summary.tracked_since_q, summary.period_q, asof],
  );
  const [period, setPeriod] = useState(() => defaultPeriod(tl));
  const sorted = useMemo(() => withSortedTrades(positions), [positions]);
  const { qs, qe } = periodOf(period, tl);
  const store = useWeeklyStore(sorted, tl, prices);
  const data = usePositionData({ positions: sorted, tl, prices, stocks, qs, qe, store });

  return (
    <WeeklyStoreContext.Provider value={store}>
      <section className="panel" id="posPanel" aria-labelledby="posTitle">
        <PeriodPicker state={period} onChange={setPeriod} tl={tl} asOf={fmtLong(endDate(tl, qe))} />
        <PositionsTable
          fundId={fundId}
          rows={data.rows}
          pending={data.pending}
          failed={data.failed}
          progress={data.progress}
          latest={prices}
        />
      </section>
    </WeeklyStoreContext.Provider>
  );
}
