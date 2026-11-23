import { useMemo, useRef, useState, type PointerEvent } from "react";
import { useTooltip } from "../charts/Tooltip";
import type { Skill } from "../data/types";
import { pct } from "../lib/format";
import { ChartSlot } from "./ChartSlot";
import { qShort } from "./fmt";
import { useWidth } from "./hooks";
import { LEVEL_NAMES, mixSeries, rotations, sectorColor, stackAreas, type Level, type MixSeries } from "./mix";
import { Seg } from "./Seg";
import "./skill.css";
import { SkTable, ViewButton } from "./StackedPanel";

const MIN_LABEL: Record<Level, number> = { 1: 0.04, 2: 0.045, 3: 0.05 };

/** "Sector mix over time": the fund's book by sector, industry or sub-industry, with the big switches marked. */
export function MixPanel({ skill }: { skill: Skill }) {
  const [level, setLevel] = useState<Level>(1);
  const [focus, setFocus] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const s = useMemo(() => mixSeries(skill.mix, level), [skill, level]);
  const sectors = useMemo(() => mixSeries(skill.mix, 1), [skill]);
  const rots = useMemo(() => rotations(sectors), [sectors]);
  if (skill.mix.q.length < 2) return null;
  const name = LEVEL_NAMES[level];
  const pick = (sector: string) => setFocus((f) => (f === sector ? null : sector));
  return (
    <section className="panel skp mixp" aria-labelledby="mixTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="mixTitle">
            {name} mix over time
          </h3>
          <p className="ps">
            Share of the portfolio by {name.toLowerCase()}, each quarter · estimate{focus ? ` · ${focus} picked out, tap again to clear` : ""}
          </p>
        </div>
        <div className="ph-c">
          <Seg label="Group by" options={([1, 2, 3] as Level[]).map((l) => ({ id: String(l), label: LEVEL_NAMES[l] }))} value={String(level)} onChange={(v) => setLevel(Number(v) as Level)} />
          <ViewButton table={table} onToggle={() => setTable((t) => !t)} />
        </div>
      </div>
      <div className="chips" role="group" aria-label="Pick out a sector">
        {sectors.bands.map((b) => (
          <button key={b.sector} type="button" className="chip" aria-pressed={focus === b.sector} onClick={() => pick(b.sector)}>
            <i style={{ background: sectorColor(b.sector) }} />
            {b.sector}
          </button>
        ))}
      </div>
      <div className="pb">
        <MixChart s={s} level={level} focus={focus} onPick={pick} rots={rots.map((r) => r.q)} table={table} />
        {rots.length > 0 && (
          <ol className="rot">
            {rots.map((r, i) => (
              <li key={r.q}>
                <span className="n" aria-hidden="true">
                  {i + 1}
                </span>
                <span>
                  <span className="vh">Switch {i + 1}: </span>
                  <b>{qShort(r.q)}</b> {r.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="pf">
        {level > 1 ? "Each band keeps its sector's colour; lighter shades are its smaller parts. " : ""}
        Shares use quarter-end values{rots.length ? "; numbered lines are the big switches listed above" : ""}. "Not classified" is broad ETFs and stocks
        without a label.{level === 3 ? " A sub-industry with only a few stocks leans on one or two companies." : ""} Estimates.
      </p>
    </section>
  );
}

function MixChart({ s, level, focus, onPick, rots, table }: { s: MixSeries; level: Level; focus: string | null; onPick: (sector: string) => void; rots: number[]; table: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const w0 = useWidth(host, 280, 600);
  const W = Math.max(w0, 640); // narrower screens scroll the chart sideways, never the page
  const tip = useTooltip();
  const n = s.q.length;
  const H = 320;
  const L = 44;
  const R = W - (level === 1 ? 150 : 190);
  const top = 10;
  const bot = H - 46;
  const x = (i: number) => L + (n > 1 ? i / (n - 1) : 0.5) * (R - L);
  const y = (f: number) => top + (bot - top) * f;
  const areas = stackAreas(s, x, y);
  const quarterAt = (e: PointerEvent<SVGElement>) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || r.width === 0) return n - 1;
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((px - L) / (R - L)) * (n - 1))));
  };
  const first = 2013 + Math.floor(s.q[0] / 4);
  const last = 2013 + Math.floor(s.q[n - 1] / 4);
  const every = last - first > 14 ? 4 : 2;
  const years: { x: number; t: string }[] = [];
  for (let yr = Math.ceil(first / every) * every; yr <= last; yr += every) {
    const i = s.q.indexOf((yr - 2013) * 4);
    if (i >= 0) years.push({ x: x(i), t: String(yr) });
  }
  // labels at the right edge for bands big enough in the last quarter, nudged apart
  const labs = areas
    .map((a) => ({ a, h: a.hi[n - 1] - a.lo[n - 1] }))
    .filter(({ a, h }) => h >= MIN_LABEL[level] && (!focus || s.bands[a.i].sector === focus))
    .map(({ a, h }) => ({ i: a.i, y: y(a.lo[n - 1] + h / 2) + 4, t: `${s.bands[a.i].name} ${Math.round(h * 100)}%` }));
  for (let k = 1; k < labs.length; k++) labs[k].y = Math.max(labs[k].y, labs[k - 1].y + 13);
  const qs = s.q.map((q, i) => ({ q, i })).filter(({ q, i }) => ((q % 4) + 4) % 4 === 3 || i === n - 1);
  return (
    <div className="chart" ref={host}>
      <ChartSlot table={table}>
        <div className="scroll">
          <svg ref={svg} className="viz" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label={`Share of the portfolio by ${LEVEL_NAMES[level].toLowerCase()}, each quarter.`}>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <text key={t} className="tick" x={L - 6} y={y(t) + 4} textAnchor="end">
                {Math.round((1 - t) * 100)}%
              </text>
            ))}
            {areas.map((a) => {
              const b = s.bands[a.i];
              const dim = focus !== null && b.sector !== focus;
              return (
                <path
                  key={b.key}
                  className={"area" + (level === 1 ? " l1" : "")}
                  d={a.d}
                  fill={dim ? "var(--line2)" : sectorColor(b.sector)}
                  fillOpacity={dim ? 0.45 : b.shade}
                  onPointerMove={(e) => {
                    const i = quarterAt(e);
                    tip.show({ title: b.name, rows: [{ label: qShort(s.q[i]), value: pct(b.shares[i], 1, false) + " of the fund" }], note: level > 1 ? b.trail : undefined }, e.clientX, e.clientY, { place: "cursor" });
                  }}
                  onPointerLeave={() => tip.hide()}
                  onClick={() => onPick(b.sector)}
                />
              );
            })}
            {rots.map((q, k) => {
              const i = s.q.indexOf(q);
              if (i < 0) return null;
              return (
                <g key={q}>
                  <line className="rline" x1={x(i)} x2={x(i)} y1={top} y2={bot} />
                  <circle className="rdot" cx={x(i)} cy={bot + 14} r={8} />
                  <text className="rnum" x={x(i)} y={bot + 18} textAnchor="middle" aria-hidden="true">
                    {k + 1}
                  </text>
                </g>
              );
            })}
            {years.map((yy) => (
              <text key={yy.t} className="clab" x={yy.x} y={bot + 36} textAnchor="middle">
                {yy.t}
              </text>
            ))}
            {labs.map((l) => (
              <text key={l.i} className="alab" x={R + 8} y={l.y}>
                {l.t}
              </text>
            ))}
          </svg>
        </div>
      </ChartSlot>
      {table && (
        <SkTable
          caption={`Share of the portfolio by ${LEVEL_NAMES[level].toLowerCase()}, each year end`}
          head={["Quarter end", ...s.bands.map((b) => b.name)]}
          rows={qs.map(({ q, i }) => [qShort(q), ...s.bands.map((b) => pct(b.shares[i], 1, false))])}
        />
      )}
    </div>
  );
}

