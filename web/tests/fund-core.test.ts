import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Summary } from "../src/data/types";
import * as fmt from "../src/fund/fmt";
import {
  endRound,
  endRoundH,
  monoW,
  niceTicks,
  overlap,
  r2,
  slots,
  stepFor,
  textW,
  xLabelItems,
  xLabels,
} from "../src/fund/geometry";
import { nearestEdge } from "../src/fund/PeriodStrip";
import {
  buildSeries,
  cagrOf,
  defaultYearLabel,
  lastFullLabel,
  returnYears,
  spanKpi,
  spanName,
  spanYears,
  windowYears,
  yearDetail,
  type Series,
  type YearPoint,
} from "../src/fund/series";

const here = dirname(fileURLToPath(import.meta.url));
const demo: Summary = JSON.parse(
  readFileSync(resolve(here, "../public/demo-data/fund/9100002/summary.json"), "utf8"),
);

// ---------------------------------------------------------------------- fmt

describe("fmt", () => {
  test("signed percentages use a real minus and no sign on zero", () => {
    expect(fmt.fPct(-16.71)).toBe("−16.7%");
    expect(fmt.fPct(5)).toBe("+5.0%");
    expect(fmt.fPct(0.04)).toBe("0.0%");
    expect(fmt.fPct(-0.04)).toBe("0.0%");
    expect(fmt.f1(12.34)).toBe("+12.3");
    expect(fmt.sgn(-1)).toBe("−");
    expect(fmt.sgn(0)).toBe("+");
    expect(fmt.fShort(12.6)).toBe("+13");
    expect(fmt.fShort(-0.4)).toBe("0");
    expect(fmt.fShort(-7.2)).toBe("−7");
  });

  test("percentage points keep their decimals and drop the sign on zero", () => {
    expect(fmt.fPP(2.04)).toBe("+2.0");
    expect(fmt.fPP(-2.04, 2)).toBe("−2.04");
    expect(fmt.fPP(-0.004)).toBe("0.0");
    expect(fmt.fPP(0, 2)).toBe("0.00");
  });

  test("axis labels", () => {
    expect(fmt.axisPct(0)).toBe("0%");
    expect(fmt.axisPct(-20)).toBe("−20%");
    expect(fmt.axisPct(30)).toBe("+30%");
    expect(fmt.axisPP(0)).toBe("0");
    expect(fmt.axisPP(-5)).toBe("−5");
    expect(fmt.axisMoney(0)).toBe("$0");
    expect(fmt.axisMoney(5e8)).toBe("$500M");
    expect(fmt.axisMoney(2e9)).toBe("$2B");
    expect(fmt.axisMoney(1e10)).toBe("$10B");
    expect(fmt.axisMoney(2.5e9)).toBe("$2.5B");
    expect(fmt.axisMoney(0.1 * 3 * 1e9)).toBe("$300M"); // float noise of tick multiples
    expect(fmt.axisMoney(-1e9)).toBe("−$1B");
    expect(fmt.axisMoney(250e3)).toBe("$250K");
  });

  test("years and quarters", () => {
    expect(fmt.shortYear("2019")).toBe("’19");
    expect(fmt.shortYear("2026 H1")).toBe("’26 H1");
    expect(fmt.qShort(53)).toBe("Q2 ’26");
    expect(fmt.qShort(0)).toBe("Q1 ’13");
    expect(fmt.qShort(7)).toBe("Q4 ’14");
    expect(fmt.qLabelFull(53)).toBe("Q2 2026");
    expect(fmt.fmtLong("2026-10-30")).toBe("30 Oct 2026");
    expect(fmt.fmtLong("2026-07-01")).toBe("1 Jul 2026");
    expect(fmt.fYrs(2.5)).toBe("2.5");
    expect(fmt.fYrs(3)).toBe("3");
    expect(fmt.fYrs(12.25)).toBe("12.3");
  });

  test("money, in dollars", () => {
    expect(fmt.fMm(2968000000)).toBe("$2,968m");
    expect(fmt.fMm(-12e6, true)).toBe("−$12m");
    expect(fmt.fMm(3e6, true)).toBe("+$3m");
    expect(fmt.fMm(400000)).toBe("$0m");
    expect(fmt.fMm(null)).toBe("–");
    expect(fmt.fM(2968000000)).toBe("$2.97B");
    expect(fmt.fM(340e6)).toBe("$340M");
    expect(fmt.fM(12.34e6)).toBe("$12.3M");
    expect(fmt.fM(85000)).toBe("$85K");
    expect(fmt.fM(-1.5e9, true)).toBe("−$1.50B");
    expect(fmt.fM(2.5e6, true)).toBe("+$2.5M");
    expect(fmt.fM(null)).toBe("–");
    expect(fmt.fMoney(11141121260)).toBe("$11.1B");
    expect(fmt.fMoney(3.4e8)).toBe("$340M");
    expect(fmt.fMoneySigned(1.23e9)).toBe("+$1.23B");
    expect(fmt.fMoneySigned(-3.4e8)).toBe("−$340M");
    expect(fmt.fMoneySigned(0)).toBe("$0");
  });

  test("position figures", () => {
    expect(fmt.fP0(0.234)).toBe("+23%");
    expect(fmt.fP0(-1.5)).toBe("−150%");
    expect(fmt.fP0(null)).toBe("–");
    expect(fmt.fPc1(1.26)).toBe("+1.3%");
    expect(fmt.fPc1(-4)).toBe("−4.0%");
    expect(fmt.fPc1(null)).toBe("–");
    expect(fmt.fPx(1234.5)).toBe("$1,235");
    expect(fmt.fPx(null)).toBe("–");
    expect(fmt.fW0(0.3)).toBe("<1%");
    expect(fmt.fW0(0)).toBe("0%");
    expect(fmt.fW0(12.4)).toBe("12%");
  });
});

