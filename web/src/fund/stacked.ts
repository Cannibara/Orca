// Pure layout of the "Annual return stacked graph" (spec §5.2): built as a twin of the Assets under management
// chart (aum.ts): the same slots, rounded ends, x labels and hit columns. Stacked: one bar per calendar year,
// split into market, sector choice and stock choice by the AUM rule (skill.ts stackParts). Lines: the value of
// each replay at every quarter end.

import type { Skill } from "../data/types";
import { pct } from "../lib/format";
import { axisMoney, qShort } from "./fmt";
import { endRound, niceTicks, overlap, slots, stepFor, textW, xLabelItems, xLabels, type Box, type Slots, type XLabelItem } from "./geometry";
import { pts, stackParts, tierOf, type Stack, type Tier, type TierWords, type YearRow } from "./skill";

export type StackCls = "mkt" | "sel" | "stk" | "box";
export type StackSeg = { cls: StackCls; sign: 1 | -1; i: number; d: string };

export type StackedLayout = {
  W: number;
  H: number;
  G: Slots;
  stacks: Stack[];
  ticks: { v: number; y: number; text: string }[];
  z: number;
  step: number;
  segs: StackSeg[];
  labels: { i: number; text: string; x: number; y: number }[];
  xItems: XLabelItem[];
  hits: { i: number; x: number; width: number; label: string }[];
  /** A choice that softened a fall is drawn (the legend then names it). */
  cushion: boolean;
};

/** A return with a sign and one decimal: 0.153 → "+15.3%". */
export const ret1 = (x: number | null): string => pct(x, 1);

/** What a year's bar is announced with. */
export function yearAria(y: YearRow, w: TierWords): string {
  return `${y.name}: whole market ${ret1(y.m)}, ${w.choice.toLowerCase()} ${pts(y.alloc)}, stock choice ${pts(y.pick)}, fund ${ret1(y.f)}${y.part ? ", part year" : ""}`;
}

const CLS = { m: "mkt", s: "sel", p: "stk" } as const;

export function stackedLayout(rows: YearRow[], W: number, w: TierWords): StackedLayout {
  const n = rows.length;
  const H = W < 520 ? 300 : 360;
  const G = slots(W, n, 52);
  const stacks = rows.map(stackParts);
  let lo = 0;
  let hi = 0;
  for (const s of stacks) {
    lo = Math.min(lo, s.gross, ...s.solid.map((p) => p.b));
    hi = Math.max(hi, s.gross, ...s.solid.map((p) => p.b));
  }
  const tv = niceTicks(lo * 100, hi * 100, 5).map((v) => v / 100);
  const t0 = tv[0];
  const t1 = tv[tv.length - 1];
  const mt = 26;
  const mb = 34;
  const ih = H - mt - mb;
  const span = t1 - t0 || 1;
  const Y = (v: number) => mt + ih - ((v - t0) / span) * ih;
  const z = Y(0);
  const bw = G.bw;
  const segs: StackSeg[] = [];
  const labels: StackedLayout["labels"] = [];
  let cushion = false;
  stacks.forEach((s, i) => {
    const cx = G.cx(i);
    const x = +(cx - bw / 2).toFixed(2);
    s.solid.forEach((p, j) => {
      const ya = Y(p.a);
      const yb = Y(p.b);
      if (Math.abs(ya - yb) < 0.8) return;
      segs.push({ cls: CLS[p.k], sign: p.sign, i, d: endRound(x, +bw.toFixed(2), +ya.toFixed(2), +yb.toFixed(2), j === s.solid.length - 1 ? 3 : 0) });
    });
    for (const b of s.boxes) {
      const ya = Y(b.a);
      const yb = Y(b.b);
      if (Math.abs(ya - yb) < 0.8) continue;
      if (b.sign > 0) cushion = true;
      segs.push({ cls: "box", sign: b.sign, i, d: endRound(x + 0.6, +(bw - 1.2).toFixed(2), +ya.toFixed(2), +yb.toFixed(2), 0) });
    }
    // the fund's return, beyond the outer end of the bar and its boxes; never down among the x labels
    let ly = s.dir > 0 ? Y(s.gross) - 6 : Y(s.gross) + 14;
    if (ly > H - mb - 2) ly = z - 6;
    labels.push({ i, text: ret1(rows[i].f), x: +cx.toFixed(1), y: +ly.toFixed(1) });
  });
  // As AUM's labels: where two would touch, the newest year and the biggest moves keep theirs.
  const box = (l: StackedLayout["labels"][number]): Box => {
    const tw = textW(l.text, 11.5);
    return { x0: l.x - tw / 2, x1: l.x + tw / 2, y0: l.y - 11, y1: l.y + 2 };
  };
  const order = labels.map((_, i) => i).sort((a, b) => Number(b === n - 1) - Number(a === n - 1) || Math.abs(rows[b].f) - Math.abs(rows[a].f));
  const placed: Box[] = [];
  const keep = new Set<number>();
  for (const i of order) {
    const bx = box(labels[i]);
    if (placed.some((q) => overlap(bx, q, 2))) continue;
    placed.push(bx);
    keep.add(i);
  }
  const xItems = xLabelItems(
    xLabels(
      rows.map((r) => r.name),
      G,
      -1,
    ),
    G,
    -1,
    H,
  );
  return {
    W,
    H,
    G,
    stacks,
    ticks: tv.map((v) => ({ v, y: +Y(v).toFixed(1), text: v === 0 ? "0%" : pct(v, 0) })),
    z,
    step: stepFor(n),
    segs,
    labels: labels.filter((l) => keep.has(l.i)),
    xItems,
    hits: rows.map((r, i) => ({ i, x: +(G.ml + G.band * i).toFixed(1), width: +G.band.toFixed(1), label: yearAria(r, w) })),
    cushion,
  };
}

