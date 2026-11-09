// Small hooks of the fund page: motion preference, element width, and the one-time
// grow-in of a chart.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** True when motion should be off: the user asks for less, or <html data-motion="reduce"> says so. */
export function reducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.getAttribute("data-motion") === "reduce") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Width in px of the element `ref` points at (it must have no padding), floored and never
 * below `min`; `fallback` when it cannot be measured (jsdom, hidden, no ResizeObserver).
 */
export function useWidth(ref: RefObject<HTMLElement>, min = 280, fallback = 600): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => setWidth(w > 0 ? Math.max(min, Math.floor(w)) : fallback);
    apply(el.clientWidth); // before the first paint, so there is no flash at the fallback width
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) apply(last.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min, fallback]);
  return width;
}

type GrowPhase = "pre" | "run" | "done";

export type GrowOnce = {
  /** Class suffix for the chart's <svg className={"viz" + cls}>: " pre" (bars hidden), " run" (growing), or "". */
  cls: "" | " pre" | " run";
  /** End the animation now (a selection or a resize must not replay it). */
  settle: () => void;
  /** Arm the grow-in again: bars hide and grow when the host is next 25% visible. */
  replay: () => void;
};

const canAnimate = (): boolean => typeof IntersectionObserver !== "undefined" && !reducedMotion();

/**
 * The grow-in of a chart: the bars start hidden, and grow once when `ref`'s element is
 * first 25% visible. A re-render never restarts it. Without IntersectionObserver, or
 * with reduced motion, there is no animation and `cls` is always "". `durMs` is how
 * long the run lasts before the chart counts as settled.
 */
export function useGrowOnce(ref: RefObject<HTMLElement>, { durMs = 2400 }: { durMs?: number } = {}): GrowOnce {
  const [phase, setPhase] = useState<GrowPhase>(() => (canAnimate() ? "pre" : "done"));
  const [armId, setArmId] = useState(0);
  const timer = useRef<number>(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canAnimate()) {
      setPhase("done");
      return;
    }
    setPhase("pre");
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (!last?.isIntersecting) return;
        io.disconnect();
        setPhase("run");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPhase("done"), durMs);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer.current);
    };
  }, [ref, armId, durMs]);

  const settle = useCallback(() => {
    window.clearTimeout(timer.current);
    setPhase((p) => (p === "run" ? "done" : p));
  }, []);
  const replay = useCallback(() => setArmId((n) => n + 1), []);

  return { cls: phase === "pre" ? " pre" : phase === "run" ? " run" : "", settle, replay };
}
