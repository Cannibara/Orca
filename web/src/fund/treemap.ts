// The Holdings tree map's model, pure: the squarified layout, the Other stocks grouping, the fund's
// return on each holding (the tile colour), the colour scale and label ink, which labels fit, and the
// arrow-key neighbour of a tile. No DOM: HoldingsPanel draws what this computes.

import type { PositionRow, Trade } from "../data/types";
import { money, pct } from "../lib/format";
import { dividendsAsOf, sharesAt, type Timeline } from "./positions";

// ---- layout ---------------------------------------------------------------------------------

export type Rect = { x: number; y: number; w: number; h: number };

/** d3's default aspect ratio for squarify: tiles near the golden ratio read better than squares in a wide box. */
export const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * Squarified tree map (Bruls, Huizing and van Wijk; d3-hierarchy's treemapSquarify): values in the order given,
 * all > 0, laid out in rows along the shorter side; a row takes the next value while that keeps its worst aspect
 * ratio from getting worse.
 */
export function squarify(values: number[], box: Rect, ratio = PHI): Rect[] {
  const out: Rect[] = [];
  let x0 = box.x;
  let y0 = box.y;
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  let value = values.reduce((a, b) => a + b, 0);
  let i0 = 0;
  const n = values.length;
  while (i0 < n) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let i1 = i0;
    let sum = values[i1++];
    let lo = sum;
    let hi = sum;
    const alpha = Math.max(dy / dx, dx / dy) / (value * ratio);
    let beta = sum * sum * alpha;
    let worst = Math.max(hi / beta, beta / lo);
    for (; i1 < n; i1++) {
      const v = values[i1];
      const s2 = sum + v;
      const lo2 = Math.min(lo, v);
      const hi2 = Math.max(hi, v);
      beta = s2 * s2 * alpha;
      const r = Math.max(hi2 / beta, beta / lo2);
      if (r > worst) break;
      sum = s2;
      lo = lo2;
      hi = hi2;
      worst = r;
    }
    if (dx < dy) {
      // a row across the top, its tiles side by side
      const h = value ? (dy * sum) / value : dy;
      let x = x0;
      for (let i = i0; i < i1; i++) {
        const w = sum ? (values[i] * dx) / sum : 0;
        out.push({ x, y: y0, w, h });
        x += w;
      }
      y0 += h;
    } else {
      // a column down the left, its tiles stacked
      const w = value ? (dx * sum) / value : dx;
      let y = y0;
      for (let i = i0; i < i1; i++) {
        const h = sum ? (values[i] * dy) / sum : 0;
        out.push({ x: x0, y, w, h });
        y += h;
      }
      x0 += w;
    }
    value -= sum;
    i0 = i1;
  }
  return out;
}

/**
 * Tiles of a W × H box with `gap` px between neighbours and none at the outer edges, every edge on a whole
 * pixel (d3's paddingInner + round): lay out in the box grown by half a gap all round, then inset each tile.
 */
export function layout(values: number[], W: number, H: number, gap = 2): Rect[] {
  const p = gap / 2;
  return squarify(values, { x: -p, y: -p, w: W + gap, h: H + gap }).map((r) => {
    let ax = r.x + p;
    let bx = r.x + r.w - p;
    let ay = r.y + p;
    let by = r.y + r.h - p;
    if (bx < ax) ax = bx = (ax + bx) / 2;
    if (by < ay) ay = by = (ay + by) / 2;
    ax = Math.round(ax);
    bx = Math.round(bx);
    ay = Math.round(ay);
    by = Math.round(by);
    return { x: ax, y: ay, w: bx - ax, h: by - ay };
  });
}

// ---- tiles ----------------------------------------------------------------------------------

/** Holdings under this share of the book are drawn together as one "Other stocks" tile. */
export const SMALL = 0.01;
export const OTHER_KEY = "__other";

export type Tile<T> = {
  key: string;
  value: number;
  /** Share of the total, 0 to 1. */
  weight: number;
  /** The holding, or null for Other stocks. */
  item: T | null;
  /** Other stocks' holdings, largest first; [] for a holding. */
  others: T[];
};

/**
 * The tiles of the tree map, largest first with Other stocks last. A holding under SMALL of the total joins
 * Other stocks, unless it would be alone there: one small holding is shown as itself. Values ≤ 0 are left out.
 */
