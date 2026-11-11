import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { priceMap, yearsSince2013 } from "../src/data/api";
import type { LatestPrices, PositionRow, Positions, Trade, Weekly } from "../src/data/types";
import { irr, positionFlows, positionRows, returnPct, totalPnl } from "../src/lib/live";
import {
  asOf,
  buildRows,
  defaultPeriod,
  dividendsAsOf,
  endDate,
  inPeriod,
  neededStocks,
  periodOf,
  priceAt,
  quarterClose,
  sharesAt,
  sortRows,
  tEnd,
  withSortedTrades,
  yearLabel,
  yearRange,
  yearSpan,
  type PriceSource,
  type Timeline,
} from "../src/fund/positions";

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(DEMO, p), "utf8")) as T;

/**
 * a ≈ b within `rel` of `scale`. positions.json prints each trade's price to 4 decimals while the
 * pipeline's own sums use the unrounded ones, so figures rebuilt from the trades differ from the
 * published ones by up to ~2e-5 of the dollars invested; the bound here is 1e-4 of that scale.
 * The IRR is rebuilt from the same rounded trades on both sides and must match to 1e-9.
 */
const near = (a: number | null, b: number | null, scale = Math.max(1, Math.abs(b ?? 0)), rel = 1e-4) => {
  if (a === null || b === null) return expect(a).toBe(b);
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * scale);
};

const trade = (q: number, delta: number, px: number, sharesAfter: number): Trade => ({ q, delta, px, low: null, high: null, sharesAfter });
const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  stock_id: 1,
  from_q: 0,
  to_q: null,
  avg_cost: 0,
  avg_exit: null,
  invested: 0,
  realised: 0,
  dividends: 0,
  shares_now: 0,
  cost_now: 0,
  last_q: 0,
  last_type: "new",
  last_pct: null,
  last_usd: 0,
  trades: [],
  ...over,
});

const TL: Timeline = { qmin: 4, latest: 53, asof: "2026-10-30" };

// ---------------------------------------------------------------------------------------
// The as-of accounting at the newest quarter is the published one, for every demo fund.

describe("as-of accounting at the newest quarter reproduces positions.json", () => {
  const funds = readdirSync(resolve(DEMO, "fund")).sort();
  const latestPrices = readJson<LatestPrices>("latest_prices.json");
  const prices = priceMap(latestPrices);
  const nowT = yearsSince2013(latestPrices.asof);

  test("there are demo funds to check", () => expect(funds.length).toBeGreaterThan(5));

  test.each(funds)("fund %s", (id) => {
    const summary = readJson<{ period_q: number; tracked_since_q: number }>(`fund/${id}/summary.json`);
    const rows = positionRows(readJson<Positions>(`fund/${id}/positions.json`));
    const tl: Timeline = { qmin: summary.tracked_since_q, latest: summary.period_q, asof: latestPrices.asof };
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      const price = prices.get(p.stock_id);
      const f = asOf(p, tl.latest, price ?? null, tl.latest);
      near(f.ac, p.avg_cost);
      near(f.ax, p.avg_exit);
      near(f.inv, p.invested);
      near(f.real, p.realised, p.invested);
      near(f.sh, p.shares_now, p.shares_now, 1e-9);
      near(f.cost, p.cost_now, p.invested);
      expect(f.divs).toBe(p.dividends);
      near(f.total, totalPnl(p, price), p.invested);
      near(f.ret, returnPct(p, price), 1);
    }
    // The table's rows over the whole tracked range include every position, so IRR is checked for all.
    const src: PriceSource = { tl, prices, weekly: new Map() };
    const table = buildRows(rows, tl.qmin, tl.latest, src, new Map());
    expect(table.length).toBe(rows.length);
    for (const r of table) {
      const p = r.pos;
      near(r.irr(), irr(positionFlows(p.trades, p.shares_now, prices.get(p.stock_id), nowT)), 1, 1e-9);
      near(r.total, totalPnl(p, prices.get(p.stock_id)), p.invested);
    }
  });
});

// ---------------------------------------------------------------------------------------

