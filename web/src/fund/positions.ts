// The Positions panel's model, pure: every figure of every position as it stood at the end of a
// chosen period (a quarter, a year or a custom run of quarters). Ported from the approved
// artifact (app.js: tradeT/irrOf/sharesAt/priceQ/tEnd/dividendsAsOf/asOf/periodRows and the sort),
// with the live data behind it: trades come from positions.json, prices from latest_prices.json
// (the newest quarter) or the weekly series (earlier quarter ends).
//
// At the newest quarter the as-of figures are exactly the ones positions.json and lib/live publish
// (average-cost method, realised via the running average cost); tests/fund-positions.test.ts pins that.

import { yearsSince2013, type Stock } from "../data/api";
import type { PositionRow, Trade, Weekly } from "../data/types";
import { irr, positionFlows } from "../lib/live";
import { qShort } from "./fmt";

// ---- time -------------------------------------------------------------------------------

const DAY = 86_400_000;
const D2013 = Date.UTC(2013, 0, 1);

/** What fixes the picker's range and the "now" of the newest period. */
export type Timeline = {
  /** First selectable quarter (summary.tracked_since_q). */
  qmin: number;
  /** Newest quarter (summary.period_q): its figures use the latest prices. */
  latest: number;
  /** Date of the latest prices: the end of the newest period and the IRR clock. */
  asof: string;
};

/** Last day of quarter q, as UTC milliseconds. */
const qEndMs = (q: number): number => Date.UTC(2013 + Math.floor(q / 4), (q % 4) * 3 + 3, 0);

/** Last day of quarter q as an ISO date. */
export const qEndIso = (q: number): string => new Date(qEndMs(q)).toISOString().slice(0, 10);

/** The date a period ending in quarter qe is "as of": the latest prices' date for the newest quarter. */
export const endDate = (tl: Timeline, qe: number): string => (qe >= tl.latest ? tl.asof : qEndIso(qe));

/** End of the period in years after 2013-01-01 (the IRR clock). */
export const tEnd = (tl: Timeline, qe: number): number =>
  qe >= tl.latest ? yearsSince2013(tl.asof) : (qEndMs(qe) - D2013) / (365.25 * DAY);

// ---- periods ----------------------------------------------------------------------------

export type Mode = "quarter" | "year" | "custom";

export type PeriodState = {
  mode: Mode;
  /** Selected quarter of the Quarter view. */
  pq: number;
  /** Selected year of the Year view. */
  py: number;
  /** Quarters a..b (inclusive) of the Custom view. */
  pr: { a: number; b: number };
};

/** Calendar years the Year picker offers: the year of the first selectable quarter to the year of the newest. */
export function yearRange(tl: Timeline): { lo: number; hi: number } {
  return { lo: 2013 + Math.floor(tl.qmin / 4), hi: 2013 + Math.floor(tl.latest / 4) };
}

/** First and last quarter a year's view covers (clamped to the tracked range). */
export function yearSpan(y: number, tl: Timeline): { qs: number; qe: number } {
  return { qs: Math.max(tl.qmin, (y - 2013) * 4), qe: Math.min(tl.latest, (y - 2013) * 4 + 3) };
}

/** The year as the picker names it: a part year says which quarters it covers ("2026 H1", "2026 9M", "2014 H2"). */
export function yearLabel(y: number, tl: Timeline): string {
  const { qs, qe } = yearSpan(y, tl);
  const a = qs - (y - 2013) * 4;
  const b = qe - (y - 2013) * 4;
  if (a === 0 && b === 3) return String(y);
  if (a === 0) return y + (b === 0 ? " Q1" : b === 1 ? " H1" : " 9M");
  if (a === 2 && b === 3) return y + " H2";
  if (a === b) return y + " Q" + (a + 1);
  return y + " Q" + (a + 1) + "–Q" + (b + 1);
}

/** The state a fresh panel starts in: the newest quarter, the last full year, the last four quarters. */
export function defaultPeriod(tl: Timeline): PeriodState {
  const { lo, hi } = yearRange(tl);
  const fullHi = tl.latest % 4 === 3 ? hi : hi - 1;
  return {
    mode: "quarter",
    pq: tl.latest,
    py: Math.max(lo, fullHi),
    pr: { a: Math.max(tl.qmin, tl.latest - 3), b: tl.latest },
  };
}

