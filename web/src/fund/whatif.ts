// The "What if they'd kept it" panel's model, pure: one row for every stock the fund sold or trimmed,
// with what it did afterwards and what holding on would have earned. Number rules are those of the old
// section (lib/live missed / sinceSale / heldFlows); everything that is a property of the position
// (avg cost, price, avg exit, return, IRR, last change) comes from the Positions panel's as-of model
// (positions.ts) at the newest quarter, so the two tables print the same digits for the same stock.

import { toRows, yearsSince2013, type Stock } from "../data/api";
import type { Exits, ExitsRows, ExitStatus, PositionRow, Summary } from "../data/types";
import { heldFlows, irr, missed, sinceSale, tradeMove, type Move } from "../lib/live";
import { buildRows, sharesAt, withSortedTrades, type PosRow, type PriceSource, type Tag, type Timeline } from "./positions";

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

// ---- the rows ---------------------------------------------------------------------------

/** What the fund last did with the stock, and by how much its weight in the book moved. */
export type LastChange = {
  tag: Tag;
  /** Quarter of the last trade. */
  q: number;
  /** Change of the position's weight in the book over that quarter, percentage points; null when unpriced. */
  dw: number | null;
  /** True when it is the Positions table's own figure (the newest quarter), false when estimated (see weightChangesAt). */
  exact: boolean;
};

export type SaleRow = {
  id: number;
  ticker: string;
  name: string;
  status: ExitStatus;
  soldShares: number;
  /** What the sales brought in (dollars, from exits.json): the sold shares' value at the time. */
  soldUsd: number;
  /** The as-of row of the position at the newest quarter: what the price chart and trade list under an opened row read. */
  base: PosRow;
  /** False when positions.json has no row for the stock: its position figures are dashes. */
  hasPos: boolean;
  /** Latest close; null = none. */
  px: number | null;
  ac: number | null;
  /** Average price of the shares sold (the Positions table's, from the fund's trades). */
  ax: number | null;
  ret: number | null;
  irr: () => number | null;
  irrHeld: () => number | null;
  last: LastChange | null;
  /** Move in the price since the average exit (a fraction). */
  since: number | null;
  /** The stock's return over the 12 months after the sale, and SPY's. */
  oneY: number | null;
  spyOneY: number | null;
  /** Sold shares at today's price less what they sold for: plus = sold too early, minus = loss dodged. */
  missed: number | null;
};

type ExitIn = { [K in keyof ExitsRows]: ExitsRows[K][number] };

const TAG_OF: Record<Move, Tag> = { New: "new", Add: "add", Trim: "trim", Exit: "exit" };

/**
 * The Positions table's weight change (after-weight less before-weight, percentage points of the priced
 * book) for the wanted stocks at the end of an earlier quarter, one entry per stock id -> its quarter.
 * That table needs every position's close at the quarter end, i.e. every weekly series; here each
 * position's last trade price up to the quarter stands in for its close (the table does the same for a
 * stock with no weekly file), so the figure is an estimate that is close to the table's but not its digits.
 * One pass over the positions per distinct quarter, which is cheap: the fund has at most ~60 quarters.
 */
export function weightChangesAt(positions: PositionRow[], wanted: ReadonlyMap<number, number>): Map<number, number | null> {
  const byQ = new Map<number, Set<number>>();
  for (const [id, q] of wanted) {
    const ids = byQ.get(q);
    if (ids) ids.add(id);
    else byQ.set(q, new Set([id]));
  }
  const out = new Map<number, number | null>();
  for (const [q, ids] of byQ) {
    let vb = 0;
    const mine: { id: number; a: number; b: number; px: number | null }[] = [];
    for (const p of positions) {
      let px: number | null = null;
      for (const t of p.trades) {
        if (t.q > q) break;
        px = t.px;
      }
      const b = sharesAt(p.trades, q - 1);
      if (px !== null) vb += b * px;
      if (ids.has(p.stock_id)) mine.push({ id: p.stock_id, a: sharesAt(p.trades, q), b, px });
    }
    for (const { id, a, b, px } of mine) {
      if (px === null) {
        out.set(id, null);
        continue;
      }
      const A = a * px;
      const B = b * px;
      const den = vb - B + A;
      out.set(id, ((den > 0 ? A / den : 0) - (vb > 0 ? B / vb : 0)) * 100);
    }
  }
  return out;
}

