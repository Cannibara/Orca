import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Skill } from "../data/types";
import { useTooltip, type TipContent } from "../charts/Tooltip";
import { money } from "../lib/format";
import { ViewIcon } from "./AumPanel";
import "./aum.css";
import { ChartSlot } from "./ChartSlot";
import { qShort } from "./fmt";
import { useGrowOnce, useWidth } from "./hooks";
import { Seg } from "./Seg";
import { spanName } from "./series";
import { pts, tierOf, tierWords, yearRows, type Tier, type TierWords, type YearRow } from "./skill";
import "./skill.css";
import { linesLayout, nearestQuarter, ret1, stackedLayout, type LineKey, type LinesLayout } from "./stacked";

const css = (o: Record<string, string | number>): CSSProperties => o as CSSProperties;
const sc = (v: number) => (v >= 0 ? "var(--gain)" : "var(--loss)");
type View = "stacked" | "lines";

/** A year's split: the market, the two choices, the fund, and the S&P 500 for reference. */
function yearTip(y: YearRow, w: TierWords): TipContent {
  return {
    title: y.name,
    part: y.part,
    rows: [
      { color: sc(y.m), label: "Whole market", value: ret1(y.m) },
      { color: sc(y.alloc), label: w.choice, value: pts(y.alloc) },
      { color: sc(y.pick), label: "Stock choice", value: pts(y.pick) },
      { label: "Fund", value: ret1(y.f), sum: true },
    ],
    note: "S&P 500, for reference: " + ret1(y.spy),
  };
}

const LINE_COLOR: Record<LineKey, string> = {
  fund: "var(--gain)",
  label: "color-mix(in srgb,var(--gain) 50%,var(--surface))",
  mkt: "var(--ink3)",
  spy: "var(--ink3)",
};

