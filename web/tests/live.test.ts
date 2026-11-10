import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { priceMap } from "../src/data/api";
import type { LatestPrices, PositionRow, Positions, Summary, Trade } from "../src/data/types";
import {
  heldFlows,
  irr,
  liveValue,
  missed,
  positionFlows,
  positionRows,
  profitablePct,
  returnPct,
  sinceSale,
  totalPnl,
  tradeMove,
  midQuarterMs,
  tradeYears,
  unrealised,
} from "../src/lib/live";

const trade = (q: number, delta: number, px: number, sharesAfter = 0): Trade => ({
  q,
  delta,
  px,
  low: null,
  high: null,
  sharesAfter,
});

const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  stock_id: 1,
  from_q: 0,
  to_q: null,
  avg_cost: 10,
  avg_exit: null,
  invested: 1000,
  realised: 0,
  dividends: 0,
  shares_now: 0,
  cost_now: 0,
  last_q: 0,
  last_type: "new",
  last_pct: null,
  last_usd: 1000,
  trades: [],
  ...over,
});

test("irr simple", () => expect(irr([[0, -100], [2, 121]])).toBeCloseTo(0.10, 6));
test("irr none without sign change", () => expect(irr([[0, -100], [1, -5]])).toBeNull());

test("irr finds a negative rate", () => expect(irr([[0, -100], [1, 50]])).toBeCloseTo(-0.5, 6));

test("irr is null for no flows, all-zero flows or non-finite flows", () => {
  expect(irr([])).toBeNull();
  expect(irr([[0, 0], [1, 0]])).toBeNull();
  expect(irr([[0, -100], [1, Number.NaN]])).toBeNull();
  expect(irr([[0, -100], [Number.POSITIVE_INFINITY, 120]])).toBeNull();
});

test("irr is null when the root lies outside [-0.99, 10]", () => {
  expect(irr([[0, -1], [1, 1000]])).toBeNull(); // +99,900 %
});

test("missed and dodged", () => {
  expect(missed(150, 2640, 25)).toBe(1110);      // sold too early
  expect(missed(150, 2640, 10)).toBe(-1140);     // dodged
});

test("missed is null without a price", () => expect(missed(150, 2640, undefined)).toBeNull());

test("liveValue skips missing prices", () => {
  expect(liveValue({ stock_id: [1, 2], shares: [10, 5], cost: [0, 0] }, new Map([[1, 3]])))
    .toEqual({ value: 30, missing: 1 });
});

test("liveValue of no holdings", () => {
  expect(liveValue({ stock_id: [], shares: [], cost: [] }, new Map())).toEqual({ value: 0, missing: 0 });
});

test("totalPnl closed position", () => {
  // realised 940 + dividends 125, shares_now 0 -> 1065, whatever the price (even none)
  const r = row({ realised: 940, dividends: 125, shares_now: 0, cost_now: 0 });
  expect(totalPnl(r, undefined)).toBe(1065);
  expect(totalPnl(r, 99)).toBe(1065);
});

test("totalPnl open position adds unrealised; null without a price", () => {
  const r = row({ realised: 100, dividends: 20, shares_now: 10, cost_now: 500 });
  expect(totalPnl(r, 60)).toBe(100 + (10 * 60 - 500) + 20);
  expect(totalPnl(r, undefined)).toBeNull();
});

test("unrealised", () => {
  expect(unrealised(10, 100, 12)).toBe(20);
  expect(unrealised(10, 100, 8)).toBe(-20);
  expect(unrealised(10, 100, undefined)).toBeNull();
});

test("unrealised with sharesNow 0 is 0 whatever the price", () => {
  expect(unrealised(0, 0, undefined)).toBe(0);
  expect(unrealised(0, 0, 55)).toBe(0);
});

test("returnPct is total P&L over invested", () => {
  const closed = row({ invested: 1000, realised: 940, dividends: 125 });
  expect(returnPct(closed, undefined)).toBeCloseTo(1.065, 12);
  const open = row({ invested: 500, shares_now: 10, cost_now: 500 });
  expect(returnPct(open, 60)).toBeCloseTo(0.2, 12); // 100 / 500
});

test("returnPct is null when invested <= 0 or the total is unknown", () => {
  expect(returnPct(row({ invested: 0, realised: 5 }), 1)).toBeNull();
  expect(returnPct(row({ invested: -5, realised: 5 }), 1)).toBeNull();
  expect(returnPct(row({ invested: 500, shares_now: 10, cost_now: 500 }), undefined)).toBeNull();
});