describe("periods", () => {
  test("year range and labels: full years, a part year at the end, one at the start", () => {
    expect(yearRange(TL)).toEqual({ lo: 2014, hi: 2026 });
    expect(yearLabel(2025, TL)).toBe("2025");
    expect(yearLabel(2026, TL)).toBe("2026 H1");
    expect(yearLabel(2026, { ...TL, latest: 52 })).toBe("2026 Q1");
    expect(yearLabel(2026, { ...TL, latest: 54 })).toBe("2026 9M");
    expect(yearLabel(2026, { ...TL, latest: 55 })).toBe("2026");
    expect(yearLabel(2014, { ...TL, qmin: 6 })).toBe("2014 H2");
    expect(yearLabel(2014, { ...TL, qmin: 5 })).toBe("2014 Q2–Q4");
    expect(yearLabel(2014, { ...TL, qmin: 7 })).toBe("2014 Q4");
  });

  test("a year's span is clamped to the tracked range", () => {
    expect(yearSpan(2025, TL)).toEqual({ qs: 48, qe: 51 });
    expect(yearSpan(2026, TL)).toEqual({ qs: 52, qe: 53 });
    expect(yearSpan(2014, { ...TL, qmin: 6 })).toEqual({ qs: 6, qe: 7 });
  });

  test("the default period is the newest quarter; the Year view starts on the last full year", () => {
    const d = defaultPeriod(TL);
    expect(d).toEqual({ mode: "quarter", pq: 53, py: 2025, pr: { a: 50, b: 53 } });
    expect(defaultPeriod({ ...TL, latest: 55 }).py).toBe(2026);
    expect(defaultPeriod({ qmin: 52, latest: 53, asof: TL.asof }).pr).toEqual({ a: 52, b: 53 });
    expect(defaultPeriod({ qmin: 52, latest: 53, asof: TL.asof }).py).toBe(2026);
  });

  test("periodOf", () => {
    const d = defaultPeriod(TL);
    expect(periodOf(d, TL)).toEqual({ qs: 53, qe: 53 });
    expect(periodOf({ ...d, mode: "year" }, TL)).toEqual({ qs: 48, qe: 51 });
    expect(periodOf({ ...d, mode: "custom", pr: { a: 40, b: 44 } }, TL)).toEqual({ qs: 40, qe: 44 });
  });

  test("end dates: the latest prices' date for the newest quarter, else the quarter's last day", () => {
    expect(endDate(TL, 53)).toBe("2026-10-30");
    expect(endDate(TL, 52)).toBe("2026-03-31");
    expect(endDate(TL, 51)).toBe("2025-12-31");
    expect(endDate(TL, 4)).toBe("2014-03-31");
    expect(endDate(TL, 7)).toBe("2014-12-31");
    expect(tEnd(TL, 53)).toBeCloseTo(yearsSince2013("2026-10-30"), 12);
    expect(tEnd(TL, 3)).toBeCloseTo(1, 2);
  });
});

describe("trades and prices", () => {
  const t = [trade(4, 100, 10, 100), trade(6, 50, 12, 150), trade(8, -150, 20, 0), trade(10, 40, 15, 40)];

  test("sharesAt follows the shares after the last trade", () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11].map((q) => sharesAt(t, q))).toEqual([0, 100, 100, 150, 150, 0, 0, 40, 40]);
  });

  test("withSortedTrades keeps ordered lists and sorts the others", () => {
    const ok = [row({ trades: t })];
    expect(withSortedTrades(ok)).toBe(ok);
    const sorted = withSortedTrades([row({ trades: [t[1], t[0]] })]);
    expect(sorted[0].trades.map((x) => x.q)).toEqual([4, 6]);
  });

  test("quarterClose: last week ending on or before the quarter's last day, back over gaps", () => {
    // Fridays from 2013-01-04: week i ends 2013-01-04 + 7 i. Q1 2013 ends 2013-03-31: week 12 ends 2013-03-29.
    const close: (number | null)[] = Array.from({ length: 30 }, (_, i) => i + 1);
    const w: Weekly = { start: "2013-01-04", close };
    expect(quarterClose(w, 0)).toBe(13); // week 12 -> close[12]
    close[12] = null;
    close[11] = null;
    expect(quarterClose(w, 0)).toBe(11);
    expect(quarterClose({ start: "2013-01-04", close: [null, null] }, 0)).toBeNull();
    expect(quarterClose({ start: "2014-01-03", close: [5, 6] }, 0)).toBeNull(); // before the first week
    expect(quarterClose(w, 40)).toBe(30); // after the last week: the last close
  });

  test("priceAt: latest price at the newest quarter, weekly close earlier, last trade price as fallback, else null", () => {
    const p = row({ stock_id: 7, trades: t });
    const weekly = new Map<number, Weekly | null>();
    const src: PriceSource = { tl: TL, prices: new Map([[7, 99]]), weekly };
    expect(priceAt(p, 53, src)).toBe(99);
    expect(priceAt(row({ stock_id: 8, trades: t }), 53, src)).toBeNull();
    expect(priceAt(p, 9, src)).toBe(20); // no weekly entry: last trade at or before Q2 2015
    weekly.set(7, null);
    expect(priceAt(p, 9, src)).toBe(20);
    expect(priceAt(p, 3, src)).toBeNull(); // before the first trade
    weekly.set(7, { start: "2013-01-04", close: Array.from({ length: 400 }, () => 33) });
    expect(priceAt(p, 9, src)).toBe(33);
  });
});

