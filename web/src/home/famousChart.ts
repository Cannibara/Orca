// Pure helpers for the home page's Famous funds ranked return chart (spec docs/superpowers/specs/2026-11-20-home-famous-chart-design.md).
// Domains are in percentage points; returns are fractions.
import { count, DASH, pct, pp, qLabel } from "../lib/format";

/** Assets as "$304.2B": one decimal in billions at every size (the table view keeps the site's "$250m"); below
 * $0.05B, "<$0.1B" rather than a "$0.0B" that reads as nothing. */
export const aumLabel = (book: number | null | undefined): string =>
  book == null || !Number.isFinite(book) ? DASH : book < 0.05e9 ? "<$0.1B" : "$" + (book / 1e9).toFixed(1) + "B";

export const retLabel = (r: number | null): string => pct(r, 1);

/** A fund's return against the S&P 500, in points: "+2.0 pts". */
export const vsLabel = (r: number, spx: number): string => pp((r - spx) * 100);

// ---- colour (6): bars shaded by size ----
const GAIN_LIGHT = ["#9CC8E2", "#267CAA", "#0B4A72"] as const;
const LOSS_LIGHT = ["#F2B08F", "#C64A14", "#8A3208"] as const;
const GAIN_DARK = ["#1F5F86", "#3D93C2", "#8CCBEE"] as const;
const LOSS_DARK = ["#7E3714", "#D9622B", "#F7A882"] as const;

const rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a: string, b: string, t: number): string {
  const A = rgb(a);
  const B = rgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** Bar colour: strength f = min(|ret| / 30%, 1), t = 0.15 + 0.85 f along a three-stop ramp (linear RGB mix). */
export function shadeFor(ret: number, dark: boolean): string {
  const s = ret < 0 ? (dark ? LOSS_DARK : LOSS_LIGHT) : dark ? GAIN_DARK : GAIN_LIGHT;
  const t = 0.15 + 0.85 * Math.min(Math.abs(ret) / 0.3, 1);
  return t <= 0.5 ? mix(s[0], s[1], t / 0.5) : mix(s[1], s[2], (t - 0.5) / 0.5);
}

// ---- the fitted scale (7.3) ----
export type Dom = { lo: number; hi: number };
/**
 * A list's scale while it scrolls. The span (points across the plot) is one for the whole list, so a bar's
 * length for a given return never changes as you scroll (owner, 2026-11-21); only the axis slides. Per whole-row
 * window k (rows k … k+vis−1): `top[k]` is the highest left end that keeps its losses and their labels in view
 * (0, zero at the left edge, when it has none), `floor[k]` the lowest that keeps its gains and the S&P in view,
 * and `smooth[k]` the left end the axis passes through there.
 */
export type Track = { span: number; top: number[]; floor: number[]; smooth: number[] };

const SMOOTH_R = 3; // triangular weights 1,2,3,4,3,2,1

/**
 * The list's fixed span and where its axis sits for each window. `rets` best first; the span is the widest
 * window's need (zero and the S&P always in view, at least 20 pts; a window with a loss also keeps `room` px
 * of the `innerW` px plot free for the loss labels).
 */
export function windowDomains(rets: number[], vis: number, spx: number | null, innerW: number, room: number): Track {
  const v = rets.map((x) => x * 100);
  const s = spx == null ? 0 : spx * 100;
  const K = Math.max(1, v.length - vis + 1);
  const lows: number[] = [];
  const highs: number[] = [];
  for (let k = 0; k < K; k++) {
    const w = v.slice(k, k + vis);
    lows.push(Math.min(0, ...w));
    highs.push(Math.max(0, s, ...w));
  }
  // A window with a loss also needs `room` px for the loss labels: its points fill only (innerW − room) px, so
  // its need grows by f. The floor only guards a tiny or unmeasured width (a phone's ~130px plot keeps its room).
  const f = 1 + room / Math.max(80, innerW - room);
  const span = Math.max(...highs.map((h, k) => Math.max(20, h - lows[k]) * (lows[k] < 0 ? f : 1)));
  const labelRoom = (span * (f - 1)) / f; // the room in points, the same in every window
  const top = lows.map((l) => (l < 0 ? l - labelRoom : 0));
  const floor = highs.map((h) => h - span);
  // smoothed so the axis starts sliding a little before a loss arrives, and stays within what each window allows
  const smooth = top.map((t, k) => {
    let sum = 0;
    let w = 0;
    for (let j = Math.max(0, k - SMOOTH_R); j <= Math.min(K - 1, k + SMOOTH_R); j++) {
      const wt = SMOOTH_R + 1 - Math.abs(j - k);
      sum += top[j] * wt;
      w += wt;
    }
    return Math.min(t, Math.max(floor[k], sum / w));
  });
  return { span, top, floor, smooth };
}

/**
 * The domain at fractional scroll position p (rows from the top): the left end on a Catmull-Rom curve through
 * the windows, kept between the linear blends of their limits so the rows in view always fit; the width is
 * always the list's span.
 */
export function domainAt(track: Track, p: number): Dom {
  const { span, top, floor, smooth } = track;
  const L = smooth.length - 1;
  const pc = Math.max(0, Math.min(L, p));
  const k = Math.min(L, Math.floor(pc));
  const t = pc - k;
  const at = (a: number[], j: number): number => a[Math.max(0, Math.min(L, j))];
  const p0 = at(smooth, k - 1);
  const p1 = at(smooth, k);
  const p2 = at(smooth, k + 1);
  const p3 = at(smooth, k + 2);
  const cr = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  const lin = (a: number[]): number => at(a, k) + (at(a, k + 1) - at(a, k)) * t;
  const lo = Math.max(lin(floor), Math.min(lin(top), cr));
  return { lo, hi: lo + span };
}

/** Steps a tick may take, smallest first. */
const STEPS = [5, 10, 20, 40, 50, 100, 200, 500];
/** px: the least room between two tick labels ("+300%" is about 30px wide at 11px; this keeps a clear gap). */
const TICK_GAP = 48; // the widest label ("+200%") is ~34px: 48 leaves a clear gap and still keeps a number beside 0% on a phone

/** The tick step: the spec's by span (desktop 5/10/20, phone 10/20), raised until labels sit TICK_GAP px apart. */
export function tickStep(span: number, phone: boolean, innerW: number): number {
  const base = phone ? (span <= 25 ? 10 : 20) : span < 25 ? 5 : span <= 60 ? 10 : 20;
  return STEPS.find((s) => s >= base && (s * innerW) / span >= TICK_GAP) ?? STEPS[STEPS.length - 1];
}

/**
 * Axis tick values (points): 0 always, other multiples of the step that sit inside the domain with a margin.
 * `innerW` is the plot's inner width in px, so labels never crowd on a narrow plot or a wide range.
 */
export function ticksFor(dom: Dom, phone: boolean, innerW: number): number[] {
  const step = tickStep(dom.hi - dom.lo, phone, innerW);
  const mLo = phone ? 2 : 1;
  const mHi = phone ? 1 : 0.5;
  const out = new Set<number>([0]);
  for (let k = Math.ceil((dom.lo + mLo) / step); k * step <= dom.hi - mHi; k++) out.add(k * step + 0); // + 0 turns -0 into 0
  return [...out].sort((a, b) => a - b);
}

// ---- copy ----
export function sourceLine(spx: { ann_return: number | null; from_q: number; to_q: number } | null | undefined): string {
  const base = "Source: SEC 13F filings; Orca estimates.";
  return spx == null || spx.ann_return == null ? base : `${base} S&P 500: SPY total return, ${qLabel(spx.from_q)} to ${qLabel(spx.to_q)}.`;
}

/**
 * The line under the chart. `first`/`last` are places in the whole list; `total` is set when the chart shows one
 * page of a longer list (Top funds, 80 a page), whose scale is then the page's.
 */
export function captionText(first: number, last: number, n: number, scrolls: boolean, total?: number): string {
  if (total !== undefined) {
    const of = `Showing ${count(first)}–${count(last)} of ${count(total)}`;
    return scrolls ? `${of} · one scale for this page` : of;
  }
  if (!scrolls) return n === 1 ? "Showing 1 fund" : `Showing all ${n} funds`;
  return `Showing ${first}–${last} of ${n} · one scale for the whole list`;
}

/**
 * A photo placeholder: the first letters of the first two words ("Battery Ventures" → "BV"), or a leading
 * acronym of 2–4 capitals, whole up to 3 letters ("IVP XVI" → "IVP", "TCV VIII" → "TCV"), which is the brand.
 */
export function initials(s: string): string {
  const words = s
    .replace(/[^\p{L} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (/^\p{Lu}{2,4}$/u.test(words[0] ?? "")) return words[0].slice(0, 3);
  return words
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** The full spoken label of a chart row (5). */
export function rowLabel(o: { i: number; n: number; name: string; manager: string | null; book: number; ret: number; spx: number | null }): string {
  const who = o.manager ? `${o.name}, ${o.manager}` : o.name;
  const what = `${o.ret < 0 ? "loss" : "gain"} of ${pct(Math.abs(o.ret), 1, false)} a year (estimate)`;
  const vs = o.spx == null ? "" : o.ret > o.spx ? ", ahead of the S&P 500" : ", behind the S&P 500";
  return `${o.i} of ${o.n}. ${who}, AUM ${aumLabel(o.book)}: ${what}${vs}${o.i === 1 ? ", best in this list" : ""}`;
}
