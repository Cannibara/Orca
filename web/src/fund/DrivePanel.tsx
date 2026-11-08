import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTooltip } from "../charts/Tooltip";
import type { Stock } from "../data/api";
import type { Contrib } from "../data/types";
import { byMagnitude, driveItems, headline, itemTip, periodRows, quartersIn, sumOf, tableView, TABLE_CAP, waterfall, type WfBar } from "./drive";
import { fPP } from "./fmt";
import { useGrowOnce, useWidth } from "./hooks";
import { PeriodStrip } from "./PeriodStrip";
import { spanName, type Series, type Win } from "./series";
import { resolvePeriod, type Span } from "./span";
import "./drive.css";

export type DrivePanelProps = {
  series: Series;
  win: Win;
  contrib: Contrib;
  stocks: Map<number, Stock>;
  /** The selected year label (a period of just that year when `cr` is unset). */
  sel: string | null;
  /** The What-drove period as year labels; null = just `sel`. */
  cr: Span | null;
  onCr: (span: Span) => void;
};

const ICONS = {
  table: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M6.5 6.5V13" /></>,
  bars: <path d="M3.5 13V8.5M8 13V3.5M12.5 13V6.5" />,
  prev: <path d="M9.75 4 5.75 8l4 4" />,
  next: <path d="M6.25 4l4 4-4 4" />,
  inbox: <path d="M2.5 9.5l1.75-5.5h7.5l1.75 5.5v3h-11v-3zM2.5 9.5h3.5l.75 1.5h2.5L10 9.5h3.5" />,
};

