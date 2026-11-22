import { describe, expect, it } from "vitest";
import type { FundsIndex, SectorScores, Skill, SkillTier, TopRow } from "../src/data/types";
import { betRows, returnTicks, stockRows } from "../src/fund/decisions";
import { mixSeries, rotations, sectorColor } from "../src/fund/mix";
import { isEligible, peersFor, quadrant, rollingPath, shortFund, stackParts, tierWords, yearRows } from "../src/fund/skill";
import { linesLayout, roundMoney, stackedLayout } from "../src/fund/stacked";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

function tier(over: Partial<SkillTier> = {}): SkillTier {
  return {
    irr_fund: 0.1, irr_label: 0.08, irr_mkt: 0.07, irr_spy: 0.075, picking: 0.02, allocation: 0.01, coverage: 1, n: 25,
    quarters: { label: [], v_label: [], v_never: null }, years: { label: [] },
    picks: { stock_id: [], label: [], bought: [], irr_own: [], irr_label: [] },
    bets: { label: [], bought: [], irr: [], irr_mkt: [], mkt_share: [] },
    ...over,
  };
}

function skillOf(n: number, r: { f: number; l: number; m: number }): Skill {
  const q = Array.from({ length: n }, (_, i) => 4 + i); // from Q1 2014
  const arr = (v: number) => q.map(() => v);
  const t = tier({ quarters: { label: arr(r.l), v_label: arr(100), v_never: null }, years: { label: [r.l] } });
  return {
    last_q: q[n - 1], first_q: 4,
    quarters: { q, bought: arr(0), fund: arr(r.f), mkt: arr(r.m), spy: arr(r.m), v_fund: arr(100), v_mkt: arr(100), v_spy: arr(100) },
    years: { name: ["2014"], fund: [r.f], mkt: [r.m], spy: [null] },
    tiers: { "1": t, "2": t, "3": t },
    mix: { q: [], label: [], share: [] },
  };
}

describe("tier words", () => {
  it("say sub-industry, never vertical", () => {
    expect(tierWords(3)).toMatchObject({ noun: "sub-industry", plural: "sub-industries", choice: "Sub-industry choice", stockView: "Stocks vs their sub-industry", betsView: "Sub-industries vs market" });
    expect(tierWords(2).their).toBe("Their industries");
    expect(tierWords(1).picker).toBe("Sector picker");
  });
});

describe("stackParts (the AUM rule)", () => {
  it("stacks every part when all pushed up", () => {
    const s = stackParts({ m: 0.1, alloc: 0.02, pick: 0.03, f: 0.15 });
    expect(s.dir).toBe(1);
    expect(s.solid.map((p) => p.k)).toEqual(["m", "s", "p"]);
    near(s.solid[2].b, 0.15);
    expect(s.boxes).toEqual([]);
  });
  it("takes a negative choice in an up year off the top, drawn above as a box", () => {
    const s = stackParts({ m: 0.12, alloc: -0.02, pick: 0.03, f: 0.13 });
    near(s.solid[s.solid.length - 1].b, 0.13); // the solid bar ends at the fund's return
    expect(s.boxes).toHaveLength(1);
    expect(s.boxes[0]).toMatchObject({ k: "s", sign: -1 });
    near(s.boxes[0].a, 0.13);
    near(s.boxes[0].b, 0.15);
    near(s.gross, 0.15);
  });
  it("draws a down market's choice that softened the fall as a blue box below", () => {
    const s = stackParts({ m: -0.2, alloc: 0.05, pick: 0, f: -0.15 });
    expect(s.dir).toBe(-1);
    expect(s.solid).toEqual([{ k: "m", sign: -1, a: -0, b: expect.closeTo(-0.15, 9) as number }]);
    expect(s.boxes[0]).toMatchObject({ k: "s", sign: 1 });
    near(s.gross, -0.2);
  });
  it("has no solid bar when the year ended flat", () => {
    const s = stackParts({ m: 0.05, alloc: -0.05, pick: 0, f: 0 });
    expect(s.solid).toEqual([]);
    expect(s.boxes.map((b) => b.k)).toEqual(["s"]);
  });
});