/** The fields of the page's data this model reads. */
export type WhatIfInput = {
  positions: PositionRow[];
  exits: Exits;
  /** period_q (the newest quarter) and tracked_since_q: the timeline of the as-of model. */
  summary: Pick<Summary, "period_q" | "tracked_since_q">;
  /** Latest close of every stock that has one. */
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  /** Date of those prices: "now" for every IRR. */
  asof: string;
};

/** A stand-in position for a sale whose stock positions.json does not list: no trades, so every position figure is a dash. */
function stubBase(e: ExitIn, stock: Stock | undefined, price: number | null): PosRow {
  const pos: PositionRow = {
    stock_id: e.stock_id,
    from_q: e.last_sale_q,
    to_q: null,
    avg_cost: 0,
    avg_exit: e.avg_exit,
    invested: 0,
    realised: 0,
    dividends: 0,
    shares_now: 0,
    cost_now: 0,
    last_q: e.last_sale_q,
    last_type: "trim",
    last_pct: null,
    last_usd: 0,
    trades: [],
  };
  return {
    id: e.stock_id,
    pos,
    ticker: stock?.ticker ?? "#" + e.stock_id,
    name: stock?.name ?? "",
    from: e.last_sale_q,
    to: null,
    open: false,
    px: price,
    val: 0,
    w: 0,
    ac: null,
    ax: null,
    ret: null,
    re: 0,
    unreal: null,
    total: null,
    tag: null,
    dw: null,
    irr: () => null,
  };
}

/**
 * One row per sale in exits.json. The position figures are the as-of model at the newest quarter, so they
 * are the Positions table's own; the sale figures (since sale, $ missed / dodged) keep the old rules.
 */
export function buildSaleRows(input: WhatIfInput): SaleRow[] {
  const { exits, summary, prices, stocks, asof } = input;
  const tl: Timeline = { qmin: summary.tracked_since_q, latest: summary.period_q, asof };
  const src: PriceSource = { tl, prices, weekly: new Map() }; // the newest quarter reads the latest prices only
  const sales = toRows<ExitIn>(exits.rows);
  if (sales.length === 0) return [];
  const nowT = yearsSince2013(asof);
  const positions = withSortedTrades(input.positions);

  const wanted = new Set(sales.map((e) => e.stock_id));
  const mine = positions.filter((p) => wanted.has(p.stock_id));
  // Every figure of a position as of the newest quarter. The start of the period only matters for tag and
  // weight change, which are not read from here.
  const asOfNow = new Map(buildRows(mine, 0, tl.latest, src, stocks).map((r) => [r.id, r]));

  // A stock the fund traded in the newest quarter: its weight change is the Positions table's own figure,
  // which needs the whole book at the newest prices (no weekly files).
  const tradedNow = mine.some((p) => p.trades.length > 0 && p.trades[p.trades.length - 1].q === tl.latest);
  const newest = new Map<number, PosRow>();
  if (tradedNow) for (const r of buildRows(positions, tl.latest, tl.latest, src, stocks)) if (wanted.has(r.id)) newest.set(r.id, r);

  // The weight change of a last trade in an earlier quarter: estimated (the newest quarter's is exact).
  const older = new Map<number, number>();
  for (const e of sales) {
    const p = asOfNow.get(e.stock_id)?.pos;
    const t = p && p.trades.length > 0 ? p.trades[p.trades.length - 1] : undefined;
    if (t && t.q < tl.latest) older.set(e.stock_id, t.q);
  }
  const estimated = older.size > 0 ? weightChangesAt(positions, older) : new Map<number, number | null>();

  return sales.map((e): SaleRow => {
    const stock = stocks.get(e.stock_id);
    const price = prices.get(e.stock_id);
    const base = asOfNow.get(e.stock_id);
    const pos = base?.pos;
    const row = base ?? stubBase(e, stock, price ?? null);

    let last: LastChange | null = null;
    const t = pos && pos.trades.length > 0 ? pos.trades[pos.trades.length - 1] : undefined;
    if (t) {
      const exact = newest.get(e.stock_id);
      if (exact && exact.tag && t.q === tl.latest) {
        last = { tag: exact.tag, q: t.q, dw: exact.dw, exact: true };
      } else {
        last = { tag: TAG_OF[tradeMove(t)], q: t.q, dw: estimated.get(e.stock_id) ?? null, exact: false };
      }
    }

    return {
      id: e.stock_id,
      ticker: row.ticker,
      name: row.name,
      status: e.status,
      soldShares: e.sold_shares,
      soldUsd: e.sold_usd,
      base: row,
      hasPos: pos !== undefined,
      px: price ?? null,
      ac: base ? base.ac : null,
      ax: base?.ax ?? e.avg_exit,
      ret: base ? base.ret : null,
      irr: base ? base.irr : () => null,
      irrHeld: once(() => (pos ? irr(heldFlows(pos.trades, price, nowT)) : null)),
      last,
      since: sinceSale(e.avg_exit, price),
      oneY: e.one_y,
      spyOneY: e.spy_one_y,
      missed: missed(e.sold_shares, e.sold_usd, price),
    };
  });
}