test("sinceSale is the price move from the average exit", () => {
  expect(sinceSale(10, 12)).toBeCloseTo(0.2, 12);
  expect(sinceSale(10, 8)).toBeCloseTo(-0.2, 12);
});

test("sinceSale is null without an exit price or a price", () => {
  expect(sinceSale(null, 12)).toBeNull();
  expect(sinceSale(0, 12)).toBeNull();
  expect(sinceSale(-3, 12)).toBeNull();
  expect(sinceSale(10, undefined)).toBeNull();
});

test("mid-quarter dates follow the workbook's rule", () => {
  const iso = (q: number) => new Date(midQuarterMs(q)).toISOString().slice(0, 10);
  expect([iso(4), iso(5), iso(6), iso(7), iso(12)]).toEqual(["2014-02-14", "2014-05-16", "2014-08-15", "2014-11-15", "2016-02-15"]);
});

test("IRR counts days ÷ 365 like XIRR", () => {
  // buy 100 on 2014-02-14 (q=4), worth 110 on 2015-02-14: exactly 365 days
  const t1 = (Date.UTC(2015, 1, 14) - Date.UTC(2013, 0, 1)) / (365 * 86_400_000);
  expect(irr([[tradeYears(4), -100], [t1, 110]])).toBeCloseTo(0.1, 12);
});

test("tradeMove names a trade from its signed change and the shares left (New / Add / Trim / Exit)", () => {
  expect(tradeMove(trade(4, 100, 10, 100))).toBe("New"); // shares after = the buy: nothing held before
  expect(tradeMove(trade(5, 50, 10, 150))).toBe("Add");
  expect(tradeMove(trade(6, -50, 10, 100))).toBe("Trim");
  expect(tradeMove(trade(7, -100, 10, 0))).toBe("Exit");
  expect(tradeMove(trade(8, 30, 10, 30))).toBe("New"); // bought again after a full exit
});

test("tradeMove tolerates float noise in the share counts", () => {
  expect(tradeMove(trade(4, 1234567.1, 10, 1234567.1 + 1e-7))).toBe("New");
  expect(tradeMove(trade(5, -1234567.1, 10, 1e-7))).toBe("Exit");
  expect(tradeMove(trade(6, -10, 10, 1e-3))).toBe("Trim"); // a real remainder is not an exit
});

// Years of 365 days from 2013-01-01 to a day count (q=0 trades on day 44, q=4 on 409, q=8 on 774: Feb 14).
const yrs = (days: number): number => (days * 86_400_000) / (365 * 86_400_000);

test("positionFlows: trade flow is -delta x px at tradeYears(q), plus the holding at now (R10)", () => {
  const trades = [trade(0, 100, 10, 100), trade(4, -40, 15, 60)];
  expect(positionFlows(trades, 60, 20, 3)).toEqual([
    [yrs(44), -1000], // buy: money out
    [yrs(409), 600], // sale: money in
    [3, 1200], //      terminal: 60 shares x 20 at now
  ]);
});

test("positionFlows: a closed position has no terminal flow and needs no price", () => {
  const trades = [trade(0, 100, 10, 100), trade(8, -100, 12.1, 0)];
  const flows = positionFlows(trades, 0, undefined, 5);
  expect(flows).toEqual([[yrs(44), -1000], [yrs(774), 1210]]);
  expect(irr(flows)).toBeCloseTo(0.1, 6); // 1000 -> 1210 over two years
});

test("positionFlows: an open position with an unknown price has no flows (IRR shows a dash)", () => {
  expect(positionFlows([trade(0, 100, 10, 100)], 100, undefined, 5)).toEqual([]);
});

test("heldFlows: only buys, plus every bought share valued at now (R10)", () => {
  const trades = [trade(0, 100, 10, 100), trade(4, -40, 15, 60), trade(8, 20, 12, 80)];
  expect(heldFlows(trades, 30, 6)).toEqual([
    [yrs(44), -1000],
    [yrs(774), -240],
    [6, 120 * 30], // 100 + 20 bought shares, the sale ignored
  ]);
});

test("heldFlows: no flows when the price is unknown", () => {
  expect(heldFlows([trade(0, 100, 10, 100)], undefined, 5)).toEqual([]);
});