describe("years and the map", () => {
  it("splits each year exactly", () => {
    const s = skillOf(4, { f: 0.1, l: 0.07, m: 0.05 });
    const [y] = yearRows(s, 2);
    near(y.m + y.alloc + y.pick, y.f);
    near(y.alloc, 0.02);
    near(y.pick, 0.03);
  });
  it("puts a fund in its corner, with a band too close to call", () => {
    expect(quadrant(0.02, 0.02)).toBe("both");
    expect(quadrant(0.02, 0.005)).toBe("stock");
    expect(quadrant(-0.01, 0.02)).toBe("sector");
    expect(quadrant(0.007, -0.03)).toBe("neither");
  });
  it("draws 3-year windows ending each Q4 and the latest quarter", () => {
    const s = skillOf(14, { f: 0.03, l: 0.02, m: 0.01 }); // Q1 2014 .. Q2 2017
    const p = rollingPath(s, 1);
    expect(p.map((x) => x.q)).toEqual([15, 17]); // Q4 2016 and the latest, Q2 2017
    const ann = (r: number) => Math.pow(1 + r, 4) - 1;
    near(p[0].pick, ann(0.03) - ann(0.02));
    near(p[0].alloc, ann(0.02) - ann(0.01));
  });
  it("needs 3 years, 20 picks and 80% coverage", () => {
    expect(isEligible({ span_q: 12, n: 20, coverage: 0.8 })).toBe(true);
    expect(isEligible({ span_q: 11, n: 20, coverage: 0.8 })).toBe(false);
    expect(isEligible({ span_q: 12, n: 19, coverage: 0.9 })).toBe(false);
  });
  it("finds peers in the fund's famous lists, else funds of a similar size", () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const scores: SectorScores = {
      last_q: 50, fund_id: ids, tier: ids.map(() => 2), picking: ids.map((i) => i / 100), allocation: ids.map(() => 0),
      n: [30, 30, 30, 30, 5, 30], coverage: ids.map(() => 1), span_q: ids.map(() => 20),
    };
    const funds: FundsIndex = { v: 1, id: ids, name: ids.map((i) => `Fund ${i} Capital LP`), book: [100, 90, 80, 70, 60, 1000], n: ids.map(() => 1) };
    const row = (fund_id: number, group: string) => ({ fund_id, group }) as TopRow;
    const famous = [row(1, "Value"), row(2, "Value"), row(3, "Value"), row(4, "Value"), row(5, "Value"), row(1, "Tiger cubs"), row(6, "Tiger cubs")];
    const got = peersFor(1, 2, famous, scores, funds);
    expect(got.similar).toBeNull();
    expect(got.lists.map((l) => l.name)).toEqual(["Value"]); // Tiger cubs has one peer only; fund 5 has 5 picks
    expect(got.lists[0].peers.map((p) => p.fund_id)).toEqual([2, 3, 4]);
    expect(got.lists[0].peers[0].name).toBe("Fund 2 Capital");
    const alone = peersFor(6, 2, famous, scores, funds);
    expect(alone.lists).toEqual([]);
    expect(alone.similar?.map((p) => p.fund_id)).toEqual([1, 2, 3, 4]); // nearest in book first
  });
  it("shortens fund names for the map", () => {
    expect(shortFund("KELPWOOD CAPITAL LP")).toBe("Kelpwood Capital");
    expect(shortFund("Saltglass Advisors, LLC")).toBe("Saltglass Advisors");
  });
});

