import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Trade } from "../data/types";
import { useGrowOnce } from "../fund/hooks";
import { px, qLabel, sgn } from "../lib/format";
import { tradeMove } from "../lib/live";
import { Legend, type LegendItem } from "./Legend";
import { compact, linePath, markerPath, niceTicks } from "./scale";
import { tipHandlers, useTooltip, type TipRow } from "./Tooltip";
import { useChartWidth } from "./useChartWidth";
import "./charts.css";

export type PriceChartProps = {
  /** Weekly closes: closes[i] is the close of the week ending `start` + 7 i days; null = no close that week (a gap). */
  closes: (number | null)[];
  /** ISO date of the first week's Friday. */
  start: string;
  /** The fund's trades in this stock, with estimated prices and each quarter's low-high. */
  trades: Trade[];
  /** The latest price: the line ends in a dot at it, with its label. Omit to end the line at its last close. */
  latest?: number;
  /** Accessible name of the chart. */
  label?: string;
};

const M = { t: 14, r: 14, b: 30, l: 52 };
const WEEK = 7 * 864e5;
const LEGEND: LegendItem[] = [
  { label: "Weekly close", color: "var(--ink)", kind: "lk" },
  { label: "Buy (est. price)", color: "var(--gain)", kind: "up" },
  { label: "Sell (est. price)", color: "var(--loss)", kind: "dn" },
  { label: "Quarter low–high", color: "var(--rng)", kind: "sw" },
];

// Quarter q covers calendar quarter q % 4 of year 2013 + floor(q / 4).
const qStartMs = (q: number) => Date.UTC(2013 + Math.floor(q / 4), (q % 4) * 3, 1);
const qMidMs = (q: number) => (qStartMs(q) + qStartMs(q + 1)) / 2;

const dollars = (t: number) => "$" + +t.toFixed(2);

