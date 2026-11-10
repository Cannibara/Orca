import { Link } from "react-router-dom";
import { niceTicks } from "./geometry";
import { midQuarterMs, tradeMove } from "../lib/live";
import { qLabelFull, fM, MINUS } from "./fmt";
import { useWeekly } from "./usePositionData";
import type { PosRow } from "./positions";
import "./positions.css";

// The panel under an expanded row: the stock's weekly share price with the fund's buys and sells on it,
// and the list of those trades. Ported from the artifact's stockPanel.

const DAY = 86_400_000;
const STEP = 7 * DAY;
const H = 210;
const ML = 44;
const MR = 10;
const MT = 14;
const MB = 24;
const SZ = 5.5; // half the width of a trade marker

const MOVE_WORD = { New: "New", Add: "Added", Trim: "Trimmed", Exit: "Sold all" } as const;

const n0 = (v: number): string => Math.round(v).toLocaleString("en-US");

function Chart({
  row,
  W,
  start,
  close,
  latestPrice,
}: {
  row: PosRow;
  W: number;
  start: string;
  close: (number | null)[];
  latestPrice: number | undefined;
}) {
  const t0 = Date.parse(start);
  const n = close.length;
  const iw = Math.max(120, W - ML - MR);
  const ih = H - MT - MB;
  // From a year before the fund first held the stock.
  const q0 = Math.max(0, row.from - 4);
  const i0 = Math.max(0, Math.floor((Date.UTC(2013 + Math.floor(q0 / 4), (q0 % 4) * 3, 1) - t0) / STEP));
  const i1 = n - 1;
  let lo = Infinity;
  let hi = -Infinity;
  let iLast = -1;
  for (let k = i0; k <= i1; k++) {
    const c = close[k];
    if (c == null) continue;
    lo = Math.min(lo, c);
    hi = Math.max(hi, c);
    iLast = k;
  }
  if (iLast < 0 || i1 <= i0) return <p className="x-none">No price history for this stock.</p>;

  const ticks = niceTicks(Math.max(0, lo * 0.95), hi * 1.05, 3);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const X = (i: number) => ML + ((i - i0) / (i1 - i0)) * iw;
  const Y = (v: number) => MT + ih - ((v - y0) / (y1 - y0)) * ih;

  const years: number[] = [];
  const lastYear = new Date(t0 + i1 * STEP).getUTCFullYear();
  for (let yr = 2013 + Math.floor(q0 / 4) + 1; yr <= lastYear; yr++) {
    const xi = (Date.UTC(yr, 0, 1) - t0) / STEP;
    if (xi < i0 || xi > i1) continue;
    if (yr % 2 === 0 || iw > 520) years.push(yr);
  }

  // The line breaks over weeks without a close.
  let d = "";
  let pen = false;
  for (let k = i0; k <= i1; k++) {
    const c = close[k];
    if (c == null) {
      pen = false;
      continue;
    }
    d += (pen ? "L" : "M") + X(k).toFixed(1) + "," + Y(c).toFixed(1);
    pen = true;
  }

  const marks = row.pos.trades.flatMap((t, idx) => {
    const fi = (midQuarterMs(t.q) - t0) / STEP;
    if (fi < i0 || fi > i1) return [];
    const f0 = Math.floor(fi);
    const f1 = Math.min(n - 1, f0 + 1);
    const a = close[f0];
    const b = close[f1];
    const py = a != null && b != null ? a + (b - a) * (fi - f0) : t.px; // on the line, or at the estimate over a gap
    const x = X(fi);
    const y = Y(py);
    const buy = t.delta > 0;
    const path = buy
      ? `M${x.toFixed(1)},${(y - SZ - 2).toFixed(1)}l${SZ},${(SZ * 1.7).toFixed(1)}h${-2 * SZ}z`
      : `M${x.toFixed(1)},${(y + SZ + 2).toFixed(1)}l${SZ},${(-SZ * 1.7).toFixed(1)}h${-2 * SZ}z`;
    const title = `${buy ? "Bought " : "Sold "}${n0(Math.abs(t.delta))} shares at $${t.px.toFixed(2)}, ${qLabelFull(t.q)}`;
    return [{ key: idx, buy, path, title }];
  });

  const last = latestPrice ?? (close[iLast] as number);
  return (
    <svg
      className="viz px"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={`${row.name || row.ticker} share price with the fund's buys and sells`}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={ML} x2={W - MR} y1={Y(t).toFixed(1)} y2={Y(t).toFixed(1)} />
          <text className="tick" x={ML - 8} y={Y(t) + 4} textAnchor="end">
            {"$" + t}
          </text>
        </g>
      ))}
      {years.map((yr) => (
        <text key={yr} className="tick" x={X((Date.UTC(yr, 0, 1) - t0) / STEP).toFixed(1)} y={H - 6} textAnchor="middle">
          {yr}
        </text>
      ))}
      <path className="pxline" d={d} />
      {marks.map((m) => (
        <path key={m.key} className={"mk " + (m.buy ? "buy" : "sell")} d={m.path}>
          <title>{m.title}</title>
        </path>
      ))}
      <circle className="pxdot" cx={X(iLast).toFixed(1)} cy={Y(last).toFixed(1)} r={3.5} />
      <text className="blab" x={(X(iLast) - 8).toFixed(1)} y={(Y(last) - 9).toFixed(1)} textAnchor="end">
        {"$" + last.toFixed(2)}
      </text>
    </svg>
  );
}