export function groupTiles<T>(items: T[], value: (t: T) => number, key: (t: T) => string): { tiles: Tile<T>[]; total: number; nSmall: number } {
  const held = items.filter((t) => value(t) > 0).sort((a, b) => value(b) - value(a) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const total = held.reduce((s, t) => s + value(t), 0);
  if (total <= 0) return { tiles: [], total: 0, nSmall: 0 };
  let big = held.filter((t) => value(t) / total >= SMALL);
  let small = held.filter((t) => value(t) / total < SMALL);
  if (small.length === 1) {
    big = held;
    small = [];
  }
  const tiles: Tile<T>[] = big.map((t) => ({ key: key(t), value: value(t), weight: value(t) / total, item: t, others: [] }));
  if (small.length) {
    const v = small.reduce((s, t) => s + value(t), 0);
    tiles.push({ key: OTHER_KEY, value: v, weight: v / total, item: null, others: small });
  }
  return { tiles, total, nSmall: small.length };
}

// ---- the fund's return on a holding ----------------------------------------------------------

/**
 * The fund's return on one holding over quarters qs..qe, the app's usual measure: the shares held at the end of
 * qs − 1 valued at `startPx` (that quarter-end close), buys and sales in qs..qe at their trade price, the
 * dividends received in the period, and the shares held at the end valued at `endPx`:
 * (end + sales + dividends − start − buys) ÷ (start + buys). null when that denominator is not positive, a
 * needed price is missing, or the period starts before the fund's record (there is no start to compare with).
 */
export function holdingReturn(pos: PositionRow, qs: number, qe: number, startPx: number | null, endPx: number | null, tl: Timeline): number | null {
  if (qs - 1 < tl.qmin) return null;
  const shStart = sharesAt(pos.trades, qs - 1);
  const shEnd = sharesAt(pos.trades, qe);
  if ((shStart > 0 && startPx == null) || (shEnd > 0 && endPx == null)) return null;
  const start = shStart > 0 ? shStart * (startPx as number) : 0;
  const end = shEnd > 0 ? shEnd * (endPx as number) : 0;
  let buys = 0;
  let sales = 0;
  for (const t of pos.trades) {
    if (t.q < qs) continue;
    if (t.q > qe) break;
    if (t.delta > 0) buys += t.delta * t.px;
    else sales -= t.delta * t.px;
  }
  const divs = dividendsAsOf(pos, qe, tl.latest) - dividendsAsOf(pos, qs - 1, tl.latest);
  const den = start + buys;
  if (!(den > 0)) return null;
  const r = (end + sales + divs - start - buys) / den;
  return Number.isFinite(r) ? r : null;
}

/** The quarter the holding at the end of qe began: its last buy from no shares. null when nothing is held. */
export function heldSince(trades: Trade[], qe: number): number | null {
  let since: number | null = null;
  let sh = 0;
  for (const t of trades) {
    if (t.q > qe) break;
    if (sh <= 1e-6 && t.sharesAfter > 1e-6) since = t.q;
    sh = t.sharesAfter;
  }
  return sh > 1e-6 ? since : null;
}

/** A share price's change from a to b; null without both (or from a price of zero). */
export function priceChange(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !(a > 0)) return null;
  return b / a - 1;
}

// ---- colour ---------------------------------------------------------------------------------

export type RGB = [number, number, number];
/** Two one-hue ramps, no neutral: a gain runs gainLo → gain and a loss lossLo → loss by its size. */
export type Scale = { gain: RGB; gainLo: RGB; loss: RGB; lossLo: RGB };

/** "#rgb", "#rrggbb" or "rgb(r, g, b)"; null for anything else (an unset token reads ""). */
export function parseColor(s: string): RGB | null {
  const t = s.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as RGB;
  m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

export const rgbCss = (c: RGB): string => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;

const toLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
// CIE Lab under D65
const XN = 0.95047;
const ZN = 1.08883;
const E = 216 / 24389;
const K = 24389 / 27;
const f = (t: number) => (t > E ? Math.cbrt(t) : (K * t + 16) / 116);
const fi = (t: number) => (t * t * t > E ? t * t * t : (116 * t - 16) / K);

function toLab(c: RGB): [number, number, number] {
  const [r, g, b] = c.map(toLin);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x) - fy), 200 * (fy - f(z))];
}

