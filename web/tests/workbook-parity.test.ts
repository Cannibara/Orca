// Site vs Excel: the site's own functions, run on the inputs of tests/fixtures/workbook-cases.json
// (12 demo funds and the hand-built edge-case funds), must give the numbers LibreOffice computed
// from the fund workbook for the figures only the site calculates. The fixture is written by
// pipeline/tests/test_workbook_parity.py (ORCA_WRITE_PARITY=1); it is a pytest check that it is fresh.
// Tolerances: 1e-9 relative for money and ratios, 1e-7 for IRR, tags exact. A figure the site cannot
// reproduce would have to be excluded here with a reason (none is today: the two edges known so far, a
// trade in a carried quarter after period_q and flows with two IRR roots, are not in the fixture).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Contrib, Exits, PositionRow, Summary, TradeTuple } from "../src/data/types";
import { aumParts } from "../src/fund/aum";
import { periodRows } from "../src/fund/drive";
import { buildRows, type PriceSource, type Timeline } from "../src/fund/positions";
import { buildSeries, spanKpi } from "../src/fund/series";
import { buildSaleRows } from "../src/fund/whatif";
import { profitablePct, returnPct, totalPnl, unrealised } from "../src/lib/live";

type StockExpected = {
  irr: number | null;
  value_now: number | null;
  unrealised: number | null;
  total: number | null;
  ret: number | null;
  weight: number | null;
  dw: number | null;
  tag: string | null;
  since_sale: number | null;
  missed: number | null;
  irr_held: number | null;
};
type Case = {
  name: string;
  positions: (Omit<PositionRow, "trades"> & { trades: TradeTuple[] })[];
  prices: Record<string, number>;
  asof: string;
  summary: { period_q: number; tracked_since_q: number; quarters: { q: number[]; ret: number[] }; years: Record<string, unknown[]> };
  contrib: Contrib;
  exits: Exits;
  from_year: number | null;
  to_year: number | null;
  expected: {
    stocks: Record<string, StockExpected>;
    profitable: number | null;
    range: Record<string, number | null>;
    aum: Record<string, Record<string, number>>;
    points: Record<string, number>;
  };
};

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/workbook-cases.json");
const cases = (JSON.parse(readFileSync(FILE, "utf8")) as { cases: Case[] }).cases;

const MONEY = 1e-9;
const IRR = 1e-7;

/** What one case compared (floors are asserted so a test cannot pass by comparing nothing). */
const fresh = () => ({ compared: 0, irr: 0, tags: 0, dw: 0, range: 0, aum: 0, profitable: 0, positions: 0 });
let tally = fresh();

/** Records a mismatch (or a one-sided blank) into `bad`; both blank is a match. */
function same(bad: string[], what: string, got: number | null | undefined, want: number | null | undefined, tol = MONEY) {
  const g = got ?? null;
  const w = want ?? null;
  tally.compared++;
  if (g === null && w === null) return;
  if (g === null || w === null) return void bad.push(`${what}: site ${g}, Excel ${w}`);
  // Relative to the Excel value; a tiny absolute floor only when that value is exactly 0.
  const limit = w === 0 ? 1e-12 : tol * Math.abs(w);
  if (!(Math.abs(g - w) <= limit)) bad.push(`${what}: site ${g}, Excel ${w}`);
}

