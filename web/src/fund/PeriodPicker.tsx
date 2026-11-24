import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Seg } from "./Seg";
import { qShort } from "./fmt";
import { reducedMotion } from "./hooks";
import { periodValues, withMode, withYearQuarter, yearRange, type Mode, type PeriodState, type Timeline } from "./positions";
import "./positions.css";

// The Holdings panel's header and period picker: the title and the as-of line, the Quarter / Year switch (and,
// in Year mode, which quarter the years end in), and the stepper (three periods in full with the edge of the
// ones either side peeking in, arrows, mouse-wheel hint). One picker drives the tree map and the Positions
// table. The mouse wheel over the header or the tools steps through periods (down goes back in time) once the
// page is at rest, and trying to go past the newest or oldest one makes the selected pill nudge and spring back.
// The same goes for the element passed as `alsoOn` (the tree map, owner 2026-11-23). On a touch screen a sideways
// swipe on any of them steps one period: left for a later one, right for an earlier one (the pills run old → new).
// `wheelOn` (the Positions table, owner 2026-11-24) takes the wheel only: a phone is too narrow for the whole table,
// so a sideways swipe there must keep scrolling the columns. A sideways wheel (shift, or a trackpad) is left alone
// for the same reason.

const MODES: { id: Mode; label: string }[] = [
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
];

/** The wheel has to travel this far (px) before it steps a period, and steps no faster than every 60ms. */
const WHEEL_STEP = 24;
const WHEEL_GAP = 60;
/** Within this long (ms) of a page scroll the wheel keeps scrolling the page: the picker only steps from rest. */
const WHEEL_REST = 300;
/** A swipe: the finger travels this far (px) sideways, and more sideways than up or down, before it steps. */
const SWIPE_STEP = 40;

type Props = {
  state: PeriodState;
  onChange: (next: PeriodState) => void;
  tl: Timeline;
  /** The panel's heading and its id (the panel is labelled by it). */
  title: string;
  titleId: string;
  /** The as-of line, already printed: "Holdings and prices as of 30 Oct 2026". */
  asOf: string;
  /** Another element whose wheel and swipes step the periods too: the tree map. */
  alsoOn?: RefObject<HTMLElement | null>;
  /** Another element whose wheel (not its swipes) steps the periods: the Positions table. */
  wheelOn?: RefObject<HTMLElement | null>;
};

