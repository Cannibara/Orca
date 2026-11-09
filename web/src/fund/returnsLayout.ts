// Geometry of the Annual returns chart: where each bar stands, which value labels fit, and
// the bracket's pieces. Pure functions ported from the artifact (app.js colLayout, bracketSvg,
// idxAt), so they can be tested without a DOM.

import { fPct, fShort } from "./fmt";
import { niceTicks, overlap, slots, textW, type Box, type Slots } from "./geometry";

export type ColLayout = {
  G: Slots;
  n: number;
  H: number;
  ticks: number[];
  Y: (v: number) => number;
  /** The bar rectangles, for the label collision test. */
  bars: Box[];
  /** Where each value label would sit. */
  boxes: Box[];
  /** The label text of each bar ("+12.4%", or "+12" when crowded). */
  txt: string[];
  /** Labels turned on their side (very narrow slots). */
  rot: boolean;
  size: number;
  show: boolean[];
  shown: number;
  form: "full" | "short";
  mt: number;
};

/** Indexes of the best and the worst full year (first of equals); -1 when there is no full year. */
export function bestWorst(vals: number[], part: boolean[]): { bestI: number; worstI: number } {
  let bestI = -1;
  let worstI = -1;
  vals.forEach((v, i) => {
    if (part[i]) return;
    if (bestI < 0 || v > vals[bestI]) bestI = i;
    if (worstI < 0 || v < vals[worstI]) worstI = i;
  });
  return { bestI, worstI };
}

/**
 * Layout of `vals` (percent) in a chart W px wide. `sel` is the selected bar (-1 for none);
 * `withBracket` makes room above the bars for the annualised-return bracket. Labels are placed
 * greedily: the selected bar first, then the best and worst full years, the last and first
 * years, then the biggest moves; a label that touches another label or a bar is dropped. When
 * the full "+12.4%" does not fit the slot it steps down to "+12", then to a label on its side.
 */
export function colLayout(W: number, vals: number[], part: boolean[], sel: number, withBracket: boolean): ColLayout {
  const n = vals.length;
  const H = (W < 520 ? 300 : 340) + (withBracket ? 24 : 0);
  const LS = 11.5;
  const BR = withBracket ? 44 : 0;
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 6);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const anyPos = vals.some((v) => v >= 0);
  const anyNeg = vals.some((v) => v < 0);
  const G = slots(W, n, 46);
  const { band, bw } = G;
  const full = vals.map(fPct);
  const short = vals.map(fShort);
  const widest = (a: string[], px: number) => Math.max(0, ...a.map((s) => textW(s, px)));
  let form: "full" | "short" = "full";
  let rot = false;
  if (band < widest(full, LS) + 4) form = "short";
  const SS = form === "short" ? 11 : LS;
  if (form === "short" && band < widest(short, SS) + 3) rot = true;
  const txt = form === "full" ? full : short;
  const size = rot ? 10 : SS;
  const room = Math.ceil((rot ? widest(txt, size) : size) + 7);
  const mt = 12 + BR + (anyPos ? room : 0);
  const mb = 32 + (anyNeg ? room : 0);
  const ih = H - mt - mb;
  const Y = (v: number) => mt + ih - ((v - t0) / (t1 - t0)) * ih;
  const bars: Box[] = vals.map((v, i) => ({
    x0: G.cx(i) - bw / 2,
    x1: G.cx(i) + bw / 2,
    y0: Math.min(Y(0), Y(v)),
    y1: Math.max(Y(0), Y(v)),
  }));
  const boxes: Box[] = vals.map((v, i) => {
    const s = txt[i];
    const w = rot ? size : textW(s, size);
    const hh = rot ? textW(s, size) : size;
    const y0 = v >= 0 ? Y(v) - 4 - hh : Y(v) + 4;
    return { x0: G.cx(i) - w / 2, x1: G.cx(i) + w / 2, y0, y1: y0 + hh };
  });
  const { bestI, worstI } = bestWorst(vals, part);
  const rank = (i: number) => (i === sel ? 0 : i === bestI ? 1 : i === worstI ? 2 : i === n - 1 ? 3 : i === 0 ? 4 : 5);
  const order = vals.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || Math.abs(vals[b]) - Math.abs(vals[a]));
  const placed: Box[] = [];
  const show = vals.map(() => false);
  for (const i of order) {
    const b = boxes[i];
    if (placed.some((p) => overlap(b, p, 2))) continue;
    if (bars.some((r, j) => j !== i && overlap(b, r, 1))) continue;
    placed.push(b);
    show[i] = true;
  }
  return { G, n, H, ticks, Y, bars, boxes, txt, rot, size, show, shown: show.filter(Boolean).length, form, mt };
}

/** The bar a pointer at page x is over, 0..n-1; `svgLeft`/`svgWidth` are the svg's box, W its drawn width. */
export function idxAtX(clientX: number, svgLeft: number, svgWidth: number, W: number, G: Pick<Slots, "ml" | "band">, n: number): number {
  const x = (clientX - svgLeft) * (W / (svgWidth || W));
  return Math.max(0, Math.min(n - 1, Math.round((x - G.ml - G.band / 2) / G.band)));
}

export type BracketMode = "a" | "b" | "move";

/** The bracket after the pointer moved from bar `i0` (where it was grabbed) to bar `i`. */
export function dragBracket(mode: BracketMode, a0: number, b0: number, i0: number, i: number, n: number): { a: number; b: number } {
  if (mode === "a") return { a: Math.min(i, b0 - 1), b: b0 };
  if (mode === "b") return { a: a0, b: Math.max(i, a0 + 1) };
  const len = b0 - a0;
  const a = Math.max(0, Math.min(n - 1 - len, a0 + (i - i0)));
  return { a, b: a + len };
}

/** The bracket after an arrow key on handle `mode`: one end by `dx` bars, or with shift both. */
export function keyBracket(mode: BracketMode, a0: number, b0: number, dx: number, shift: boolean, n: number): { a: number; b: number } {
  if (shift) {
    const len = b0 - a0;
    const a = Math.max(0, Math.min(n - 1 - len, a0 + dx));
    return { a, b: a + len };
  }
  if (mode === "a") return { a: Math.max(0, Math.min(b0 - 1, a0 + dx)), b: b0 };
  return { a: a0, b: Math.min(n - 1, Math.max(a0 + 1, b0 + dx)) };
}
