import { describe, expect, it } from "vitest";
import type { Landscape } from "../src/data/types";
import type { Measure } from "../src/fund/treemap";
import { HEAD, MIN_AREA, ROOT, buildTree, fitHead, fitTile, layoutMap, pathTo, type LNode } from "../src/home/landscape";

const per = <T,>(xs: T[]) => ({ "1y": xs, "3y": xs, "5y": xs, "10y": xs, "15y": xs, max: xs });

/** Two hedge styles, an ETF provider, a big type with a rest, and a type with no filer. */
function file(): Landscape {
  return {
    latest_q: 54,
    n_filers: 1006,
    total: 0,
    types: {
      key: ["hedge", "hedge.macro", "hedge.quant", "am", "am.etf", "am.wealth", "bank", "family"],
      label: ["Hedge funds", "Macro", "Quant", "Asset managers", "ETF providers", "Wealth managers", "Banks", "Family offices"],
      parent: [null, "hedge", "hedge", null, "am", "am", null, null],
    },
    funds: {
      fund_id: [1, 2, 3, 4, 5, 6],
      name: ["BRIDGEWATER ASSOCIATES, LP", "CITADEL ADVISORS LLC", "BLACKROCK, INC.", "TINY WEALTH LLC", "BIG WEALTH LLC", "JPMORGAN CHASE & CO"],
      book: [2e9, 1.7e9, 6600e9, 1e8, 400e9, 1700e9],
      type: ["hedge.macro", "hedge.quant", "am.etf", "am.wealth", "am.wealth", "bank"],
      ret: { ...per([0.1, 0.2, 0.12, null, 0.08, 0.15]), "10y": [0.05, null, null, null, null, null] },
    },
    rest: { type: ["am.wealth"], n: [1000], book: [5000e9], ret: per([0.06]), covered: per([0.5]) },
  };
}

const keys = (ns: LNode[]) => ns.map((n) => n.key);
const charMeasure: Measure = (font, s) => s.length * (font === "n" ? 6 : 7);

describe("buildTree", () => {
  it("nests types, filers and the rest, largest first, and leaves out a type with no filer", () => {
    const root = buildTree(file(), "1y");
    expect(root.key).toBe(`t:${ROOT}`);
    expect(keys(root.children)).toEqual(["t:am", "t:bank", "t:hedge"]); // no Family offices
    const am = root.children[0];
    expect(keys(am.children)).toEqual(["t:am.etf", "t:am.wealth"]);
    expect(keys(am.children[1].children)).toEqual(["r:am.wealth", "f:5", "f:4"]);
    expect(root.n).toBe(1006 - 1000 + 1000); // 6 listed + the rest's 1,000
    expect(root.value).toBeCloseTo(6600e9 + 1e8 + 400e9 + 5000e9 + 1700e9 + 3.7e9);
  });

  it("gives a type the book-weighted return of those with one, and a filer its short name", () => {
    const root = buildTree(file(), "1y");
    const wealth = pathTo(root, "am.wealth").at(-1)!;
    // 400e9 at 8% and the rest's covered half (2,500e9) at 6%; the tiny filer has none
    expect(wealth.ret).toBeCloseTo((400e9 * 0.08 + 2500e9 * 0.06) / 2900e9);
    expect(wealth.covered).toBeCloseTo(2900e9);
    const hedge = pathTo(root, "hedge").at(-1)!;
    expect(hedge.children.flatMap((c) => c.children).map((f) => f.label)).toContain("Bridgewater");
    // another period: only Bridgewater has a 10-year record
    expect(pathTo(buildTree(file(), "10y"), "hedge").at(-1)!.ret).toBeCloseTo(0.05);
  });

  it("finds the path to a type for the breadcrumb, and the root for an unknown one", () => {
    const root = buildTree(file(), "1y");
    expect(pathTo(root, "hedge.macro").map((n) => n.label)).toEqual(["All 13F filers", "Hedge funds", "Macro"]);
    expect(pathTo(root, "family")).toEqual([root]);
  });
});

