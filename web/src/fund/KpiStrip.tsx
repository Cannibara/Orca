import type { ReactNode } from "react";
import { f1, fPct } from "./fmt";
import { returnYears, spanKpi, spanName, type Series, type SpanKpi, type Win } from "./series";
import { resolveBracket, type Span } from "./span";
import "./returns.css";

// The four tiles under the header. They follow the bracket of the Annual returns chart: the
// figures are for the calendar years from its left arrow to its right arrow, computed from the
// quarterly returns inside them (series.spanKpi). Each tile has a small picture of the same span.

const W = 84; // sparkline viewBox, in px
const H = 30;

const d1 = (v: number) => v.toFixed(1);

/** Growth of $1: the chained index as a line, a faint rule at 1.00 and a dot on the last quarter. */
export function growthSpark(idx: number[]) {
  const mn = Math.min(...idx);
  const mx = Math.max(...idx);
  const range = mx - mn || 1;
  const pts = idx.map((v, i) => [2 + (i / Math.max(1, idx.length - 1)) * (W - 6), H - 3 - ((v - mn) / range) * (H - 8)] as const);
  const d = pts.map((p, i) => (i ? "L" : "M") + d1(p[0]) + "," + d1(p[1])).join("");
  return { d, zy: H - 3 - ((1 - mn) / range) * (H - 8), last: pts[pts.length - 1] };
}

/** One tick per full year in the span, up for a gain and down for a loss. */
export function tickSpark(rets: number[]) {
  const k = Math.max(1, rets.length);
  const gap = k > 14 ? 1 : 2;
  const bw = (W - gap * (k - 1)) / k;
  const mid = H / 2;
  return { mid, ticks: rets.map((v, i) => ({ x: i * (bw + gap), y: v > 0 ? mid - 11 : mid + 1, w: bw, gain: v > 0 })) };
}

/** The drawdown from the running peak as an area hanging from the top rule. */
export function underwaterSpark(dd: number[]) {
  const md = Math.min(...dd) || -1;
  const q = dd.map((v, i) => [2 + (i / Math.max(1, dd.length - 1)) * (W - 4), 3 + (v / md) * (H - 8)] as const);
  const line = q.map((p, i) => (i ? "L" : "M") + d1(p[0]) + "," + d1(p[1])).join("");
  return { line, area: line + "L" + d1(q[q.length - 1][0]) + ",3L" + d1(q[0][0]) + ",3Z" };
}

/** Bars for the size of each year's move in the span; the biggest is darker. */
export function sizeSpark(rets: number[]) {
  const abs = rets.map(Math.abs);
  const mx = Math.max(0.1, ...abs);
  const n = abs.length;
  const bw = (W - 2 * (n - 1)) / n;
  return abs.map((v, i) => {
    const h = Math.max(1.5, (v / mx) * (H - 4));
    return { x: i * (bw + 2), y: H - h, w: bw, h, hi: v === mx };
  });
}

const dash = "–";

function Spark({ children }: { children: ReactNode }) {
  return (
    <div className="kpi-s">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {children}
      </svg>
    </div>
  );
}

export function KpiStrip({ series, win, br }: { series: Series; win: Win; br: Span | null }) {
  const ry = returnYears(win);
  const labels = ry.map((y) => y.label);
  const bs = resolveBracket(labels, br);
  const inSpan = ry.slice(bs.a, bs.b + 1);
  const k: SpanKpi | null = ry.length ? spanKpi(series, ry[bs.a].year, ry[bs.b].year) : null;
  const full = inSpan.filter((y) => !y.part).map((y) => y.ret as number);
  const rets = inSpan.map((y) => y.ret as number);

  const growth = k ? growthSpark(k.idx) : null;
  const ticks = k ? tickSpark(full) : null;
  const under = k ? underwaterSpark(k.dd) : null;
  const sizes = k ? sizeSpark(rets) : [];

  return (
    <>
      <p className="kpi-cap">
        {k ? (
          <>
            Tiles follow the Annual returns bracket: <b>{spanName(labels[bs.a], labels[bs.b])}</b>.
          </>
        ) : (
          "No year with a return yet."
        )}
      </p>
      <section className="kpis" aria-label="Key figures">
        <article className="kpi">
          <div className="kpi-l">Annualised return</div>
          <div className="kpi-v">{k && k.ann != null ? fPct(k.ann) : dash}</div>
          <div className="kpi-b">
            <div className="kpi-n">{k ? "Growth of $1: $" + k.growth.toFixed(2) : ""}</div>
            <Spark>
              {growth && (
                <>
                  <line className="spk-zero" x1="2" x2={W - 2} y1={d1(growth.zy)} y2={d1(growth.zy)} />
                  <path className="spk-line" d={growth.d} />
                  <circle className="spk-dot" cx={d1(growth.last[0])} cy={d1(growth.last[1])} r="3" />
                </>
              )}
            </Spark>
          </div>
        </article>
        <article className="kpi">
          <div className="kpi-l">Years positive</div>
          <div className="kpi-v">
            {k ? (
              <>
                {k.up}
                <span className="vh"> </span>
                <small>of {k.nFull}</small>
              </>
            ) : (
              dash
            )}
          </div>
          <div className="kpi-b">
            <div className="kpi-n">{k && k.qpos != null ? Math.round(k.qpos * 100) + "% of quarters positive" : ""}</div>
            <Spark>
              {ticks && (
                <>
                  {ticks.ticks.map((t, i) => (
                    <rect key={i} className={t.gain ? "spk-gain" : "spk-loss"} x={d1(t.x)} y={t.y} width={d1(t.w)} height="10" rx="1" />
                  ))}
                  <line className="spk-zero" x1="0" x2={W} y1={ticks.mid} y2={ticks.mid} />
                </>
              )}
            </Spark>
          </div>
        </article>
        <article className="kpi">
          <div className="kpi-l">Max drawdown</div>
          <div className="kpi-v">{k ? fPct(k.mdd) : dash}</div>
          <div className="kpi-b">
            <div className="kpi-n">{k ? "Peak to trough, quarterly" : ""}</div>
            <Spark>
              {under && (
                <>
                  <path className="spk-area-loss" d={under.area} />
                  <path className="spk-ln-loss" d={under.line} />
                  <line className="spk-zero" x1="2" x2={W - 2} y1="3" y2="3" />
                </>
              )}
            </Spark>
          </div>
        </article>
        <article className="kpi">
          <div className="kpi-l">Volatility</div>
          <div className="kpi-v">{k && k.vol != null ? f1(k.vol).replace("+", "") + "%" : dash}</div>
          <div className="kpi-b">
            <div className="kpi-n">Annualised</div>
            <Spark>
              {sizes.map((r, i) => (
                <rect key={i} className={"spk-neutral" + (r.hi ? " hi" : "")} x={d1(r.x)} y={d1(r.y)} width={d1(r.w)} height={d1(r.h)} rx="1" />
              ))}
            </Spark>
          </div>
        </article>
      </section>
    </>
  );
}
