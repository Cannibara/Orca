// The Holdings tree map's drawing: SVG tiles kept in step with a list of tile data, tweened with
// requestAnimationFrame (persisting tiles move and recolour, new ones grow from their centre, leaving ones
// shrink into theirs). A new list mid-tween continues from where every tile is. Imperative on purpose: a
// period step re-lays out dozens of tiles and their labels at 60 fps, which React would re-render each frame.
// The layout, colours and labels themselves come from ./treemap (pure).

import type { TipContent, TooltipApi } from "../charts/Tooltip";
import { BASE, PADX, labelSet, neighbour, rgbCss, type Direction, type LabelTile, type Measure, type Rect, type RGB } from "./treemap";

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
};

type Geo = { x: number; y: number; w: number; h: number; op: number };
type Key = "tk" | "w" | "n";
const KEYS: Key[] = ["tk", "w", "n"];
type Label = { el: SVGTextElement; text: string; kf: { t: number; v: number }[]; texts: { t: number; s: string }[] };

type Node = {
  key: string;
  g: SVGGElement;
  rect: SVGRectElement;
  labels: Record<Key, Label>;
  from: Geo;
  to: Geo;
  t0: number;
  fillFrom: RGB | null;
  fillTo: RGB | null;
  inkFrom: RGB;
  inkTo: RGB;
  leaving: boolean;
  d: TileDatum;
};

/** 600 ms on the site's --ease-out, cubic-bezier(.2,.7,.2,1). */
export const DUR = 600;
const LABEL_OUT = 110;
const LABEL_IN = 220;

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
const EASE = bezier(0.2, 0.7, 0.2, 1);

const SVGNS = "http://www.w3.org/2000/svg";
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const lerpRgb = (a: RGB, b: RGB, p: number): RGB => [lerp(a[0], b[0], p), lerp(a[1], b[1], p), lerp(a[2], b[2], p)];
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

  const geoAt = (n: Node, t: number): Geo => {
    const p = EASE(Math.max(0, Math.min(1, (t - n.t0) / DUR)));
    return {
      x: lerp(n.from.x, n.to.x, p),
      y: lerp(n.from.y, n.to.y, p),
      w: lerp(n.from.w, n.to.w, p),
      h: lerp(n.from.h, n.to.h, p),
      op: lerp(n.from.op, n.to.op, p),
    };
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
    const p = EASE(Math.max(0, Math.min(1, (t - n.t0) / DUR)));
    n.g.setAttribute("transform", `translate(${geo.x},${geo.y})`);
    n.g.style.opacity = String(geo.op);
    n.rect.setAttribute("width", String(Math.max(0, geo.w)));
    n.rect.setAttribute("height", String(Math.max(0, geo.h)));
    n.rect.style.fill = n.fillTo === null ? opts.hatch : rgbCss(n.fillFrom ? lerpRgb(n.fillFrom, n.fillTo, p) : n.fillTo);
    const ink = rgbCss(lerpRgb(n.inkFrom, n.inkTo, p));
    let busy = t < n.t0 + DUR;
    for (const k of KEYS) {
      const l = n.labels[k];
      settleTexts(l, t);
      l.el.style.fill = ink;
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
    const labels = {} as Record<Key, Label>;
    for (const k of KEYS) {
      const el = document.createElementNS(SVGNS, "text");
      el.setAttribute("class", "l-" + k);
      el.setAttribute("x", String(PADX));
      el.setAttribute("y", String(BASE[k]));
      el.setAttribute("opacity", "0");
      g.append(el);
      labels[k] = { el, text: "", kf: [{ t: 0, v: 0 }], texts: [] };
    }
    const n: Node = {
      key: d.key,
      g,
      rect,
      labels,
      from: { x: 0, y: 0, w: 0, h: 0, op: 0 },
      to: { x: 0, y: 0, w: 0, h: 0, op: 0 },
      t0: 0,
      fillFrom: null,
      fillTo: d.fill,
      inkFrom: d.ink,
      inkTo: d.ink,
      leaving: false,
      d,
    };
    const show = (e: PointerEvent) => opts.tip.show(n.d.tip(), e.clientX, e.clientY);
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

  /** The labels of n moving from box ob to box nb (port of the approved draft's rules). */
  const setLabels = (n: Node, ob: Geo, nb: Rect, anim: boolean, t: number) => {
    const fin = labelSet(n.d.label, nb.w, nb.h, opts.measure);
    // what fits all the way through the move
    const mid = anim ? labelSet(n.d.label, Math.min(ob.w, nb.w), Math.min(ob.h, nb.h), opts.measure) : fin;
    for (const k of KEYS) {
      const l = n.labels[k];
      settleTexts(l, t);
      l.texts = [];
      const op = kfValue(l.kf, t);
      const f = fin[k] ?? "";
      const setNow = (s: string) => {
        if (s !== l.text) {
          l.text = s;
          l.el.textContent = s;
        }
      };
      if (!anim) {
        setNow(f);
        l.kf = [{ t, v: f ? 1 : 0 }];
      } else if (op > 0.99 && l.text && mid[k]) {
        // it fits before, during and after the move: it rides along with the tile
        setNow(mid[k] as string);
        l.kf = [{ t, v: 1 }];
        if (mid[k] !== f) l.texts = [{ t: t + DUR, s: f }];
      } else if (op > 0) {
        l.kf = [
          { t, v: op },
          { t: t + LABEL_OUT, v: 0 },
          { t: t + DUR, v: 0 },
          { t: t + DUR + LABEL_IN, v: f ? 1 : 0 },
        ];
        l.texts = [{ t: t + DUR, s: f }];
      } else {
        setNow(f);
        l.kf = f
          ? [
              { t, v: 0 },
              { t: t + DUR, v: 0 },
              { t: t + DUR + LABEL_IN, v: 1 },
            ]
          : [{ t, v: 0 }];
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const i = order.findIndex((n) => n.g === document.activeElement);
    if (i < 0) return;
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
      const anim = animate && canAnimate && nodes.size > 0;
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
        n.to = { x: c.x + c.w / 2, y: c.y + c.h / 2, w: 0, h: 0, op: 0 };
        n.t0 = t;
        n.fillFrom = n.fillTo;
        n.inkFrom = n.inkTo;
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
        const target: Geo = { x: r.x, y: r.y, w: r.w, h: r.h, op: 1 };
        if (!n || n.leaving) {
          if (n) {
            n.g.remove();
            nodes.delete(n.key);
          }
          n = make(d);
          nodes.set(d.key, n);
          n.from = anim ? { x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0, op: 0 } : target;
          n.fillFrom = null;
          n.inkFrom = d.ink;
          n.d = d;
          setLabels(n, { ...n.from }, r, anim, t);
        } else {
          const c = anim ? geoAt(n, t) : target;
          const p = EASE(Math.max(0, Math.min(1, (t - n.t0) / DUR)));
          n.fillFrom = anim && n.fillTo && d.fill ? (n.fillFrom ? lerpRgb(n.fillFrom, n.fillTo, p) : n.fillTo) : null;
          n.inkFrom = anim ? lerpRgb(n.inkFrom, n.inkTo, p) : d.ink;
          n.from = c;
          n.d = d;
          setLabels(n, c, r, anim, t);
        }
        n.to = target;
        n.t0 = t;
        n.fillTo = d.fill;
        n.inkTo = d.ink;
        n.g.classList.toggle("oth", d.other);
        n.g.classList.toggle("nul", d.hollow);
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