// ----------------------------------------------------------------- geometry

describe("geometry", () => {
  test("text width estimates", () => {
    expect(textW("+12.3%", 12)).toBeCloseTo((0.54 + 0.6 + 0.6 + 0.275 + 0.6 + 0.79) * 12, 9);
    expect(textW("", 12)).toBe(0);
    expect(monoW("AAPL", 10)).toBeCloseTo(24, 9);
  });

  test("overlap, rounding, ticks", () => {
    const a = { x0: 0, x1: 10, y0: 0, y1: 10 };
    expect(overlap(a, { x0: 11, x1: 20, y0: 0, y1: 10 }, 0)).toBe(false);
    expect(overlap(a, { x0: 11, x1: 20, y0: 0, y1: 10 }, 2)).toBe(true);
    expect(overlap(a, { x0: 5, x1: 20, y0: 20, y1: 30 }, 2)).toBe(false);
    expect(r2(1.2345)).toBe(1.23);
    expect(niceTicks(-21, 30, 6)).toEqual([-30, -20, -10, 0, 10, 20, 30]);
  });

  test("bars with a rounded data end", () => {
    expect(endRound(10, 20, 100, 50, 3)).toBe("M10,100V53Q10,50 13,50H27Q30,50 30,53V100Z");
    expect(endRound(10, 20, 100, 150, 3)).toBe("M10,100V147Q10,150 13,150H27Q30,150 30,147V100Z");
    // under 0.6 px of rounding left, a plain rectangle
    expect(endRound(0, 10, 5, 5.4, 3)).toBe("M0,5V5.4H10V5Z");
    expect(endRoundH(10, 20, 0, 100, 3)).toBe("M0,10H97Q100,10 100,13V27Q100,30 97,30H0Z");
    expect(endRoundH(10, 20, 100, 0, 3)).toBe("M100,10H3Q0,10 0,13V27Q0,30 3,30H100Z");
  });

  test("stepFor staggers neighbours, capped at 40 ms", () => {
    expect(stepFor(1)).toBe(0);
    expect(stepFor(2)).toBe(40);
    expect(stepFor(16)).toBe(30);
  });

  test("slots: the axis shows from 520 px and the bar is at most 40 wide", () => {
    const wide = slots(600, 12, 46);
    expect(wide.axis).toBe(true);
    expect(wide.ml).toBe(46);
    expect(wide.iw).toBe(550);
    expect(wide.band).toBeCloseTo(550 / 12, 9);
    expect(wide.bw).toBe(40 > wide.band * 0.8 ? wide.band * 0.8 : 40);
    expect(wide.cx(0)).toBeCloseTo(46 + wide.band / 2, 9);
    const narrow = slots(400, 13, 46);
    expect(narrow.axis).toBe(false);
    expect(narrow.ml).toBe(4);
    expect(narrow.cx(12)).toBeCloseTo(4 + narrow.band * 12.5, 9);
    expect(slots(1100, 3, 46).bw).toBe(40);
    expect(slots(300, 100, 46).bw).toBe(3);
  });

  test("xLabels shows every label when they fit", () => {
    const cats = ["2019", "2020", "2021"];
    const C = xLabels(cats, slots(600, 3, 46), 1);
    expect(C.labels).toEqual(cats);
    expect(C.show).toEqual([true, true, true]);
    expect(C.count).toBe(3);
  });

  test("xLabels falls back to short years when the full ones collide", () => {
    const cats = Array.from({ length: 8 }, (_, i) => String(2015 + i));
    const G = { band: 26, cx: (i: number) => 13 + 26 * i };
    const C = xLabels(cats, G, -1);
    expect(C.labels[0]).toBe("’15");
    expect(C.count).toBe(8);
  });

  test("xLabels thins out, keeping the selected, last and first labels", () => {
    const cats = [...Array.from({ length: 24 }, (_, i) => String(2002 + i)), "2026 H1"];
    const G = slots(300, cats.length, 46);
    const C = xLabels(cats, G, 10);
    expect(C.count).toBeLessThan(cats.length);
    expect(C.count).toBe(C.show.filter(Boolean).length);
    expect(C.show[10]).toBe(true);
    expect(C.show[cats.length - 1]).toBe(true);
    expect(C.show[0]).toBe(true);
  });

  test("xLabelItems gives the selected label a pill, at the artifact's positions", () => {
    const cats = ["2019", "2020", "2021"];
    const G = slots(600, 3, 46);
    const items = xLabelItems(xLabels(cats, G, 1), G, 1, 340);
    expect(items.map((i) => i.text)).toEqual(cats);
    expect(items.every((i) => i.y === 329)).toBe(true);
    expect(items[0].pill).toBeNull();
    const pill = items[1].pill!;
    expect(items[1].selected).toBe(true);
    expect(pill.y).toBe(315);
    expect(pill.h).toBe(20);
    expect(pill.w).toBeCloseTo(textW("2020", 12) + 12, 1);
    expect(pill.x + pill.w / 2).toBeCloseTo(items[1].x, 1);
    // hidden labels are left out
    const crowded = slots(280, 25, 46);
    const cs = Array.from({ length: 25 }, (_, i) => String(2002 + i));
    const C = xLabels(cs, crowded, -1);
    expect(xLabelItems(C, crowded, -1, 300)).toHaveLength(C.count);
  });
});