// ---- Lines ----------------------------------------------------------------------------------------------

export type LineKey = "fund" | "label" | "mkt" | "spy";
export type Line = { k: LineKey; name: string; d: string; end: { x: number; y: number; v: number } | null };

export type LinesLayout = {
  W: number;
  H: number;
  ml: number;
  mr: number;
  mt: number;
  mb: number;
  lines: Line[];
  ticks: { v: number; y: number; text: string }[];
  years: { x: number; text: string }[];
  /** The end labels, nudged apart (≥ 15 px). */
  ends: { k: LineKey; x: number; y: number; text: string }[];
  /** x of quarter index i. */
  xs: number[];
  /** Values per line per quarter index. */
  values: Record<LineKey, (number | null)[]>;
  q: number[];
};

/**
 * Dollars made since the first quarter, each way, on the fund's own money: Σ over quarters of the dollars at work
 * (`cap`) × that way's return. A quarter with nothing at work adds nothing.
 */
export function madeSoFar(cap: number[], ret: (number | null)[]): number[] {
  let sum = 0;
  return cap.map((c, i) => (sum += c * (ret[i] ?? 0)));
}

/** The dollars each way made so far, every quarter end, all drawn at once. */
export function linesLayout(skill: Skill, t: Tier, W: number, w: TierWords): LinesLayout {
  const Q = skill.quarters;
  const values: Record<LineKey, (number | null)[]> = {
    fund: madeSoFar(Q.cap, Q.fund),
    label: madeSoFar(Q.cap, tierOf(skill, t).quarters.label),
    mkt: madeSoFar(Q.cap, Q.mkt),
    spy: madeSoFar(Q.cap, Q.spy),
  };
  const names: Record<LineKey, string> = { fund: "Their stocks", label: w.their, mkt: "Whole market", spy: "S&P 500" };
  const H = W < 520 ? 300 : 360;
  const narrow = W < 520;
  const ml = narrow ? 8 : 60;
  const mr = narrow ? 64 : 84;
  const mt = 16;
  const mb = 34;
  const n = Q.q.length;
  const xs = Q.q.map((_, i) => +(ml + (n > 1 ? i / (n - 1) : 0.5) * (W - ml - mr)).toFixed(1));
  let vmax = 0;
  let vmin = 0; // a fund that lost money goes below $0
  for (const k of Object.keys(values) as LineKey[])
    for (const v of values[k])
      if (v != null) {
        vmax = Math.max(vmax, v);
        vmin = Math.min(vmin, v);
      }
  const tv = niceTicks(vmin, vmax || (vmin < 0 ? 0 : 1), 4);
  const top = tv[tv.length - 1];
  const bottom = tv[0];
  const Y = (v: number) => mt + ((top - v) / (top - bottom || 1)) * (H - mt - mb);
  const lines: Line[] = (["fund", "label", "mkt", "spy"] as LineKey[]).map((k) => {
    let d = "";
    let pen = false;
    let last: Line["end"] = null;
    values[k].forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += (pen ? "L" : "M") + xs[i] + " " + Y(v).toFixed(1);
      pen = true;
      last = { x: xs[i], y: +Y(v).toFixed(1), v };
    });
    return { k, name: names[k], d, end: last };
  });
  const ends = lines
    .filter((l) => l.end)
    .map((l) => ({ k: l.k, x: l.end!.x + 8, y: l.end!.y, text: axisMoney(roundMoney(l.end!.v)) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
  const years: LinesLayout["years"] = [];
  const firstYear = 2013 + Math.floor(Q.q[0] / 4);
  const lastYear = 2013 + Math.floor(Q.q[n - 1] / 4);
  const every = lastYear - firstYear > 14 ? 4 : 2;
  for (let yr = Math.ceil(firstYear / every) * every; yr <= lastYear; yr += every) {
    const i = Q.q.indexOf((yr - 2013) * 4);
    if (i >= 0) years.push({ x: xs[i], text: narrow ? "’" + String(yr).slice(2) : String(yr) });
  }
  return {
    W,
    H,
    ml,
    mr,
    mt,
    mb,
    lines,
    ticks: tv.map((v) => ({ v, y: +Y(v).toFixed(1), text: axisMoney(v) })),
    years,
    ends: ends.map((e) => ({ ...e, y: +(e.y + 4).toFixed(1) })),
    xs,
    values,
    q: Q.q,
  };
}

/** Two significant figures, so an end label reads "$2.4B", not "$2.4381B". */
export function roundMoney(v: number): number {
  if (v === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / mag) * mag;
}

/** The quarter index nearest an x pixel. */
export function nearestQuarter(L: Pick<LinesLayout, "xs">, x: number): number {
  let best = 0;
  for (let i = 1; i < L.xs.length; i++) if (Math.abs(L.xs[i] - x) < Math.abs(L.xs[best] - x)) best = i;
  return best;
}

export const quarterName = qShort;