/** First and last quarter of the chosen period. */
export function periodOf(s: PeriodState, tl: Timeline): { qs: number; qe: number } {
  if (s.mode === "year") return yearSpan(s.py, tl);
  if (s.mode === "custom") return { qs: s.pr.a, qe: s.pr.b };
  return { qs: s.pq, qe: s.pq };
}

// ---- trades -----------------------------------------------------------------------------

/** The rows with every trade list in quarter order (positions.json has them so; this only guards the contract). */
export function withSortedTrades(rows: PositionRow[]): PositionRow[] {
  const sorted = (ts: Trade[]) => ts.every((t, i) => i === 0 || ts[i - 1].q <= t.q);
  if (rows.every((r) => sorted(r.trades))) return rows;
  return rows.map((r) => (sorted(r.trades) ? r : { ...r, trades: r.trades.slice().sort((a, b) => a.q - b.q) }));
}

/** Shares held at the end of quarter q (zero before the first trade, and below float noise). */
export function sharesAt(trades: Trade[], q: number): number {
  let sh = 0;
  for (const t of trades) {
    if (t.q > q) break;
    sh = t.sharesAfter;
  }
  return sh > 1e-6 ? sh : 0;
}

/** Quarter ends 0..upTo, summed over the shares held at each. */
function shareQuarters(trades: Trade[], upTo: number): number {
  let sum = 0;
  for (let i = 0; i < trades.length; i++) {
    const from = trades[i].q;
    if (from > upTo) break;
    const to = Math.min(upTo, i + 1 < trades.length ? trades[i + 1].q - 1 : upTo);
    sum += trades[i].sharesAfter * Math.max(0, to - from + 1);
  }
  return sum;
}

/**
 * Dividends received up to the end of quarter qe. positions.json has only a total per position, so
 * for an earlier quarter the total is spread over the quarters in proportion to the shares held.
 * A quarter's dividends are paid on the shares held at the end of the one before (as the pipeline
 * books them), so a stock bought in quarter qe has paid nothing yet. The artifact weighted by
 * value instead; this needs no price, which keeps the weekly files out of the way. Exact at the newest quarter.
 */
export function dividendsAsOf(pos: PositionRow, qe: number, latest: number): number {
  if (qe >= latest) return pos.dividends;
  if (pos.dividends === 0) return 0;
  const den = shareQuarters(pos.trades, latest - 1);
  return den > 0 ? (pos.dividends * shareQuarters(pos.trades, qe - 1)) / den : 0;
}

// ---- prices -----------------------------------------------------------------------------

/**
 * Close at the end of quarter q from a weekly series: the last week ending on or before the
 * quarter's last day, walking back over gaps. null when the series has no close that early.
 */
export function quarterClose(w: Weekly, q: number): number | null {
  let i = Math.floor((qEndMs(q) - Date.parse(w.start)) / (7 * DAY));
  if (i >= w.close.length) i = w.close.length - 1;
  for (; i >= 0; i--) {
    const c = w.close[i];
    if (c != null) return c;
  }
  return null;
}

/** What the model reads prices from. */
export type PriceSource = {
  tl: Timeline;
  /** Latest close per stock (the newest quarter). */
  prices: Map<number, number>;
  /** Weekly series loaded so far; null = the stock has no file. */
  weekly: ReadonlyMap<number, Weekly | null>;
};

/**
 * The position's price at the end of quarter qe. The newest quarter uses the latest price (none = unpriced);
 * an earlier one the weekly series, else the position's last trade price up to then, else unpriced.
 */
export function priceAt(pos: PositionRow, qe: number, src: PriceSource): number | null {
  if (qe >= src.tl.latest) return src.prices.get(pos.stock_id) ?? null;
  const w = src.weekly.get(pos.stock_id);
  const c = w ? quarterClose(w, qe) : null;
  if (c != null) return c;
  let px: number | null = null;
  for (const t of pos.trades) {
    if (t.q > qe) break;
    px = t.px;
  }
  return px;
}

// ---- one position as of a quarter --------------------------------------------------------

export type Figures = {
  /** Shares held, and what they cost. */
  sh: number;
  cost: number;
  /** Realised P&L so far (running average cost). */
  real: number;
  /** Dollars bought so far. */
  inv: number;
  /** Average buy price and average sell price; null when nothing was bought / sold. */
  ac: number | null;
  ax: number | null;
  /** Value of the shares held: 0 when none, null when held but unpriced. */
  val: number | null;
  /** Value less cost; null when nothing is held or the price is unknown. */
  unreal: number | null;
  divs: number;
  /** Realised + unrealised + dividends; null when held but unpriced. */
  total: number | null;
  /** Total ÷ invested; null when nothing was invested or the total is unknown. */
  ret: number | null;
  /** Trades up to the quarter. */
  n: number;
};

