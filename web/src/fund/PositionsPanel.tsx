import type { Stock } from "../data/api";
import type { PositionRow, Summary } from "../data/types";

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

/** Stub: the POSITIONS agent replaces it. */
export function PositionsPanel(_props: PositionsPanelProps) {
  return <section className="panel" id="posPanel" />;
}
