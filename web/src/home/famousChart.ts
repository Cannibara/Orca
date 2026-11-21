// Pure helpers for the home page's Famous funds ranked return chart (spec docs/superpowers/specs/2026-11-20-home-famous-chart-design.md).
// Domains are in percentage points; returns are fractions.
import { DASH, pct, pp, qLabel } from "../lib/format";

/** Assets as "$304.2B": one decimal in billions at every size (the table view keeps the site's "$250m"). */
export const aumLabel = (book: number | null | undefined): string =>
  book == null || !Number.isFinite(book) ? DASH : "$" + (book / 1e9).toFixed(1) + "B";

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
export type Track = { raw: Dom[]; smooth: Dom[] };

/** The domain for the rows in one window: zero and the S&P line always in view, at least 20 pts wide, room for loss labels. */
export function rawDomain(rets: number[], spx: number | null, innerW: number, room: number): Dom {
  const v = rets.map((x) => x * 100);
  let lo = Math.min(0, ...v);
  let hi = Math.max(0, spx == null ? 0 : spx * 100, ...v);
  if (hi - lo < 20) hi = lo + 20;
  // the floor only guards a tiny or unmeasured width; a phone's ~140px plot keeps its full label room
  if (lo < 0) lo -= (room * (hi - lo)) / Math.max(80, innerW - room);
  return { lo, hi };
}

const SMOOTH_R = 3; // triangular weights 1,2,3,4,3,2,1

/** One domain per whole-row window (rows k … k+vis−1 of `rets`, best first), then smoothed so the axis glides. */
export function windowDomains(rets: number[], vis: number, spx: number | null, innerW: number, room: number): Track {
  const K = Math.max(1, rets.length - vis + 1);
  const raw: Dom[] = [];
  for (let k = 0; k < K; k++) raw.push(rawDomain(rets.slice(k, k + vis), spx, innerW, room));
  const smooth = raw.map((r, k) => {
    let lo = 0;
    let hi = 0;
    let w = 0;
    for (let j = Math.max(0, k - SMOOTH_R); j <= Math.min(K - 1, k + SMOOTH_R); j++) {
      const wt = SMOOTH_R + 1 - Math.abs(j - k);
      lo += raw[j].lo * wt;
      hi += raw[j].hi * wt;
      w += wt;
    }
    return { lo: Math.min(lo / w, r.lo), hi: Math.max(hi / w, r.hi) };
  });
  return { raw, smooth };
}

/** The domain at fractional scroll position p (rows from the top): a Catmull-Rom curve through the windows, never narrower than the linear blend of the raw ones. */
export function domainAt(track: Track, p: number): Dom {
  const { raw, smooth } = track;
  const L = smooth.length - 1;
  const pc = Math.max(0, Math.min(L, p));
  const k = Math.min(L, Math.floor(pc));
  const t = pc - k;
  const at = (a: Dom[], j: number): Dom => a[Math.max(0, Math.min(L, j))];
  const cr = (key: "lo" | "hi"): number => {
    const p0 = at(smooth, k - 1)[key];
    const p1 = at(smooth, k)[key];
    const p2 = at(smooth, k + 1)[key];
    const p3 = at(smooth, k + 2)[key];
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  };
  const lin = (key: "lo" | "hi"): number => at(raw, k)[key] + (at(raw, k + 1)[key] - at(raw, k)[key]) * t;
  return { lo: Math.min(cr("lo"), lin("lo")), hi: Math.max(cr("hi"), lin("hi")) };
}

/** Axis tick values (points): 0 always, other multiples of the step that sit inside the domain with a margin. */
export function ticksFor(dom: Dom, phone: boolean): number[] {
  const span = dom.hi - dom.lo;
  const step = phone ? (span <= 25 ? 10 : 20) : span < 25 ? 5 : span <= 60 ? 10 : 20;
  const mLo = phone ? 2 : 1;
  const mHi = phone ? 1 : 0.5;
  const out = new Set<number>([0]);
  for (let k = Math.ceil((dom.lo + mLo) / step); k * step <= dom.hi - mHi; k++) out.add(k * step + 0); // + 0 turns -0 into 0
  return [...out].sort((a, b) => a - b);
}

// ---- copy ----
/** The period as it reads inside a sentence. */
export function periodPhrase(period: string): string {
  if (period === "1y") return "over the last year";
  const n = /^(\d+)y$/.exec(period);
  return n ? `over the last ${n[1]} years` : "since each fund's first filing";
}

export function standfirst(period: string, spx: number | null, view: "chart" | "table"): string {
  const over = periodPhrase(period);
  if (view === "table") return `Estimated figures ${over}. Select a heading to sort; Fund steps through A–Z, Z–A and most popular.`;
  return `Estimated return a year ${over}, best first.` + (spx == null ? "" : ` The dotted line is the S&P 500 (${pct(spx, 1)}).`);
}

/** The finding, computed: rows best first. */
export function leadLine(rows: { name: string; ret: number }[], spx: number | null): string {
  if (rows.length === 0) return "";
  const n = rows.length;
  const lost = rows.filter((r) => r.ret < 0).length;
  const lead = `${rows[0].name} leads with ${pct(rows[0].ret, 1)} a year.`;
  if (spx == null) return `${lead} ${lost === 0 ? `None of the ${n} lost money.` : `${lost} of the ${n} lost money.`}`;
  const beat = rows.filter((r) => r.ret > spx).length;
  return `${lead} ${beat} of the ${n} beat the S&P 500; ${lost === 0 ? "none" : lost} lost money.`;
}

export function sourceLine(spx: { ann_return: number | null; from_q: number; to_q: number } | null | undefined): string {
  const base = "Source: SEC 13F filings; Orca estimates.";
  return spx == null || spx.ann_return == null ? base : `${base} S&P 500: SPY total return, ${qLabel(spx.from_q)} to ${qLabel(spx.to_q)}.`;
}

export function captionText(first: number, last: number, n: number, scrolls: boolean): string {
  if (!scrolls) return n === 1 ? "Showing 1 fund" : `Showing all ${n} funds`;
  return `Showing ${first}–${last} of ${n} · scale fits the funds in view`;
}

/** First letters of the first two words, for a photo placeholder. */
export const initials = (s: string): string =>
  s
    .replace(/[^\p{L} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** The full spoken label of a chart row (5). */
export function rowLabel(o: { i: number; n: number; name: string; manager: string | null; book: number; ret: number; spx: number | null }): string {
  const who = o.manager ? `${o.name}, ${o.manager}` : o.name;
  const what = `${o.ret < 0 ? "loss" : "gain"} of ${pct(Math.abs(o.ret), 1, false)} a year (estimate)`;
  const vs = o.spx == null ? "" : o.ret > o.spx ? ", ahead of the S&P 500" : ", behind the S&P 500";
  return `${o.i} of ${o.n}. ${who}, AUM ${aumLabel(o.book)}: ${what}${vs}${o.i === 1 ? ", best in this list" : ""}`;
}
