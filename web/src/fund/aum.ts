// Pure layout of the "Assets under management" chart. Ported from the artifact's
// aumParts / aumSvg (app.js), with money in dollars (the artifact drew billions) and
// the labels in adaptive units ($340M, $1.23B, $11.1B).

import { axisMoney, fMoney, fMoney1, fMoneySigned } from "./fmt";
import { endRound, niceTicks, overlap, slots, stepFor, textW, xLabelItems, xLabels, type Box, type Slots, type XLabelItem } from "./geometry";
import type { Win, YearPoint } from "./series";

/** A first book at or under $100K counts as "no book yet": the fund started in that year. */
const NO_BOOK = 1e5;
/** Under $500K a part of the stack is too small to decide which one is the topmost (and gets the rounded end). */
const TINY = 5e5;

/**
 * One bar = the book at year end. Bottom to top: carried over (c), net inflows (f), gains (g).
 * What was lost or withdrawn is taken off the top of that stack and drawn above the bar as
 * dotted boxes (loss, out), so the solid part is always the book.
 */
export type AumParts = {
  c: number;
  f: number;
  g: number;
  loss: number;
  out: number;
  /** The fund's first year in the data: the whole book is drawn as one block. */
  first: boolean;
  /** Top of the solid bar (the book at year end). */
  top: number;
  /** Top of the bar with the dotted boxes. */
  gross: number;
  /** Book at start and at end. */
  S0: number;
  E: number;
};

/** `isFirst` is true for the first year of the whole series (window offset 0, index 0). */
export function aumParts(y: Pick<YearPoint, "start" | "end" | "inflows" | "gains">, isFirst: boolean): AumParts {
  const S0 = y.start;
  const E = y.end;
  if (isFirst && S0 <= NO_BOOK) return { c: E, f: 0, g: 0, loss: 0, out: 0, first: true, top: E, gross: E, S0, E };
  let f = Math.max(y.inflows, 0);
  let g = Math.max(y.gains, 0);
  const out = Math.max(-y.inflows, 0);
  const loss = Math.max(-y.gains, 0);
  let rem = out + loss;
  let t = Math.min(g, rem);
  g -= t;
  rem -= t;
  t = Math.min(f, rem);
  f -= t;
  rem -= t;
  const c = Math.max(0, S0 - rem);
  return { c, f, g, loss, out, first: false, top: c + f + g, gross: c + f + g + loss + out, S0, E };
}

export type AumSeg = {
  cls: "corp" | "fin" | "gain" | "rm-loss" | "rm-out";
  /** Bar index (the grow-in delay). */
  i: number;
  /** Outline path. */
  d: string;
};

export type AumLabel = {
  i: number;
  text: string;
  x: number;
  y: number;
  /** Rotated a quarter turn counter-clockwise about (x, y). */
  rot: boolean;
  size: number;
};

export type AumHit = { i: number; x: number; width: number; label: string };

export type AumLayout = {
  W: number;
  H: number;
  G: Slots;
  parts: AumParts[];
  ticks: { v: number; y: number; text: string }[];
  /** Pixel y of the zero line. */
  z: number;
  /** Grow-in stagger in ms. */
  step: number;
  segs: AumSeg[];
  labels: AumLabel[];
  /** "full" = "$11.1B", "short" = "11.1B" (the dollar sign dropped), as the room allows. */
  form: "full" | "short";
  rot: boolean;
  xItems: XLabelItem[];
  hits: AumHit[];
};

/** The text an AUM bar is announced with. */
export function aumAria(y: YearPoint): string {
  return `${y.label}: book ${fMoney(y.start)} to ${fMoney(y.end)}; net inflows ${fMoneySigned(y.inflows)}; gains ${fMoneySigned(y.gains)}${y.part ? ", part year" : ""}`;
}

