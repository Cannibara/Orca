import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useTooltip, type TipContent, type TipRow } from "../charts/Tooltip";
import { axisPct, f1, fMoney, fPct } from "./fmt";
import { endRound, stepFor, textW, xLabelItems, xLabels } from "./geometry";
import { useGrowOnce, useWidth } from "./hooks";
import { colLayout, dragBracket, idxAtX, keyBracket, type BracketMode } from "./returnsLayout";
import { Seg } from "./Seg";
import { cagrOf, returnYears, yearDetail, type Range, type Series, type Win } from "./series";
import { resolveBracket, type Span } from "./span";
import "./returns.css";

export type ReturnsPanelProps = {
  series: Series;
  win: Win;
  range: Range;
  onRange: (r: Range) => void;
  /** Selected year label (the highlighted bar); null when the fund has no year. */
  sel: string | null;
  onSelect: (label: string) => void;
  /** The annualised-return bracket as year labels of the drawn return years; null = the whole window. */
  br: Span | null;
  onBr: (span: Span) => void;
};

const RANGE_OPTIONS = [
  { id: "15", label: "15 years" },
  { id: "max", label: "Max" },
];

const BRACKET_Y = 16; // the bracket's horizontal line, from the top of the svg

/** Whether the keyboard (not a mouse click) put the focus here; true where the browser cannot say. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

const vars = (o: Record<string, string | number>) => o as CSSProperties;

/**
 * Annual returns: one bar per year with a return, the selected year highlighted, and the
 * draggable annualised-return bracket above the bars. Selecting a bar picks the year the
 * What-drove panel shows; the bracket sets the span the four tiles describe.
 */
