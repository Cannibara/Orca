import { describe, expect, it } from "vitest";
import type { Summary } from "../src/data/types";
import { buildSeries, spanKpi } from "../src/fund/series";

// Q1 2024 = q 44. 2024 has four quarters; 2025 has two (a part year: H1).
const quarters = { q: [44, 45, 46, 47, 48, 49], ret: [0.02, 0.01, -0.01, 0.03, 0.05, 0.04] };
const yr = (rets: number[]) => rets.reduce((g, r) => g * (1 + r), 1) - 1;
const summary = {
  period_q: 49,
  tracked_since_q: 44,
  quarters,
  years: {
    label: ["2024", "2025 H1"],
    ret: [yr([0.02, 0.01, -0.01, 0.03]), yr([0.05, 0.04])],
    start: [1, 1],
    end: [1, 1],
    gains: [0, 0],
    inflows: [0, 0],
  },
  metrics: {},
} as unknown as Summary;

describe("part years", () => {
  const series = buildSeries(summary);

  it("show the return to date: the quarters compounded, not annualised", () => {
    const p = series.years[1];
    expect(p.part).toBe(true);
    expect(p.ret).toBeCloseTo(yr([0.05, 0.04]) * 100, 9); // 9.2%, not (1.092)^2 − 1
  });

  it("count in the annualised return and growth of the span", () => {
    const k = spanKpi(series, 2024, 2025);
    expect(k.n).toBe(6);
    expect(k.growth).toBeCloseTo(yr(quarters.ret) + 1, 12);
    expect(k.ann).toBeCloseTo((Math.pow(yr(quarters.ret) + 1, 1 / 1.5) - 1) * 100, 9);
  });

  it("count in the years positive tile (both years gained), while the workbook's full-year count stays 1 of 1", () => {
    const k = spanKpi(series, 2024, 2025);
    expect([k.upAll, k.nAll]).toEqual([2, 2]);
    expect([k.up, k.nFull]).toEqual([1, 1]);
  });
});
