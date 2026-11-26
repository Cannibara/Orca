// The Holdings tree map's drawing: SVG tiles kept in step with a list of tile data, tweened with
// requestAnimationFrame (persisting tiles move, new ones grow from their centre, leaving ones shrink into
// theirs). A new list mid-tween continues from where every tile is. Imperative on purpose: a period step
// re-lays out dozens of tiles and their labels at 60 fps, which React would re-render each frame.
// Only the boxes move: a tile has its final colour from the moment it exists (the owner wants no colour
// animation; a red tile fading into green passes through brown). The layout, colours and labels themselves
// come from ./treemap (pure).

import type { TipContent, TooltipApi } from "../charts/Tooltip";
import { BASE, FONT_PX, PADX, labelScale, labelSet, neighbour, rgbCss, type Direction, type LabelSet, type LabelTile, type Measure, type Rect, type RGB } from "./treemap";

export type TileDatum = {
  key: string;
  rect: Rect;
  other: boolean;
  /** The fill; null = the hatch pattern (Other stocks). */
  fill: RGB | null;
  /** No return to show: drawn hollow (dashed outline). */
  hollow: boolean;
  ink: RGB;
  /** The name line may be softened to 80%. */
  soft: boolean;
  label: LabelTile;
  aria: string;
  tip: () => TipContent;
  /** Its own labels for a w × h box instead of labelSet's (the home Landscape's names and figures). */
  fit?: (w: number, h: number, measure: Measure) => LabelSet;
  /** Labels at their base size whatever the tile's (a group's heading strip). */
  fixed?: boolean;
  /** The tile's data-kind attribute, for CSS (the Landscape's "grp", "fund", "rest"). */
  kind?: string;
  /** What a click, Enter or Space on the tile does (open a fund, zoom into a group); none: nothing. */
  onActivate?: () => void;
};

type Geo = { x: number; y: number; w: number; h: number };
type Key = "tk" | "w" | "n" | "v";
const KEYS: Key[] = ["tk", "w", "n", "v"];
type Label = { el: SVGTextElement; text: string; kf: { t: number; v: number }[]; texts: { t: number; s: string }[] };

type Node = {
  key: string;
  g: SVGGElement;
  rect: SVGRectElement;
  clipRect: SVGRectElement;
  labels: Record<Key, Label>;
  from: Geo;
  to: Geo;
  t0: number;
  leaving: boolean;
  d: TileDatum;
  /** The labels' scale: k0 at t0, gliding to k (labelScale of the tile's final box) with the box; kShown as drawn. */
  k0: number;
  k: number;
  kShown: number;
};

/** The same motion as the Analysis charts' bars (--d-grow 600 ms on --ease-out, cubic-bezier(.2,.7,.2,1)): the
 * owner wants one speed across the page, and a test holds this to tokens.css. A tile starts moving on the frame
 * after the draw: no delay of its own. */
export const DUR = 600;
/**
 * The words. On that curve a box has covered 56% of its way at 100 ms and 89% at 250 ms, so a label that changes
 * (or a tile that is new) is hidden until 100 ms, then fades in and is fully shown at 250 ms: by then you can see
 * where the box is going. An old text goes out in 70 ms. A label that does not change stays as it is.
 */
export const LABEL_OUT = 70;
export const LABEL_FROM = 100;
export const LABEL_FULL = 250;

/** A CSS cubic-bezier timing function as a function of progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}
export const EASE = bezier(0.2, 0.7, 0.2, 1);

const SVGNS = "http://www.w3.org/2000/svg";
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function kfValue(kf: { t: number; v: number }[], t: number): number {
  if (kf.length === 0) return 0;
  if (t <= kf[0].t) return kf[0].v;
  for (let i = 1; i < kf.length; i++) {
    const a = kf[i - 1];
    const b = kf[i];
    if (t <= b.t) return b.t === a.t ? b.v : lerp(a.v, b.v, (t - a.t) / (b.t - a.t));
  }
  return kf[kf.length - 1].v;
}

export type TreemapView = {
  render(tiles: TileDatum[], animate: boolean): void;
  destroy(): void;
};

/**
 * Draws tiles into `layer` (a <g> of the tree map's <svg>). `hatch` is the url() of the Other stocks pattern.
 * The svg is one Tab stop: the arrow keys move between tiles by where they are, Home and End go to the
 * largest and the last; each tile shows the shared tooltip while hovered or focused.
 */