function fromLab([L, a, b]: [number, number, number]): RGB {
  const fy = (L + 16) / 116;
  const x = fi(fy + a / 500) * XN;
  const y = fi(fy);
  const z = fi(fy - b / 200) * ZN;
  const lin = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  return lin.map((v) => Math.max(0, Math.min(255, fromLin(v)))) as RGB;
}

/** a → b at t (0..1) through Lab, so equal steps of return look like equal steps of colour. */
export function lerpLab(a: RGB, b: RGB, t: number): RGB {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const la = toLab(a);
  const lb = toLab(b);
  return fromLab([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
}

/** Green for a gain (0 counts as one), red for a loss, deeper the bigger it is, clamped at ±clamp (0.25 for a
 * quarter, 0.5 for 12 months). No grey: the owner wants every tile to say up or down at a glance. */
export function returnColor(ret: number, clamp: number, s: Scale): RGB {
  const t = Math.max(-1, Math.min(1, ret / clamp));
  return t >= 0 ? lerpLab(s.gainLo, s.gain, t) : lerpLab(s.lossLo, s.loss, -t);
}

/** The legend's gradient, loss to gain, as CSS. */
export function gradientCss(s: Scale, stops = 6): string {
  // two ramps meeting at 0% with a hard edge: deep red … pale red | pale green … deep green
  const out: string[] = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    out.push(`${rgbCss(lerpLab(s.loss, s.lossLo, t))} ${Math.round(t * 50)}%`);
  }
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    out.push(`${rgbCss(lerpLab(s.gainLo, s.gain, t))} ${Math.round(50 + t * 50)}%`);
  }
  return `linear-gradient(90deg, ${out.join(", ")})`;
}

const lum = (c: RGB) => {
  const [r, g, b] = c.map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: RGB, b: RGB): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

/**
 * Label ink on a fill: the text token (ink or surface) with more contrast; on a mid-tone where neither reaches
 * 4.5:1, pure black or white (one of them always does). `soft`: the name line can be softened to 80% and still
 * read at 4.5:1.
 */
export function inkFor(fill: RGB, ink: RGB, surface: RGB): { ink: RGB; soft: boolean } {
  let c = contrast(fill, ink) >= contrast(fill, surface) ? ink : surface;
  if (contrast(fill, c) < 4.5) c = contrast(fill, WHITE) >= contrast(fill, BLACK) ? WHITE : BLACK;
  const blend: RGB = [c[0] * 0.8 + fill[0] * 0.2, c[1] * 0.8 + fill[1] * 0.2, c[2] * 0.8 + fill[2] * 0.2];
  return { ink: c, soft: contrast(fill, blend) >= 4.5 };
}

// ---- labels ---------------------------------------------------------------------------------

/** The label fonts: ticker (mono 600 13px), Other stocks' name (sans 600 13px), weight (500 12px), name (400 11.5px). */
export type LabelFont = "tk" | "oth" | "w" | "n";
/** Width in px of a text in a label font. */
export type Measure = (font: LabelFont, text: string) => number;
/**
 * tk: the ticker. w: the second row: the weight, the dollar value and the fund's return over the period, as many
 * as fit (see labelSet). n: the third row (the name; the stock count on Other stocks). v: the value (and return)
 * at the right end of the ticker's row, only on a tile too short for a second row.
 */
export type LabelSet = { tk: string | null; w: string | null; n: string | null; v: string | null };
/** `ret`: the fund's return on the holding over the period (a fraction); null = none to show (also Other stocks). */
export type LabelTile = { other: boolean; ticker: string; name: string; weight: number; value: number; count: number; ret: number | null };

/** The labels' inner padding and baselines, px from the tile's top left. */
export const PADX = 7;
export const BASE = { tk: 18, w: 33, n: 48 } as const;
/** The least room between the ticker and a value on the same row. */
const ROW_GAP = 8;

/** A share of the book: 0.123 → "12.3%". */
export const share = (x: number): string => pct(x, 1, false);

