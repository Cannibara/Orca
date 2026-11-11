// The pure logic behind "Return constituents ...": a period's contribution rows, the waterfall's
// items and geometry, the headline sentence and the table. Ported from the approved
// artifact (app.js drvRows/drvRange/drvItems/drvSvg/renderC3Body). The panel only draws
// what these return, so everything here is testable without a DOM.

import type { Stock } from "../data/api";
import type { Contrib } from "../data/types";
import { axisPP, fPP, fYrs } from "./fmt";
import { endRound, niceTicks, textW } from "./geometry";
import { yearOfQ, type Series } from "./series";

/** One stock's contribution to the period's return, in percentage points. */
export type DriveRow = {
  id: number;
  /** Ticker, or "#id" for a stock missing from securities.json. */
  t: string;
  /** Company name; "" when unknown. */
  name: string;
  v: number;
};

/** What a row is called in running text: the company, else its ticker. */
export const rowName = (r: Pick<DriveRow, "t" | "name">): string => r.name || r.t;

/**
 * The contributions of the years `labels`, added up per stock, largest first. A fund can
 * have thousands of stocks a year, so this is one pass into a Map and one sort.
 */
export function periodRows(contrib: Contrib, stocks: Map<number, Stock>, labels: string[]): DriveRow[] {
  const sum = new Map<number, number>();
  for (const label of labels) {
    const y = contrib.by_year[label];
    if (!y) continue;
    const n = Math.min(y.stock_id.length, y.points.length);
    for (let i = 0; i < n; i++) {
      const p = y.points[i];
      if (!Number.isFinite(p)) continue;
      sum.set(y.stock_id[i], (sum.get(y.stock_id[i]) ?? 0) + p);
    }
  }
  const rows: DriveRow[] = [];
  sum.forEach((v, id) => {
    const s = stocks.get(id);
    rows.push({ id, t: s?.ticker ?? "#" + id, name: s?.name ?? "", v });
  });
  return rows.sort((a, b) => b.v - a.v);
}

/** The rows, biggest mover first (by size, whatever the sign). */
export function byMagnitude(rows: DriveRow[]): DriveRow[] {
  return rows.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}

/** Quarters with a return inside the years ya..yb: the length of a period. */
export function quartersIn(series: Series, ya: number, yb: number): number {
  let n = 0;
  for (const p of series.quarters) {
    const y = yearOfQ(p.q);
    if (y >= ya && y <= yb) n++;
  }
  return n;
}

export const sumOf = (rows: DriveRow[]): number => rows.reduce((a, r) => a + r.v, 0);

/** The headline: bold period, its length, then one sentence on the biggest winner and loser. */
export type Headline = { span: string; meta: string; text: string };

export function headline(rows: DriveRow[], span: string, nq: number): Headline {
  const top = rows[0];
  const worst = rows[rows.length - 1];
  let text: string;
  if (top.v <= 0) text = "No stock added to return. " + rowName(worst) + " took away " + Math.abs(worst.v).toFixed(1) + " points.";
  else if (worst.v >= 0)
    text = rowName(top) + " added " + top.v.toFixed(1) + " points, the most of " + rows.length + (rows.length === 1 ? " stock." : " stocks.");
  else text = rowName(top) + " added " + top.v.toFixed(1) + " points, but " + rowName(worst) + " took away " + Math.abs(worst.v).toFixed(1) + ".";
  const yrs = fYrs(nq / 4);
  const meta = yrs + (yrs === "1" ? " year" : " years") + ", " + nq + (nq === 1 ? " quarter" : " quarters");
  return { span, meta, text };
}

// ---- waterfall -----------------------------------------------------------

/** A bar of the waterfall: a named stock, the grouped rest, or the total. */
export type WfItem = {
  /** Ticker; "Other" for the group, "Total" for the sum. */
  t: string;
  name: string;
  v: number;
  other?: boolean;
  tot?: boolean;
  /** Stocks in the "Other" group, and the group itself (biggest first) for its tooltip. */
  n?: number;
  list?: DriveRow[];
};

/** How many stocks get their own bar at chart width W: 4 to 10. */
export function namedCount(W: number): number {
  return Math.max(4, Math.min(10, Math.floor((W - 46) / 96) - 2));
}

/** The named stocks (by size, shown by value) followed by "Other stocks" for the rest. */
export function driveItems(byMag: DriveRow[], W: number): WfItem[] {
  const K = namedCount(W);
  const named = byMag.slice(0, K);
  let rest = byMag.slice(K);
  if (rest.length === 1) {
    named.push(rest[0]);
    rest = [];
  }
  named.sort((a, b) => b.v - a.v);
  const items: WfItem[] = named.map((r) => ({ t: r.t, name: r.name, v: r.v }));
  if (rest.length) items.push({ t: "Other", name: "Other stocks", v: sumOf(rest), other: true, n: rest.length, list: rest });
  return items;
}

export type WfBar = {
  i: number;
  item: WfItem;
  cls: "gain" | "loss" | "tot" | "tot neg";
  d: string;
  /** The bar grows from its bottom edge when it goes up, from its top when it goes down. */
  up: boolean;
  cx: number;
  /** The value above (or below) the bar. */
  label: string;
  labelY: number;
  /** Ticker under the bar, and the company name (wide charts only; null otherwise). */
  tick: string;
  tickY: number;
  nm: string | null;
  nmY: number;
  /** Full-height hit rectangle. */
  hit: { x: number; w: number };
  aria: string;
};

export type WfLayout = {
  W: number;
  H: number;
  ml: number;
  mr: number;
  wide: boolean;
  /** y-axis ticks, null when the chart is too narrow for the axis. */
  ticks: { y: number; text: string }[] | null;
  zeroY: number;
  bars: WfBar[];
  /** The dotted connectors between neighbouring bars. */
  conns: { x1: number; x2: number; y: number }[];
  /** Grow-in stagger in ms. */
  step: number;
};

