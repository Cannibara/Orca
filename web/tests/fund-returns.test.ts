import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Summary } from "../src/data/types";
import { growthSpark, sizeSpark, tickSpark, underwaterSpark } from "../src/fund/KpiStrip";
import { bestWorst, colLayout, dragBracket, idxAtX, keyBracket } from "../src/fund/returnsLayout";
import { buildSeries, returnYears, windowYears } from "../src/fund/series";

const here = dirname(fileURLToPath(import.meta.url));
const demo: Summary = JSON.parse(readFileSync(resolve(here, "../public/demo-data/fund/9100002/summary.json"), "utf8"));

const series = buildSeries(demo);
const ry = returnYears(windowYears(series, "15"));
const vals = ry.map((y) => y.ret as number);
const part = ry.map((y) => y.part);

describe("bestWorst", () => {
  test("picks the best and the worst full year, never a part year", () => {
    // 2014 (-20.9%) and 2026 H1 (-16.7%) are part years; the worst full year is 2022
    const { bestI, worstI } = bestWorst(vals, part);
    expect(ry[bestI].label).toBe("2019");
    expect(ry[worstI].label).toBe("2022");
  });

  test("the first of equals wins, and no full year gives -1", () => {
    expect(bestWorst([5, 5, -3, -3], [false, false, false, false])).toEqual({ bestI: 0, worstI: 2 });
    expect(bestWorst([5, 1], [true, true])).toEqual({ bestI: -1, worstI: -1 });
  });
});

describe("colLayout", () => {
  test("wide chart: full labels on every bar, room for the bracket, ticks around zero", () => {
    const L = colLayout(1150, vals, part, 11, true);
    expect(L.form).toBe("full");
    expect(L.rot).toBe(false);
    expect(L.txt[5]).toBe("+30.2%");
    expect(L.shown).toBe(13);
    expect(L.H).toBe(364);
    expect(L.ticks[0]).toBe(-30);
    expect(L.ticks[L.ticks.length - 1]).toBe(40);
    expect(L.Y(0)).toBeGreaterThan(L.Y(40));
    expect(L.Y(0)).toBeLessThan(L.Y(-30));
  });

  test("phone width: whole-percent labels, shorter chart, no y axis", () => {
    const L = colLayout(344, vals, part, 11, true);
    expect(L.form).toBe("short");
    expect(L.rot).toBe(false);
    expect(L.txt[5]).toBe("+30");
    expect(L.H).toBe(324);
    expect(L.G.axis).toBe(false);
    expect(L.shown).toBe(13);
  });

  test("a long history on a phone turns the labels on their side", () => {
    const many = [...vals, ...vals];
    const L = colLayout(344, many, [...part, ...part], 11, true);
    expect(L.rot).toBe(true);
    expect(L.show[11]).toBe(true);
    expect(L.txt[5]).toBe("+30");
    expect(L.size).toBe(10);
  });

  test("a label that would sit on a neighbouring bar is never shown", () => {
    const many = [...vals, ...vals];
    const L = colLayout(344, many, [...part, ...part], 0, true);
    L.show.forEach((shown, i) => {
      if (!shown) return;
      L.bars.forEach((bar, j) => {
        if (j === i) return;
        const b = L.boxes[i];
        const touches = b.x0 < bar.x1 + 1 && b.x1 + 1 > bar.x0 && b.y0 < bar.y1 + 1 && b.y1 + 1 > bar.y0;
        expect(touches).toBe(false);
      });
    });
  });

  test("no bracket: no extra height and no room above the bars", () => {
    const withBr = colLayout(1150, vals, part, -1, true);
    const without = colLayout(1150, vals, part, -1, false);
    expect(withBr.H - without.H).toBe(24);
    expect(withBr.mt - without.mt).toBe(44);
  });
});

