import type { ReactNode } from "react";
import { Legend } from "./Legend";
import { barPath, niceTicks } from "./scale";
import { tipHandlers, useTooltip, type TipRow } from "./Tooltip";
import { useChartWidth } from "./useChartWidth";

export type ColumnSeries = { name: string; color: string; values: number[] };

export type ColumnChartProps = {
  cats: string[];
  series: ColumnSeries[];
  /** Stack the series in each category (positives up, negatives down) instead of grouping them. */
  stacked?: boolean;
  /** Index of the highlighted category. */
  selected?: number;
  /** Makes each category a button that selects it (click, Enter or Space). */
  onSelect?: (i: number) => void;
  /** Axis label. */
  yFmt: (v: number) => string;
  /** Value in tooltips and accessible names. */
  tipFmt: (v: number) => string;
  /** Text above a category's column, or null for none. */
  topLabel?: (i: number) => string | null;
  /** Extra tooltip rows for a category. */
  extraTip?: (i: number) => TipRow[];
  height?: number;
  /** Accessible name of the chart. */
  label: string;
};

const M = { t: 22, r: 8, b: 30, l: 58 };

export function ColumnChart({
  cats,
  series,
  stacked,
  selected,
  onSelect,
  yFmt,
  tipFmt,
  topLabel,
  extraTip,
  height,
  label,
}: ColumnChartProps) {
  const [ref, width] = useChartWidth();
  const tip = useTooltip();
  const H = height ?? 260;
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  let lo = 0;
  let hi = 0;
  cats.forEach((_, i) => {
    if (stacked) {
      let up = 0;
      let down = 0;
      series.forEach((s) => {
        if (s.values[i] >= 0) up += s.values[i];
        else down += s.values[i];
      });
      hi = Math.max(hi, up);
      lo = Math.min(lo, down);
    } else {
      series.forEach((s) => {
        hi = Math.max(hi, s.values[i]);
        lo = Math.min(lo, s.values[i]);
      });
    }
  });
  const ticks = niceTicks(lo, hi, 5);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const Y = (v: number) => M.t + ih - ((v - t0) / (t1 - t0)) * ih;
  const band = iw / cats.length;
  const nS = stacked ? 1 : series.length;
  const bw = Math.max(6, Math.min(24, (band * 0.72 - (nS - 1) * 2) / nS)); // bars are at most 24 px wide

  // On a narrow chart, label every other (every third, ...) category rather than letting
  // labels overlap; counted back from the last so the latest always has its label.
  // Roughly 6 px per character of the 12 px category labels and the 11.5 px top labels.
  const thin = (chars: number) => Math.max(1, Math.ceil((chars * 6 + 4) / band));
  const catEvery = thin(Math.max(0, ...cats.map((c) => c.length)));
  const topEvery = thin(Math.max(0, ...cats.map((_, i) => topLabel?.(i)?.length ?? 0)));
  const shown = (i: number, every: number) => (cats.length - 1 - i) % every === 0;

  const marks = (i: number, cx: number): ReactNode[] => {
    const out: ReactNode[] = [];
    if (stacked) {
      const up = series.map((s, k) => (s.values[i] > 0 ? k : -1)).filter((k) => k >= 0);
      const down = series.map((s, k) => (s.values[i] < 0 ? k : -1)).filter((k) => k >= 0);
      let a = 0;
      let b = 0;
      series.forEach((s, k) => {
        const v = s.values[i];
        if (!v) return;
        let from: number;
        let to: number;
        let outer: boolean; // only the segment at the end of its stack is rounded
        if (v > 0) {
          from = a;
          to = a + v;
          a = to;
          outer = k === up[up.length - 1];
        } else {
          from = b;
          to = b + v;
          b = to;
          outer = k === down[down.length - 1];
        }
        let yb = Y(from);
        const ye = Y(to);
        if (from !== 0) yb += v > 0 ? -2 : 2; // 2 px gap between stacked segments
        const d = barPath(cx - bw / 2, bw, yb, ye, outer);
        if (d) out.push(<path key={k} d={d} className="mark" style={{ fill: s.color }} />);
      });
    } else {
      const gw = nS * bw + (nS - 1) * 2;
      series.forEach((s, k) => {
        const d = barPath(cx - gw / 2 + k * (bw + 2), bw, Y(0), Y(s.values[i]), true);
        if (d) out.push(<path key={k} d={d} className="mark" style={{ fill: s.color }} />);
      });
    }
    return out;
  };

  return (
    <>
      {series.length >= 2 && <Legend items={series.map((s) => ({ label: s.name, color: s.color }))} />}
      <div className="chart" ref={ref}>
        <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="group" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? "base" : "grid"} />
              <text x={M.l - 8} y={Y(t) + 4} textAnchor="end" className="ax">
                {yFmt(t)}
              </text>
            </g>
          ))}
          {cats.map((c, i) => {
            const cx = M.l + band * i + band / 2;
            const isSel = selected === i;
            const top = topLabel?.(i);
            const content = () => {
              const rows: TipRow[] = series.map((s) => ({ color: s.color, value: tipFmt(s.values[i]), label: s.name }));
              return { title: c, rows: rows.concat(extraTip?.(i) ?? []) };
            };
            const select = onSelect && (() => onSelect(i));
            return (
              <g key={i} className="cat">
                {isSel && (
                  <rect x={M.l + band * i + 2} y={M.t - 18} width={band - 4} height={ih + 18} rx={6} className="selbg" />
                )}
                {marks(i, cx)}
                {top && shown(i, topEvery) && (
                  <text x={cx} y={M.t - 6} textAnchor="middle" className="val">
                    {top}
                  </text>
                )}
                {(isSel || shown(i, catEvery)) && (
                  <text x={cx} y={H - 10} textAnchor="middle" className={"lab" + (isSel ? " sel" : "")}>
                    {c}
                  </text>
                )}
                <rect
                  x={M.l + band * i}
                  y={M.t - 18}
                  width={band}
                  height={ih + 18 + M.b}
                  className="hit"
                  tabIndex={0}
                  role={onSelect ? "button" : "img"}
                  aria-pressed={onSelect ? isSel : undefined}
                  aria-label={c + ": " + series.map((s) => s.name + " " + tipFmt(s.values[i])).join(", ")}
                  onClick={select}
                  onKeyDown={
                    select &&
                    ((e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select();
                      }
                    })
                  }
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