/** Every figure of a position at the end of quarter qe, at the given price. */
export function asOf(pos: PositionRow, qe: number, price: number | null, latest: number): Figures {
  let sh = 0;
  let cost = 0;
  let real = 0;
  let inv = 0;
  let bsh = 0;
  let sold = 0;
  let ssh = 0;
  let n = 0;
  for (const t of pos.trades) {
    if (t.q > qe) break;
    n++;
    if (t.delta > 0) {
      cost += t.delta * t.px;
      inv += t.delta * t.px;
      bsh += t.delta;
    } else {
      const sl = -t.delta;
      const avg = sh > 0 ? cost / sh : t.px;
      real += (t.px - avg) * sl;
      cost -= avg * sl;
      sold += sl * t.px;
      ssh += sl;
    }
    sh = t.sharesAfter;
    if (sh <= 1e-6) {
      sh = 0;
      cost = 0;
    }
  }
  const val = sh > 0 ? (price == null ? null : sh * price) : 0;
  const unreal = sh > 0 && val !== null ? val - cost : null;
  const divs = dividendsAsOf(pos, qe, latest);
  const total = sh > 0 ? (val === null ? null : real + (val - cost) + divs) : real + divs;
  return {
    sh,
    cost,
    real,
    inv,
    ac: bsh > 0 ? inv / bsh : null,
    ax: ssh > 0 ? sold / ssh : null,
    val,
    unreal,
    divs,
    total,
    ret: total !== null && inv > 0 && Number.isFinite(total / inv) ? total / inv : null,
    n,
  };
}

/** Runs `f` the first time it is asked and keeps the answer: an IRR is dear and most rows are never looked at. */
function once<T>(f: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = f();
      done = true;
    }
    return value;
  };
}

// ---- the table rows ---------------------------------------------------------------------

export type Tag = "new" | "add" | "trim" | "exit";

/** One row of the table: a position as of the end of the period. */
export type PosRow = {
  id: number;
  pos: PositionRow;
  ticker: string;
  name: string;
  /** First quarter held, and the quarter it was sold out (null while held at the end of the period). */
  from: number;
  to: number | null;
  /** Shares held at the end of the period. */
  open: boolean;
  /** Price at the end of the period; null = unknown. */
  px: number | null;
  /** Value held (0 when sold out, null when unpriced). */
  val: number | null;
  /** Share of the priced book, percent (0 unless held and priced). */
  w: number;
  ac: number | null;
  ax: number | null;
  ret: number | null;
  re: number;
  unreal: number | null;
  total: number | null;
  /** What the fund did over the period: null = no net change. */
  tag: Tag | null;
  /** Change in the position's weight over the period, percentage points of the book; null when unpriced. */
  dw: number | null;
  /** Annualised IRR, worked out on first use. */
  irr: () => number | null;
};

/** Held at the end of the period, held just before it, or traded in it. */
export function inPeriod(pos: PositionRow, qs: number, qe: number): { a: number; b: number } | null {
  const a = sharesAt(pos.trades, qe);
  const b = sharesAt(pos.trades, qs - 1);
  if (a > 0 || b > 0 || pos.trades.some((t) => t.q >= qs && t.q <= qe)) return { a, b };
  return null;
}

/** Stocks whose weekly series the period needs: none for the newest quarter, which uses the latest prices. */
export function neededStocks(positions: PositionRow[], qs: number, qe: number, tl: Timeline): number[] {
  if (qe >= tl.latest) return [];
  return positions.filter((p) => inPeriod(p, qs, qe) !== null).map((p) => p.stock_id);
}

/**
 * Stock ids in the order their weekly files are worth prefetching: the positions held at the newest quarter
 * first (largest first, as the newest table lists them), then every other position by how recently the
 * fund last traded it. The first steps back in time touch the first group; the old exits come last.
 */
