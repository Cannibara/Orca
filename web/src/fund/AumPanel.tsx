import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useTooltip, type TipContent } from "../charts/Tooltip";
import { aumLayout, aumRows, aumTotals } from "./aum";
import "./aum.css";
import { fMoney, fMoneySigned } from "./fmt";
import { useGrowOnce, useWidth } from "./hooks";
import { spanName, type Series, type Win, type YearPoint } from "./series";

/** Inline style with custom properties (--i, --y0 ...). */
const css = (o: Record<string, string | number>): CSSProperties => o as CSSProperties;

const GAIN = "var(--gain)";
const LOSS = "var(--loss)";

/** The tooltip of one year: the book at start, what came in, what the market did, the book at end. */
function tipFor(y: YearPoint): TipContent {
  const f = y.inflows;
  const g = y.gains;
  return {
    title: y.label,
    part: y.part,
    rows: [
      { label: "Book at start", value: fMoney(y.start) },
      { color: f >= 0 ? GAIN : LOSS, label: f >= 0 ? "Net inflows" : "Net outflows", value: fMoneySigned(f) },
      { color: g >= 0 ? GAIN : LOSS, label: g >= 0 ? "Gains" : "Losses", value: fMoneySigned(g) },
      { label: "Book at end", value: fMoney(y.end), sum: true },
    ],
  };
}

/** The toggle's icon: a table when it offers the numbers, bars when it offers the chart. */
function ViewIcon({ table }: { table: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      {table ? (
        <path d="M3.5 13V8.5M8 13V3.5M12.5 13V6.5" />
      ) : (
        <>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M2.5 6.5h11M6.5 6.5V13" />
        </>
      )}
    </svg>
  );
}

/** The chart: one static column per year. It is not clickable and keeps no selection. */
function AumChart({ win, grow }: { win: Win; grow: string }) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const W = useWidth(host, 280, 600);
  const L = aumLayout(win, W);
  const tip = useTooltip();
  const hatch = "aum-hatch-" + useId().replace(/:/g, "");
  // The hover band keeps its last column while it fades out.
  const [band, setBand] = useState({ i: 0, on: false });

  const pinned = (i: number) => {
    const el = host.current;
    tip.show(tipFor(win.years[i]), 0, 0, el ? { place: { pin: el } } : undefined);
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
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const i = hitIndex(e);
    if (i === null) unpin();
    else pinned(i);
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
      <svg
        ref={svg}
        className={"viz c2" + grow}
        viewBox={`0 0 ${L.W} ${L.H}`}
        width={L.W}
        height={L.H}
        role="group"
        aria-label="Assets under management at each year end."
        style={css({ "--y0": L.z.toFixed(1) + "px", "--step": L.step.toFixed(1) + "ms" })}
        onPointerMove={onPointer}
        onPointerLeave={unpin}
        onFocus={(e) => {
          const i = hitIndex(e);
          if (i !== null) pinned(i);
        }}
        onBlur={unpin}
        onKeyDown={onKey}
      >
        <defs>
          <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="hf-bg" width="5" height="5" />
            <rect className="hf-ln" width="1.7" height="5" />
          </pattern>
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
        {L.segs.map((s) => (
          <path
            key={s.cls + s.i}
            className={"bar " + s.cls}
            style={css(s.cls === "fin" ? { "--i": s.i, fill: `url(#${hatch})` } : { "--i": s.i })}
            d={s.d}
          />
        ))}
        <line className="zero" x1={L.G.ml} x2={L.W - L.G.mr} y1={+L.z.toFixed(1)} y2={+L.z.toFixed(1)} />
        {L.labels.map((b) => (
          <text
            key={b.i}
            className="blab"
            style={css(b.rot ? { "--i": b.i, fontSize: "10px" } : { "--i": b.i })}
            transform={b.rot ? `rotate(-90 ${b.x} ${b.y})` : undefined}
            x={b.x}
            y={b.y}
            textAnchor={b.rot ? "start" : "middle"}
            aria-hidden="true"
          >
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
    </div>
  );
}

function AumTable({ years }: { years: YearPoint[] }) {
  return (
    <div className="chart">
      <div className="tbl-box">
        <table className="tbl-mini">
          <caption>Book value, net inflows and gains by year</caption>
          <thead>
            <tr>
              {["Year", "Book at start", "Net inflows", "Gains", "Net change", "Book at end"].map((h) => (
                <th scope="col" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {aumRows(years).map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  {r.label}
                  {r.part && (
                    <>
                      {" "}
                      <span className="tag hollow">Part year</span>
                    </>
                  )}
                </th>
                <td>{r.start}</td>
                <td>{r.flows}</td>
                <td>{r.gains}</td>
                <td>{r.change}</td>
                <td>{r.end}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AumBody({ win }: { win: Win }) {
  const [table, setTable] = useState(false);
  const grow = useRef<HTMLDivElement>(null);
  const anim = useGrowOnce(grow);
  // A change of window must not replay the grow-in (the artifact settles it).
  const { settle } = anim;
  useEffect(() => settle(), [win, settle]);

  const years = win.years;
  const T = aumTotals(years);
  const span = spanName(years[0].label, years[years.length - 1].label);

  return (
    <>
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="aumTitle">
            Assets under management
          </h3>
        </div>
        <div className="ph-c">
          <button type="button" className="btn btn-secondary sm" aria-pressed={table} onClick={() => setTable((t) => !t)}>
            <ViewIcon table={table} />
            <span>{table ? "Show the chart" : "Show the numbers"}</span>
          </button>
        </div>
      </div>
      <div className="stats" aria-live="polite">
        <div className="stat">
          <span>Book at the end of {years[years.length - 1].label}</span>
          <b>{fMoney(T.end)}</b>
        </div>
        <div className="stat">
          <span>
            {T.flows >= 0 ? "Net inflows" : "Net outflows"}, {span}
          </span>
          <b>{fMoneySigned(T.flows)}</b>
        </div>
        <div className="stat">
          <span>
            {T.gains >= 0 ? "Gains" : "Losses"}, {span}
          </span>
          <b>{fMoneySigned(T.gains)}</b>
        </div>
      </div>
      <div className="strip">
        <div className="legend">
          <span className="lg">
            <i className="flow" />
            Net inflows
          </span>
          <span className="lg">
            <i className="gain" />
            Gains
          </span>
          <span className="lg">
            <i className="rml" />
            Losses
          </span>
          <span className="lg">
            <i className="out" />
            Net outflows
          </span>
        </div>
      </div>
      <div className="pb" ref={grow}>
        {table ? <AumTable years={years} /> : <AumChart win={win} grow={anim.cls} />}
      </div>
    </>
  );
}

/** Book value at each year end, split into what carried over, what came in and what the market added. */
export function AumPanel({ win }: { series: Series; win: Win }) {
  return (
    <section className="panel aum" id="flowPanel" aria-labelledby="aumTitle">
      {win.years.length > 0 ? (
        <AumBody win={win} />
      ) : (
        <>
          <div className="ph">
            <div className="ph-t">
              <h3 className="pt" id="aumTitle">
                Assets under management
              </h3>
              <p className="ps">No year-end book values are available for this fund yet.</p>
            </div>
          </div>
          <div className="pb" />
        </>
      )}
    </section>
  );
}
