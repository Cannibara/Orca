import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { PeriodStrip } from "./PeriodStrip";
import { Seg } from "./Seg";
import { qShort } from "./fmt";
import { reducedMotion } from "./hooks";
import { yearLabel, yearRange, type Mode, type PeriodState, type Timeline } from "./positions";
import "./positions.css";

// The Positions panel's header and period picker: the title and "as of" date, the Quarter / Year / Custom
// switch, the stepper (three periods in full with the edge of the ones either side peeking in, arrows,
// mouse-wheel hint) and the custom strip. Ported from the artifact's period picker. The mouse wheel
// over the header or the tools steps through periods (down goes back in time), and trying to go
// past the newest or oldest one makes the selected pill nudge and spring back.

const MODES: { id: Mode; label: string }[] = [
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
  { id: "custom", label: "Custom" },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The wheel has to travel this far (px) before it steps a period, and steps no faster than every 60ms. */
const WHEEL_STEP = 24;
const WHEEL_GAP = 60;

type Props = {
  state: PeriodState;
  onChange: (next: PeriodState) => void;
  tl: Timeline;
  /** The end date of the period, already printed: "30 Oct 2026". */
  asOf: string;
};

export function PeriodPicker({ state, onChange, tl, asOf }: Props) {
  const { mode } = state;
  const ys = mode === "year";
  const yr = yearRange(tl);
  const cur = ys ? state.py : state.pq;
  const lo = ys ? yr.lo : tl.qmin;
  const hi = ys ? yr.hi : tl.latest;
  const lab = (v: number) => (ys ? yearLabel(v, tl) : qShort(v));

  const phRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<HTMLSpanElement>(null);
  const jig = useRef<Animation | null>(null);
  const refocus = useRef(false);

  const pick = (v: number) => onChange(ys ? { ...state, py: v } : { ...state, pq: v });

  /** At the end of the range the selected period nudges towards the missing side and springs back: "no more that way". */
  const jiggle = (dir: number) => {
    if (reducedMotion()) return;
    const el = winRef.current?.querySelector<HTMLElement>(".pi.on");
    if (!el || typeof el.animate !== "function") return;
    if (jig.current && jig.current.playState === "running") return;
    const sg = dir > 0 ? 1 : -1;
    jig.current = el.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${14 * sg}px) scaleX(1.06)`, offset: 0.18 },
        { transform: `translateX(${-6 * sg}px)`, offset: 0.42 },
        { transform: `translateX(${3.5 * sg}px)`, offset: 0.62 },
        { transform: `translateX(${-1.5 * sg}px)`, offset: 0.8 },
        { transform: "translateX(0)" },
      ],
      { duration: 640, easing: "cubic-bezier(.25,.8,.35,1)" },
    );
  };

  const step = (dx: number) => {
    if (mode === "custom") return;
    const next = clamp(cur + dx, lo, hi);
    if (next !== cur) pick(next);
    else jiggle(dx);
  };

  // The wheel listener is attached once and reads the latest step through this.
  const stepRef = useRef(step);
  stepRef.current = step;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    // Native, non-passive listeners: the page must not scroll under a wheel that steps periods.
    let acc = 0;
    let last = 0;
    let seen = 0;
    const onWheel = (e: WheelEvent) => {
      if (modeRef.current === "custom") return;
      e.preventDefault();
      const now = Date.now();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1); // lines and pages (Firefox, some mice) to pixels
      if (now - seen > 250 || dy > 0 !== acc > 0) acc = 0;
      seen = now;
      acc += dy;
      if (Math.abs(acc) < WHEEL_STEP) return;
      if (now - last < WHEEL_GAP) {
        acc = 0;
        return;
      }
      last = now;
      stepRef.current(acc > 0 ? -1 : 1);
      acc = 0;
    };
    const els = [phRef.current, toolsRef.current].filter((el): el is HTMLDivElement => el !== null);
    els.forEach((el) => el.addEventListener("wheel", onWheel, { passive: false }));
    return () => els.forEach((el) => el.removeEventListener("wheel", onWheel));
  }, []);

  // A pick from the list takes the focus with it: the selected pill is a different element afterwards.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    winRef.current?.querySelector<HTMLElement>(".pi.on")?.focus({ preventScroll: true });
  });

  // Three periods in full, the selected one among them, with the edge of the periods either side peeking in.
  const st = Math.max(lo, Math.min(hi - 2, cur - 1));
  const slots: number[] = [];
  for (let v = st - 1; v <= st + 3; v++) slots.push(v);
  const options: number[] = [];
  for (let v = hi; v >= lo; v--) options.push(v);

  const strip = useMemo(() => {
    const names: string[] = [];
    const ticks: string[] = [];
    for (let q = tl.qmin; q <= tl.latest; q++) {
      names.push(qShort(q));
      ticks.push(q % 4 === 0 ? "’" + String(2013 + Math.floor(q / 4)).slice(2) : "");
    }
    return { names, ticks };
  }, [tl.qmin, tl.latest]);

  const hint = ys ? "Scroll with the mouse wheel to change year" : "Scroll with the mouse wheel to change quarter";

  return (
    <>
      <div className="ph" ref={phRef}>
        <div className="ph-t">
          <h3 className="pt" id="posTitle">
            Positions
          </h3>
        </div>
        <div className="ph-c">
          <span className="asof">{"Positions and prices as of " + asOf}</span>
        </div>
      </div>
      <div className="ptools" ref={toolsRef}>
        <Seg label="Period" options={MODES} value={mode} onChange={(id) => onChange({ ...state, mode: id as Mode })} />
        <div className="stepper" role="group" aria-label={ys ? "Year" : "Quarter"} title={hint} hidden={mode === "custom"}>
          {/* The arrows grey out at the ends but stay clickable (aria-disabled, not disabled), so a click can still nudge. */}
          <button type="button" aria-label={ys ? "Earlier year" : "Earlier quarter"} aria-disabled={cur <= lo} onClick={() => step(-1)}>
            <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.75 4 5.75 8l4 4" />
            </svg>
          </button>
          <span className="pwin" ref={winRef}>
            <span className="ptrack">
              {slots.map((v) => {
                if (v < lo || v > hi) return <span key={"ph" + v} className="pi hole" aria-hidden="true" />;
                const on = v === cur;
                const edge = v === st - 1 || v === st + 3;
                return (
                  <button
                    key={v}
                    type="button"
                    className={"pi" + (on ? " on" : "") + (edge ? " edge" : "")}
                    data-v={v}
                    aria-pressed={on}
                    tabIndex={edge ? -1 : undefined}
                    aria-label={edge ? lab(v) : undefined}
                    onClick={() => {
                      if (on) return;
                      refocus.current = false;
                      pick(v);
                    }}
                  >
                    <span>{lab(v)}</span>
                    {on && (
                      <>
                        <svg className="ico caret" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 6.25 8 10.25l4-4" />
                        </svg>
                        <select
                          className="psel-o"
                          aria-label={ys ? "Pick a year" : "Pick a quarter"}
                          value={v}
                          onChange={(e) => {
                            refocus.current = true;
                            pick(Number(e.target.value));
                          }}
                        >
                          {options.map((o) => (
                            <option key={o} value={o}>
                              {lab(o)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </button>
                );
              })}
            </span>
          </span>
          <button type="button" aria-label={ys ? "Later year" : "Later quarter"} aria-disabled={cur >= hi} onClick={() => step(1)}>
            <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.25 4l4 4-4 4" />
            </svg>
          </button>
          <span className="whint" aria-hidden="true">
            <svg viewBox="0 0 12 18">
              <rect x="1" y="1" width="10" height="16" rx="5" />
              <path className="wd" d="M6 4.5v3.2" />
            </svg>
          </span>
        </div>
      </div>
      {mode === "custom" && (
        <PeriodStrip
          variant="quarters"
          names={strip.names}
          tickLabels={strip.ticks}
          a={state.pr.a - tl.qmin}
          b={state.pr.b - tl.qmin}
          onChange={(a, b) => onChange({ ...state, pr: { a: a + tl.qmin, b: b + tl.qmin } })}
          ariaLabel="Custom period for the positions table. Drag the handles or the box, or use the arrow keys on a handle."
        />
      )}
    </>
  );
}