/** Inline plus or minus for the action tags. */
function Sign({ plus }: { plus: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={plus ? "M8 3.5v9M3.5 8h9" : "M3.5 8h9"} />
    </svg>
  );
}

type StockPanelProps = {
  row: PosRow;
  fundId: number;
  /** Width of the chart, px. */
  width: number;
  /** The stock's latest close, the figure at the end of the line. */
  latestPrice: number | undefined;
};

export function StockPanel({ row, fundId, width, latestPrice }: StockPanelProps) {
  const weekly = useWeekly(row.id);
  const name = row.name || row.ticker;
  // Oldest first for the running share count; the list shows the newest first.
  const trades = row.pos.trades.map((t) => ({ t, move: tradeMove(t) })).reverse();
  return (
    <>
      <div className="xhead">
        <div>
          <b>{row.ticker}</b> <span>{row.name}</span>
        </div>
        <div className="xleg">
          <span>
            <i className="tri up" />
            Bought
          </span>
          <span>
            <i className="tri dn" />
            Sold
          </span>
          <span>Share price, $</span>
          <Link className="xlink" to={`/fund/${fundId}/stock/${row.id}`}>
            Open full page
          </Link>
        </div>
      </div>
      {weekly === undefined ? (
        <p className="x-none" role="status">
          Loading prices…
        </p>
      ) : weekly === null ? (
        <p className="x-none">No price history for this stock.</p>
      ) : (
        <Chart row={row} W={width} start={weekly.start} close={weekly.close} latestPrice={latestPrice} />
      )}
      <div className="xtbl">
        <table className="tbl-mini">
          <caption>{`When the fund bought and sold ${name}`}</caption>
          <thead>
            <tr>
              <th scope="col" className="tl">
                Quarter
              </th>
              <th scope="col" className="tl">
                Action
              </th>
              <th scope="col">Shares</th>
              <th scope="col">Price</th>
              <th scope="col">Value</th>
              <th scope="col">Held after</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(({ t, move }) => (
              <tr key={t.q}>
                <td>{qLabelFull(t.q)}</td>
                <td className="tl">
                  <span className="tag">
                    <Sign plus={t.delta > 0} />
                    {MOVE_WORD[move]}
                  </span>
                </td>
                <td>{(t.delta < 0 ? MINUS : "+") + n0(Math.abs(t.delta))}</td>
                <td>{"$" + t.px.toFixed(2)}</td>
                <td>{fM(Math.abs(t.delta) * t.px)}</td>
                <td>{n0(Math.max(0, t.sharesAfter))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
