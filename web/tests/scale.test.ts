import { barPath, compact, linePath, markerPath, niceTicks } from "../src/charts/scale";

describe("niceTicks", () => {
  test("mixed range uses the mockup's 2.5 step (ruling R2)", () => {
    expect(niceTicks(-3.2, 7.9, 5)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5, 10]);
  });

  test("a symmetric range gives symmetric ticks", () => {
    const t = niceTicks(-5, 5, 5);
    expect(t).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    t.forEach((v, i) => expect(v + t[t.length - 1 - i]).toBeCloseTo(0, 10));
  });

  test("ticks cover the range and step evenly", () => {
    const t = niceTicks(0, 87, 5);
    expect(t[0]).toBeLessThanOrEqual(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(87);
    const step = t[1] - t[0];
    t.forEach((v, i) => i && expect(v - t[i - 1]).toBeCloseTo(step, 9));
    expect(t.length).toBeLessThanOrEqual(7);
  });

  test("a flat range still gives an axis", () => {
    const t = niceTicks(3, 3, 5);
    expect(t.length).toBeGreaterThan(1);
    expect(t[0]).toBeLessThanOrEqual(3);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(3);
  });
});

describe("barPath", () => {
  test("a positive bar rounds only its top corners and starts at the baseline", () => {
    // Screen y grows downwards: the baseline is at 100, the bar tip at 50.
    const d = barPath(10, 20, 100, 50, true);
    expect(d.startsWith("M10,100")).toBe(true);
    expect(d).toBe("M10,100V54Q10,50 14,50H26Q30,50 30,54V100Z");
    expect(d.match(/Q/g)).toHaveLength(2);
  });

  test("a negative bar rounds only its bottom corners", () => {
    expect(barPath(10, 20, 100, 150, true)).toBe("M10,100V146Q10,150 14,150H26Q30,150 30,146V100Z");
  });

  test("the corner radius is capped at 4 px, half the width and the height", () => {
    expect(barPath(0, 6, 100, 50, true)).toContain("Q0,50 3,50"); // w/2 = 3
    expect(barPath(0, 20, 100, 98, true)).toContain("Q0,98 2,98"); // h = 2
    expect(barPath(0, 20, 100, 0, true)).toContain("Q0,0 4,0"); // 4
  });

  test("an unrounded bar has square corners (zero-radius curves)", () => {
    expect(barPath(10, 20, 100, 50, false)).toBe("M10,100V50Q10,50 10,50H30Q30,50 30,50V100Z");
  });

  test("a bar under half a pixel tall draws nothing", () => {
    expect(barPath(0, 10, 100, 99.8, true)).toBe("");
    expect(barPath(0, 10, 100, 100, true)).toBe("");
  });
});

describe("linePath", () => {
  test("one run is one move followed by lines", () => {
    expect(linePath([[0, 10], [5, 20], [10, 15]])).toBe("M0.0,10.0L5.0,20.0L10.0,15.0");
  });

  test("a null starts a new subpath instead of joining across the gap", () => {
    const d = linePath([[0, 1], [1, 2], null, [3, 4], [4, 5]]);
    expect(d).toBe("M0.0,1.0L1.0,2.0M3.0,4.0L4.0,5.0");
    expect(d.match(/M/g)).toHaveLength(2);
  });

  test("an isolated point is a zero-length segment so it still draws a dot", () => {
    expect(linePath([[0, 1], null, [2, 3], null])).toBe("M0.0,1.0h0M2.0,3.0h0");
  });

  test("no points give an empty path", () => {
    expect(linePath([])).toBe("");
    expect(linePath([null, null])).toBe("");
  });
});

describe("compact", () => {
  test("shortens large share counts", () => {
    expect(compact(12_345_678)).toBe("12.35M");
    expect(compact(2_500_000)).toBe("2.5M");
    expect(compact(850_000)).toBe("850K");
    expect(compact(1_200_000_000)).toBe("1.2B");
    expect(compact(0)).toBe("0");
    expect(compact(42)).toBe("42");
  });

  test("rounds up into the next unit instead of printing 1000K", () => {
    expect(compact(999_999)).toBe("1M");
  });

  test("negatives use the real minus sign", () => {
    expect(compact(-2_500)).toBe("−2.5K");
  });
});

describe("markerPath", () => {
  test("a buy points up from just above the price, a sale down from just below it", () => {
    expect(markerPath(100, 50, true)).toBe("M100.0,42.5l5.5,9.3h-11z");
    expect(markerPath(100, 50, false)).toBe("M100.0,57.5l5.5,-9.3h-11z");
  });

  test("its width follows `half`", () => {
    expect(markerPath(0, 0, true, 4)).toBe("M0.0,-6.0l4,6.8h-8z");
  });
});