describe("layoutMap", () => {
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("draws a heading per group and its tiles below it, in the box, none overlapping", () => {
    const tiles = layoutMap(buildTree(file(), "1y"), 1100, 620);
    for (const t of tiles) {
      expect(t.rect.x).toBeGreaterThanOrEqual(0);
      expect(t.rect.y).toBeGreaterThanOrEqual(0);
      expect(t.rect.x + t.rect.w).toBeLessThanOrEqual(1100);
      expect(t.rect.y + t.rect.h).toBeLessThanOrEqual(620);
    }
    const drawn = tiles.filter((t) => t.rect.w > 0 && t.rect.h > 0);
    for (let i = 0; i < drawn.length; i++)
      for (let j = i + 1; j < drawn.length; j++) expect(overlap(drawn[i].rect, drawn[j].rect)).toBe(false);
    const heads = tiles.filter((t) => t.role === "head");
    expect(heads.map((t) => t.node.type)).toEqual(expect.arrayContaining(["am", "am.etf", "am.wealth", "bank"]));
    for (const h of heads) expect(h.rect.h).toBe(HEAD);
    expect(tiles.find((t) => t.node.key === "f:3")?.role).toBe("fund"); // BlackRock
  });

  it("draws a group too small to open as one tile, and merges filers too small to draw into the rest", () => {
    const tiles = layoutMap(buildTree(file(), "1y"), 1100, 620);
    // Hedge funds hold $3.7B of ~$13.7T: too little room for a heading and tiles
    expect(tiles.find((t) => t.node.type === "hedge")?.role).toBe("box");
    expect(tiles.some((t) => t.node.key === "f:4")).toBe(false); // 100m: under MIN_AREA
    const rest = tiles.find((t) => t.role === "rest" && t.node.type === "am.wealth")!;
    expect(rest.node.n).toBe(1001);
    expect(rest.node.others?.map((o) => o.key)).toEqual(["f:4"]);
    expect(rest.rect.w * rest.rect.h).toBeGreaterThan(MIN_AREA);
  });

  it("zoomed into a group, shows its filers with the room it has", () => {
    const hedge = pathTo(buildTree(file(), "1y"), "hedge").at(-1)!;
    const tiles = layoutMap(hedge, 1100, 620);
    expect(tiles.filter((t) => t.role === "head").map((t) => t.node.type).sort()).toEqual(["hedge.macro", "hedge.quant"]);
    expect(tiles.filter((t) => t.role === "fund").map((t) => t.node.key).sort()).toEqual(["f:1", "f:2"]);
  });

  it("draws nothing in no room", () => {
    expect(layoutMap(buildTree(file(), "1y"), 0, 620)).toEqual([]);
  });
});

describe("labels", () => {
  it("puts the name first, then the value and return, as many as fit", () => {
    expect(fitTile("Citadel", 170e9, 0.2, 200, 60, charMeasure)).toEqual({ tk: "Citadel", w: "$170B · +20.0%", n: null, v: null });
    expect(fitTile("Citadel", 170e9, 0.2, 80, 60, charMeasure).w).toBe("$170B");
    expect(fitTile("Citadel", 170e9, null, 200, 60, charMeasure).w).toBe("$170B");
    expect(fitTile("Citadel", 170e9, 0.2, 200, 30, charMeasure)).toEqual({ tk: "Citadel", w: null, n: null, v: "$170B · +20.0%" });
    expect(fitTile("Citadel", 170e9, 0.2, 200, 20, charMeasure).tk).toBeNull();
    expect(fitTile("A long fund name", 1e9, 0.1, 60, 60, charMeasure).tk).toMatch(/…$/);
    expect(fitTile(["1,234 others", "1,234"], 1e9, 0.1, 60, 60, charMeasure).tk).toBe("1,234");
  });

  it("puts a heading's book at its right end when both fit", () => {
    expect(fitHead("Hedge funds", 4.2e12, 300, charMeasure)).toEqual({ tk: "Hedge funds", w: null, n: null, v: "$4.2T" });
    expect(fitHead("Hedge funds", 4.2e12, 100, charMeasure).v).toBeNull();
  });
});
