import { Legend } from "./Legend";
import { niceTicks } from "./scale";
import { tipHandlers, useTooltip, type TipRow } from "./Tooltip";
import { useChartWidth } from "./useChartWidth";

export type DivergingItem = {
  label: string;
  /** Second line of the tooltip title, e.g. the company name. */
  sub: string;
  value: number;
  extra?: TipRow[];
};

export type DivergingBarsProps = {
  items: DivergingItem[];
  /** Formats axis ticks, bar-tip values and the accessible names. */
  fmt: (v: number) => string;
  /** Accessible name of the chart. */
  label: string;
};

const ROW = 28;
const BAR = 16;
const M = { t: 8, r: 64, b: 24, l: 64 };
const LEGEND = [
  { label: "Added to return", color: "var(--pos)" },
  { label: "Took away", color: "var(--neg)" },
];

/** Horizontal bars either side of a centred zero line, in the order given. */
export function DivergingBars({ items, fmt, label }: DivergingBarsProps) {
  const [ref, width] = useChartWidth();
  const tip = useTooltip();
  const H = M.t + M.b + items.length * ROW;
  const iw = width - M.l - M.r;

  // Symmetric domain, so the zero line is the centre of the plot.
  const extent = Math.max(0, ...items.map((d) => Math.abs(d.value))) || 1;
  const ticks = niceTicks(-extent, extent, 5);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const X = (v: number) => M.l + ((v - t0) / (t1 - t0)) * iw;
  const x0 = X(0);

  // Thin the axis labels, keeping 0, when they would run into each other.
  const widest = Math.max(...ticks.map((t) => fmt(t).length));
  const every = Math.max(1, Math.ceil((widest * 6.4 + 10) / (iw / Math.max(1, ticks.length - 1))));
  const zeroAt = Math.max(0, ticks.findIndex((t) => t === 0));

  return (
    <>
      <Legend items={LEGEND} />
      <div className="chart" ref={ref}>
        <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="img" aria-label={label}>
          {ticks.map((t, i) => (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={M.t} y2={H - M.b} className={t === 0 ? "base" : "grid"} />
              {Math.abs(i - zeroAt) % every === 0 && (
                <text x={X(t)} y={H - 6} textAnchor="middle" className="ax">
                  {fmt(t)}
                </text>
              )}
            </g>
          ))}
          {items.map((d, i) => {
            const yc = M.t + i * ROW + ROW / 2;
            const x1 = X(d.value);
            const r = Math.min(4, BAR / 2, Math.abs(x1 - x0));
            const gain = d.value >= 0;
            const top = yc - BAR / 2;
            const bottom = yc + BAR / 2;
            // Rounded at the tip (x1), square at the zero line.
            const path = gain
              ? `M${x0},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${bottom - r}Q${x1},${bottom} ${x1 - r},${bottom}H${x0}Z`
              : `M${x0},${top}H${x1 + r}Q${x1},${top} ${x1},${top + r}V${bottom - r}Q${x1},${bottom} ${x1 + r},${bottom}H${x0}Z`;
            const color = gain ? "var(--pos)" : "var(--neg)";
            const content = () => {
              const rows: TipRow[] = [{ color, value: fmt(d.value), label: "contribution" }];
              return { title: d.label + " · " + d.sub, rows: rows.concat(d.extra ?? []) };
            };
            return (
              <g key={i} className="cat">
                {Math.abs(x1 - x0) > 0.5 && <path d={path} className="mark" style={{ fill: color }} />}
                <text x={gain ? x0 - 8 : x0 + 8} y={yc + 4} textAnchor={gain ? "end" : "start"} className="lab">
                  {d.label}
                </text>
                <text x={gain ? x1 + 6 : x1 - 6} y={yc + 4} textAnchor={gain ? "start" : "end"} className="val">
                  {fmt(d.value)}
                </text>
                <rect
                  x={0}
                  y={M.t + i * ROW}
                  width={width}
                  height={ROW}
                  className="hit"
                  tabIndex={0}
                  role="img"
                  aria-label={d.label + " " + fmt(d.value)}
                  {...tipHandlers(tip, content)}
                />
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}
