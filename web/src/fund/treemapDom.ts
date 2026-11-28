// The tree maps' DOM side, shared by the fund page's Holdings and the home page's Landscape: the colour tokens
// as the page has them now, a key that bumps when the theme changes, and text widths in the label fonts.

import { useEffect, useState } from "react";
import { parseColor, type LabelFont, type Measure, type RGB, type Scale } from "./treemap";

export type Colours = { scale: Scale; ink: RGB; surface: RGB; band: RGB };

/** The tree map's tokens as they are now (both themes define them; the defaults are the light theme's). */
export function readColours(): Colours {
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  const get = (name: string, fallback: string): RGB => parseColor(cs?.getPropertyValue(name) ?? "") ?? (parseColor(fallback) as RGB);
  return {
    scale: {
      gain: get("--tm-gain", "#00875F"),
      gainLo: get("--tm-gain-lo", "#C4ECDC"),
      loss: get("--tm-loss", "#D60F25"),
      lossLo: get("--tm-loss-lo", "#FBCDD1"),
    },
    ink: get("--ink", "#1B1916"),
    surface: get("--surface", "#FFFCF8"),
    band: get("--band", "#F0E6D8"),
  };
}

/** Bumps when the page switches theme (the switch, or the device's setting), so the colours are read again. */
export function useThemeKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const bump = () => setKey((k) => k + 1);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(bump) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener?.("change", bump);
    return () => {
      mo?.disconnect();
      mq?.removeEventListener?.("change", bump);
    };
  }, []);
  return key;
}

export const SIZES: Record<LabelFont, number> = { tk: 13, oth: 13, w: 12, n: 11.5 };

/**
 * Text widths in the label fonts, from a canvas once the page's fonts are known; a character-count estimate
 * where there is no canvas to ask (jsdom).
 */
export function makeMeasure(root: () => HTMLElement | null): Measure & { clear(): void } {
  const cache = new Map<string, number>();
  let ctx: CanvasRenderingContext2D | null | undefined;
  const fonts = () => {
    const cs = root() ? getComputedStyle(root() as HTMLElement) : null;
    const mono = cs?.getPropertyValue("--f-mono").trim() || "monospace";
    const sans = cs?.getPropertyValue("--f-sans").trim() || "sans-serif";
    return { tk: `600 13px ${mono}`, oth: `600 13px ${sans}`, w: `500 12px ${sans}`, n: `400 11.5px ${sans}` } as Record<LabelFont, string>;
  };
  let f: Record<LabelFont, string> | null = null;
  const m = ((font: LabelFont, s: string) => {
    const k = font + "|" + s;
    let w = cache.get(k);
    if (w === undefined) {
      if (ctx === undefined) ctx = "fonts" in document ? document.createElement("canvas").getContext("2d") : null;
      if (ctx) {
        f ??= fonts();
        ctx.font = f[font];
        w = ctx.measureText(s).width * (font === "tk" ? 0.99 : 1) + 1;
      } else w = s.length * SIZES[font] * (font === "tk" ? 0.62 : 0.56);
      cache.set(k, w);
    }
    return w;
  }) as Measure & { clear(): void };
  m.clear = () => {
    cache.clear();
    f = null;
  };
  return m;
}