// ------------------------------------------------------------------- series

describe("series on the demo fund", () => {
  const series = buildSeries(demo);

  test("part years are found from the quarters, not the labels", () => {
    expect(series.years).toHaveLength(13);
    expect(series.years.filter((y) => y.part).map((y) => y.year)).toEqual([2014, 2026]);
    expect(series.years[0].label).toBe("2014");
    expect(series.years[12].label).toBe("2026 H1");
    expect(series.years.map((y) => y.qCount)).toEqual([3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2]);

    // 2015 loses a quarter's return: it becomes a part year whatever its label says
    const cut: Summary = JSON.parse(JSON.stringify(demo));
    cut.quarters.ret[cut.quarters.q.indexOf(10)] = null;
    const s2 = buildSeries(cut);
    expect(s2.years[1].label).toBe("2015");
    expect(s2.years[1].part).toBe(true);
    expect(s2.years[1].qCount).toBe(3);
  });

  test("years carry percent returns and dollar amounts from the summary", () => {
    const y = series.years[0];
    expect(y.ret).toBeCloseTo(-20.850155788096547, 9);
    expect(y.start).toBe(0);
    expect(y.end).toBeCloseTo(1495416830.7383652, 3);
    expect(y.gains).toBeCloseTo(-383790370.7002416, 3);
    expect(y.inflows).toBeCloseTo(1879207201.4386067, 3);
    expect(series.periodQ).toBe(53);
    expect(series.trackedSinceQ).toBe(4);
    expect(series.metrics).toBe(demo.metrics);
  });

  test("quarters keep only the ones with a return, in order", () => {
    expect(series.quarters).toHaveLength(49);
    expect(series.quarters[0].q).toBe(5);
    expect(series.quarters.at(-1)!.q).toBe(53);
    expect(series.quarters.map((p) => p.q)).toEqual([...series.quarters.map((p) => p.q)].sort((a, b) => a - b));
  });

  test("windowYears: 15 years or everything", () => {
    const w15 = windowYears(series, "15");
    expect(w15.years).toHaveLength(13);
    expect(w15.offset).toBe(0);
    expect(w15.total).toBe(13);
    expect(windowYears(series, "max").years).toHaveLength(13);

    const long: Series = {
      ...series,
      years: Array.from({ length: 20 }, (_, i) => ({ ...series.years[1], year: 2000 + i, label: String(2000 + i) })),
    };
    const a = windowYears(long, "15");
    expect(a.years).toHaveLength(15);
    expect(a.offset).toBe(5);
    expect(a.total).toBe(20);
    expect(a.years[0].label).toBe("2005");
    const m = windowYears(long, "max");
    expect(m.years).toHaveLength(20);
    expect(m.offset).toBe(0);
  });

  test("returnYears drops years without a return", () => {
    const years: YearPoint[] = [
      { ...series.years[1], ret: null },
      { ...series.years[2] },
    ];
    expect(returnYears({ years })).toEqual([years[1]]);
  });

  test("the default year is the latest full year", () => {
    expect(lastFullLabel(series.years)).toBe("2025");
    expect(defaultYearLabel(demo)).toBe("2025");
    expect(lastFullLabel(series.years.filter((y) => y.part))).toBe("2026 H1");
    expect(lastFullLabel([])).toBe("");
  });

  test("spanKpi over the whole range reproduces the pipeline's metrics", () => {
    const k = spanKpi(series, 2014, 2026);
    const m = demo.metrics;
    expect(k.n).toBe(49);
    expect(k.quarterly).toBe(true);
    expect(Math.abs(k.ann! / 100 - m.ann_return!)).toBeLessThan(1e-9);
    expect(Math.abs(k.vol! / 100 - m.vol!)).toBeLessThan(1e-9);
    expect(Math.abs(k.mdd / 100 - m.max_dd!)).toBeLessThan(1e-9);
    expect(Math.abs(k.qpos! - m.quarters_pos_pct!)).toBeLessThan(1e-9);
    expect(k.nFull).toBe(m.years_total);
    expect(k.up).toBe(m.years_pos);
    expect(k.idx).toHaveLength(50);
    expect(k.dd).toHaveLength(50);
    expect(k.idx[0]).toBe(1);
    expect(k.idx.at(-1)).toBeCloseTo(k.growth, 12);
  });

  test("spanKpi of one full year is that year's return", () => {
    const k = spanKpi(series, 2022, 2022);
    expect(k.n).toBe(4);
    expect(k.ann).toBeCloseTo(series.years.find((y) => y.year === 2022)!.ret!, 9);
    expect(k.nFull).toBe(1);
    expect(k.up).toBe(0);
    expect(k.vol).not.toBeNull();
  });

  test("spanKpi under four quarters has no annualised figures", () => {
    const k = spanKpi(series, 2026, 2026);
    expect(k.n).toBe(2);
    expect(k.ann).toBeNull();
    expect(k.vol).toBeNull();
    expect(k.qpos).toBe(0);
    expect(k.nFull).toBe(0);
    expect(k.mdd).toBeCloseTo(series.years[12].ret!, 6); // both quarters fell, so the drawdown is the whole return
    expect(cagrOf(series, 2026, 2026)).toBe(0);
    const none = spanKpi(series, 1990, 1991);
    expect(none.n).toBe(0);
    expect(none.qpos).toBeNull();
    expect(none.mdd).toBe(0);
  });

  test("span length and name", () => {
    expect(spanYears(series, 2014, 2026)).toBe(49 / 4);
    expect(spanYears(series, 2022, 2022)).toBe(1);
    expect(cagrOf(series, 2015, 2025)).toBeGreaterThan(-100);
    expect(spanName("2019", "2019")).toBe("2019");
    expect(spanName("2015", "2019")).toBe("2015 to 2019");
  });

  test("yearDetail: the quarters of 2014 compound to the year", () => {
    const d = yearDetail(series, 2014);
    expect(d.qs.map((p) => "Q" + ((p.q % 4) + 1) + " " + fmt.fPct(p.ret * 100))).toEqual([
      "Q2 +1.8%",
      "Q3 −13.7%",
      "Q4 −10.0%",
    ]);
    const compounded = d.qs.reduce((g, p) => g * (1 + p.ret), 1) - 1;
    expect(fmt.fPct(compounded * 100)).toBe("−20.9%");
    expect(d.vol).toBeNull(); // three quarters
    expect(d.mdd).toBeCloseTo(-22.26, 1); // from the Q2 high to the Q4 low
  });

  test("yearDetail: a full year has volatility, an empty one nothing", () => {
    const d = yearDetail(series, 2022);
    expect(d.qs).toHaveLength(4);
    const r = d.qs.map((p) => p.ret);
    const mean = r.reduce((a, b) => a + b, 0) / 4;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / 3);
    expect(d.vol).toBeCloseTo(sd * 200, 9);
    expect(d.mdd).toBeLessThan(0);
    const none = yearDetail(series, 1999);
    expect(none.qs).toEqual([]);
    expect(none.mdd).toBe(0);
    expect(none.vol).toBeNull();
  });
});