/** Bars: one per year, AUM's look and behaviour (hover band, pinned tooltip, arrow keys). */
function StackedChart({ rows, w, grow, table }: { rows: YearRow[]; w: TierWords; grow: string; table: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const W = useWidth(host, 280, 600);
  const L = stackedLayout(rows, W, w);
  const tip = useTooltip();
  const id = useId().replace(/:/g, "");
  const [band, setBand] = useState({ i: 0, on: false });
  const pinned = (i: number) => {
    const el = host.current;
    tip.show(yearTip(rows[i], w), 0, 0, el ? { place: { pin: el } } : undefined);
    setBand((b) => (b.i === i && b.on ? b : { i, on: true }));
  };
  const unpin = () => {
    tip.hide();
    setBand((b) => (b.on ? { ...b, on: false } : b));
  };
  const hitIndex = (e: { target: EventTarget }): number | null => {
    const el = (e.target as Element).closest(".hit");
    return el ? Number(el.getAttribute("data-i")) : null;
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const i = hitIndex(e);
    if (i === null) return;
    const hits = svg.current ? Array.from(svg.current.querySelectorAll<SVGRectElement>(".hit")) : [];
    let nx: number | null = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (e.key === "Home") nx = 0;
    if (e.key === "End") nx = hits.length - 1;
    if (nx !== null && hits[nx]) {
      e.preventDefault();
      hits[nx].focus();
    }
  };
  const bandX = L.G.ml + L.G.band * band.i;
  return (
    <div className="chart" ref={host}>
      <ChartSlot table={table}>
        <svg
          ref={svg}
          className={"viz c2" + grow}
          viewBox={`0 0 ${L.W} ${L.H}`}
          width={L.W}
          height={L.H}
          role="group"
          aria-label={`Each calendar year's return, split into the whole market, ${w.choice.toLowerCase()} and stock choice.`}
          style={css({ "--y0": L.z.toFixed(1) + "px", "--step": L.step.toFixed(1) + "ms" })}
          onPointerMove={(e: PointerEvent<SVGSVGElement>) => {
            const i = hitIndex(e);
            if (i === null) unpin();
            else pinned(i);
          }}
          onPointerLeave={unpin}
          onFocus={(e) => {
            const i = hitIndex(e);
            if (i !== null) pinned(i);
          }}
          onBlur={unpin}
          onKeyDown={onKey}
        >
          <defs>
            {(["up", "dn"] as const).map((s) => (
              <pattern key={s} id={`stk-${s}-${id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect className={"hf-" + s} width="1.7" height="5" />
              </pattern>
            ))}
          </defs>
          {L.G.axis &&
            L.ticks.map((t) => (
              <g key={t.v}>
                <line className="grid" x1={L.G.ml} x2={L.W - L.G.mr} y1={t.y} y2={t.y} />
                <text className="tick" x={L.G.ml - 10} y={t.y + 4} textAnchor="end">
                  {t.text}
                </text>
              </g>
            ))}
          <rect className={"hovband" + (band.on ? " on" : "")} x={bandX} y={2} width={L.G.band} height={L.H - 4} rx={6} />
          {L.segs.map((s, k) => (
            <path
              key={k}
              className={`bar ${s.cls} ${s.sign > 0 ? "up" : "dn"}`}
              style={css(s.cls === "sel" ? { "--i": s.i, fill: `url(#stk-${s.sign > 0 ? "up" : "dn"}-${id})` } : { "--i": s.i })}
              d={s.d}
            />
          ))}
          <line className="zero" x1={L.G.ml} x2={L.W - L.G.mr} y1={+L.z.toFixed(1)} y2={+L.z.toFixed(1)} />
          {L.labels.map((b) => (
            <text key={b.i} className="blab" style={css({ "--i": b.i })} x={b.x} y={b.y} textAnchor="middle" aria-hidden="true">
              {b.text}
            </text>
          ))}
          {L.xItems.map((x) => (
            <text key={x.i} className="clab" x={x.x} y={x.y} textAnchor="middle">
              {x.text}
            </text>
          ))}
          {L.hits.map((h) => (
            <rect key={h.i} className="hit" data-i={h.i} x={h.x} y={0} width={h.width} height={L.H} rx={6} tabIndex={0} role="img" aria-label={h.label} />
          ))}
        </svg>
      </ChartSlot>
      {table && (
        <SkTable
          caption={`Each year: the whole market, ${w.choice.toLowerCase()}, stock choice and the fund`}
          head={["Year", "Whole market", w.choice, "Stock choice", "Fund", "S&P 500"]}
          rows={rows.map((r) => [r.name, ret1(r.m), pts(r.alloc), pts(r.pick), ret1(r.f), ret1(r.spy)])}
        />
      )}
    </div>
  );
}

/** Lines: what the money they put in would be worth in each replay, every quarter end, all drawn at once. */
function LinesChart({ skill, tier, w, table }: { skill: Skill; tier: Tier; w: TierWords; table: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const W = useWidth(host, 280, 600);
  const L: LinesLayout = linesLayout(skill, tier, W, w);
  const tip = useTooltip();
  const [at, setAt] = useState<number | null>(null);
  const n = L.q.length;
  const show = (i: number) => {
    setAt(i);
    const el = host.current;
    tip.show(
      {
        title: qShort(L.q[i]),
        rows: L.lines.map((l) => ({ color: LINE_COLOR[l.k], label: l.name, value: money(L.values[l.k][i]) })),
        note: "Put in that quarter: " + money(skill.quarters.bought[i]),
      },
      0,
      0,
      el ? { place: { pin: el } } : undefined, // pinned top left: the lines climb to the right
    );
  };
  const hide = () => {
    setAt(null);
    tip.hide();
  };
  const fromPointer = (e: PointerEvent<SVGRectElement>) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    show(nearestQuarter(L, ((e.clientX - r.left) / r.width) * L.W));
  };
  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    const cur = at ?? n - 1;
    const nx = e.key === "ArrowRight" ? cur + 1 : e.key === "ArrowLeft" ? cur - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (nx === null) return;
    e.preventDefault();
    show(Math.max(0, Math.min(n - 1, nx)));
  };
  const qs = L.q.map((q, i) => ({ q, i })).filter(({ q, i }) => ((q % 4) + 4) % 4 === 3 || i === n - 1);
  return (
    <div className="chart" ref={host}>
      <ChartSlot table={table}>
        <svg ref={svg} className="viz draw" viewBox={`0 0 ${L.W} ${L.H}`} width={L.W} height={L.H} role="group" aria-label="What the money they put in would be worth in each version, each quarter end.">
          {L.ticks.map((t) => (
            <g key={t.v}>
              <line className={t.v === 0 ? "zero" : "grid"} x1={L.ml} x2={L.W - L.mr} y1={t.y} y2={t.y} />
              {L.ml > 20 && (
                <text className="tick" x={L.ml - 10} y={t.y + 4} textAnchor="end">
                  {t.text}
                </text>
              )}
            </g>
          ))}
          {L.years.map((y) => (
            <text key={y.text} className="clab" x={y.x} y={L.H - 11} textAnchor="middle">
              {y.text}
            </text>
          ))}
          {at !== null && <line className="guide" x1={L.xs[at]} x2={L.xs[at]} y1={L.mt} y2={L.H - L.mb} />}
          {[...L.lines].reverse().map((l) => (
            <g key={l.k}>
              <path className={"ln " + l.k + (l.k === "spy" ? "" : " solid")} d={l.d} pathLength={l.k === "spy" ? undefined : 1} />
              {l.end && <circle className={"lend " + l.k} cx={l.end.x} cy={l.end.y} r={3.5} />}
            </g>
          ))}
          {L.ends.map((e) => (
            <text key={e.k} className="blab late" x={e.x} y={e.y} aria-hidden="true">
              {e.text}
            </text>
          ))}
          <rect
            className="hit"
            x={L.ml}
            y={0}
            width={Math.max(0, L.W - L.ml - L.mr)}
            height={L.H}
            tabIndex={0}
            role="img"
            aria-label="Use the arrow keys to read the values quarter by quarter."
            onPointerMove={fromPointer}
            onPointerLeave={hide}
            onFocus={() => show(at ?? n - 1)}
            onBlur={hide}
            onKeyDown={onKey}
          />
        </svg>
      </ChartSlot>
      {table && (
        <SkTable
          caption="What the money they put in would be worth, each year end"
          head={["Quarter end", "Their stocks", w.their, "Whole market", "S&P 500"]}
          rows={qs.map(({ q, i }) => [qShort(q), money(L.values.fund[i]), money(L.values.label[i]), money(L.values.mkt[i]), money(L.values.spy[i])])}
        />
      )}
    </div>
  );
}

/** The Table view of a panel: the same box as the chart (base.css .tview). */
export function SkTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <div className="tview">
      <div className="tbl-box" tabIndex={0} role="region" aria-label={caption + ", scrollable"}>
        <table className="tbl-mini">
          <caption>{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th scope="col" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{r[0]}</th>
                {r.slice(1).map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The Table view / Chart view button every panel of the tab has (AUM's). */
export function ViewButton({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="btn btn-secondary sm" aria-pressed={table} onClick={onToggle}>
      <ViewIcon table={table} />
      <span>{table ? "Chart view" : "Table view"}</span>
    </button>
  );
}

/** "Annual return stacked graph": each year split into the market, the tier choice and stock choice; or Lines. */
export function StackedPanel({ skill, tier }: { skill: Skill; tier: Tier }) {
  const w = tierWords(tier);
  const [view, setView] = useState<View>("stacked");
  const [table, setTable] = useState(false);
  const grow = useRef<HTMLDivElement>(null);
  const anim = useGrowOnce(grow);
  const { settle } = anim;
  useEffect(() => settle(), [tier, view, settle]);
  const rows = useMemo(() => yearRows(skill, tier), [skill, tier]);
  const T = tierOf(skill, tier);
  if (rows.length === 0) return null;
  const span = spanName(rows[0].name, rows[rows.length - 1].name);
  const lines = view === "lines";
  const cushion = !lines && stackedLayout(rows, 880, w).cushion;
  return (
    <section className="panel aum skp stkp" aria-labelledby="stkTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="stkTitle">
            Annual return stacked graph
          </h3>
        </div>
        <div className="ph-c">
          <Seg
            label="Show the years as"
            options={[
              { id: "stacked", label: "Stacked" },
              { id: "lines", label: "Lines" },
            ]}
            value={view}
            onChange={(v) => setView(v as View)}
          />
          <ViewButton table={table} onToggle={() => setTable((t) => !t)} />
        </div>
      </div>
      <div className="stats" aria-live="polite">
        <div className="stat">
          <span>Whole market, {span}</span>
          <b>{ret1(T.irr_mkt)} a year</b>
        </div>
        <div className="stat">
          <span>
            {w.choice}, {span}
          </span>
          <b>{pts(T.allocation)} a year</b>
        </div>
        <div className="stat">
          <span>Stock choice, {span}</span>
          <b>{pts(T.picking)} a year</b>
        </div>
      </div>
      <div className="strip">
        {lines ? (
          <div className="legend">
            <span className="lg">
              <i className="ln l-fund" />
              Their stocks
            </span>
            <span className="lg">
              <i className="ln l-label" />
              {w.their}
            </span>
            <span className="lg">
              <i className="ln l-mkt" />
              Whole market
            </span>
            <span className="lg">
              <i className="ln l-spy" />
              S&amp;P 500
            </span>
          </div>
        ) : (
          <div className="legend">
            <span className="lg">
              <i className="mkt" />
              Whole market
            </span>
            <span className="lg">
              <i className="sel" />
              {w.choice}
            </span>
            <span className="lg">
              <i className="stk" />
              Stock choice
            </span>
            <span className="lg">
              <i className="gave" />
              Gave back
            </span>
            {cushion && (
              <span className="lg">
                <i className="cush" />
                Cushioned a fall
              </span>
            )}
          </div>
        )}
      </div>
      <div className="pb" ref={grow}>
        {lines ? <LinesChart skill={skill} tier={tier} w={w} table={table} /> : <StackedChart rows={rows} w={w} grow={anim.cls} table={table} />}
      </div>
      <p className="pf">
        {lines
          ? "What the money they put in would be worth, with the same buys and sells on the same dates. Whole market = Orca's index of every US stock it prices. S&P 500 for reference only. Estimates."
          : `Each bar is one calendar year. Light = what the whole market returned, hatched = what their ${w.noun} choices added, solid = what their stock choices added; a dashed box is a choice that went the other way. pts = percentage points: 15% when the market made 12% is +3 pts. The three figures above count all the money they put in, so they differ a little from the yearly bars. Estimates.`}
      </p>
    </section>
  );
}
