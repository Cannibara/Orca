import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { priceMap, stockMap } from "../src/data/api";
import type { LatestPrices, Positions, Securities, Summary, Weekly } from "../src/data/types";
import { positionRows } from "../src/lib/live";
import { buildRows, dividendsAsOf, priceAt, sharesAt, withSortedTrades, type PriceSource, type Timeline } from "../src/fund/positions";
import { holdingReturn } from "../src/fund/treemap";

// The return printed on a tree map tile (and used for its colour) against the owner's four rules, and against the
// Positions table, on every demo fund:
//   shares held before the period: the price at the start of the period against the price at its end;
//   shares bought in the period: the quarter's VWAP (the trade price) against the price at its end;
//   the end price of the newest quarter is today's price, of an older one its last day's close.
// The table's own Return column is the whole life of a position (total P&L over everything invested), so the two
// agree exactly where the position began in the period.

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(DEMO, p), "utf8")) as T;
const latest = readJson<LatestPrices>("latest_prices.json");
const prices = priceMap(latest);
const stocks = stockMap(readJson<Securities>("securities.json"));

/** A stock's quarter-end closes, rising at its own pace, so no two quarters share a price. */
const weeklyFor = (id: number): Weekly => ({
  start: "2013-01-04",
  close: [],
  q0: -60,
  qclose: Array.from({ length: 120 }, (_, i) => (10 + (id % 7)) * (1 + 0.02 * i)),
});

type Period = { qs: number; qe: number };
const periodsOf = (tl: Timeline): Period[] => {
  const out: Period[] = [];
  for (const back of [0, 1, 2, 5]) if (tl.latest - back - 1 >= tl.qmin) out.push({ qs: tl.latest - back, qe: tl.latest - back }); // quarters
  for (const back of [0, 4]) if (tl.latest - back - 4 >= tl.qmin) out.push({ qs: tl.latest - back - 3, qe: tl.latest - back }); // 12 months
  return out;
};

const near = (a: number | null, b: number, what: string) => {
  expect(a, what).not.toBeNull();
  expect(Math.abs((a as number) - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
};

describe("the tile's return follows the four rules and agrees with the Positions table", () => {
  const seen = { fresh: 0, carried: 0, mixed: 0, sold: 0, table: 0 };

  for (let k = 1; k <= 12; k++) {
    const id = 9100000 + k;
    test(`fund ${id}`, () => {
      const summary = readJson<Summary>(`fund/${id}/summary.json`);
      const positions = withSortedTrades(positionRows(readJson<Positions>(`fund/${id}/positions.json`)));
      const tl: Timeline = { qmin: summary.tracked_since_q, latest: summary.period_q, asof: latest.asof };
      const weekly = new Map(positions.map((p) => [p.stock_id, weeklyFor(p.stock_id)] as [number, Weekly]));
      const src: PriceSource = { tl, prices, weekly };

      for (const { qs, qe } of periodsOf(tl)) {
        for (const r of buildRows(positions, qs, qe, src, stocks)) {
          if (!r.open || r.px === null) continue;
          const where = `${r.ticker} ${qs}..${qe}`;
          const p = r.pos;
          const s0 = sharesAt(p.trades, qs - 1);
          const p0 = priceAt(p, qs - 1, src);
          const inPeriod = p.trades.filter((t) => t.q >= qs && t.q <= qe);
          const buys = inPeriod.filter((t) => t.delta > 0);
          const hasSale = inPeriod.some((t) => t.delta < 0);
          const divs = dividendsAsOf(p, qe, tl.latest) - dividendsAsOf(p, qs - 1, tl.latest);
          const ret = holdingReturn(p, qs, qe, p0, r.px, tl);

          // the end price is today's for the newest quarter, that quarter's last close for an older one
          const endPx = qe >= tl.latest ? prices.get(p.stock_id) : weekly.get(p.stock_id)!.qclose![qe + 60];
          expect(r.px, where).toBe(endPx);

          if (!hasSale && (s0 === 0 || p0 !== null)) {
            // rules 1-4, worked as separate lots: shares carried in start → end, shares bought VWAP → end
            const carriedGain = s0 > 0 ? s0 * (r.px - (p0 as number)) : 0;
            const boughtGain = buys.reduce((s, t) => s + t.delta * (r.px! - t.px), 0);
            const capital = (s0 > 0 ? s0 * (p0 as number) : 0) + buys.reduce((s, t) => s + t.delta * t.px, 0);
            if (capital > 0 && qs - 1 >= tl.qmin) {
              near(ret, (carriedGain + boughtGain + divs) / capital, where);
              if (s0 === 0 && buys.length) seen.fresh++;
              else if (s0 > 0 && !buys.length) seen.carried++;
              else if (s0 > 0) seen.mixed++;
            }
          } else if (hasSale && ret !== null) seen.sold++;

          // began in this period: the table's Return (the whole life of the position) is the same figure
          if (ret !== null && p.trades.length > 0 && p.trades.every((t) => t.q >= qs) && r.ret !== null) {
            near(ret, r.ret, `${where} against the table's Return`);
            seen.table++;
          }
        }
      }
    });
  }

  test("every kind of holding was exercised: new, carried, bought on top of a stake, sold from, and compared with the table", () => {
    for (const [kind, n] of Object.entries(seen)) expect(n, kind).toBeGreaterThan(0);
  });
});
