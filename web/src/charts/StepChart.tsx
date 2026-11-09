import { useRef, useState, type PointerEvent } from "react";
import { useGrowOnce } from "../fund/hooks";
import { qLabel } from "../lib/format";
import { compact, niceTicks } from "./scale";
import { useTooltip } from "./Tooltip";
import { useChartWidth } from "./useChartWidth";
import "./charts.css";

export type StepChartProps = {
  /** Quarters (Q1 2013 = 0) in which the holding changed, ascending. */
  quarters: number[];
  /** Shares held from that quarter on: shares[i] applies from quarters[i] until quarters[i + 1]. */
  shares: number[];
  /** Last quarter drawn (inclusive); the final level is held through it. Default: the last change. */
  endQ?: number;
  /** Accessible name of the chart. */
  label?: string;
};

const H = 170;
const M = { t: 12, r: 14, b: 30, l: 52 };
const MIN_TICK_GAP = 5; // quarter ticks closer than this (px) are left out

export function StepChart({ quarters, shares, endQ, label = "Shares held by quarter" }: StepChartProps) {
  const [ref, width] = useChartWidth();
  const grow = useGrowOnce(ref, { durMs: 1400 });
  const tip = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null); // quarter under the pointer
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const changes = quarters.map((q, i) => ({ q, v: shares[i] })).sort((a, b) => a.q - b.q);
  // Two quarters of lead-in before the first change, as in the mockup.
  const qa = changes.length ? Math.max(0, changes[0].q - 2) : 0;
  const qb = Math.max(endQ ?? (changes.length ? changes[changes.length - 1].q : 0), qa);
  const slots = qb + 1 - qa;
  const levelAt = (q: number) => changes.reduce((v, c) => (c.q <= q ? c.v : v), 0);

  const top = Math.max(0, ...changes.map((c) => c.v)) || 1;
  const ticks = niceTicks(0, top * 1.05, 4);
  const t1 = ticks[ticks.length - 1];
  const X = (q: number) => M.l + ((q - qa) / slots) * iw; // left edge of quarter q's slot
  const Y = (v: number) => M.t + ih - (v / t1) * ih;

  // Start at zero, then for each change step to the new level and hold it until the next change.
  let d = changes.length ? `M${X(qa)},${Y(0)}` : "";
  changes.forEach((c, i) => {
    const until = i + 1 < changes.length ? changes[i + 1].q : qb + 1;
    if (i === 0) d += `H${X(c.q)}`;
    d += `V${Y(c.v)}H${X(until)}`;
  });
  const area = d && d + `V${Y(0)}H${X(qa)}Z`;

  const firstYear = Math.ceil(qa / 4); // year labels at the first quarter of each year
  const lastYear = Math.floor(qb / 4);
  const yearStep = Math.max(1, Math.ceil((lastYear - firstYear + 1) / Math.max(2, Math.floor(iw / 70))));
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y += yearStep) years.push(y);

  // One small tick per quarter edge under the baseline (taller at a new year), if there is room for them.
  const quarterTicks: number[] = [];
  if (iw / slots >= MIN_TICK_GAP) for (let q = qa; q <= qb + 1; q++) quarterTicks.push(q);

  const onOverlay = (e: PointerEvent<SVGRectElement>) => {
    const b = svgRef.current!.getBoundingClientRect();
    const sx = (e.clientX - b.left) * (b.width > 0 ? width / b.width : 1); // client px → svg units
    const q = Math.max(qa, Math.min(qb, Math.floor(qa + ((sx - M.l) / iw) * slots)));
    setHover(q);
    tip.show(
      { title: qLabel(q), rows: [{ color: "var(--gain)", value: levelAt(q).toLocaleString("en-US"), label: "shares held" }] },
      e.clientX,
      e.clientY,
      { place: "cursor" },
    );
  };

  const hoverX = hover != null && hover <= qb ? (X(hover) + X(hover + 1)) / 2 : null;

  return (
    <div className="stc">
      <div className="chart" ref={ref}>
        <svg ref={svgRef} className={"stsvg" + grow.cls} viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="group" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? "base" : "grid"} />
              <text x={M.l - 8} y={Y(t) + 4} textAnchor="end" className="ax">
                {compact(t)}
              </text>
            </g>
          ))}
          {quarterTicks.map((q) => (
            <line
              key={q}
              className={"qtick" + (q % 4 === 0 ? " yr" : "")}
              x1={X(q)}
              x2={X(q)}
              y1={M.t + ih}
              y2={M.t + ih + (q % 4 === 0 ? 6 : 3)}
            />
          ))}
          {years.map((y) => (
            <text key={y} x={X(y * 4)} y={H - 8} textAnchor="middle" className="ax">
              {2013 + y}
            </text>
          ))}
          <rect
            className="overlay"
            x={M.l}
            y={M.t}
            width={iw}
            height={ih}
            fill="transparent"
            onPointerEnter={onOverlay}
            onPointerMove={onOverlay}
            onPointerLeave={() => {
              setHover(null);
              tip.hide();
            }}
          />
          <g className="stdraw">
            {area && <path className="step-area" d={area} />}
            {d && <path className="step-line" d={d} fill="none" strokeLinejoin="round" />}
          </g>
          {hoverX != null && hover != null && (
            <>
              <line className="base crosshair" x1={hoverX} x2={hoverX} y1={M.t} y2={M.t + ih} />
              <circle className="crosshair-dot" cx={hoverX} cy={Y(levelAt(hover))} r={4} />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