/** Everything the chart draws for `win` at W px wide. */
export function aumLayout(win: Pick<Win, "years" | "offset">, W: number): AumLayout {
  const years = win.years;
  const n = years.length;
  const H = W < 520 ? 300 : 360;
  const G = slots(W, n, 52);
  const parts = years.map((y, i) => aumParts(y, win.offset === 0 && i === 0));
  let hi = 0;
  for (const p of parts) hi = Math.max(hi, p.gross);
  const tv = niceTicks(0, hi, 4);
  const t0 = tv[0];
  const t1 = tv[tv.length - 1];

  // Label text: the full form, then the form without "$" (the axis says dollars), then rotated.
  const LS = 11.5;
  const full = parts.map((p) => fMoney1(p.E));
  const short = full.map((s) => s.replace(/^\$/, ""));
  const widest = (a: string[], px: number) => Math.max(0, ...a.map((s) => textW(s, px)));
  let form: "full" | "short" = "full";
  let rot = false;
  if (G.band < widest(full, LS) + 4) form = "short";
  const SS = form === "short" ? 11 : LS;
  if (form === "short" && G.band < widest(short, SS) + 3) rot = true;
  const txt = form === "full" ? full : short;
  const size = rot ? 10 : SS;
  const room = Math.ceil((rot ? widest(txt, size) : size) + 7);
  const mt = 14 + room;
  const mb = 34;
  const ih = H - mt - mb;
  const span = t1 - t0 || 1;
  const Y = (v: number) => mt + ih - ((v - t0) / span) * ih;
  const z = Y(0);
  const bw = G.bw;

  const segs: AumSeg[] = [];
  const seg = (cls: AumSeg["cls"], i: number, x: number, lo: number, up: number, r: number) => {
    const yb = Y(lo);
    const yt = Y(up);
    if (yb - yt < 0.8) return;
    segs.push({ cls, i, d: endRound(x, +bw.toFixed(2), +yb.toFixed(2), +yt.toFixed(2), r) });
  };
  const boxes: Box[] = [];
  const bars: Box[] = [];
  parts.forEach((p, i) => {
    const cx = G.cx(i);
    const x = +(cx - bw / 2).toFixed(2);
    const cTop = p.c;
    const fTop = p.c + p.f;
    const topmost = p.g > TINY ? "g" : p.f > TINY ? "f" : "c";
    seg("corp", i, x, 0, cTop, topmost === "c" ? 3 : 0);
    seg("fin", i, x, cTop, fTop, topmost === "f" ? 3 : 0);
    seg("gain", i, x, fTop, p.top, topmost === "g" ? 3 : 0);
    seg("rm-loss", i, x, p.top, p.top + p.loss, 0);
    seg("rm-out", i, x, p.top + p.loss, p.top + p.loss + p.out, 0);
    bars.push({ x0: cx - bw / 2, x1: cx + bw / 2, y0: Y(p.gross), y1: z });
    const w = rot ? size : textW(txt[i], size);
    const hh = rot ? textW(txt[i], size) : size;
    const y0 = Y(p.top) - 4 - hh;
    boxes.push({ x0: cx - w / 2, x1: cx + w / 2, y0, y1: y0 + hh });
  });

  // Top labels, greedily: the newest year, the biggest book and the first year get the room first,
  // then the rest from the biggest down. A label that would touch another label or another bar is dropped.
  let maxI = 0;
  parts.forEach((p, i) => {
    if (p.E > parts[maxI].E) maxI = i;
  });
  const rank = (i: number) => (i === n - 1 ? 1 : i === maxI ? 2 : i === 0 ? 3 : 4);
  const order = parts.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || parts[b].E - parts[a].E);
  const placed: Box[] = [];
  const show = parts.map(() => false);
  for (const i of order) {
    const bx = boxes[i];
    if (placed.some((q) => overlap(bx, q, 2))) continue;
    if (bars.some((r, j) => j !== i && overlap(bx, r, 1))) continue;
    placed.push(bx);
    show[i] = true;
  }
  const labels: AumLabel[] = [];
  parts.forEach((p, i) => {
    if (!show[i]) return;
    const cx = G.cx(i);
    const ty = Y(p.top) - 5;
    if (rot) labels.push({ i, text: txt[i], x: +(cx + 0.36 * size).toFixed(1), y: +(ty + 1).toFixed(1), rot: true, size });
    else labels.push({ i, text: txt[i], x: +cx.toFixed(1), y: +ty.toFixed(1), rot: false, size });
  });

  const xItems = xLabelItems(
    xLabels(
      years.map((y) => y.label),
      G,
      -1,
    ),
    G,
    -1,
    H,
  );
  const hits: AumHit[] = years.map((y, i) => ({ i, x: +(G.ml + G.band * i).toFixed(1), width: +G.band.toFixed(1), label: aumAria(y) }));

  return {
    W,
    H,
    G,
    parts,
    ticks: tv.map((v) => ({ v, y: +Y(v).toFixed(1), text: axisMoney(v) })),
    z,
    step: stepFor(n),
    segs,
    labels,
    form,
    rot,
    xItems,
    hits,
  };
}

export type AumTotals = {
  /** Book at the end of the last windowed year. */
  end: number;
  flows: number;
  gains: number;
};

/** The three figures of the stats row: the end book and the net inflows and gains over the window. */
export function aumTotals(years: Pick<YearPoint, "end" | "inflows" | "gains">[]): AumTotals {
  let flows = 0;
  let gains = 0;
  for (const y of years) {
    flows += y.inflows;
    gains += y.gains;
  }
  return { end: years.length ? years[years.length - 1].end : 0, flows, gains };
}

/** A row of the "Table view" table. */
export type AumRow = {
  label: string;
  part: boolean;
  start: string;
  flows: string;
  gains: string;
  change: string;
  end: string;
};

export function aumRows(years: YearPoint[]): AumRow[] {
  return years.map((y) => ({
    label: y.label,
    part: y.part,
    start: fMoney(y.start),
    flows: fMoneySigned(y.inflows),
    gains: fMoneySigned(y.gains),
    change: fMoneySigned(y.gains + y.inflows),
    end: fMoney(y.end),
  }));
}