describe("bracket geometry", () => {
  const G = { ml: 46, band: 80 };

  test("idxAtX maps a page x to a bar, clamped to the chart", () => {
    expect(idxAtX(46 + 80 * 3 + 40, 0, 1100, 1100, G, 13)).toBe(3);
    expect(idxAtX(10, 0, 1100, 1100, G, 13)).toBe(0);
    expect(idxAtX(5000, 0, 1100, 1100, G, 13)).toBe(12);
    // the svg drawn at half size: page pixels count double
    expect(idxAtX((46 + 80 * 3 + 40) / 2, 0, 550, 1100, G, 13)).toBe(3);
    // the svg offset on the page
    expect(idxAtX(200 + 46 + 80 * 5 + 40, 200, 1100, 1100, G, 13)).toBe(5);
  });

  test("dragging an end keeps at least one bar between the ends", () => {
    expect(dragBracket("a", 2, 9, 2, 4, 13)).toEqual({ a: 4, b: 9 });
    expect(dragBracket("a", 2, 9, 2, 12, 13)).toEqual({ a: 8, b: 9 });
    expect(dragBracket("b", 2, 9, 9, 6, 13)).toEqual({ a: 2, b: 6 });
    expect(dragBracket("b", 2, 9, 9, 0, 13)).toEqual({ a: 2, b: 3 });
  });

  test("dragging the bar moves both ends by the pointer's travel and stops at the edges", () => {
    expect(dragBracket("move", 2, 9, 5, 7, 13)).toEqual({ a: 4, b: 11 });
    expect(dragBracket("move", 2, 9, 5, 12, 13)).toEqual({ a: 5, b: 12 });
    expect(dragBracket("move", 2, 9, 5, 0, 13)).toEqual({ a: 0, b: 7 });
  });

  test("arrow keys move one end, shift moves both", () => {
    expect(keyBracket("a", 2, 9, 1, false, 13)).toEqual({ a: 3, b: 9 });
    expect(keyBracket("a", 8, 9, 1, false, 13)).toEqual({ a: 8, b: 9 });
    expect(keyBracket("a", 0, 9, -1, false, 13)).toEqual({ a: 0, b: 9 });
    expect(keyBracket("b", 2, 9, -1, false, 13)).toEqual({ a: 2, b: 8 });
    expect(keyBracket("b", 2, 3, -1, false, 13)).toEqual({ a: 2, b: 3 });
    expect(keyBracket("b", 2, 12, 1, false, 13)).toEqual({ a: 2, b: 12 });
    expect(keyBracket("a", 2, 9, 1, true, 13)).toEqual({ a: 3, b: 10 });
    expect(keyBracket("b", 5, 12, 1, true, 13)).toEqual({ a: 5, b: 12 });
  });
});

describe("tile sparklines", () => {
  test("growth line starts on the 1.00 rule and ends on a dot", () => {
    const g = growthSpark([1, 1.1, 0.9, 1.2]);
    expect(g.d.startsWith("M2.0,")).toBe(true);
    expect(g.last[0]).toBeCloseTo(80, 5);
    // a flat index does not divide by zero
    expect(Number.isFinite(growthSpark([1]).zy)).toBe(true);
  });

  test("win/loss ticks: gains above the middle line, losses below, narrower gaps from 15 years", () => {
    const t = tickSpark([5, -2, 0]);
    expect(t.ticks.map((x) => x.gain)).toEqual([true, false, false]);
    expect(t.ticks[0].y).toBe(t.mid - 11);
    expect(t.ticks[1].y).toBe(t.mid + 1);
    const step = (n: number) => {
      const k = tickSpark(Array(n).fill(1)).ticks;
      return k[1].x - k[0].x;
    };
    expect(step(3)).toBeCloseTo((84 - 2 * 2) / 3 + 2, 5); // a 2 px gap
    expect(step(15)).toBeCloseTo((84 - 14) / 15 + 1, 5); // a 1 px gap
    expect(tickSpark([]).ticks).toEqual([]);
  });

  test("underwater area hangs from the top rule and closes on it", () => {
    const u = underwaterSpark([0, -0.1, -0.3, -0.1, 0]);
    expect(u.area.endsWith(",3Z")).toBe(true);
    expect(u.line.startsWith("M2.0,3.0")).toBe(true);
    // no drawdown at all: still a path
    expect(underwaterSpark([0, 0]).line).toContain("L");
  });

  test("size bars: the biggest move is the dark one and a tiny move keeps a visible height", () => {
    const s = sizeSpark([10, -30, 0]);
    expect(s.map((r) => r.hi)).toEqual([false, true, false]);
    expect(s[2].h).toBe(1.5);
    expect(s[1].h).toBeCloseTo(26, 5);
  });
});