// ------------------------------------------------------------- nearestEdge

describe("nearestEdge", () => {
  test("a slot outside the period moves the nearer outer edge", () => {
    expect(nearestEdge(2, 6, 0)).toEqual({ a: 0, b: 6 });
    expect(nearestEdge(2, 6, 9)).toEqual({ a: 2, b: 9 });
  });
  test("a slot inside moves the nearer edge, the start on a tie", () => {
    expect(nearestEdge(2, 6, 3)).toEqual({ a: 3, b: 6 });
    expect(nearestEdge(2, 6, 5)).toEqual({ a: 2, b: 5 });
    expect(nearestEdge(2, 6, 4)).toEqual({ a: 4, b: 6 }); // tie -> start
  });
  test("on an edge it changes nothing", () => {
    expect(nearestEdge(2, 6, 2)).toEqual({ a: 2, b: 6 });
    expect(nearestEdge(2, 6, 6)).toEqual({ a: 2, b: 6 });
    expect(nearestEdge(3, 3, 3)).toEqual({ a: 3, b: 3 });
  });
});

const { fMoney1 } = fmt;
describe("fMoney1", () => {
  test("one decimal in billions like the artifact, adaptive below a billion", () => {
    expect(fMoney1(1.5e9)).toBe("$1.5B");
    expect(fMoney1(11141121260)).toBe("$11.1B");
    expect(fMoney1(-2.04e9)).toBe("−$2.0B");
    expect(fMoney1(3.4e8)).toBe("$340M");
  });
});