export function PeriodPicker({ state, onChange, tl, title, titleId, asOf, alsoOn, wheelOn }: Props) {
  const { mode } = state;
  const ys = mode === "year";
  const vals = periodValues(state, tl);
  const n = vals.length;
  const cur = ys ? state.py : state.pq;
  const ci = Math.max(0, vals.indexOf(cur));

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

  /** dx periods later (a quarter, or a year of four quarters). */
  const step = (dx: number) => {
    const ni = Math.max(0, Math.min(n - 1, ci + dx));
    if (ni !== ci) pick(vals[ni]);
    else jiggle(dx);
  };

  // The wheel listener is attached once and reads the latest step through this.
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    // Native, non-passive listeners: the page must not scroll under a wheel that steps periods.
    let acc = 0;
    let last = 0;
    let seen = 0;
    // The picker sits near the top of the page: a page scroll that carries it under the cursor keeps scrolling
    // the page (like the browser's own scroll latching); the wheel steps periods only from rest.
    let paged = 0;
    const onScroll = () => {
      paged = Date.now();
    };
    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now - paged < WHEEL_REST) return;
      // a sideways wheel scrolls the table's columns (shift + wheel, a trackpad swipe): not ours
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
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

    // Touch: one step per sideways swipe, taken as soon as the finger has gone far enough. Up-and-down stays the
    // page's (touch-action: pan-y in CSS; the browser then cancels the pointer and scrolls).
    let sx = 0;
    let sy = 0;
    let sid: number | null = null;
    let swiped = 0;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      sid = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== sid) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < SWIPE_STEP || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
      sid = null;
      swiped = Date.now();
      stepRef.current(dx < 0 ? 1 : -1);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId === sid) sid = null;
    };
    // the lift after a swipe must not also press the pill or button it ended on
    const onClick = (e: MouseEvent) => {
      if (Date.now() - swiped < 400) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    const els = [phRef.current, toolsRef.current, alsoOn?.current ?? null].filter((el): el is HTMLElement => el != null);
    const wheelOnly = wheelOn?.current ?? null;
    wheelOnly?.addEventListener("wheel", onWheel, { passive: false });
    els.forEach((el) => {
      el.addEventListener("wheel", onWheel, { passive: false });
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onEnd);
      el.addEventListener("pointercancel", onEnd);
      el.addEventListener("click", onClick, true);
    });
    return () => {
      window.removeEventListener("scroll", onScroll);
      wheelOnly?.removeEventListener("wheel", onWheel);
      els.forEach((el) => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onEnd);
        el.removeEventListener("pointercancel", onEnd);
        el.removeEventListener("click", onClick, true);
      });
    };
    // `alsoOn` and `wheelOn` are refs: their elements are in place when this runs (all rendered in the same pass as
    // the picker), and never swapped
  }, []);

  // A pick from the list keeps the focus on the list: the selected pill is a different element afterwards.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    winRef.current?.querySelector<HTMLElement>(".pi.on .psel-o")?.focus({ preventScroll: true });
  });

  // Three periods in full, the selected one among them, with the edge of the periods either side peeking in.
  const st = Math.max(0, Math.min(n - 3, ci - 1));
  const slots: number[] = [];
  for (let i = st - 1; i <= st + 3; i++) slots.push(i);

  const hint = ys ? "Scroll with the mouse wheel to change year" : "Scroll with the mouse wheel to change quarter";
  const quarters = [0, 1, 2, 3].map((yq) => {
    const r = yearRange(tl, yq);
    return { id: String(yq), label: "Q" + (yq + 1), title: `Years ending in Q${yq + 1}`, disabled: r.lo > r.hi };
  });

  return (
    <>
      <div className="ph" ref={phRef}>
        <div className="ph-t">
          <h3 className="pt" id={titleId}>
            {title}
          </h3>
        </div>
        <div className="ph-c">
          <span className="asof">{asOf}</span>
        </div>
      </div>
      <div className="ptools" ref={toolsRef}>
        <div className="pmodes">
          <Seg label="Period" options={MODES} value={mode} onChange={(id) => onChange(withMode(state, id as Mode, tl))} />
          {ys && <Seg label="Years end in" options={quarters} value={String(state.yq)} onChange={(id) => onChange(withYearQuarter(state, Number(id), tl))} />}
        </div>
        <div className="stepper" role="group" aria-label={ys ? "Year" : "Quarter"} title={hint}>
          {/* The arrows grey out at the ends but stay clickable (aria-disabled, not disabled), so a click can still nudge. */}
          <button type="button" aria-label={ys ? "Earlier year" : "Earlier quarter"} aria-disabled={ci <= 0} onClick={() => step(-1)}>
            <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.75 4 5.75 8l4 4" />
            </svg>
          </button>
          <span className="pwin" ref={winRef}>
            <span className="ptrack">
              {slots.map((i) => {
                if (i < 0 || i >= n) return <span key={"h" + i} className="pi hole" aria-hidden="true" />;
                const v = vals[i];
                const on = i === ci;
                const edge = i === st - 1 || i === st + 3;
                return (
                  <button
                    key={v}
                    type="button"
                    className={"pi" + (on ? " on" : "") + (edge ? " edge" : "")}
                    data-v={v}
                    aria-pressed={on}
                    // the selected pill's list is its tab stop; the pill itself does nothing
                    tabIndex={edge || on ? -1 : undefined}
                    aria-label={edge ? qShort(v) : undefined}
                    onClick={(e) => {
                      if (on || (e.target as HTMLElement).tagName === "SELECT") return;
                      refocus.current = false;
                      pick(v);
                    }}
                  >
                    <span>{qShort(v)}</span>
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
                          {vals
                            .slice()
                            .reverse()
                            .map((o) => (
                              <option key={o} value={o}>
                                {qShort(o)}
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
          <button type="button" aria-label={ys ? "Later year" : "Later quarter"} aria-disabled={ci >= n - 1} onClick={() => step(1)}>
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
    </>
  );
}
