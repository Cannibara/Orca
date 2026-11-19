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
};

/**
 * The Holdings tab: the Holdings panel (period picker and tree map), then the Positions table. One picker drives
 * both and both read one set of rows, so the tiles and the table agree. The newest quarter's table needs only
 * the latest prices; an earlier period reads each stock's weekly file for the prices at its end. Once the page
 * has landed and the browser is idle, the weekly files of every position are fetched quietly in the background
 * (see usePositionData), so stepping back through the quarters is instant; a step taken before they are in
 * asks for the files it needs first.
 */
export function HoldingsTab({ fundId, h, prices, stocks }: Props) {
  const { qs, qe } = periodOf(h.period);
  const data = usePositionData({ positions: h.positions, tl: h.tl, prices, stocks, qs, qe, store: h.store });
  return (
    <>
      <HoldingsPanel h={h} data={data} prices={prices} />
      <PositionsPanel fundId={fundId} data={data} asOf={"Positions and prices as of " + fmtLong(endDate(h.tl, qe))} latest={prices} />
    </>
  );
}
