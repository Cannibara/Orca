// Shared fixtures of the What-if tests: small positions, exits and the summary fields the model reads.
import type { Stock } from "../src/data/api";
import type { Exits, ExitsSummary, ExitStatus, PositionRow, Summary, Trade } from "../src/data/types";

export const FUND = 42;
export const ASOF = "2026-10-30"; // 13.83 years after 2013-01-01
export const NEWEST = 53; // Q2 2026

/** A buy (delta > 0) or sale (delta < 0) at quarter q. */
export const trade = (q: number, delta: number, px: number, sharesAfter: number): Trade => ({ q, delta, px, low: null, high: null, sharesAfter });

/** A position held now (100 shares, cost 1,000, one buy) unless `over` says otherwise. */
export function pos(stock_id: number, over: Partial<PositionRow> = {}): PositionRow {
  return {
    stock_id,
    from_q: 10,
    to_q: null,
    avg_cost: 10,
    avg_exit: null,
    invested: 1000,
    realised: 0,
    dividends: 0,
    shares_now: 100,
    cost_now: 1000,
    last_q: 10,
    last_type: "new",
    last_pct: null,
    last_usd: 1000,
    trades: [trade(10, 100, 10, 100)],
    ...over,
  };
}

/** A position sold out: nothing held, `realised` made (bought 100 at 10 in q 10, sold all at 20 in q 49). */
export const sold = (stock_id: number, realised: number, over: Partial<PositionRow> = {}): PositionRow =>
  pos(stock_id, {
    shares_now: 0,
    cost_now: 0,
    to_q: 49,
    realised,
    avg_exit: 20,
    last_type: "exit",
    last_q: 49,
    last_usd: -2000,
    trades: [trade(10, 100, 10, 100), trade(49, -100, 20, 0)],
    ...over,
  });

export type ExitIn = {
  stock_id: number;
  status?: ExitStatus;
  sold_shares: number;
  sold_usd: number;
  one_y?: number | null;
  spy_one_y?: number | null;
};

export function exitsOf(rows: ExitIn[], summary: Partial<ExitsSummary> = {}): Exits {
  return {
    rows: {
      stock_id: rows.map((r) => r.stock_id),
      status: rows.map((r) => r.status ?? "sold_all"),
      sold_shares: rows.map((r) => r.sold_shares),
      sold_usd: rows.map((r) => r.sold_usd),
      avg_exit: rows.map((r) => r.sold_usd / r.sold_shares),
      last_sale_q: rows.map(() => 40),
      one_y: rows.map((r) => r.one_y ?? null),
      spy_one_y: rows.map((r) => r.spy_one_y ?? null),
    },
    summary: { buys_12m: null, sells_12m: null, beat_spy_pct: null, ...summary },
  };
}

export const NO_EXITS = exitsOf([]);

/** The summary fields the panel reads: newest quarter 53, tracked from quarter 0, a book of $1bn (or `book`) at every quarter end. */
export function summaryOf(over: Partial<Pick<Summary, "period_q" | "tracked_since_q">> & { book?: number } = {}): Summary {
  const period_q = over.period_q ?? NEWEST;
  const q = Array.from({ length: period_q + 1 }, (_, i) => i);
  const col = (v: number) => q.map(() => v);
  const book = over.book ?? 1e9;
  return {
    id: FUND,
    name: "Test Fund",
    cik: 1,
    period_q,
    filed: "2026-08-14",
    book,
    n_holdings: 0,
    priced_pct: 1,
    tracked_since_q: over.tracked_since_q ?? 0,
    inactive: false,
    metrics: {} as Summary["metrics"],
    years: {} as Summary["years"],
    quarters: {
      q,
      ret: q.map(() => 0),
      start: col(book),
      end: col(book),
      market_move: col(0),
      net_buying: col(0),
      trade_gains: col(0),
      dividends: col(0),
    },
    holdings_now: { stock_id: [], shares: [], cost: [] },
  };
}

/** Every stock S<id> "Company <id>", for ids 1..n. */
export const stocksTo = (n: number): Map<number, Stock> =>
  new Map(Array.from({ length: n }, (_, i) => [i + 1, { ticker: `S${i + 1}`, name: `Company ${i + 1}` }]));

export const pricesOf = (closes: Record<number, number>): Map<number, number> =>
  new Map(Object.entries(closes).map(([id, p]) => [Number(id), p]));
