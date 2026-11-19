import { PositionsTable } from "./PositionsTable";
import type { PositionData } from "./usePositionData";
import "./positions.css";

export type PositionsPanelProps = {
  fundId: number;
  /** The table's rows for the period the Holdings panel's picker chose. */
  data: PositionData;
  /** The as-of line, already printed: "Positions and prices as of 30 Oct 2026". */
  asOf: string;
  /** Latest close of every stock that has one, for an opened row's price chart. */
  latest: Map<number, number>;
};

/**
 * Every position of the fund as it stood at the end of the period picked in the Holdings panel above (a
 * quarter, or the 12 months to a quarter end): the 12-column table, with a price chart and the trades under
 * an opened row. The period and the rows come from the Holdings tab (see HoldingsTab).
 */
export function PositionsPanel({ fundId, data, asOf, latest }: PositionsPanelProps) {
  return (
    <section className="panel" id="posPanel" aria-labelledby="posTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="posTitle">
            Positions
          </h3>
        </div>
        <div className="ph-c">
          <span className="asof">{asOf}</span>
        </div>
      </div>
      <PositionsTable
        fundId={fundId}
        rows={data.rows}
        pending={data.pending}
        failed={data.failed}
        progress={data.progress}
        latest={latest}
      />
    </section>
  );
}
