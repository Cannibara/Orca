// Eased scrolling for the Famous funds window (spec 7.2): the wheel and the keys set a target, and the list
// glides there with a slow start, full speed, then a slow settle, so the fitted axis moves at the same pace
// as the rows. A scroll the glide did not cause (scrollbar drag, touch with its own momentum) is followed as is.
//
// Chrome keeps a scrollTop set from script in whole CSS pixels (10.25 → 10, even at 2x), so the slow start and
// settle, under 2 px a frame, came out as 1 px hops at uneven gaps: the glide looked unsmoothed there. The box
// takes the whole pixels and the rest is a sub-pixel translateY on its first child (the list), so the rows move
// by the exact eased amount every frame. Safari keeps the fraction, so there the shift is 0. A table body (the
// ranked tables, home/ScrollTable.tsx) has no one child holding its rows: there the rest goes in its `--sub`
// property, which its rows' CSS turns into the same translateY (`rows` mode).
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { reducedMotion } from "../fund/hooks";

export type EasedScroll = {
  /** Glide to this scrollTop (clamped to the scroll range). */
  glide(toTop: number): void;
  /** Stop where the list is now. */
  stop(): void;
  /** Where the list is heading: the glide's target, or scrollTop when at rest (so keys pressed quickly add up). */
  target(): number;
};

const EASE_IN = 0.2; // the target itself eases in: the slow start
const K = 0.05; // spring stiffness per 60fps frame
const DAMP = 2 * Math.sqrt(K); // critically damped: no overshoot
const OWN = 1.5; // px: a scroll event this close to the glide's position is the glide's own

/** How the fraction of a pixel is shown: a translate on the box's first child, or `--sub` on the box itself
 * (with class `sub` while it is not 0) for a table body whose rows translate by it. */
export type Layer = "child" | "rows";

/** Moves the box's first child (the list) by `px`, a fraction of a pixel; 0 takes the shift off. */
function shift(el: HTMLElement, px: number, layer: Layer) {
  if (layer === "rows") {
    const on = Math.abs(px) >= 0.01;
    const v = on ? `${+px.toFixed(3)}px` : "";
    if (el.style.getPropertyValue("--sub") !== v) {
      if (on) el.style.setProperty("--sub", v);
      else el.style.removeProperty("--sub");
      el.classList.toggle("sub", on);
    }
    return;
  }
  const list = el.firstElementChild as HTMLElement | null;
  if (!list) return;
  const v = Math.abs(px) < 0.01 ? "" : `translateY(${+px.toFixed(3)}px)`;
  if (list.style.transform !== v) list.style.transform = v;
}

/** Shows the list at `top`: the box scrolls to what it keeps (Chrome: whole pixels) and the list makes up the rest. */
function place(el: HTMLElement, top: number, layer: Layer) {
  el.scrollTop = top;
  const kept = el.scrollTop - top;
  // more than a pixel off is a clamp at an end, not rounding: no shift past the end of the list
  shift(el, Math.abs(kept) < 1 ? kept : 0, layer);
}

/**
 * `box` is the scrolling element (it must stay mounted while the hook is); `onPos` gets the position in rows
 * (scrollTop / rowH) on every frame of a glide and on every other scroll. Without requestAnimationFrame or
 * with reduced motion a glide jumps straight to its target.
 */
export function useEasedScroll(
  box: RefObject<HTMLElement>,
  rowH: number,
  onPos: (p: number) => void,
  layer: Layer = "child",
): EasedScroll {
  const report = useRef(onPos);
  report.current = onPos;
  // T target, T2 smoothed target, C current position, v velocity (px per frame), anim the frame request
  const s = useRef({ T: 0, T2: 0, C: 0, v: 0, anim: 0, last: 0 });

  const api = useMemo<EasedScroll>(() => {
    const max = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);
    const halt = () => {
      if (s.current.anim) cancelAnimationFrame(s.current.anim);
      s.current.anim = 0;
    };
    const settleAt = (el: HTMLElement, top: number) => {
      halt();
      Object.assign(s.current, { T: top, T2: top, C: top, v: 0 });
      place(el, top, layer);
      report.current(top / rowH);
    };
    const step = (now: number) => {
      const el = box.current;
      const st = s.current;
      if (!el) return void (st.anim = 0);
      const dt = st.last ? Math.min(2, (now - st.last) / 16.667) : 1;
      st.last = now;
      st.T2 += (st.T - st.T2) * Math.min(1, EASE_IN * dt);
      const a = (st.T2 - st.C) * K - st.v * DAMP;
      st.v += a * dt;
      st.C += st.v * dt;
      if (Math.abs(st.T - st.C) < 0.4 && Math.abs(st.v) < 0.05) {
        st.C = st.T2 = st.T;
        st.v = 0;
      }
      place(el, st.C, layer);
      report.current(st.C / rowH);
      st.anim = st.C === st.T ? 0 : requestAnimationFrame(step);
    };
    return {
      glide(toTop) {
        const el = box.current;
        if (!el) return;
        const st = s.current;
        // a whole pixel, so the glide comes to rest with no sub-pixel shift left on the rows
        const T = Math.round(Math.max(0, Math.min(max(el), toTop)));
        if (typeof requestAnimationFrame !== "function" || reducedMotion()) return settleAt(el, T);
        if (!st.anim) {
          if (T === el.scrollTop) return;
          Object.assign(st, { C: el.scrollTop, T2: el.scrollTop, v: 0, last: 0 });
          st.anim = requestAnimationFrame(step);
        }
        st.T = T;
      },
      stop() {
        const el = box.current;
        halt();
        const top = el ? el.scrollTop : 0;
        if (el) shift(el, 0, layer);
        Object.assign(s.current, { T: top, T2: top, C: top, v: 0 });
      },
      target() {
        return s.current.anim ? s.current.T : (box.current?.scrollTop ?? 0);
      },
    };
  }, [box, rowH, layer]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch zoom
      // a wheel the browser will scroll anyway (it cannot be held back): gliding as well would scroll twice
      if (!e.cancelable) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a sideways swipe on a trackpad is not for the list
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      const from = api.target();
      const end = Math.max(0, el.scrollHeight - el.clientHeight);
      // at an end (or nothing to scroll): let the page scroll on
      if (dy === 0 || (dy < 0 && from <= 0) || (dy > 0 && from >= end - 0.5)) return;
      e.preventDefault();
      api.glide(from + dy);
    };
    const onScroll = () => {
      const st = s.current;
      const top = el.scrollTop;
      if (st.anim && Math.abs(top - st.C) <= OWN) return; // the glide's own frame, already reported
      if (st.anim) cancelAnimationFrame(st.anim);
      shift(el, 0, layer);
      Object.assign(st, { T: top, T2: top, C: top, v: 0, anim: 0 });
      report.current(top / rowH);
    };
    // React's onWheel is passive, so it could not keep the page from scrolling
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      api.stop();
    };
  }, [box, rowH, api, layer]);

  return api;
}
