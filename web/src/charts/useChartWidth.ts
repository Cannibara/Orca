import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Width used when the wrapper has no measurable size (no ResizeObserver, or a 0 report such as jsdom's). */
export const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 260; // a 320px phone leaves a panel about 270px wide

/**
 * Width in px of the element the returned ref is attached to, kept up to date by a
 * ResizeObserver. Never below 260; DEFAULT_WIDTH when the size cannot be measured.
 */
export function useChartWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => setWidth(w > 0 ? Math.max(MIN_WIDTH, Math.round(w)) : DEFAULT_WIDTH);
    apply(el.clientWidth); // measured before the first paint, so there is no flash at the default width
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) apply(last.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
