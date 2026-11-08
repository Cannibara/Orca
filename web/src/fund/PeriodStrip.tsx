import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useTooltip } from "../charts/Tooltip";
import { xLabelItems, xLabels } from "./geometry";
import "./base.css";
import { useWidth } from "./hooks";

/**
 * Where a click on slot `i` moves the period a..b: a slot left of it moves the start,
 * right of it the end, inside it whichever edge is nearer (the start on a tie).
 */
export function nearestEdge(a: number, b: number, i: number): { a: number; b: number } {
  if (i < a) return { a: i, b };
  if (i > b) return { a, b: i };
  return i - a <= b - i ? { a: i, b } : { a, b: i };
}

type PeriodStripProps = {
  /** "years": one slot per year, labels thinned to fit. "quarters": ticks, with a label only where `tickLabels` has one. */
  variant: "years" | "quarters";
  /** One name per slot: hit titles and the handles' value text. */
  names: string[];
  /** Text drawn under the slots. Years: replaces the names as labels. Quarters: "" = no label (and a short tick). */
  tickLabels?: string[];
  /** First and last slot of the period, inclusive. */
  a: number;
  b: number;
  onChange: (a: number, b: number) => void;
  ariaLabel: string;
};

const H = 56;
const M = 10; // left and right margin inside the svg
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Drag = { mode: string; a0: number; b0: number; i0: number; pid: number; moved: boolean };

/**
 * The period scrubber: a strip of slots with a draggable box over them. Drag a handle to
 * resize, the box to move it; click a slot to move the nearest edge; arrow keys on a
 * handle step it (shift moves both).
 */
export function PeriodStrip({ variant, names, tickLabels, a, b, onChange, ariaLabel }: PeriodStripProps) {
  const inner = useRef<HTMLDivElement>(null);
  const W = useWidth(inner, 280, 560);
  const tip = useTooltip();
  const drag = useRef<Drag | null>(null);
  const n = names.length;
  const band = (W - 2 * M) / Math.max(1, n);
  const cx = (i: number) => M + band * i + band / 2;
  const lo = clamp(a, 0, n - 1);
  const hi = clamp(b, lo, n - 1);
  // The handlers read the latest props through this, so a drag in progress never acts on stale ones.
  const cur = useRef({ a: lo, b: hi, n, band, onChange });
  cur.current = { a: lo, b: hi, n, band, onChange };

  if (n === 0) return null;

  const slotAt = (clientX: number, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect();
    const x = (clientX - r.left) * (W / (r.width || W));
    return clamp(Math.floor((x - M) / cur.current.band), 0, cur.current.n - 1);
  };
  const set = (na: number, nb: number) => {
    if (na !== cur.current.a || nb !== cur.current.b) cur.current.onChange(na, nb);
  };
  const click = (i: number) => {
    const r = nearestEdge(cur.current.a, cur.current.b, i);
    set(r.a, r.b);
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const t = (e.target as Element).closest(".bh");
    if (!t) return;
    e.preventDefault();
    drag.current = {
      mode: t.getAttribute("data-d") ?? "move",
      a0: cur.current.a,
      b0: cur.current.b,
      i0: slotAt(e.clientX, e.currentTarget),
      pid: e.pointerId,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // not capturable (jsdom, a pointer that is already gone): dragging still works while it stays over the strip
    }
    tip.hide();
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    const i = slotAt(e.clientX, e.currentTarget);
    if (i !== d.i0) d.moved = true;
    let na = d.a0;
    let nb = d.b0;
    if (d.mode === "a") na = Math.min(i, nb);
    else if (d.mode === "b") nb = Math.max(i, na);
    else {
      const len = nb - na;
      na = clamp(na + (i - d.i0), 0, cur.current.n - 1 - len);
      nb = na + len;
    }
    set(na, nb);
  };
  const onPointerEnd = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(d.pid);
    } catch {
      // see onPointerDown
    }
    // A press on the box that never moved is a click on a slot.
    if (e.type === "pointerup" && d.mode === "move" && !d.moved) click(slotAt(e.clientX, e.currentTarget));
  };
  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const h = (e.target as Element).closest(".sc-hit");
    if (h) click(Number(h.getAttribute("data-s")));
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const t = e.target as Element;
    if (!t.classList.contains("scr-h")) return;
    const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dx) return;
    e.preventDefault();
    let na = cur.current.a;
    let nb = cur.current.b;
    if (e.shiftKey) {
      const len = nb - na;
      na = clamp(na + dx, 0, cur.current.n - 1 - len);
      nb = na + len;
    } else if (t.getAttribute("data-d") === "a") na = clamp(na + dx, 0, nb);
    else nb = clamp(nb + dx, na, cur.current.n - 1);
    set(na, nb);
  };

  const years = variant === "years";
  const x0 = M + band * lo;
  const x1 = M + band * (hi + 1);
  const handleW = band < 30 ? 6 : 8;
  const items = years ? xLabelItems(xLabels(tickLabels ?? names, { band, cx }, -1), { band, cx }, -1, H - 2) : [];
  const handles = [
    { d: "a", x: x0 + 1, name: "Start of the period", at: lo },
    { d: "b", x: x1 - 1, name: "End of the period", at: hi },
  ];

  return (
    <div className="scrub">
      <div ref={inner}>
        <svg
          className="viz sc"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="group"
          aria-label={ariaLabel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          {names.map((name, i) => (
            <rect key={"h" + i} className="sc-hit" data-s={i} x={(M + band * i).toFixed(1)} y={0} width={band.toFixed(1)} height={54}>
              <title>{(years ? "Extend the period to " : "Move the nearest edge to ") + name}</title>
            </rect>
          ))}
          {names.map((_, i) => (
            <line
              key={"t" + i}
              className={"scr-tick" + (i >= lo && i <= hi ? " in" : "")}
              x1={cx(i).toFixed(1)}
              x2={cx(i).toFixed(1)}
              y1={years ? 10 : tickLabels?.[i] ? 8 : 11}
              y2={15}
            />
          ))}
          {years
            ? items.map((it) => (
                <text key={"l" + it.i} className="clab" x={it.x} y={it.y} textAnchor="middle">
                  {it.text}
                </text>
              ))
            : (tickLabels ?? []).map((l, i) =>
                l ? (
                  <text key={"l" + i} className="tick" x={(cx(i) - band / 2 + 2).toFixed(1)} y={H - 6} textAnchor="start">
                    {l}
                  </text>
                ) : null,
              )}
          <g className="scrg">
            <rect className="scr-win bh" data-d="move" x={(x0 + 1).toFixed(1)} y={2} width={Math.max(6, x1 - x0 - 2).toFixed(1)} height={50} rx={8} />
            {handles.map((h) => (
              <g key={h.d}>
                <rect className="brk-g bh" data-d={h.d} x={(h.x - 14).toFixed(1)} y={0} width={28} height={54} rx={8} />
                <rect
                  className="scr-h bh"
                  data-d={h.d}
                  x={(h.x - (band < 30 ? 3 : 4)).toFixed(1)}
                  y={16}
                  width={handleW}
                  height={20}
                  rx={3}
                  tabIndex={0}
                  role="slider"
                  aria-label={h.name}
                  aria-orientation="horizontal"
                  aria-valuemin={0}
                  aria-valuemax={n - 1}
                  aria-valuenow={h.at}
                  aria-valuetext={names[h.at]}
                />
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