export function prefetchOrder(positions: PositionRow[], tl: Timeline, prices: ReadonlyMap<number, number>): number[] {
  const held: { id: number; value: number }[] = [];
  const gone: { id: number; q: number; invested: number }[] = [];
  for (const p of positions) {
    if (sharesAt(p.trades, tl.latest) > 0) {
      const px = prices.get(p.stock_id);
      held.push({ id: p.stock_id, value: px === undefined ? p.cost_now : p.shares_now * px });
    } else {
      gone.push({ id: p.stock_id, q: p.trades.length > 0 ? p.trades[p.trades.length - 1].q : p.last_q, invested: p.invested });
    }
  }
  held.sort((a, b) => b.value - a.value);
  gone.sort((a, b) => b.q - a.q || b.invested - a.invested);
  return [...held, ...gone].map((x) => x.id);
}

/**
 * The table's rows for the period qs..qe: every position held at its end, held just before it
 * or traded in it, with its figures at the end of the period. `dw` is the change of the
 * position's weight in the whole book at the period's end prices, so it moves only with shares.
 */
export function buildRows(positions: PositionRow[], qs: number, qe: number, src: PriceSource, stocks: Map<number, Stock>): PosRow[] {
  const listed: { pos: PositionRow; a: number; b: number; px: number | null }[] = [];
  let vb = 0;
  for (const pos of positions) {
    const held = inPeriod(pos, qs, qe);
    if (!held) continue;
    const px = priceAt(pos, qe, src);
    listed.push({ pos, a: held.a, b: held.b, px });
    if (px !== null) vb += held.b * px;
  }
  const tNow = tEnd(src.tl, qe);
  const rows: PosRow[] = listed.map(({ pos, a, b, px }) => {
    const f = asOf(pos, qe, px, src.tl.latest);
    const tag: Tag | null =
      a === 0 && b === 0 ? null : b <= 1e-6 ? "new" : a <= 1e-6 ? "exit" : a > b * 1.000001 ? "add" : a < b * 0.999999 ? "trim" : null;
    let dw: number | null = null;
    if (px !== null) {
      const A = a * px;
      const B = b * px;
      const den = vb - B + A;
      dw = ((den > 0 ? A / den : 0) - (vb > 0 ? B / vb : 0)) * 100;
    }
    const stock = stocks.get(pos.stock_id);
    let to: number | null = null;
    if (a === 0) for (const t of pos.trades) if (t.q <= qe) to = t.q;
    return {
      id: pos.stock_id,
      pos,
      ticker: stock?.ticker ?? "#" + pos.stock_id,
      name: stock?.name ?? "",
      from: pos.from_q,
      to,
      open: f.sh > 0,
      px,
      val: f.val,
      w: 0,
      ac: f.ac,
      ax: f.ax,
      ret: f.ret,
      re: f.real,
      unreal: f.unreal,
      total: f.total,
      tag,
      dw,
      irr: once(() => irr(positionFlows(pos.trades.slice(0, f.n), f.sh, px ?? undefined, tNow))),
    };
  });
  const tv = rows.reduce((s, r) => s + (r.val ?? 0), 0);
  for (const r of rows) r.w = tv > 0 ? ((r.val ?? 0) / tv) * 100 : 0;
  return rows;
}

// ---- sorting ----------------------------------------------------------------------------

/** The 13 columns, in order. */
export type SortKey = "t" | "held" | "w" | "ret" | "irr" | "val" | "ac" | "px" | "ax" | "last" | "re" | "unreal" | "total";

function sortVal(r: PosRow, k: SortKey): number | string | null {
  switch (k) {
    case "t":
      return r.ticker;
    case "held":
      return r.from;
    case "last":
      return r.tag ? r.dw : null;
    case "ax":
      return r.open ? null : r.ax;
    case "irr":
      return r.irr();
    default:
      return r[k];
  }
}

/** The rows ordered by a column; missing figures go last either way, ties by total P&L (the artifact's order). */
export function sortRows(rows: PosRow[], key: SortKey, dir: 1 | -1): PosRow[] {
  const keyed = rows.map((r) => ({ r, v: sortVal(r, key) }));
  keyed.sort((x, y) => {
    const av = x.v;
    const bv = y.v;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    let c = key === "t" ? (av < bv ? -1 : av > bv ? 1 : 0) : (av as number) - (bv as number);
    if (c === 0) c = (y.r.total ?? 0) - (x.r.total ?? 0);
    return dir * c;
  });
  return keyed.map((k) => k.r);
}

/** "Q2 ’26 to Q2 ’26" shortened: one quarter, or the run. */
export function periodName(qs: number, qe: number): string {
  return qs === qe ? qShort(qs) : qShort(qs) + " to " + qShort(qe);
}