const f1 = (v: number) => +v.toFixed(1);

/** The waterfall's geometry for `items` (and their `total`) at chart width W. */
export function waterfall(items: WfItem[], total: number, W: number): WfLayout {
  const m = items.length;
  const n = m + 1;
  const wide = W >= 480;
  const names = W >= 720;
  const ml = wide ? 46 : 4;
  const mr = 4;
  const iw = W - ml - mr;
  const band = iw / n;
  const bw = Math.min(56, Math.max(10, band * 0.62));
  const H = W < 520 ? 300 : 360;
  const mt = 26;
  const mb = names ? 60 : 46;
  const ih = H - mt - mb;
  let c = 0;
  const from: number[] = [];
  const to: number[] = [];
  for (const it of items) {
    from.push(c);
    c += it.v;
    to.push(c);
  }
  const lv = [...to, ...from, 0, total];
  const ticks = niceTicks(Math.min(...lv), Math.max(...lv), 4);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const Y = (v: number) => mt + ih - ((v - t0) / (t1 - t0)) * ih;
  const cx = (i: number) => ml + band * i + band / 2;
  const seq: WfItem[] = [...items, { t: "Total", name: "Total of listed", v: total, tot: true }];
  const bars: WfBar[] = [];
  const conns: WfLayout["conns"] = [];
  seq.forEach((it, i) => {
    const f = it.tot ? 0 : from[i];
    const t2 = it.tot ? total : to[i];
    const yf = Y(f);
    let yt = Y(t2);
    const up = t2 >= f;
    const x = cx(i) - bw / 2;
    if (Math.abs(yt - yf) < 1.5) yt = yf + (up ? -1.5 : 1.5); // a bar is never thinner than a hairline
    const vup = it.v >= 0;
    let nm: string | null = null;
    if (names) {
      const full = it.other ? it.n + " stocks" : it.name;
      nm = full;
      while (nm.length > 3 && textW(nm, 12) > band - 6) nm = nm.slice(0, -1);
      if (nm !== full) nm = nm.replace(/\s+$/, "") + "…";
    }
    bars.push({
      i,
      item: it,
      cls: it.tot ? (it.v >= 0 ? "tot" : "tot neg") : it.v >= 0 ? "gain" : "loss",
      d: endRound(+x.toFixed(2), +bw.toFixed(2), +yf.toFixed(2), +yt.toFixed(2), 3),
      up,
      cx: f1(cx(i)),
      label: fPP(it.v),
      labelY: f1(vup ? Math.min(yf, yt) - 5 : Math.max(yf, yt) + 14),
      tick: it.other ? "Other" : it.t,
      tickY: H - (names ? 26 : 12),
      nm,
      nmY: H - 10,
      hit: { x: f1(ml + band * i), w: f1(band) },
      aria:
        (it.tot ? "Total of listed stocks" : it.other ? "Other stocks, " + it.n + " smaller contributors" : (it.name || it.t) + " (" + it.t + ")") +
        ": " + fPP(it.v, 2) + " percentage points",
    });
    if (i < seq.length - 1) conns.push({ x1: f1(cx(i) + bw / 2), x2: f1(cx(i + 1) - bw / 2), y: f1(Y(to[i])) });
  });
  return {
    W,
    H,
    ml,
    mr,
    wide,
    ticks: wide ? ticks.map((t) => ({ y: f1(Y(t)), text: axisPP(t) })) : null,
    zeroY: f1(Y(0)),
    bars,
    conns,
    step: Math.min(60, 480 / n),
  };
}

/** What the tooltip of a bar says. `span` names the period ("2022", "2020 to 2022"). */
export function itemTip(it: WfItem, span: string): { title: string; color: string; value: string; note: string } {
  const value = fPP(it.v, 2) + " points";
  if (it.tot) return { title: "Total of listed stocks", color: it.v >= 0 ? "var(--gain)" : "var(--loss)", value, note: "The sum of every contribution in " + span };
  const color = it.v >= 0 ? "var(--gain-soft)" : "var(--loss-soft)"; // the bar's own tint
  if (it.other) {
    const n = it.n ?? 0;
    const list = (it.list ?? []).slice(0, 4).map((r) => r.t).join(", ");
    return { title: "Other stocks", color, value, note: n + " smaller contributors: " + list + (n > 4 ? ", and " + (n - 4) + " more" : "") };
  }
  return { title: it.name || it.t, color, value, note: it.t + " in " + span };
}

// ---- the numbers table ---------------------------------------------------

/** Rows shown before the table asks for "Show all": a fund can have thousands of stocks. */
export const TABLE_CAP = 200;

export type TableView = {
  /** Rows to print, biggest contribution first. */
  rows: DriveRow[];
  /** Stocks left out of `rows` (0 when all are shown), and their summed points. */
  hidden: number;
  hiddenSum: number;
  total: number;
};

/**
 * The accessible table's rows. Up to `cap` the whole list; over it the `cap` biggest movers
 * (by size, so big losers show too), still ordered by value, and the rest as one summed line.
 */
export function tableView(rows: DriveRow[], byMag: DriveRow[], all: boolean, cap = TABLE_CAP): TableView {
  const total = sumOf(rows);
  if (all || rows.length <= cap) return { rows, hidden: 0, hiddenSum: 0, total };
  const keep = new Set(byMag.slice(0, cap));
  return {
    rows: rows.filter((r) => keep.has(r)),
    hidden: rows.length - cap,
    hiddenSum: sumOf(byMag.slice(cap)),
    total,
  };
}