describe("mix", () => {
  const mix = {
    q: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    label: ["Energy > Oil > Drillers", "Technology > Chips > Memory", "Technology > Software > Cloud", "(Not classified) > (Not classified) > (Not classified)", "Technology > (ETFs) > (ETFs)"],
    share: [
      [0.6, 0.6, 0.6, 0.6, 0.1, 0.1, 0.1, 0.1, 0.1],
      [0.2, 0.2, 0.2, 0.2, 0.5, 0.5, 0.5, 0.5, 0.5],
      [0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3, 0.3],
      [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
      [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
    ],
  };
  it("sums paths to a level, biggest sector first and the neutral row last", () => {
    const s1 = mixSeries(mix, 1);
    expect(s1.bands.map((b) => b.name)).toEqual(["Technology", "Energy", "Not classified"]);
    near(s1.bands[0].shares[0], 0.35);
    const s2 = mixSeries(mix, 2);
    expect(s2.bands.map((b) => b.name)).toEqual(["Chips", "Software", "Technology ETFs", "Oil", "Not classified"]);
    expect(s2.bands[0].shade).toBe(1);
    expect(s2.bands[2].shade).toBeCloseTo(0.38, 9);
    expect(s2.bands[0].trail).toBe("Technology › Chips");
  });
  it("finds the switch from Energy into Technology", () => {
    const r = rotations(mixSeries(mix, 1));
    expect(r).toHaveLength(1);
    expect(r[0].q).toBe(4);
    expect(r[0].text).toBe("Into Technology, out of Energy");
  });
  it("gives each sector its colour token", () => {
    expect(sectorColor("Business Services")).toBe("var(--sec-business-services)");
    expect(sectorColor("Not classified")).toBe("var(--sec-none)");
  });
});

describe("decisions", () => {
  const t = tier({
    picks: { stock_id: [7, 8, null], label: ["Tech > Chips", "Energy > Oil", null], bought: [60, 30, 10], irr_own: [0.2, 0.05, 0.1], irr_label: [0.1, 0.1, 0.1] },
    bets: { label: ["Tech", "Energy", "Utilities"], bought: [60, 40, 0], irr: [0.15, 0.05, null], irr_mkt: [0.1, 0.1, null], mkt_share: [0.3, 0.05, 0.03] },
  });
  const stocks = new Map([
    [7, { ticker: "NVDA", name: "Nvidia" }],
    [8, { ticker: "XOM", name: "Exxon" }],
  ]);
  it("ranks stocks by what they added, the rest last", () => {
    const d = stockRows(t, stocks);
    expect(d.rows.map((r) => r.lab)).toEqual(["NVDA", "XOM", "All other picks"]);
    near(d.rows[0].adds!, 0.6 * 0.1);
    near(d.rows[1].adds!, 0.3 * -0.05);
    expect(d.rows[0].sub).toBe("Nvidia · Chips");
    near(d.adds, 0.06 - 0.015);
    expect(d.bought).toBe(100);
  });
  it("lists every sector at tier 1, unbought ones last and faded", () => {
    const d = betRows(t, 1);
    expect(d.rows.map((r) => [r.lab, r.skipped])).toEqual([["Tech", false], ["Energy", false], ["Utilities", true]]);
    near(d.rows[0].adds!, 0.6 * 0.05);
    expect(d.rows[2].adds).toBe(0);
    expect(d.rows[0].sub).toBe("market holds 30%");
    expect(betRows(t, 2).rows).toHaveLength(2);
  });
  it("ticks the return axis every 5 or 10 points", () => {
    const k = returnTicks(stockRows(t, stocks).rows);
    expect(k.step).toBe(0.05);
    expect(k.lo).toBeCloseTo(0, 9);
    expect(k.hi).toBeCloseTo(0.2, 9);
  });
});

describe("stacked layout", () => {
  const w = tierWords(2);
  const rows = [
    { name: "2014", part: false, m: 0.1, alloc: 0.02, pick: 0.03, f: 0.15, spy: 0.12 },
    { name: "2015", part: false, m: -0.2, alloc: 0.05, pick: -0.01, f: -0.16, spy: -0.18 },
    { name: "2016 H1", part: true, m: 0.05, alloc: -0.01, pick: 0.01, f: 0.05, spy: 0.04 },
  ];
  it("draws parts by sign, labels each bar with the fund and says the cushion when there is one", () => {
    const L = stackedLayout(rows, 880, w);
    expect(L.labels.map((l) => l.text)).toEqual(["+15.0%", "−16.0%", "+5.0%"]);
    expect(L.segs.filter((s) => s.i === 0).map((s) => s.cls)).toEqual(["mkt", "sel", "stk"]);
    expect(L.cushion).toBe(true);
    expect(L.hits[1].label).toBe("2015: whole market −20.0%, industry choice +5.0 pts, stock choice −1.0 pts, fund −16.0%");
    for (const l of L.labels) expect(l.y).toBeLessThan(L.H - 34);
  });
  it("draws every line at once with its end value apart from the others", () => {
    const s = skillOf(9, { f: 0.03, l: 0.02, m: 0.01 });
    s.quarters.v_fund = s.quarters.v_fund.map((_, i) => 100 + i);
    s.quarters.v_spy = s.quarters.v_spy.map(() => null);
    const L = linesLayout(s, 2, 880, w);
    expect(L.lines.map((l) => l.name)).toEqual(["Their stocks", "Their industries", "Whole market", "S&P 500"]);
    expect(L.lines[3].d).toBe("");
    const ys = L.ends.map((e) => e.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(15);
    expect(roundMoney(2_438_100_000)).toBe(2_400_000_000);
  });
});