export function createTreemapView(svg: SVGSVGElement, layer: SVGGElement, opts: { hatch: string; measure: Measure; tip: TooltipApi }): TreemapView {
  const canAnimate = typeof requestAnimationFrame === "function";
  const nodes = new Map<string, Node>();
  let order: Node[] = [];
  let focusKey: string | null = null;
  let raf = 0;
  let clipSeq = 0;

  const progress = (n: Node, t: number) => EASE(Math.max(0, Math.min(1, (t - n.t0) / DUR)));
  const geoAt = (n: Node, t: number): Geo => {
    const p = progress(n, t);
    return { x: lerp(n.from.x, n.to.x, p), y: lerp(n.from.y, n.to.y, p), w: lerp(n.from.w, n.to.w, p), h: lerp(n.from.h, n.to.h, p) };
  };

  const settleTexts = (l: Label, t: number) => {
    while (l.texts.length && l.texts[0].t <= t) {
      const s = l.texts.shift()!.s;
      if (s !== l.text) {
        l.text = s;
        l.el.textContent = s;
      }
    }
  };

  /** Draws the node as it is at time t; true while anything of it is still moving. */
  const apply = (n: Node, t: number): boolean => {
    const geo = geoAt(n, t);
    const w = String(Math.max(0, geo.w));
    const h = String(Math.max(0, geo.h));
    n.g.setAttribute("transform", `translate(${geo.x},${geo.y})`);
    n.rect.setAttribute("width", w);
    n.rect.setAttribute("height", h);
    n.clipRect.setAttribute("width", w);
    n.clipRect.setAttribute("height", h);
    // the value on the ticker's row hugs the tile's right edge as the edge moves
    // the labels' size glides with the box (a big tile's text grows or shrinks with it, never jumps)
    const k = lerp(n.k0, n.k, progress(n, t));
    if (k !== n.kShown) {
      n.kShown = k;
      for (const key of KEYS) {
        const el = n.labels[key].el;
        el.style.fontSize = k === 1 ? "" : FONT_PX[key] * k + "px";
        if (key !== "v") el.setAttribute("x", String(PADX * k));
        el.setAttribute("y", String((key === "v" ? BASE.tk : BASE[key]) * k));
      }
    }
    n.labels.v.el.setAttribute("x", String(Math.max(PADX * k, geo.w - PADX * k)));
    const moves = n.from.x !== n.to.x || n.from.y !== n.to.y || n.from.w !== n.to.w || n.from.h !== n.to.h;
    let busy = moves && t < n.t0 + DUR;
    for (const k of KEYS) {
      const l = n.labels[k];
      settleTexts(l, t);
      l.el.setAttribute("opacity", String(kfValue(l.kf, t)));
      if (l.texts.length || (l.kf.length && t < l.kf[l.kf.length - 1].t)) busy = true;
    }
    return busy;
  };

  let inFrame = false;
  const frame = () => {
    // a requestAnimationFrame that calls back at once (a test's) must not recurse
    if (inFrame) return;
    inFrame = true;
    raf = 0;
    const t = now();
    let busy = false;
    for (const n of [...nodes.values()]) {
      const moving = apply(n, t);
      if (n.leaving && !moving) {
        n.g.remove();
        nodes.delete(n.key);
      } else if (moving) busy = true;
    }
    inFrame = false;
    if (busy && canAnimate) raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const make = (d: TileDatum): Node => {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "tile");
    g.setAttribute("role", "img");
    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("class", "tr");
    rect.setAttribute("rx", "2");
    g.append(rect);
    // labels are clipped to the tile while it moves, so nothing is drawn outside it
    const clipId = `tmclip-${++clipSeq}`;
    const clip = document.createElementNS(SVGNS, "clipPath");
    clip.setAttribute("id", clipId);
    const clipRect = document.createElementNS(SVGNS, "rect");
    clip.append(clipRect);
    g.append(clip);
    const labels = {} as Record<Key, Label>;
    for (const k of KEYS) {
      const el = document.createElementNS(SVGNS, "text");
      el.setAttribute("class", "l-" + k);
      el.setAttribute("x", String(PADX));
      el.setAttribute("y", String(k === "v" ? BASE.tk : BASE[k]));
      if (k === "v") el.setAttribute("text-anchor", "end");
      el.setAttribute("opacity", "0");
      el.setAttribute("clip-path", `url(#${clipId})`);
      g.append(el);
      labels[k] = { el, text: "", kf: [{ t: 0, v: 0 }], texts: [] };
    }
    const n: Node = {
      key: d.key,
      g,
      rect,
      clipRect,
      labels,
      from: { x: 0, y: 0, w: 0, h: 0 },
      to: { x: 0, y: 0, w: 0, h: 0 },
      t0: 0,
      leaving: false,
      d,
      k0: 1,
      k: 1,
      kShown: 1,
    };
    const show = (e: PointerEvent) => opts.tip.show(n.d.tip(), e.clientX, e.clientY);
    g.addEventListener("click", () => {
      if (!n.leaving) n.d.onActivate?.();
    });
    g.addEventListener("pointerenter", show);
    g.addEventListener("pointermove", show);
    g.addEventListener("pointerleave", () => opts.tip.hide());
    g.addEventListener("focus", () => {
      focusKey = n.key;
      for (const m of order) m.g.setAttribute("tabindex", m === n ? "0" : "-1");
      const b = g.getBoundingClientRect();
      opts.tip.show(n.d.tip(), b.left + b.width / 2, b.top);
    });
    g.addEventListener("blur", () => opts.tip.hide());
    return n;
  };

  /** Sets what the tile's labels say for its new box `nb`, and when each one shows (see LABEL_FULL). */
  const setLabels = (n: Node, nb: Rect, anim: boolean, t: number) => {
    // a big tile draws its labels larger: they are fitted at base size into the box shrunk by k, then scaled up
    const k = n.d.fixed ? 1 : labelScale(nb.w, nb.h);
    const fin = n.d.fit ? n.d.fit(nb.w / k, nb.h / k, opts.measure) : labelSet(n.d.label, nb.w / k, nb.h / k, opts.measure);
    // from the size drawn now (a tile with no text yet starts at its final size: it fades in), to k; apply() draws it
    n.k0 = anim && Object.values(n.labels).some((l) => l.text !== "") ? n.kShown : k;
    n.k = k;
    for (const k of KEYS) {
      const l = n.labels[k];
      settleTexts(l, t);
      const cur = kfValue(l.kf, t);
      const f = fin[k] ?? "";
      l.texts = [];
      const put = (s: string) => {
        if (s !== l.text) {
          l.text = s;
          l.el.textContent = s;
        }
      };
      if (!anim) {
        put(f);
        l.kf = [{ t, v: f ? 1 : 0 }];
      } else if (f === l.text) {
        // unchanged: it stays (a fade still running carries on to full)
        l.kf = f && cur < 1 ? [{ t, v: cur }, { t: t + LABEL_FULL, v: 1 }] : [{ t, v: f ? 1 : 0 }];
      } else if (l.text === "") {
        // new on this tile: hidden, then in by the midway point
        put(f);
        l.kf = [{ t, v: 0 }, { t: t + LABEL_FROM, v: 0 }, { t: t + LABEL_FULL, v: 1 }];
      } else if (f === "") {
        l.kf = [{ t, v: cur }, { t: t + LABEL_OUT, v: 0 }];
        l.texts = [{ t: t + LABEL_OUT, s: "" }];
      } else {
        // a new text: the old one goes, the new one is in by the midway point
        l.kf = [{ t, v: cur }, { t: t + LABEL_OUT, v: 0 }, { t: t + LABEL_FROM, v: 0 }, { t: t + LABEL_FULL, v: 1 }];
        l.texts = [{ t: t + LABEL_OUT, s: f }];
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const i = order.findIndex((n) => n.g === document.activeElement);
    if (i < 0) return;
    if ((e.key === "Enter" || e.key === " ") && order[i].d.onActivate) {
      e.preventDefault();
      order[i].d.onActivate!();
      return;
    }
    const dirs: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    let j: number | null = null;
    if (e.key === "Home") j = 0;
    else if (e.key === "End") j = order.length - 1;
    else if (dirs[e.key])
      j = neighbour(
        order.map((n) => n.d.rect),
        i,
        dirs[e.key],
      );
    else return;
    // nothing that way: the key is left to scroll the page
    if (j === null || j === i) return;
    e.preventDefault();
    order[j].g.focus();
  };
  svg.addEventListener("keydown", onKey);

  return {
    render(tiles, animate) {
      const t = now();
      const anim = animate && canAnimate; // the first draw grows every tile from its centre
      const keep = new Set(tiles.map((d) => d.key));
      for (const n of nodes.values()) {
        if (keep.has(n.key) || n.leaving) continue;
        if (!anim) {
          n.g.remove();
          nodes.delete(n.key);
          continue;
        }
        const c = geoAt(n, t);
        n.leaving = true;
        n.g.classList.add("out");
        n.g.removeAttribute("tabindex");
        n.g.setAttribute("aria-hidden", "true");
        n.from = c;
        n.to = { x: c.x + c.w / 2, y: c.y + c.h / 2, w: 0, h: 0 };
        n.t0 = t;
        for (const k of KEYS) {
          const l = n.labels[k];
          settleTexts(l, t);
          l.texts = [];
          l.kf = [
            { t, v: kfValue(l.kf, t) },
            { t: t + LABEL_OUT, v: 0 },
          ];
        }
      }

      if (focusKey === null || !keep.has(focusKey)) focusKey = tiles.length ? tiles[0].key : null;
      const focusInside = svg.contains(document.activeElement);
      order = tiles.map((d) => {
        let n = nodes.get(d.key);
        const r = d.rect;
        const target: Geo = { x: r.x, y: r.y, w: r.w, h: r.h };
        if (!n || n.leaving) {
          if (n) {
            n.g.remove();
            nodes.delete(n.key);
          }
          n = make(d);
          nodes.set(d.key, n);
          n.from = anim ? { x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 } : target;
        } else {
          n.from = anim ? geoAt(n, t) : target;
        }
        n.d = d;
        n.to = target;
        n.t0 = t;
        // colours are set once, here, and never tweened
        n.rect.style.fill = d.fill === null ? opts.hatch : rgbCss(d.fill);
        const ink = rgbCss(d.ink);
        for (const k of KEYS) n.labels[k].el.style.fill = ink;
        setLabels(n, r, anim, t);
        n.g.classList.toggle("oth", d.other);
        n.g.classList.toggle("nul", d.hollow);
        if (d.kind) n.g.setAttribute("data-kind", d.kind);
        else n.g.removeAttribute("data-kind");
        n.g.toggleAttribute("data-act", !!d.onActivate);
        n.g.classList.remove("out");
        n.g.removeAttribute("aria-hidden");
        n.g.setAttribute("aria-label", d.aria);
        n.g.setAttribute("tabindex", d.key === focusKey ? "0" : "-1");
        n.labels.n.el.style.fillOpacity = d.soft ? "0.8" : "1";
        return n;
      });
      // DOM order follows the layout (largest first) for reading order; leaving tiles stay underneath. A focused
      // tile is never moved: moving an element drops its focus.
      if (!focusInside) for (const n of order) layer.append(n.g);
      else for (const n of order) if (!n.g.isConnected) layer.append(n.g);
      opts.tip.hide();
      if (!anim) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        frame();
      } else kick();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      svg.removeEventListener("keydown", onKey);
      for (const n of nodes.values()) n.g.remove();
      nodes.clear();
      order = [];
    },
  };
}