export function ReturnsPanel({ series, win, range, onRange, sel, onSelect, br, onBr }: ReturnsPanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const W = useWidth(host, 280);
  const grow = useGrowOnce(host, { durMs: 2400 });
  const { settle } = grow;
  const tip = useTooltip();
  const [table, setTable] = useState(false);
  // The hover band keeps its last place while it fades out.
  const [hov, setHov] = useState({ i: 0, on: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ mode: BracketMode; svg: SVGSVGElement; a0: number; b0: number; i0: number; pid: number; last: { a: number; b: number } } | null>(null);

  const ry = useMemo(() => returnYears(win), [win]);
  const cats = useMemo(() => ry.map((y) => y.label), [ry]);
  const vals = useMemo(() => ry.map((y) => y.ret as number), [ry]);
  const part = useMemo(() => ry.map((y) => y.part), [ry]);
  const n = ry.length;
  const selI = sel === null ? -1 : cats.indexOf(sel);
  const hasBr = n >= 2;
  const bs = resolveBracket(cats, br);
  const L = useMemo(() => colLayout(W, vals, part, selI, hasBr), [W, vals, part, selI, hasBr]);

  // A resize must not replay the grow-in.
  useEffect(() => settle(), [W, settle]);

  const tipFor = (i: number): TipContent => {
    const y = ry[i];
    const yd = yearDetail(series, y.year);
    const rows: TipRow[] = [
      { label: "Max drawdown", value: fPct(yd.mdd) },
      { label: "Volatility", value: yd.vol == null ? "–" : f1(yd.vol).replace("+", "") + "%" },
      ...yd.qs.map((p) => ({
        color: p.ret >= 0 ? "var(--gain)" : "var(--loss)",
        label: "Q" + ((((p.q % 4) + 4) % 4) + 1),
        value: fPct(p.ret * 100),
      })),
    ];
    return { title: y.label, part: y.part, rows };
  };

  const pick = (i: number) => {
    settle();
    onSelect(cats[i]);
  };
  const setBr = (a: number, b: number) => onBr({ a: cats[a], b: cats[b] });
  const hoverOff = () => setHov((h) => (h.on ? { ...h, on: false } : h));

  // ---- bars: pointer, focus and keys ----
  const hitHandlers = (i: number) => {
    const atCursor = (e: PointerEvent<Element>) => {
      if (drag.current) return;
      tip.show(tipFor(i), e.clientX, e.clientY, { place: "cursor" });
      setHov((h) => (h.on && h.i === i ? h : { i, on: true }));
    };
    return {
      onPointerEnter: atCursor,
      onPointerMove: atCursor,
      onPointerLeave: () => {
        tip.hide();
        hoverOff();
      },
      onFocus: (e: FocusEvent<SVGRectElement>) => {
        if (!focusVisible(e.currentTarget)) return;
        const r = e.currentTarget.getBoundingClientRect();
        tip.show(tipFor(i), r.left + r.width / 2 - 14, r.top + 30);
        setHov({ i, on: true });
      },
      onBlur: () => {
        tip.hide();
        hoverOff();
      },
      onClick: (e: MouseEvent<SVGRectElement>) => {
        pick(i);
        // A click, not a key: keep the box by the cursor, where it was, not up on the bar.
        if (e.detail > 0) {
          tip.show(tipFor(i), e.clientX, e.clientY, { place: "cursor" });
          setHov({ i, on: true });
        }
      },
      onKeyDown: (e: KeyboardEvent<SVGRectElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick(i);
          return;
        }
        const nx = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
        if (nx === null || nx < 0 || nx >= n) return;
        e.preventDefault();
        e.currentTarget.parentElement?.querySelectorAll<SVGRectElement>("rect.hit")[nx]?.focus();
      },
    };
  };

  // ---- the bracket: drag an end to resize, the bar or the pill to move; arrows on a handle ----
  const barAt = (e: PointerEvent<Element>, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect();
    return idxAtX(e.clientX, r.left, r.width, W, L.G, n);
  };
  const startDrag = (e: PointerEvent<SVGElement>, mode: BracketMode) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    e.preventDefault();
    drag.current = { mode, svg, a0: bs.a, b0: bs.b, i0: barAt(e, svg), pid: e.pointerId, last: bs };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    setDragging(true);
    tip.hide();
    hoverOff();
  };
  const moveDrag = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    const { a, b } = dragBracket(d.mode, d.a0, d.b0, d.i0, barAt(e, d.svg), n);
    if (a !== d.last.a || b !== d.last.b) {
      d.last = { a, b };
      setBr(a, b);
    }
  };
  const endDrag = (e?: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || (e && e.pointerId !== d.pid)) return;
    try {
      d.svg.releasePointerCapture(d.pid);
    } catch {
      /* already released */
    }
    drag.current = null;
    setDragging(false);
  };
  const onHandleKey = (e: KeyboardEvent<SVGElement>, mode: "a" | "b") => {
    const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dx) return;
    e.preventDefault();
    const next = keyBracket(mode, bs.a, bs.b, dx, e.shiftKey, n);
    setBr(next.a, next.b);
  };

  // ---- drawing ----

  function chart(): ReactNode {
    const { G, H } = L;
    const z = L.Y(0);
    const C = xLabels(cats, G, selI);
    const bracket = (() => {
      if (!hasBr) return null;
      const yl = BRACKET_Y;
      const lab = f1(cagrOf(series, ry[bs.a].year, ry[bs.b].year)) + "%" + (W >= 560 ? " a year" : " a yr");
      const leg = (i: number) => (vals[i] >= 0 ? (L.show[i] ? L.boxes[i].y0 : L.Y(vals[i])) : z) - 5;
      const x1 = G.cx(bs.a);
      const x2 = G.cx(bs.b);
      const pw = textW(lab, 12) + 24;
      const px = Math.max(2, Math.min(W - pw - 2, (x1 + x2) / 2 - pw / 2));
      const la = leg(bs.a);
      const lb = leg(bs.b);
      const ends = [
        { mode: "a" as const, at: bs.a, x: x1, d: -1, name: "Start of the annualised return span" },
        { mode: "b" as const, at: bs.b, x: x2, d: 1, name: "End of the annualised return span" },
      ];
      return (
        <g className="late brkg">
          <path className="brk-l" d={`M${x1.toFixed(1)},${la.toFixed(1)}V${yl - 6}M${x2.toFixed(1)},${lb.toFixed(1)}V${yl - 6}`} />
          <path className="brk-d" d={`M${(x1 + 12).toFixed(1)},${yl}H${(x2 - 12).toFixed(1)}`} />
          <line className="brk-m bh" data-d="move" x1={(x1 + 12).toFixed(1)} x2={(x2 - 12).toFixed(1)} y1={yl} y2={yl} onPointerDown={(e) => startDrag(e, "move")} />
          <line className="brk-leg bh" data-d="a" x1={x1.toFixed(1)} x2={x1.toFixed(1)} y1={yl + 8} y2={la.toFixed(1)} onPointerDown={(e) => startDrag(e, "a")} />
          <line className="brk-leg bh" data-d="b" x1={x2.toFixed(1)} x2={x2.toFixed(1)} y1={yl + 8} y2={lb.toFixed(1)} onPointerDown={(e) => startDrag(e, "b")} />
          <rect className="brk-pill bh" data-d="move" x={px.toFixed(1)} y={yl - 12} width={pw.toFixed(1)} height="24" rx="12" onPointerDown={(e) => startDrag(e, "move")} />
          <text className="brk-t" x={(px + pw / 2).toFixed(1)} y={yl + 4.5} textAnchor="middle">
            {lab}
          </text>
          {/* each arrow points outward and its tip rests on the vertical line */}
          {ends.map((h) => (
            <Fragment key={h.mode}>
              <rect
                className="brk-g bh"
                data-d={h.mode}
                x={(h.d < 0 ? h.x - 8 : h.x - 22).toFixed(1)}
                y={yl - 15}
                width="30"
                height="30"
                rx="8"
                onPointerDown={(e) => startDrag(e, h.mode)}
              />
              <polygon
                className="brk-h bh"
                data-d={h.mode}
                points={`${h.x.toFixed(1)},${yl} ${(h.x - h.d * 11).toFixed(1)},${yl - 6.5} ${(h.x - h.d * 11).toFixed(1)},${yl + 6.5}`}
                tabIndex={0}
                role="slider"
                aria-label={h.name}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={n - 1}
                aria-valuenow={h.at}
                aria-valuetext={cats[h.at]}
                onPointerDown={(e) => startDrag(e, h.mode)}
                onKeyDown={(e) => onHandleKey(e, h.mode)}
              />
            </Fragment>
          ))}
        </g>
      );
    })();

    return (
      <svg
        className={"viz c1" + grow.cls + (dragging ? " drag" : "")}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="group"
        aria-label="Estimated annual return by year. Each column is a button that selects that year. The bracket handles set the span for the annualised return."
        style={vars({ "--y0": z.toFixed(1) + "px", "--step": stepFor(n).toFixed(1) + "ms" })}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => endDrag()}
      >
        {selI >= 0 && (
          <rect className="selband" x={(G.ml + G.band * selI + 1).toFixed(1)} y="2" width={Math.max(2, G.band - 2).toFixed(1)} height={H - 4} rx="6" />
        )}
        {G.axis &&
          L.ticks.map((t) => {
            const y = L.Y(t).toFixed(1);
            return (
              <g key={t}>
                <line className="grid" x1={G.ml} x2={W - G.mr} y1={y} y2={y} />
                <text className="tick" x={G.ml - 10} y={+y + 4} textAnchor="end">
                  {axisPct(t)}
                </text>
              </g>
            );
          })}
        <rect
          className={"hovband" + (hov.on ? " on" : "")}
          x={G.ml + G.band * Math.min(hov.i, n - 1)}
          y="2"
          width={G.band}
          height={H - 4}
          rx="6"
        />
        {vals.map((v, i) => {
          const cx = G.cx(i);
          const up = v >= 0;
          const hh = Math.max(1.5, Math.abs(L.Y(v) - z));
          const tp = up ? z - hh : z + hh;
          const isSel = i === selI;
          const bx = +(cx - G.bw / 2).toFixed(2);
          return (
            <g key={cats[i]}>
              <path
                className={"bar " + (up ? "gain" : "loss")}
                style={vars({ "--i": i })}
                d={endRound(bx, +G.bw.toFixed(2), +z.toFixed(2), +tp.toFixed(2), 3)}
              />
              {L.show[i] &&
                (L.rot ? (
                  <text
                    className={"blab" + (isSel ? " sel" : "")}
                    style={vars({ "--i": i, fontSize: "10px" })}
                    transform={`rotate(-90 ${(cx + 0.36 * L.size).toFixed(1)} ${(up ? tp - 4 : tp + 4).toFixed(1)})`}
                    x={(cx + 0.36 * L.size).toFixed(1)}
                    y={(up ? tp - 4 : tp + 4).toFixed(1)}
                    textAnchor={up ? "start" : "end"}
                    aria-hidden="true"
                  >
                    {L.txt[i]}
                  </text>
                ) : (
                  <text
                    className={"blab" + (isSel ? " sel" : "")}
                    style={vars({ "--i": i })}
                    x={cx.toFixed(1)}
                    y={(up ? tp - 5 : tp + L.size + 3).toFixed(1)}
                    textAnchor="middle"
                    aria-hidden="true"
                  >
                    {L.txt[i]}
                  </text>
                ))}
            </g>
          );
        })}
        <line className="zero" x1={G.ml} x2={W - G.mr} y1={z.toFixed(1)} y2={z.toFixed(1)} />
        {xLabelItems(C, G, selI, H).map((it) => (
          <g key={it.i}>
            {it.pill && <rect className="selpill" x={it.pill.x} y={it.pill.y} width={it.pill.w} height={it.pill.h} rx={it.pill.r} />}
            <text className={"clab" + (it.selected ? " sel" : "")} x={it.x} y={it.y} textAnchor="middle">
              {it.text}
            </text>
          </g>
        ))}
        {cats.map((c, i) => (
          <rect
            key={c}
            className="hit"
            data-i={i}
            x={(G.ml + G.band * i).toFixed(1)}
            y="0"
            width={G.band.toFixed(1)}
            height={H}
            rx="6"
            tabIndex={0}
            role="button"
            aria-pressed={i === selI}
            aria-label={`${c}: ${fPct(vals[i])}, ${vals[i] >= 0 ? "gain" : "loss"}${part[i] ? ", part year" : ""}`}
            {...hitHandlers(i)}
          />
        ))}
        {bracket}
      </svg>
    );
  }

  function numbers(): ReactNode {
    return (
      <div className="tbl-box">
        <table className="tbl-mini">
          <caption>Estimated annual return by year</caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">Return</th>
              <th scope="col" className="tl">
                Direction
              </th>
              <th scope="col" className="tl">
                In annual figures
              </th>
              <th scope="col">Book at year end</th>
            </tr>
          </thead>
          <tbody>
            {ry.map((y, i) => (
              <tr key={y.label} className={i === selI ? "is-sel" : undefined} aria-current={i === selI ? "true" : undefined}>
                <th scope="row">
                  {y.label}
                  {y.part && (
                    <>
                      {" "}
                      <span className="tag hollow">Part year</span>
                    </>
                  )}
                </th>
                <td>{fPct(vals[i])}</td>
                <td className="tl">{vals[i] >= 0 ? "Gain" : "Loss"}</td>
                <td className="tl">{y.part ? "Not counted" : "Counted"}</td>
                <td>{fMoney(y.end)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="panel" id="retPanel" aria-labelledby="c1t">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="c1t">
            Annual returns
          </h3>
        </div>
        <div className="ph-c">
          <Seg
            label="Years shown"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(id) => {
              settle();
              onRange(id === "max" ? "max" : "15");
            }}
          />
          {n > 0 && (
            <button type="button" className="btn btn-secondary sm" aria-pressed={table} onClick={() => setTable((t) => !t)}>
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
              <span>{table ? "Show the chart" : "Show the numbers"}</span>
            </button>
          )}
        </div>
      </div>
      <div className="pb">
        <div className="chart" id="c1Host" ref={host}>
          {n === 0 ? (
            <div className="state">
              <h4>No annual returns yet</h4>
              <p>A return needs at least one quarter between two filings. The chart appears once this fund has one.</p>
            </div>
          ) : table ? (
            numbers()
          ) : (
            chart()
          )}
        </div>
      </div>
    </section>
  );
}