function Ico({ name, size }: { name: keyof typeof ICONS; size?: "s20" }) {
  return (
    <svg className={"ico" + (size ? " " + size : "")} viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const STRIP_LABEL = "Period for what drove the return. Drag the handles or the box, or use the arrow keys on a handle.";
const WF_LABEL = "Contribution to return by stock, percentage points, as a waterfall";

/**
 * "What drove ...": the stocks behind the return of a period of years as a waterfall of
 * percentage points, with the strip that picks the period, a one-line summary and a
 * numbers table. The period itself lives in the page (`cr`), so it survives the window.
 */
export function DrivePanel({ series, win, contrib, stocks, sel, cr, onCr }: DrivePanelProps) {
  const labels = useMemo(() => win.years.map((y) => y.label), [win.years]);
  const n = labels.length;
  const { a, b } = resolvePeriod(labels, cr, sel);
  const has = n > 0;
  const span = has ? spanName(labels[a], labels[b]) : "";
  const sig = has ? `${sel}|${labels[a]}|${labels[b]}` : "";

  const rows = useMemo(() => (has ? periodRows(contrib, stocks, labels.slice(a, b + 1)) : []), [has, contrib, stocks, labels, a, b]);
  const byMag = useMemo(() => byMagnitude(rows), [rows]);
  const total = useMemo(() => sumOf(rows), [rows]);

  const [table, setTable] = useState(false);
  const [showAll, setShowAll] = useState<string | null>(null); // the period whose table was expanded
  const host = useRef<HTMLDivElement>(null);
  const W = useWidth(host, 280, 480);
  const { cls, settle } = useGrowOnce(host, { durMs: 2400 });
  const items = useMemo(() => driveItems(byMag, W), [byMag, W]);
  const wf = useMemo(() => waterfall(items, total, W), [items, total, W]);

  // A new period or a resize must not replay the grow-in: the finished chart just takes the new shape.
  useEffect(() => settle(), [sig, W, settle]);

  // A period chosen elsewhere (a bar in the Returns chart) fades the chart in; one made here (strip, stepper) does not.
  const mine = useRef<string | null>(null);
  const prev = useRef(sig);
  useEffect(() => {
    if (prev.current === sig) return;
    prev.current = sig;
    if (mine.current === sig) {
      mine.current = null;
      return;
    }
    const el = host.current;
    if (!el) return;
    el.classList.remove("swap");
    void el.offsetWidth; // restart the animation
    el.classList.add("swap");
  }, [sig]);

  const commit = (na: number, nb: number) => {
    if (na === a && nb === b) return;
    mine.current = `${sel}|${labels[na]}|${labels[nb]}`;
    onCr({ a: labels[na], b: labels[nb] });
  };
  const shift = (dx: number) => {
    const len = b - a;
    const na = clamp(a + dx, 0, n - 1 - len);
    commit(na, na + len);
  };

  const tip = useTooltip();
  const [hov, setHov] = useState({ i: 0, on: false });
  const hit = wf.bars[Math.min(hov.i, wf.bars.length - 1)]?.hit;
  const hover = (bar: WfBar, x: number, y: number) => {
    const t = itemTip(bar.item, span);
    tip.show({ title: t.title, rows: [{ color: t.color, value: t.value, big: true }], note: t.note }, x, y, { place: "cursor" });
    setHov((h) => (h.on && h.i === bar.i ? h : { i: bar.i, on: true }));
  };
  const unhover = () => {
    tip.hide();
    setHov((h) => (h.on ? { ...h, on: false } : h));
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const el = (e.target as Element).closest(".hit");
    if (!el) return;
    const hits = Array.from(e.currentTarget.querySelectorAll<SVGElement>(".hit"));
    const i = hits.indexOf(el as SVGElement);
    const k = e.key;
    const nx = k === "ArrowRight" ? i + 1 : k === "ArrowLeft" ? i - 1 : k === "Home" ? 0 : k === "End" ? hits.length - 1 : null;
    if (nx !== null && hits[nx]) {
      e.preventDefault();
      hits[nx].focus();
    }
  };

  const head = rows.length ? headline(rows, span, quartersIn(series, win.years[a].year, win.years[b].year)) : null;
  const tv = table && rows.length ? tableView(rows, byMag, showAll === sig) : null;

  return (
    <section className="panel" id="drvPanel" aria-labelledby="drvTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="drvTitle">
            {has ? "What drove " + span : "What drove the return"}
          </h3>
          <p className="ps">
            Contribution to return, percentage points. The biggest movers are named; the rest are grouped. Drag the handles to add years.
          </p>
        </div>
        {has && (
          <div className="ph-c">
            <div className="stepper" role="group" aria-label="Period">
              <button type="button" aria-label="Earlier period" disabled={a <= 0} onClick={() => shift(-1)}>
                <Ico name="prev" />
              </button>
              <output aria-live="polite">{span}</output>
              <button type="button" aria-label="Later period" disabled={b >= n - 1} onClick={() => shift(1)}>
                <Ico name="next" />
              </button>
            </div>
            <button type="button" className="btn btn-secondary sm" aria-pressed={table} onClick={() => setTable((t) => !t)}>
              <Ico name={table ? "bars" : "table"} />
              <span>{table ? "Show the chart" : "Show the numbers"}</span>
            </button>
          </div>
        )}
      </div>
      {has && <PeriodStrip variant="years" names={labels} a={a} b={b} onChange={commit} ariaLabel={STRIP_LABEL} />}
      <p className="headline">
        {head && (
          <>
            <b>{head.span}</b> <span className="hmeta">{head.meta}</span> {head.text}
          </>
        )}
      </p>
      <div className="pb">
        <div className="chart" ref={host}>
          {!rows.length ? (
            <div className="state">
              <span className="ic">
                <Ico name="inbox" size="s20" />
              </span>
              <h4>{has ? "No stock-level detail for " + span : "No stock-level detail yet"}</h4>
              <p>Orca needs two consecutive filings to attribute a period.</p>
            </div>
          ) : tv ? (
            <>
              <div className="tbl-box">
                <table className="tbl-mini">
                  <caption>Contribution to return, {span}, percentage points</caption>
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col" className="tl">
                        Company
                      </th>
                      <th scope="col">Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tv.rows.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">{r.t}</th>
                        <td className="tl">{r.name}</td>
                        <td>{fPP(r.v, 2)}</td>
                      </tr>
                    ))}
                    {tv.hidden > 0 && (
                      <tr>
                        <th scope="row">Other</th>
                        <td className="tl">{tv.hidden} smaller contributors</td>
                        <td>{fPP(tv.hiddenSum, 2)}</td>
                      </tr>
                    )}
                    <tr>
                      <th scope="row">Total</th>
                      <td className="tl">Sum of listed</td>
                      <td>{fPP(tv.total, 2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {tv.hidden > 0 && (
                <div className="tbl-more">
                  <span>
                    Showing the {TABLE_CAP} biggest movers of {rows.length} stocks.
                  </span>
                  <button type="button" className="btn btn-secondary sm" onClick={() => setShowAll(sig)}>
                    Show all {rows.length}
                  </button>
                </div>
              )}
            </>
          ) : (
            <svg
              className={"viz wf c3" + cls}
              viewBox={`0 0 ${wf.W} ${wf.H}`}
              width={wf.W}
              height={wf.H}
              role="group"
              aria-label={WF_LABEL}
              style={{ "--step": wf.step.toFixed(1) + "ms" } as CSSProperties}
              onKeyDown={onKeyDown}
            >
              {wf.ticks?.map((t, i) => (
                <g key={"g" + i}>
                  <line className="grid" x1={wf.ml} x2={wf.W - wf.mr} y1={t.y} y2={t.y} />
                  <text className="tick" x={wf.ml - 10} y={+(t.y + 4).toFixed(1)} textAnchor="end">
                    {t.text}
                  </text>
                </g>
              ))}
              <rect className={"hovband" + (hov.on ? " on" : "")} x={hit?.x ?? 0} y={0} width={hit?.w ?? 10} height={wf.H} rx={6} />
              {wf.bars.map((bar) => (
                <g key={bar.i}>
                  <path
                    className={"bar " + bar.cls}
                    style={{ "--i": bar.i, transformOrigin: "50% " + (bar.up ? "100%" : "0%") } as CSSProperties}
                    d={bar.d}
                  />
                  <text className="blab" style={{ "--i": bar.i } as CSSProperties} x={bar.cx} y={bar.labelY} textAnchor="middle" aria-hidden="true">
                    {bar.label}
                  </text>
                  <text className="rl-t" x={bar.cx} y={bar.tickY} textAnchor="middle">
                    {bar.tick}
                  </text>
                  {bar.nm && (
                    <text className="rl-n" x={bar.cx} y={bar.nmY} textAnchor="middle">
                      {bar.nm}
                    </text>
                  )}
                </g>
              ))}
              <line className="zero" x1={wf.ml} x2={wf.W - wf.mr} y1={wf.zeroY} y2={wf.zeroY} />
              <g className="late">
                {wf.conns.map((c, i) => (
                  <line key={i} className="conn" x1={c.x1} x2={c.x2} y1={c.y} y2={c.y} />
                ))}
              </g>
              {wf.bars.map((bar) => (
                <rect
                  key={bar.i}
                  className="hit"
                  x={bar.hit.x}
                  y={0}
                  width={bar.hit.w}
                  height={wf.H}
                  rx={6}
                  tabIndex={0}
                  role="img"
                  aria-label={bar.aria}
                  onPointerEnter={(e) => hover(bar, e.clientX, e.clientY)}
                  onPointerMove={(e) => hover(bar, e.clientX, e.clientY)}
                  onPointerLeave={unhover}
                  onFocus={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    hover(bar, r.left + r.width / 2 - 14, r.top + r.height / 2);
                  }}
                  onBlur={unhover}
                />
              ))}
            </svg>
          )}
        </div>
      </div>
    </section>
  );
}