export function PriceChart({ closes, start, trades, latest, label = "Weekly price with estimated trade prices" }: PriceChartProps) {
  const [ref, width] = useChartWidth();
  // The grow-in plays once, when the chart first scrolls into view; a resize or a hover never restarts it.
  const grow = useGrowOnce(ref, { durMs: 1400 });
  const tip = useTooltip();
  const svgRef = useRef<SVGSVGElement>(null);
  const touched = useRef(false); // the last press on a trade marker was a finger
  const [hover, setHover] = useState<number | null>(null); // week index under the pointer
  const H = width < 480 ? 240 : 300;
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const startMs = Date.parse(start);
  const weekOf = (ms: number) => (ms - startMs) / WEEK; // fractional week index of a date
  const weekDate = (i: number) =>
    new Date(startMs + i * WEEK).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

  // x domain (in weeks): from two quarters before the first trade to the last week, as in
  // the mockup, but never before the first priced week unless a trade needs the room.
  let xi0 = 0;
  let xi1 = Math.max(0, closes.length - 1);
  if (trades.length) {
    const qs = trades.map((t) => t.q);
    const first = Math.min(...qs);
    xi0 = Math.min(Math.max(weekOf(qStartMs(Math.max(0, first - 2))), 0), weekOf(qStartMs(first)));
    xi1 = Math.max(xi1, weekOf(qMidMs(Math.max(...qs))));
  }
  const X = (w: number) => M.l + ((w - xi0) / Math.max(1, xi1 - xi0)) * iw;
  const iLo = Math.max(0, Math.ceil(xi0)); // first and last week drawn
  const iHi = Math.min(closes.length - 1, Math.floor(xi1));

  let lo = Infinity;
  let hi = -Infinity;
  const see = (v: number | null | undefined) => {
    if (v == null) return;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  };
  let iLast = -1; // last week with a close
  for (let i = iLo; i <= iHi; i++) {
    see(closes[i]);
    if (closes[i] != null) iLast = i;
  }
  trades.forEach((t) => {
    see(t.px);
    see(t.low);
    see(t.high);
  });
  see(latest);
  if (!Number.isFinite(lo)) {
    lo = 0; // nothing priced and no trades: an empty 0-1 axis
    hi = 1;
  }
  const ticks = niceTicks(Math.max(0, lo * 0.95), hi * 1.02, 5);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const Y = (v: number) => M.t + ih - ((v - t0) / (t1 - t0)) * ih;

  // Year labels at 1 January, thinned to fit.
  const ms0 = startMs + xi0 * WEEK;
  const ms1 = startMs + xi1 * WEEK;
  const y0 = new Date(ms0).getUTCFullYear();
  const y1 = new Date(ms1).getUTCFullYear();
  const firstYear = Date.UTC(y0, 0, 1) >= ms0 - 1 ? y0 : y0 + 1;
  const lastYear = Date.UTC(y1, 0, 1) <= ms1 + 1 ? y1 : y1 - 1;
  const yearStep = Math.max(1, Math.ceil((lastYear - firstYear + 1) / Math.max(2, Math.floor(iw / 70))));
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y += yearStep) years.push(y);

  const line = linePath(
    closes.slice(iLo, iHi + 1).map((v, k) => (v == null ? null : ([X(iLo + k), Y(v)] as const))),
  );

  const onOverlay = (e: PointerEvent<SVGRectElement>) => {
    if (iHi < iLo) return;
    const b = svgRef.current!.getBoundingClientRect();
    const sx = (e.clientX - b.left) * (b.width > 0 ? width / b.width : 1); // client px → svg units
    const w = xi0 + ((sx - M.l) / iw) * (xi1 - xi0);
    const i = Math.max(iLo, Math.min(iHi, Math.round(w)));
    const c = closes[i];
    setHover(i);
    tip.show(
      { title: weekDate(i), rows: [{ color: "var(--invfg)", value: px(c), label: c == null ? "no close" : "weekly close" }] },
      e.clientX,
      e.clientY,
      { place: "cursor" },
    );
  };
  const hoverClose = hover != null && hover <= iHi ? closes[hover] : null;

  return (
    <div className="pxc">
      <Legend items={LEGEND} />
      <div className="chart" ref={ref}>
        <svg
          ref={svgRef}
          className={"pxsvg" + grow.cls}
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          role="group"
          aria-label={label}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={Y(t)} y2={Y(t)} className="grid" />
              <text x={M.l - 8} y={Y(t) + 4} textAnchor="end" className="ax">
                {dollars(t)}
              </text>
            </g>
          ))}
          {years.map((y) => (
            <text key={y} x={X(weekOf(Date.UTC(y, 0, 1)))} y={H - 10} textAnchor="middle" className="ax">
              {y}
            </text>
          ))}
          <line x1={M.l} x2={width - M.r} y1={M.t + ih} y2={M.t + ih} className="base" />
          {/* Under the drawing, so the pointer reaches it everywhere but on a trade marker. */}
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
          <g className="pxdraw">
            {trades.map(
              (t, k) =>
                t.low != null &&
                t.high != null && (
                  <rect
                    key={k}
                    className="band"
                    x={X(weekOf(qMidMs(t.q))) - 4}
                    y={Y(t.high)}
                    width={8}
                    height={Math.max(2, Y(t.low) - Y(t.high))}
                    rx={4}
                  />
                ),
            )}
            <path className="price-line" d={line} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {latest != null && iLast >= 0 && (
              <>
                <circle className="pxdot" cx={X(iLast)} cy={Y(latest)} r={3.5} />
                <text className="blab" x={X(iLast) - 8} y={Y(latest) - 9} textAnchor="end">
                  {"$" + latest.toFixed(2)}
                </text>
              </>
            )}
            {trades.map((t, k) => {
              const buy = t.delta > 0;
              const kind = tradeMove(t);
              const cx = X(weekOf(qMidMs(t.q)));
              const cy = Y(t.px);
              const color = buy ? "var(--gain)" : "var(--loss)";
              const h = tipHandlers(
                tip,
                () => {
                  const rows: TipRow[] = [{ color, value: px(t.px), label: "est. price (VWAP)" }];
                  if (t.low != null && t.high != null) rows.push({ value: px(t.low) + " – " + px(t.high), label: "quarter range" });
                  rows.push({ value: sgn(t.delta) + compact(Math.abs(t.delta)), label: "shares" });
                  return { title: kind + " · " + qLabel(t.q), rows };
                },
                { place: "cursor" },
              );
              // A finger leaves as soon as it taps, so on touch the tooltip stays until focus moves on (a tap focuses the triangle).
              const leave = (e: PointerEvent<Element>) => {
                if (e.pointerType !== "touch") h.onPointerLeave();
              };
              // The browser's own focus move to the tapped (non-focusable) target comes after pointerup, so focus on click.
              const focusOnTouch = (e: MouseEvent<SVGCircleElement>) => {
                if (touched.current) (e.currentTarget.nextElementSibling as SVGElement | null)?.focus();
              };
              return (
                <g key={k}>
                  {/* A larger invisible target for the pointer; the triangle itself takes keyboard focus. */}
                  <circle
                    className="mk-hit"
                    cx={cx}
                    cy={cy + (buy ? -3 : 3)}
                    r={12}
                    fill="transparent"
                    onPointerEnter={h.onPointerEnter}
                    onPointerMove={h.onPointerMove}
                    onPointerLeave={leave}
                    onPointerDown={(e) => {
                      touched.current = e.pointerType === "touch";
                    }}
                    onClick={focusOnTouch}
                  />
                  <path
                    className={"mk " + (buy ? "buy" : "sell")}
                    d={markerPath(cx, cy, buy)}
                    tabIndex={0}
                    aria-label={kind + " " + qLabel(t.q) + " at about " + px(t.px)}
                    {...h}
                    onPointerLeave={leave}
                  />
                </g>
              );
            })}
          </g>
          {hover != null && hover <= iHi && (
            <>
              <line className="base crosshair" x1={X(hover)} x2={X(hover)} y1={M.t} y2={M.t + ih} />
              {hoverClose != null && <circle className="crosshair-dot" cx={X(hover)} cy={Y(hoverClose)} r={4} />}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