/** `s` cut to fit `aw` px with an ellipsis; null when fewer than four characters would be left. */
export function ellipsize(font: LabelFont, s: string, aw: number, measure: Measure): string | null {
  if (measure(font, s) <= aw) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (measure(font, s.slice(0, m).trimEnd() + "…") <= aw) lo = m;
    else hi = m - 1;
  }
  return lo >= 4 ? s.slice(0, lo).trimEnd() + "…" : null;
}

/**
 * What fits in a w × h tile, top down: the ticker; then a second row of figures, most important first: the dollar
 * value (the owner wants every tile to show it), then the fund's return over the period, then the weight. The row
 * is the fullest of `12.3% · $80.2B · +4.1%`, `$80.2B · +4.1%`, `12.3% · $80.2B` (no return to show), `$80.2B`,
 * `12.3%` that fits. On tiles of at least 96 × 54 also the name (ellipsised; the stock count on Other stocks). A
 * tile too short for a second row (under 39 px) puts the value, with the return when both fit, at the right end
 * of the ticker's row. A label that does not fit is left out, never clipped.
 */
export function labelSet(t: LabelTile, w: number, h: number, measure: Measure): LabelSet {
  const o: LabelSet = { tk: null, w: null, n: null, v: null };
  const aw = w - 2 * PADX;
  if (h < 24 || aw < 8) return o;
  const font: LabelFont = t.other ? "oth" : "tk";
  let first = t.other ? "Other stocks" : t.ticker;
  if (t.other && measure(font, first) > aw) first = "Other";
  if (measure(font, first) > aw) return o;
  o.tk = first;
  const val = money(t.value);
  const wt = share(t.weight);
  const rt = t.ret === null ? null : pct(t.ret);
  const fits = (s: string, room: number) => measure("w", s) <= room;
  if (h < 39) {
    const room = aw - measure(font, first) - ROW_GAP;
    const vr = rt === null ? null : `${val} · ${rt}`;
    o.v = vr !== null && fits(vr, room) ? vr : fits(val, room) ? val : null;
    return o;
  }
  const ladder = rt === null ? [`${wt} · ${val}`, val, wt] : [`${wt} · ${val} · ${rt}`, `${val} · ${rt}`, val, wt];
  o.w = ladder.find((s) => fits(s, aw)) ?? null;
  if (h >= 54 && w >= 96) {
    const name = t.other ? `${t.count} stocks` : t.name;
    o.n = name ? ellipsize("n", name, aw, measure) : null;
  }
  return o;
}

// ---- keyboard -------------------------------------------------------------------------------

export type Direction = "left" | "right" | "up" | "down";

/**
 * The tile an arrow key moves to from tile i: among the tiles wholly beyond i's edge that way, those that
 * overlap it on the other axis first (nearest edge, then nearest centre), else the lowest gap + 2 × centre
 * offset. null when there is none, so the key can scroll the page instead.
 */
export function neighbour(rects: Rect[], i: number, dir: Direction): number | null {
  const c = rects[i];
  const TOL = 0.5;
  const horiz = dir === "left" || dir === "right";
  let best: { j: number; aligned: boolean; a: number; b: number } | null = null;
  rects.forEach((r, j) => {
    if (j === i) return;
    let gap: number;
    if (dir === "right") gap = r.x - (c.x + c.w);
    else if (dir === "left") gap = c.x - (r.x + r.w);
    else if (dir === "down") gap = r.y - (c.y + c.h);
    else gap = c.y - (r.y + r.h);
    if (gap < -TOL) return;
    const overlap = horiz ? Math.min(c.y + c.h, r.y + r.h) - Math.max(c.y, r.y) : Math.min(c.x + c.w, r.x + r.w) - Math.max(c.x, r.x);
    const off = horiz ? Math.abs(r.y + r.h / 2 - (c.y + c.h / 2)) : Math.abs(r.x + r.w / 2 - (c.x + c.w / 2));
    const aligned = overlap > 0;
    const cand = aligned ? { j, aligned, a: gap, b: off } : { j, aligned, a: gap + 2 * off, b: 0 };
    if (
      best === null ||
      (cand.aligned && !best.aligned) ||
      (cand.aligned === best.aligned && (cand.a < best.a - 1e-9 || (Math.abs(cand.a - best.a) <= 1e-9 && cand.b < best.b)))
    )
      best = cand;
  });
  return best === null ? null : (best as { j: number }).j;
}