test("heldFlows gives the IRR of never having sold", () => {
  const trades = [trade(0, 100, 10, 100), trade(8, -100, 12.1, 0)];
  const nowT = yrs(44 + 4 * 365);
  // 100 shares bought at 10 and still worth 14 exactly 1,460 days (four 365-day years) later: 1.4 over four years
  expect(irr(heldFlows(trades, 14, nowT))).toBeCloseTo(Math.pow(1.4, 1 / 4) - 1, 6);
});

test("profitablePct is the share of positions with a positive total P&L (R18)", () => {
  const rows = [
    row({ stock_id: 1, realised: 940, dividends: 125 }), //                            closed, +1065
    row({ stock_id: 2, realised: -50, dividends: 10 }), //                             closed, -40
    row({ stock_id: 3, shares_now: 10, cost_now: 500 }), //                            open, +100 at 60
    row({ stock_id: 4, shares_now: 10, cost_now: 500 }), //                            open, no price: not counted
    row({ stock_id: 5, realised: 10, dividends: -10 }), //                             closed, exactly 0: not profitable
  ];
  expect(profitablePct(rows, new Map([[3, 60]]))).toBeCloseTo(2 / 4, 12);
});

test("profitablePct is null when no position has a computable total (R21)", () => {
  expect(profitablePct([], new Map())).toBeNull();
  expect(profitablePct([row({ shares_now: 10, cost_now: 500 })], new Map())).toBeNull();
});

test("positionRows turns the columns into rows and the trade tuples into Trade objects (R22)", () => {
  const p: Positions = {
    stock_id: [1, 2],
    from_q: [0, 3],
    to_q: [null, 5],
    avg_cost: [10, 5],
    avg_exit: [null, 6],
    invested: [1000, 50],
    realised: [0, 10],
    dividends: [0, 1],
    shares_now: [100, 0],
    cost_now: [1000, 0],
    last_q: [0, 5],
    last_type: ["new", "exit"],
    last_pct: [null, null],
    last_usd: [1000, -60],
    trades: [
      [[0, 100, 10, null, null, 100]],
      [[3, 10, 5, 4, 6, 10], [5, -10, 6, 5.5, 6.5, 0]],
    ],
  };
  const rows = positionRows(p);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ stock_id: 1, to_q: null, avg_exit: null, shares_now: 100, last_type: "new" });
  expect(rows[0].trades).toEqual([{ q: 0, delta: 100, px: 10, low: null, high: null, sharesAfter: 100 }]);
  expect(rows[1].trades).toEqual([
    { q: 3, delta: 10, px: 5, low: 4, high: 6, sharesAfter: 10 },
    { q: 5, delta: -10, px: 6, low: 5.5, high: 6.5, sharesAfter: 0 },
  ]);
  expect(rows[1]).toMatchObject({ to_q: 5, avg_exit: 6, last_usd: -60 });
});

// ---- the demo data (matches the contract) ----------------------------------

const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const demo = <T>(path: string): T => JSON.parse(readFileSync(resolve(demoDir, path), "utf8")) as T;

test("positionRows and the live figures on the demo fund", () => {
  const rows = positionRows(demo<Positions>("fund/9100001/positions.json"));
  const summary = demo<Summary>("fund/9100001/summary.json");
  const prices = priceMap(demo<LatestPrices>("latest_prices.json"));
  const nowT = 13.8;

  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.trades.length).toBeGreaterThan(0);
    // the last trade leaves the holding the row reports
    expect(r.trades[r.trades.length - 1].sharesAfter).toBeCloseTo(r.shares_now, 4);
    for (const flows of [positionFlows(r.trades, r.shares_now, prices.get(r.stock_id), nowT), heldFlows(r.trades, prices.get(r.stock_id), nowT)]) {
      const x = irr(flows);
      expect(x === null || Number.isFinite(x)).toBe(true);
    }
    const t = totalPnl(r, prices.get(r.stock_id));
    expect(t === null || Number.isFinite(t)).toBe(true);
  }

  // live value of the holdings and the sum of the open positions' unrealised P&L agree
  const live = liveValue(summary.holdings_now, prices);
  expect(live.missing).toBe(0);
  const cost = summary.holdings_now.cost.reduce((a, b) => a + b, 0);
  const unreal = rows.reduce((a, r) => a + (unrealised(r.shares_now, r.cost_now, prices.get(r.stock_id)) ?? 0), 0);
  expect(live.value - cost).toBeCloseTo(unreal, -2);

  const pp = profitablePct(rows, prices);
  expect(pp).not.toBeNull();
  expect(pp as number).toBeGreaterThanOrEqual(0);
  expect(pp as number).toBeLessThanOrEqual(1);
});
