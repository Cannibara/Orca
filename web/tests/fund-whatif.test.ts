import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { priceMap, stockMap, yearsSince2013 } from "../src/data/api";
import type { Exits, LatestPrices, Positions, Securities, Summary, Weekly } from "../src/data/types";
import { heldFlows, irr, missed, positionFlows, positionRows, returnPct, sinceSale } from "../src/lib/live";
import { buildRows, type PriceSource, type Timeline } from "../src/fund/positions";
import { buildSaleRows, sortSales, tileFigures, weightChangesAt, type LastChange, type SaleKey, type SaleRow } from "../src/fund/whatif";
import { ASOF, NEWEST, exitsOf, pos, pricesOf, sold, stocksTo, summaryOf, trade } from "./fund-whatif-fixtures";

// The pure model of the What-if panel (src/fund/whatif.ts). The panel is tested in fund-whatif-ui.test.tsx.

const build = (over: Partial<Parameters<typeof buildSaleRows>[0]> = {}): SaleRow[] =>
  buildSaleRows({ positions: [], exits: exitsOf([]), summary: summaryOf(), prices: new Map(), stocks: stocksTo(20), asof: ASOF, ...over });

const byId = (rows: SaleRow[], id: number): SaleRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row for stock ${id}`);
  return r;
};

describe("sale figures keep the old rules", () => {
  // missed = sold shares at today's price less what they sold for
  //   S1 +1,000 · S2 +110 · S3 −1,000 · S4 −140 · S5 no price
  const exits = exitsOf([
    { stock_id: 1, sold_shares: 100, sold_usd: 1000 },
    { stock_id: 2, sold_shares: 100, sold_usd: 1000, status: "trimmed" },
    { stock_id: 3, sold_shares: 100, sold_usd: 2000 },
    { stock_id: 4, sold_shares: 50, sold_usd: 1000 },
    { stock_id: 5, sold_shares: 10, sold_usd: 100 },
  ]);
  const prices = pricesOf({ 1: 20, 2: 11.1, 3: 10, 4: 17.2 });
  const rows = build({ exits, prices });

  it("works out $ missed / dodged and since sale from the exits and the latest price", () => {
    expect(rows.map((r) => r.missed)).toEqual([1000, expect.closeTo(110, 9), -1000, expect.closeTo(-140, 9), null]);
    expect(rows.map((r) => r.missed)).toEqual(exits.rows.stock_id.map((id, i) => missed(exits.rows.sold_shares[i], exits.rows.sold_usd[i], prices.get(id))));
    expect(rows.map((r) => r.since)).toEqual(exits.rows.stock_id.map((id, i) => sinceSale(exits.rows.avg_exit[i], prices.get(id))));
    expect(byId(rows, 5).since).toBeNull();
  });

  it("sorts on any column, missing values last either way, ties in the list's order", () => {
    const ids = (key: SaleKey, dir: 1 | -1) => sortSales(rows, key, dir).map((r) => r.id);
    expect(ids("missed", -1)).toEqual([1, 2, 4, 3, 5]);
    expect(ids("missed", 1)).toEqual([3, 4, 2, 1, 5]);
    expect(ids("t", 1)).toEqual([1, 2, 3, 4, 5]);
    expect(ids("t", -1)).toEqual([5, 4, 3, 2, 1]);
    expect(ids("status", 1)).toEqual([1, 3, 4, 5, 2]); // "Sold all" before "Trimmed"
    expect(ids("sh", 1)).toEqual([5, 4, 1, 2, 3]);
    expect(ids("sh", -1)).toEqual([1, 2, 3, 4, 5]);
    expect(ids("since", -1)).toEqual([1, 2, 4, 3, 5]);
    expect(ids("since", 1)).toEqual([3, 4, 2, 1, 5]);
  });

  it("adds up the tiles over every sale", () => {
    expect(tileFigures(rows)).toEqual({ early: expect.closeTo(1110, 9), dodged: expect.closeTo(1140, 9), measured: 0 });
  });

  it("counts a sale as measured only with both returns", () => {
    const r = build({
      exits: exitsOf([
        { stock_id: 1, sold_shares: 10, sold_usd: 100, one_y: 0.3, spy_one_y: 0.1 },
        { stock_id: 2, sold_shares: 10, sold_usd: 100, one_y: 0.3, spy_one_y: null },
        { stock_id: 3, sold_shares: 10, sold_usd: 100 },
      ]),
    });
    expect(tileFigures(r).measured).toBe(1);
  });
});

describe("position figures come from the as-of model at the newest quarter", () => {
  // bought 100 at $10 in q 10 (2015 Q3), sold all at $20 in q 49 (Q2 2025); the stock is $40 now
  const p = sold(1, 1000);
  const rows = build({ positions: [p], exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]), prices: pricesOf({ 1: 40 }) });
  const r = rows[0];

  it("is the Positions table's row, to the digit", () => {
    const tl: Timeline = { qmin: 0, latest: NEWEST, asof: ASOF };
    const src: PriceSource = { tl, prices: pricesOf({ 1: 40 }), weekly: new Map() };
    const [posRow] = buildRows([p], 0, NEWEST, src, stocksTo(20));
    expect(r.base.id).toBe(posRow.id);
    expect(r.ac).toBe(posRow.ac);
    expect(r.ax).toBe(posRow.ax);
    expect(r.px).toBe(posRow.px);
    expect(r.ret).toBe(posRow.ret);
    expect(r.irr()).toBe(posRow.irr());
  });

  it("agrees with the old table's rules (positions.json + lib/live)", () => {
    expect(r.ac).toBeCloseTo(p.avg_cost, 9);
    expect(r.ret).toBeCloseTo(returnPct(p, 40) as number, 12);
    expect(r.ret).toBeCloseTo(1, 12); // 1,000 made on 1,000 in
    expect(r.irr()).toBeCloseTo(irr(positionFlows(p.trades, p.shares_now, 40, yearsSince2013(ASOF))) as number, 12);
    expect(r.irr()).toBeCloseTo(Math.pow(2, 365 / 3562) - 1, 6); // 1,000 -> 2,000 over q 10..49: 2015-08-15 to 2025-05-16 is 3,562 days
    expect(r.irrHeld()).toBeCloseTo(irr(heldFlows(p.trades, 40, yearsSince2013(ASOF))) as number, 12);
    expect(r.irrHeld()).toBeCloseTo(0.1, 1);
  });

  it("dashes (null) what needs a price or a position it does not have", () => {
    const noPrice = build({ positions: [sold(1, 500)], exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]) })[0];
    expect(noPrice.px).toBeNull();
    expect(noPrice.since).toBeNull();
    expect(noPrice.missed).toBeNull();
    expect(noPrice.irrHeld()).toBeNull();
    expect(noPrice.irr()).toBeCloseTo(0.0736, 3); // nothing is held, so the price is not needed
    expect(noPrice.ret).toBeCloseTo(1, 12); // the model reads the trades: 1,000 made on 1,000 in

    const none = build({ exits: exitsOf([{ stock_id: 2, sold_shares: 100, sold_usd: 2000 }]), prices: pricesOf({ 2: 5 }) })[0];
    expect(none.hasPos).toBe(false);
    expect([none.ac, none.ret, none.irr(), none.irrHeld(), none.last]).toEqual([null, null, null, null, null]);
    expect(none.ax).toBeCloseTo(20, 12); // the sale's own average
    expect(none.px).toBe(5);
    expect(none.base.pos.trades).toEqual([]); // a stand-in position for the opened row
  });

  it("names a stock the securities file does not know by its id", () => {
    const row = build({ exits: exitsOf([{ stock_id: 77777, sold_shares: 10, sold_usd: 100 }]), stocks: new Map() })[0];
    expect(row.ticker).toBe("#77777");
    expect(row.name).toBe("");
  });
});

describe("last change", () => {
  const ex = (ids: number[]) => exitsOf(ids.map((stock_id) => ({ stock_id, sold_shares: 10, sold_usd: 100 })));

  it("names the last trade of the position", () => {
    const positions = [
      pos(1, { trades: [trade(10, 100, 10, 100), trade(49, 50, 12, 150)] }), // added
      pos(2, { trades: [trade(10, 100, 10, 100), trade(50, -30, 12, 70)] }), // trimmed
      sold(3, 100), // sold all
      pos(4, { trades: [trade(10, 100, 10, 100), trade(20, -100, 12, 0), trade(30, 40, 9, 40)] }), // bought again after selling out: new
    ];
    const rows = build({ positions, exits: ex([1, 2, 3, 4]), prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
    expect(rows.map((r) => [r.last?.tag, r.last?.q])).toEqual([
      ["add", 49],
      ["trim", 50],
      ["exit", 49],
      ["new", 30],
    ]);
  });

  it("is exactly the Positions table's weight change for a trade in the newest quarter", () => {
    // book at the newest prices: S1 100 sh x 40 = 4,000, S2 50 x 20 = 1,000 (S1 trimmed from 150 in q 53)
    const p1 = pos(1, { trades: [trade(10, 150, 10, 150), trade(NEWEST, -50, 30, 100)] });
    const p2 = pos(2, { trades: [trade(20, 50, 15, 50)] });
    const prices = pricesOf({ 1: 40, 2: 20 });
    const rows = build({ positions: [p1, p2], exits: ex([1]), prices });
    const tl: Timeline = { qmin: 0, latest: NEWEST, asof: ASOF };
    const table = buildRows([p1, p2], NEWEST, NEWEST, { tl, prices, weekly: new Map() }, stocksTo(20)).find((r) => r.id === 1);
    expect(table?.tag).toBe("trim");
    expect(rows[0].last).toEqual({ tag: "trim", q: NEWEST, dw: table?.dw, exact: true });
    // before 6,000 (150 x 40), after 4,000 + 1,000: 4/5 - 6/(5 + 6 - 4) ... = the table's own number
    expect(rows[0].last?.dw).toBeCloseTo((4000 / 5000 - 6000 / 7000) * 100, 9);
  });

  it("estimates an older quarter the Positions table's way, with the last trade prices standing in for the closes", () => {
    // Q2 2025 (q 49): S1 sells its 100 shares at $20; S2 (300 shares, last traded at $10) stays. Book before: 2,000 + 3,000.
    const p1 = sold(1, 1000);
    const p2 = pos(2, { trades: [trade(10, 300, 10, 300)] });
    const rows = build({ positions: [p1, p2], exits: ex([1]), prices: pricesOf({ 1: 40, 2: 10 }) });
    const last = rows[0].last;
    expect(last?.exact).toBe(false);
    expect(last?.dw).toBeCloseTo(-(2000 / 5000) * 100, 9);
    // the table's own formula at that quarter, priced from trades (what it does for a stock with no weekly file)
    const tl: Timeline = { qmin: 0, latest: NEWEST, asof: ASOF };
    const table = buildRows([p1, p2], 49, 49, { tl, prices: pricesOf({ 1: 40, 2: 10 }), weekly: new Map() }, stocksTo(20)).find((r) => r.id === 1);
    expect(last?.dw).toBeCloseTo(table?.dw as number, 9);
    expect(weightChangesAt([p1, p2], new Map([[1, 49]])).get(1)).toBeCloseTo(table?.dw as number, 9);
  });

  it("has no weight change for a stock that was never priced by then", () => {
    expect(weightChangesAt([pos(1, { trades: [trade(10, 100, 10, 100)] })], new Map([[1, 5]])).get(1)).toBeNull();
  });

  it("sorts on the weight change, the unknown last", () => {
    const positions = [
      pos(1, { trades: [trade(10, 100, 10, 100), trade(49, 100, 10, 200)] }), // +
      sold(2, 100), // -
      pos(3, { trades: [trade(10, 100, 10, 100), trade(50, -10, 10, 90)] }), // small -
    ];
    const rows = build({ positions, exits: ex([1, 2, 3, 4]), prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
    expect(sortSales(rows, "last", -1).map((r) => r.id)).toEqual([1, 3, 2, 4]); // S4 has no position
    expect(sortSales(rows, "last", 1).map((r) => r.id)).toEqual([2, 3, 1, 4]);
  });
});

// ---- the demo fund ---------------------------------------------------------------------------

describe("the demo fund", () => {
  const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
  const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;
  const fundId = 9100002;
  const positions = positionRows(demo<Positions>(`fund/${fundId}/positions.json`));
  const exits = demo<Exits>(`fund/${fundId}/exits.json`);
  const summary = demo<Summary>(`fund/${fundId}/summary.json`);
  const latest = demo<LatestPrices>("latest_prices.json");
  const stocks = stockMap(demo<Securities>("securities.json"));
  const prices = priceMap(latest);
  const rows = buildSaleRows({ positions, exits, summary, prices, stocks, asof: latest.asof });

  it("has a row for every sale, each with its position", () => {
    expect(rows).toHaveLength(exits.rows.stock_id.length);
    expect(rows.every((r) => r.hasPos)).toBe(true);
  });

  it("agrees with positions.json and the old rules to the digit", () => {
    const nowT = yearsSince2013(latest.asof);
    for (const r of rows) {
      const p = positions.find((x) => x.stock_id === r.id);
      if (!p) throw new Error("position missing");
      const price = prices.get(r.id);
      expect(r.ac, `${r.ticker} avg cost`).toBeCloseTo(p.avg_cost, 3); // the demo file rounds its averages
      expect(r.ret, `${r.ticker} return`).toBeCloseTo(returnPct(p, price) as number, 4); // the demo file rounds its P&L
      expect(r.irr(), `${r.ticker} irr`).toBeCloseTo(irr(positionFlows(p.trades, p.shares_now, price, nowT)) as number, 4);
      expect(r.irrHeld(), `${r.ticker} irr if held`).toBeCloseTo(irr(heldFlows(p.trades, price, nowT)) as number, 12);
    }
    expect(JSON.stringify(rows.map((r) => [r.ac, r.px, r.ax, r.ret]))).not.toMatch(/NaN|Infinity/);
  });

  it("estimates an older quarter's weight change to within 1.5 points of the Positions table's, which reads every weekly series", () => {
    const weekly = new Map<number, Weekly | null>();
    for (const p of positions) {
      const file = join(DEMO, `stock/${p.stock_id}/weekly.json`);
      weekly.set(p.stock_id, existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Weekly) : null);
    }
    const tl: Timeline = { qmin: summary.tracked_since_q, latest: summary.period_q, asof: latest.asof };
    const olds = rows.filter((r) => r.last && !r.last.exact);
    expect(olds.length).toBeGreaterThan(5);
    let worst = 0;
    for (const r of olds) {
      const q = (r.last as LastChange).q;
      const table = buildRows(positions, q, q, { tl, prices, weekly }, stocks).find((x) => x.id === r.id);
      const gap = Math.abs((r.last?.dw as number) - (table?.dw as number));
      worst = Math.max(worst, gap);
      expect(table?.tag, `${r.ticker} q${q}`).toBe(r.last?.tag);
    }
    expect(worst).toBeLessThan(1.5);
  });

  it("takes the exact weight change for a stock traded in the newest quarter", () => {
    const exact = rows.filter((r) => r.last?.exact);
    expect(exact.length).toBeGreaterThan(0);
    for (const r of exact) expect(r.last?.q).toBe(summary.period_q);
  });
});