describe("asOf", () => {
  // Buy 100 @10, buy 100 @20 (avg 15), sell 50 @30 (realised 750, cost left 1500), sell the rest @10 (realised -250).
  const trades = [trade(4, 100, 10, 100), trade(5, 100, 20, 200), trade(6, -50, 30, 150), trade(7, -150, 10, 0)];
  const p = row({ trades, dividends: 8 });

  test("average-cost accounting at each quarter", () => {
    const q5 = asOf(p, 5, 25, 53);
    expect(q5).toMatchObject({ sh: 200, cost: 3000, real: 0, inv: 3000, ac: 15, ax: null, val: 5000, unreal: 2000 });
    const q6 = asOf(p, 6, 25, 53);
    expect(q6).toMatchObject({ sh: 150, cost: 2250, real: 750, inv: 3000, ax: 30, val: 3750, unreal: 1500 });
    const q7 = asOf(p, 7, 25, 53);
    expect(q7).toMatchObject({ sh: 0, cost: 0, val: 0, unreal: null, ac: 15 });
    expect(q7.real).toBe(750 + (10 - 15) * 150);
    expect(q7.ax).toBeCloseTo((50 * 30 + 150 * 10) / 200, 12);
  });

  test("total = realised + unrealised + dividends, return = total ÷ invested; unpriced = null, never NaN", () => {
    const q6 = asOf(p, 6, 25, 53);
    expect(q6.total).toBeCloseTo(750 + 1500 + dividendsAsOf(p, 6, 53), 9);
    expect(q6.ret).toBeCloseTo(q6.total! / 3000, 12);
    const unpriced = asOf(p, 6, null, 53);
    expect(unpriced).toMatchObject({ val: null, unreal: null, total: null, ret: null, sh: 150 });
    const sold = asOf(p, 7, null, 53); // sold out: the price does not matter
    expect(sold.total).not.toBeNull();
    expect(asOf(p, 3, 25, 53)).toMatchObject({ sh: 0, inv: 0, ac: null, ret: null, total: 0 });
  });

  test("dividends: the exact total at the newest quarter, spread by shares held before", () => {
    // 100 shares held at the end of Q4..Q5 ... the dividends of quarter q are paid on the shares of q-1.
    const d = row({ dividends: 100, trades: [trade(4, 100, 10, 100), trade(8, -100, 10, 0)] });
    expect(dividendsAsOf(d, 53, 53)).toBe(100);
    expect(dividendsAsOf(d, 4, 53)).toBe(0); // bought at the end of Q4: nothing paid yet
    // paid on q=5..8 (4 quarters of the shares of q-1 = 4..7), then none
    expect(dividendsAsOf(d, 6, 53)).toBeCloseTo(50, 9);
    expect(dividendsAsOf(d, 8, 53)).toBeCloseTo(100, 9);
    expect(dividendsAsOf(d, 30, 53)).toBeCloseTo(100, 9);
    expect(dividendsAsOf(row({ trades: [trade(4, 1, 1, 1)] }), 10, 53)).toBe(0);
  });
});

