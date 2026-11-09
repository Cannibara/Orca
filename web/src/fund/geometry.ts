// Chart geometry shared by the fund page panels. Ported from the artifact (app.js):
// text-width estimates, label collision, the column slots, the rounded bar ends and
// the thinning of x-axis labels.

import { MINUS } from "../lib/format";
import { shortYear } from "./fmt";

export { niceTicks } from "../charts/scale";

/** A rectangle in chart pixels, for label collision tests. */
export type Box = { x0: number; x1: number; y0: number; y1: number };

/** Text width estimate calibrated against the loaded fonts: tabular digits .60em, signs .54, % .79. */
export function textW(s: string, px: number): number {
  let w = 0;
  for (const c of s) {
    if (c >= "0" && c <= "9") w += 0.6;
    else if (c === "+" || c === MINUS) w += 0.54;
    else if (c === "%") w += 0.79;
    else if (c === "." || c === "," || c === "’") w += 0.275;
    else if (c === " ") w += 0.2;
    else if (c === "$") w += 0.63;
    else if (c >= "A" && c <= "Z") w += 0.69;
    else w += 0.54;
  }
  return w * px;
}

/** Monospace width (Geist Mono is .6em a character). */
export function monoW(s: string, px: number): number {
  return s.length * 0.6 * px;
}

/** Whether two boxes come within `pad` px of each other. */
export function overlap(a: Box, b: Box, pad: number): boolean {
  return a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0;
}

export function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Vertical bar: square end on the baseline y0, rounded end (radius r) at the data end y1. */
export function endRound(x: number, w: number, y0: number, y1: number, r: number): string {
  const d = y1 < y0 ? 1 : -1;
  r = Math.min(r, w / 2, Math.abs(y1 - y0));
  if (r < 0.6) return "M" + x + "," + y0 + "V" + y1 + "H" + (x + w) + "V" + y0 + "Z";
  return (
    "M" + x + "," + y0 + "V" + (y1 + d * r) + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 +
    "H" + (x + w - r) + "Q" + (x + w) + "," + y1 + " " + (x + w) + "," + (y1 + d * r) + "V" + y0 + "Z"
  );
}

/** Horizontal bar: square end on the baseline x0, rounded end at the data end x1. */
export function endRoundH(y: number, h: number, x0: number, x1: number, r: number): string {
  const d = x1 > x0 ? -1 : 1;
  r = Math.min(r, h / 2, Math.abs(x1 - x0));
  if (r < 0.6) return "M" + x0 + "," + y + "H" + x1 + "V" + (y + h) + "H" + x0 + "Z";
  return (
    "M" + x0 + "," + y + "H" + (x1 + d * r) + "Q" + x1 + "," + y + " " + x1 + "," + (y + r) +
    "V" + (y + h - r) + "Q" + x1 + "," + (y + h) + " " + (x1 + d * r) + "," + (y + h) + "H" + x0 + "Z"
  );
}

/** Stagger between neighbouring bars in the grow-in, in ms (the CSS reads it as --step). */
export function stepFor(n: number): number {
  return n > 1 ? Math.min(40, 450 / (n - 1)) : 0;
}

export type Slots = {
  /** Whether the y axis (and its left margin) is drawn: from 520 px wide. */
  axis: boolean;
  ml: number;
  mr: number;
  /** Inner width. */
  iw: number;
  /** Width of one category slot. */
  band: number;
  /** Bar width. */
  bw: number;
  /** x of the centre of slot i. */
  cx: (i: number) => number;
};

/** One slot per category across a chart W px wide; `axisW` is the left margin when the axis shows. */
export function slots(W: number, n: number, axisW: number): Slots {
  const axis = W >= 520;
  const ml = axis ? axisW : 4;
  const mr = 4;
  const iw = W - ml - mr;
  const band = iw / n;
  const bw = Math.min(40, Math.max(3, band * 0.8));
  return { axis, ml, mr, iw, band, bw, cx: (i) => ml + band * i + band / 2 };
}

export type XLabels = { labels: string[]; show: boolean[]; count: number };

/**
 * Which category labels fit on the x axis. The selected one, the last and the first get
 * the room first, then the others from the end backwards. Falls back to "’19" and then
 * "H1"-style forms when the full text does not fit, keeping the form that shows most.
 */
export function xLabels(cats: string[], G: Pick<Slots, "band" | "cx">, sel: number): XLabels {
  const n = cats.length;
  const run = (labels: string[]): XLabels => {
    const pp = G.band < 30 ? 8 : 12;
    const boxes: Box[] = labels.map((s, i) => {
      const w = textW(s, 12) + (i === sel ? pp : 0);
      return { x0: G.cx(i) - w / 2, x1: G.cx(i) + w / 2, y0: 0, y1: 1 };
    });
    const order: number[] = [];
    const seen = new Set<number>();
    const add = (i: number) => {
      if (i >= 0 && i < n && !seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    };
    add(sel);
    add(n - 1);
    add(0);
    for (let i = n - 2; i > 0; i--) add(i);
    const placed: Box[] = [];
    const show = cats.map(() => false);
    for (const i of order) {
      if (placed.some((p) => overlap(boxes[i], p, 6))) continue;
      placed.push(boxes[i]);
      show[i] = true;
    }
    return { labels, show, count: show.filter(Boolean).length };
  };
  const a = run(cats);
  if (a.count === n) return a;
  const b = run(cats.map(shortYear));
  if (b.count === n) return b;
  const c = run(cats.map((s) => (/\sH1$/.test(s) ? "H1" : shortYear(s))));
  return c.count > b.count && c.count > a.count ? c : b.count > a.count ? b : a;
}

export type XLabelItem = {
  i: number;
  text: string;
  /** Text anchor x (text-anchor middle) and baseline y. */
  x: number;
  y: number;
  selected: boolean;
  /** The dark pill behind the selected label, drawn before the text. */
  pill: { x: number; y: number; w: number; h: number; r: number } | null;
};

/**
 * The labels `xLabels` chose to show, with the positions the artifact drew them at, so a
 * panel renders `<rect className="selpill">` and `<text className="clab">` in JSX.
 * `H` is the chart height; labels sit on its bottom edge.
 */
export function xLabelItems(C: XLabels, G: Pick<Slots, "band" | "cx">, sel: number, H: number): XLabelItem[] {
  const out: XLabelItem[] = [];
  C.labels.forEach((text, i) => {
    if (!C.show[i]) return;
    const x = +G.cx(i).toFixed(1);
    const selected = i === sel;
    let pill: XLabelItem["pill"] = null;
    if (selected) {
      const w = +(textW(text, 12) + (G.band < 30 ? 8 : 12)).toFixed(1);
      pill = { x: +(x - w / 2).toFixed(1), y: H - 25, w, h: 20, r: 10 };
    }
    out.push({ i, text, x, y: H - 11, selected, pill });
  });
  return out;
}
