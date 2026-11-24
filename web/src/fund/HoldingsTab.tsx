import { useRef, type ReactNode } from "react";
import type { Stock } from "../data/api";
import { fmtLong } from "./fmt";
import { HoldingsPanel } from "./HoldingsPanel";
import { PositionsPanel } from "./PositionsPanel";
import { endDate, periodOf } from "./positions";
import { usePositionData, type HoldingsState } from "./usePositionData";

type Props = {
  fundId: number;
  /** The tab's state, kept by the page (see useHoldingsState). */
  h: HoldingsState;
  /** Latest close of every stock that has one: "now" for the newest period. */
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  /** The four key-figure tiles at the top of the tab (the page builds them: they read its bracket). */
  tiles?: ReactNode;
  /** Annual returns, between the tree map and the table (the page builds it: its window and year are page state). */
  returns?: ReactNode;
};

/**
 * The Holdings tab: four key-figure tiles, the Holdings panel (period picker and tree map), Annual returns, then
 * the Positions table. One picker drives the tree map and the table and both read one set of rows, so they agree. The newest quarter's table needs only
 * the latest prices; an earlier period reads each stock's weekly file for the prices at its end. Once the page
 * has landed and the browser is idle, the weekly files of every position are fetched quietly in the background
 * (see usePositionData), so stepping back through the quarters is instant; a step taken before they are in
 * asks for the files it needs first.
 */
export function HoldingsTab({ fundId, h, prices, stocks, tiles, returns }: Props) {
  const { qs, qe } = periodOf(h.period);
  const data = usePositionData({ positions: h.positions, tl: h.tl, prices, stocks, qs, qe, store: h.store });
  // The table's box, so the mouse wheel over it steps the picker's periods like it does over the tree map.
  const tableRef = useRef<HTMLDivElement>(null);
  return (
    <>
      {tiles}
      <HoldingsPanel h={h} data={data} prices={prices} tableRef={tableRef} />
      {returns}
      <PositionsPanel
        fundId={fundId}
        data={data}
        asOf={"Positions and prices as of " + fmtLong(endDate(h.tl, qe))}
        latest={prices}
        tableRef={tableRef}
      />
    </>
  );
}
