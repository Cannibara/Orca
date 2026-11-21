// Eased scrolling for the Famous funds window (spec 7.2): the wheel and the keys set a target, and the list
// glides there with a slow start, full speed, then a slow settle, so the fitted axis moves at the same pace
// as the rows. A scroll the glide did not cause (scrollbar drag, touch with its own momentum) is followed as is.
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

/**
 * `box` is the scrolling element (it must stay mounted while the hook is); `onPos` gets the position in rows
 * (scrollTop / rowH) on every frame of a glide and on every other scroll. Without requestAnimationFrame or
 * with reduced motion a glide jumps straight to its target.
 */
export function useEasedScroll(
  box: RefObject<HTMLElement>,
  rowH: number,
  onPos: (p: number) => void,
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
      el.scrollTop = top;
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
      el.scrollTop = st.C;
      report.current(st.C / rowH);
      st.anim = st.C === st.T ? 0 : requestAnimationFrame(step);
    };
    return {
      glide(toTop) {
        const el = box.current;
        if (!el) return;
        const st = s.current;
        const T = Math.max(0, Math.min(max(el), toTop));
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
        Object.assign(s.current, { T: top, T2: top, C: top, v: 0 });
      },
      target() {
        return s.current.anim ? s.current.T : (box.current?.scrollTop ?? 0);
      },
    };
  }, [box, rowH]);

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
  }, [box, rowH, api]);

  return api;
}