describe("table rows", () => {
  // Three positions in a book priced at 10 / 20 / 50 at the end of quarter 9.
  const a = row({ stock_id: 1, from_q: 4, trades: [trade(4, 100, 10, 100), trade(9, 100, 12, 200)] }); // add in Q9
  const b = row({ stock_id: 2, from_q: 9, trades: [trade(9, 10, 20, 10)] }); // new in Q9
  const c = row({ stock_id: 3, from_q: 4, to_q: 9, trades: [trade(4, 5, 40, 5), trade(9, -5, 60, 0)] }); // sold out in Q9
  const d = row({ stock_id: 4, from_q: 4, trades: [trade(4, 8, 5, 8)] }); // held, untouched
  const e = row({ stock_id: 5, from_q: 12, trades: [trade(12, 8, 5, 8)] }); // not yet bought
  const weekly = new Map<number, Weekly | null>();
  for (const [id, px] of [
    [1, 10],
    [2, 20],
    [3, 50],
    [4, 10],
  ] as const)
    weekly.set(id, { start: "2013-01-04", close: Array(300).fill(px) });
  const src: PriceSource = { tl: TL, prices: new Map(), weekly };
  const stocks = new Map([[1, { ticker: "AAA", name: "Alpha" }]]);
  const all = [a, b, c, d, e];

  test("which positions are in the period, and which weekly files it needs", () => {
    expect(inPeriod(e, 9, 9)).toBeNull();
    expect(inPeriod(d, 9, 9)).toEqual({ a: 8, b: 8 });
    expect(inPeriod(c, 9, 9)).toEqual({ a: 0, b: 5 });
    expect(neededStocks(all, 9, 9, TL)).toEqual([1, 2, 3, 4]);
    expect(neededStocks(all, 53, 53, TL)).toEqual([]); // the newest quarter uses the latest prices
  });

  test("tags, held range, weights and the weight change", () => {
    const rows = buildRows(all, 9, 9, src, stocks);
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect([1, 2, 3, 4].map((i) => by.get(i)!.tag)).toEqual(["add", "new", "exit", null]);
    expect(by.get(1)).toMatchObject({ ticker: "AAA", name: "Alpha", from: 4, to: null, open: true, px: 10, val: 2000 });
    expect(by.get(2)).toMatchObject({ ticker: "#2", name: "", open: true, px: 20, val: 200 });
    expect(by.get(3)).toMatchObject({ open: false, to: 9, val: 0, w: 0, unreal: null });
    // weights among the held: 2000 / 200 / 80
    const tv = 2000 + 200 + 80;
    expect(by.get(1)!.w).toBeCloseTo((2000 / tv) * 100, 9);
    expect(by.get(4)!.w).toBeCloseTo((80 / tv) * 100, 9);
    expect(rows.reduce((s, r) => s + r.w, 0)).toBeCloseTo(100, 9);
    // weight change: before the period the book (at the end prices) was 100*10 + 5*50 + 8*10 = 1330.
    const vb = 1000 + 250 + 80;
    expect(by.get(1)!.dw).toBeCloseTo((2000 / (vb - 1000 + 2000) - 1000 / vb) * 100, 9);
    expect(by.get(2)!.dw).toBeCloseTo((200 / (vb + 200)) * 100, 9);
    expect(by.get(3)!.dw).toBeCloseTo(-(250 / vb) * 100, 9);
    // the weight before, at the end prices: it plus the change is the weight now
    expect(by.get(1)!.wPrev).toBeCloseTo((1000 / vb) * 100, 9);
    expect(by.get(2)!.wPrev).toBe(0);
    expect(by.get(3)!.wPrev).toBeCloseTo((250 / vb) * 100, 9);
      });

  test("a position without a price shows null figures and stays out of the weights", () => {
    const rows = buildRows(
      [a, d],
      9,
      9,
      {
        ...src,
        weekly: new Map([
          [1, null],
          [4, { start: "2013-01-04", close: Array(300).fill(10) }],
        ]),
      },
      stocks,
    );
    const r1 = rows.find((r) => r.id === 1)!;
    expect(r1.px).toBe(12); // falls back to the last trade price
    const noPx = buildRows([row({ stock_id: 9, trades: [] }), d], 9, 9, { tl: TL, prices: new Map(), weekly: new Map() }, new Map());
    expect(noPx.map((r) => r.id)).toEqual([4]);
    const lone = buildRows([d], 53, 53, { tl: TL, prices: new Map(), weekly: new Map() }, new Map())[0];
    expect(lone).toMatchObject({ px: null, val: null, total: null, ret: null, unreal: null, dw: null, w: 0, open: true });
    expect(lone.irr()).toBeNull();
  });

  test("sorting: numbers, text, missing last whichever way, ties by total P&L", () => {
    const rows = buildRows(all, 9, 9, src, stocks);
    const ids = (r: typeof rows) => r.map((x) => x.id);
    expect(ids(sortRows(rows, "w", -1))).toEqual([1, 2, 4, 3]);
    expect(ids(sortRows(rows, "w", 1))).toEqual([3, 4, 2, 1]);
    expect(ids(sortRows(rows, "t", 1))).toEqual(
      [1, 2, 3, 4].sort((x, y) => (rows.find((r) => r.id === x)!.ticker < rows.find((r) => r.id === y)!.ticker ? -1 : 1)),
    );
    // Avg exit: only the sold out one has it shown; open positions sort after it either way
    expect(sortRows(rows, "ax", -1)[0].id).toBe(3);
    expect(sortRows(rows, "ax", 1)[0].id).toBe(3);
    // IRR is computed only when asked for
    expect(sortRows(rows, "irr", -1)).toHaveLength(4);
  });
});