// ---- tiles (R25) ----------------------------------------------------------------------------

export type TileFigures = {
  /** Sum of what was missed over the sales that were too early (dollars, positive). */
  early: number;
  /** Sum of the drops avoided over the sales that dodged a loss (dollars, positive). */
  dodged: number;
  /** Sales with both a 12-month return and SPY's. */
  measured: number;
};

export function tileFigures(rows: SaleRow[]): TileFigures {
  let early = 0;
  let dodged = 0;
  let measured = 0;
  for (const r of rows) {
    if (r.missed !== null) {
      if (r.missed > 0) early += r.missed;
      else dodged -= r.missed;
    }
    if (r.oneY !== null && r.spyOneY !== null) measured++;
  }
  return { early, dodged, measured };
}

// ---- sorting ----------------------------------------------------------------------------------

/** The 14 columns, in order. */
export type SaleKey = "t" | "status" | "usd" | "ac" | "px" | "ax" | "ret" | "irr" | "irrHeld" | "last" | "since" | "one" | "spy" | "missed";

/** Columns that sort A to Z first; the others largest first. */
export const TEXT_KEYS: ReadonlySet<SaleKey> = new Set<SaleKey>(["t", "status"]);

const STATUS_WORD: Record<ExitStatus, string> = { trimmed: "Trimmed", sold_all: "Sold all" };
export const statusWord = (s: ExitStatus): string => STATUS_WORD[s];

function sortVal(r: SaleRow, k: SaleKey): number | string | null {
  switch (k) {
    case "t":
      return r.ticker;
    case "status":
      return STATUS_WORD[r.status];
    case "usd":
      return r.soldUsd;
    case "ac":
      return r.ac;
    case "px":
      return r.px;
    case "ax":
      return r.ax;
    case "ret":
      return r.ret;
    case "irr":
      return r.irr();
    case "irrHeld":
      return r.irrHeld();
    case "last":
      return r.last ? r.last.dw : null;
    case "since":
      return r.since;
    case "one":
      return r.oneY;
    case "spy":
      return r.spyOneY;
    case "missed":
      return r.missed;
  }
}

/** The rows ordered by a column; missing figures go last either way, ties keep the list's order. */
export function sortSales(rows: SaleRow[], key: SaleKey, dir: 1 | -1): SaleRow[] {
  const keyed = rows.map((r) => ({ r, v: sortVal(r, key) }));
  keyed.sort((x, y) => {
    const av = x.v;
    const bv = y.v;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const c = TEXT_KEYS.has(key) ? (av < bv ? -1 : av > bv ? 1 : 0) : (av as number) - (bv as number);
    return dir * c;
  });
  return keyed.map((k) => k.r);
}