function check(c: Case) {
tally = fresh();
  const bad: string[] = [];
  const positions: PositionRow[] = c.positions.map((p) => ({
    ...p,
    trades: p.trades.map(([q, delta, px, low, high, sharesAfter]) => ({ q, delta, px, low, high, sharesAfter })),
  }));
  const prices = new Map(Object.entries(c.prices).map(([id, px]) => [Number(id), px]));
  const tl: Timeline = { qmin: c.summary.tracked_since_q, latest: c.summary.period_q, asof: c.asof };
  const src: PriceSource = { tl, prices, weekly: new Map() };
  const newest = c.summary.period_q;

  // The positions as of the newest quarter: all of them (figures) and the quarter's own movers (tag, dw).
  const all = new Map(buildRows(positions, 0, newest, src, new Map()).map((r) => [r.id, r]));
  const last = new Map(buildRows(positions, newest, newest, src, new Map()).map((r) => [r.id, r]));
  const sales = new Map(
    buildSaleRows({
      positions,
      exits: c.exits,
      summary: { period_q: newest, tracked_since_q: c.summary.tracked_since_q },
      prices,
      stocks: new Map(),
      asof: c.asof,
    }).map((r) => [r.id, r]),
  );

  for (const pos of positions) {
    const id = pos.stock_id;
    const e = c.expected.stocks[String(id)];
    const at = (what: string, got: number | null | undefined, want: number | null, tol = MONEY) =>
      same(bad, `${c.name} stock ${id} ${what}`, got, want, tol);
    const row = all.get(id);
    const price = prices.get(id);

    at("value now", row ? row.val : null, e.value_now);
    at("unrealised (as of)", row?.open ? row.unreal : unrealised(0, 0, price), e.unrealised);
    at("unrealised (live)", unrealised(pos.shares_now, pos.cost_now, price), e.unrealised);
    at("total P&L (as of)", row ? row.total : null, e.total);
    at("total P&L (live)", totalPnl(pos, price), e.total);
    at("return (as of)", row ? row.ret : null, e.ret);
    at("return (live)", returnPct(pos, price), e.ret);
    at("weight", row ? row.w / 100 : 0, e.weight);
    if (e.irr !== null) tally.irr++;
    at("IRR", row ? row.irr() : null, e.irr, IRR);

    const mover = last.get(id);
    tally.compared++;
    if ((mover?.tag ?? null) !== e.tag) bad.push(`${c.name} stock ${id} tag: site ${mover?.tag ?? null}, Excel ${e.tag}`);
    if (e.tag !== null) {
      tally.tags++;
      if (e.dw !== null) tally.dw++;
      at("weight change", mover?.dw, e.dw);
    }

    const sale = sales.get(id);
    at("since sale", sale?.since, e.since_sale);
    at("missed", sale?.missed, e.missed);
    at("IRR if held", sale ? sale.irrHeld() : null, e.irr_held, IRR);
  }
  tally.profitable = 1;
  same(bad, `${c.name} % profitable`, profitablePct(positions, prices), c.expected.profitable);

  // What drove: the points of every year added up per stock (drive.periodRows).
  const drove = new Map(periodRows(c.contrib, new Map(), c.contrib.years).map((r) => [r.id, r.v]));
  for (const [id, want] of Object.entries(c.expected.points)) same(bad, `${c.name} stock ${id} points`, drove.get(Number(id)) ?? 0, want);

  // The series as summary.json gives it, then the range tiles and the AUM parts.
  const series = buildSeries({
    period_q: newest,
    tracked_since_q: c.summary.tracked_since_q,
    quarters: c.summary.quarters,
    years: c.summary.years,
    metrics: {},
  } as unknown as Summary);
  {
    tally.range = 8;
    const k = spanKpi(series, c.from_year as number, c.to_year as number);
    const x = c.expected.range;
    same(bad, `${c.name} range ann`, k.ann === null ? null : k.ann / 100, x.r_ann);
    same(bad, `${c.name} range growth`, k.growth, x.r_growth);
    same(bad, `${c.name} range years positive`, k.up, x.r_years_pos);
    same(bad, `${c.name} range full years`, k.nFull, x.r_full_years);
    same(bad, `${c.name} range quarters positive`, k.qpos, x.r_qpos);
    same(bad, `${c.name} range max drawdown`, k.mdd / 100, x.r_mdd);
    same(bad, `${c.name} range vol`, k.vol === null ? null : k.vol / 100, x.r_vol);
    same(bad, `${c.name} range quarters`, k.n, x.r_n);
  }
  series.years.forEach((y, i) => {
    tally.aum += 5;
    const p = aumParts(y, i === 0);
    const x = c.expected.aum[String(y.year)];
    same(bad, `${c.name} ${y.year} AUM carried over`, p.c, x.aum_carried);
    same(bad, `${c.name} ${y.year} AUM net inflows`, p.f, x.aum_inflows);
    same(bad, `${c.name} ${y.year} AUM gains`, p.g, x.aum_gains);
    same(bad, `${c.name} ${y.year} AUM losses`, p.loss, x.aum_losses);
    same(bad, `${c.name} ${y.year} AUM outflows`, p.out, x.aum_outflows);
  });

tally.positions = positions.length;
return { bad, tally };
}

describe("site vs Excel (workbook-cases.json)", () => {
  it("has the demo funds and the edge cases", () => {
    expect(cases.filter((c) => c.name.startsWith("demo-")).length).toBe(12);
    expect(cases.filter((c) => c.name.startsWith("edge-")).length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { bad, tally: t } = check(c);
    expect(bad).toEqual([]);
    expect(c.from_year, "the bracket's From year").not.toBeNull();
    expect(c.to_year, "the bracket's To year").not.toBeNull();
    expect(t.positions).toBeGreaterThanOrEqual(1);
    expect(t.range).toBe(8); // the range tiles
    expect(t.aum).toBe(5 * c.summary.years.label.length);
    expect(t.profitable).toBe(1);
  });

  it("compared plenty (the run is not vacuous)", () => {
    const sum = fresh();
    let profitable = 0;
    for (const c of cases) {
      const { tally: t } = check(c);
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k];
      if (c.expected.profitable !== null) profitable++;
    }
    expect(sum.compared).toBeGreaterThan(2000);
    expect(sum.irr).toBeGreaterThan(100);
    expect(sum.tags).toBeGreaterThan(20);
    expect(sum.dw).toBeGreaterThan(20);
    expect(profitable).toBeGreaterThan(20); // % profitable known in nearly every case
    expect(cases.filter((c) => c.name.startsWith("range-")).length).toBe(2);
  });
});
