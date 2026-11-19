import type { PositionRow, Trade } from "../src/data/types";
import { dividendsAsOf, type Timeline } from "../src/fund/positions";
import {
  contrast,
  ellipsize,
  groupTiles,
  heldSince,
  holdingReturn,
  inkFor,
  labelSet,
  layout,
  neighbour,
  parseColor,
  priceChange,
  returnColor,
  squarify,
  type Measure,
  type Rect,
  type RGB,
} from "../src/fund/treemap";

const trade = (q: number, delta: number, px: number, sharesAfter: number): Trade => ({ q, delta, px, low: null, high: null, sharesAfter });
const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  stock_id: 1,
  from_q: 0,
  to_q: null,
  avg_cost: 0,
  avg_exit: null,
  invested: 0,
  realised: 0,
  dividends: 0,
  shares_now: 0,
  cost_now: 0,
  last_q: 0,
  last_type: "new",
  last_pct: null,
  last_usd: 0,
  trades: [],
  ...over,
});
const TL: Timeline = { qmin: 4, latest: 53, asof: "2026-10-30" };

const area = (r: Rect) => r.w * r.h;
const close = (a: Rect, b: Rect, d = 1e-9) => {
  for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(d);
};

// ---- layout ---------------------------------------------------------------------------------

describe("squarify", () => {
  test("one value fills the rectangle", () => {
    expect(squarify([5], { x: 0, y: 0, w: 300, h: 200 })).toEqual([{ x: 0, y: 0, w: 300, h: 200 }]);
  });

  test("Bruls, Huizing and van Wijk's example (aspect ratio 1): 6, 6, 4, 3, 2, 2, 1 in a 6 x 4 box", () => {
    const r = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 }, 1);
    const want: Rect[] = [
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 3, h: 2 },
      { x: 3, y: 0, w: 12 / 7, h: 7 / 3 },
      { x: 3 + 12 / 7, y: 0, w: 9 / 7, h: 7 / 3 },
      { x: 3, y: 7 / 3, w: 1.2, h: 5 / 3 },
      { x: 4.2, y: 7 / 3, w: 1.2, h: 5 / 3 },
      { x: 5.4, y: 7 / 3, w: 0.6, h: 5 / 3 },
    ];
    expect(r).toHaveLength(want.length);
    r.forEach((x, i) => close(x, want[i]));
  });

  test("two equal values in a 2:1 box (the golden ratio d3 uses) are two squares side by side", () => {
    const r = squarify([1, 1], { x: 0, y: 0, w: 200, h: 100 });
    close(r[0], { x: 0, y: 0, w: 100, h: 100 });
    close(r[1], { x: 100, y: 0, w: 100, h: 100 });
  });

  test("every area is in proportion to its value, inside the box, and no two tiles overlap", () => {
    const values = [40, 22, 13, 9, 6, 4.5, 3, 1.2, 0.8, 0.5];
    const box = { x: 10, y: 20, w: 640, h: 440 };
    const r = squarify(values, box);
    const sum = values.reduce((a, b) => a + b, 0);
    r.forEach((t, i) => {
      expect(area(t)).toBeCloseTo((values[i] / sum) * box.w * box.h, 6);
      expect(t.x).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(t.y).toBeGreaterThanOrEqual(box.y - 1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(box.x + box.w + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    });
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i];
        const b = r[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox <= 1e-9 || oy <= 1e-9, `${i} and ${j} overlap`).toBe(true);
      }
  });

  test("no values, no tiles", () => {
    expect(squarify([], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe("layout: gaps and whole pixels", () => {
  test("a 2px gap between tiles, none at the edges, edges on whole pixels", () => {
    expect(layout([1, 1], 200, 100)).toEqual([
      { x: 0, y: 0, w: 99, h: 100 },
      { x: 101, y: 0, w: 99, h: 100 },
    ]);
  });

  test("a bigger set stays inside the box on whole pixels, the gaps at least 2px", () => {
    const r = layout([40, 22, 13, 9, 6, 4.5, 3, 1.2], 641, 440);
    for (const t of r) {
      for (const k of ["x", "y", "w", "h"] as const) expect(Number.isInteger(t[k])).toBe(true);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(641);
      expect(t.y + t.h).toBeLessThanOrEqual(440);
    }
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i];
        const b = r[j];
        const gx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const gy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        expect(Math.max(gx, gy), `${i} and ${j}`).toBeGreaterThanOrEqual(2);
      }
    // the outer tiles touch the box's edges
    expect(Math.min(...r.map((t) => t.x))).toBe(0);
    expect(Math.max(...r.map((t) => t.x + t.w))).toBe(641);
  });
});

describe("groupTiles: holdings under 1% go into one Other stocks tile", () => {
  const items = [
    { k: "A", v: 500 },
    { k: "B", v: 300 },
    { k: "C", v: 182 },
    { k: "D", v: 9 },
    { k: "E", v: 6 },
    { k: "F", v: 3 },
    { k: "G", v: 0 },
  ];
  const g = groupTiles(items, (x) => x.v, (x) => x.k);

  test("largest first, Other stocks last, with the small ones' value, weight and count", () => {
    expect(g.tiles.map((t) => t.key)).toEqual(["A", "B", "C", "__other"]);
    expect(g.total).toBe(1000);
    expect(g.nSmall).toBe(3);
    const other = g.tiles[3];
    expect(other.item).toBeNull();
    expect(other.others.map((x) => x.k)).toEqual(["D", "E", "F"]);
    expect(other.value).toBe(18);
    expect(other.weight).toBeCloseTo(0.018, 12);
    expect(g.tiles[0].weight).toBe(0.5);
  });

  test("a single small holding is shown as itself", () => {
    const one = groupTiles(items.slice(0, 4), (x) => x.v, (x) => x.k);
    expect(one.tiles.map((t) => t.key)).toEqual(["A", "B", "C", "D"]);
    expect(one.nSmall).toBe(0);
  });

  test("nothing held, nothing to draw", () => {
    expect(groupTiles([], (x: { v: number }) => x.v, () => "x")).toEqual({ tiles: [], total: 0, nSmall: 0 });
  });
});

// ---- the colour: the fund's return on the holding over the period ---------------------------

describe("holdingReturn", () => {
  test("held throughout: the change in value", () => {
    const p = row({ trades: [trade(10, 100, 9, 100)] });
    expect(holdingReturn(p, 20, 20, 10, 12, TL)).toBeCloseTo(0.2, 12);
  });

  test("a buy in the period counts at its price: (end − start − buys) ÷ (start + buys)", () => {
    const p = row({ trades: [trade(10, 100, 9, 100), trade(20, 50, 11, 150)] });
    expect(holdingReturn(p, 20, 20, 10, 12, TL)).toBeCloseTo((1800 - 1000 - 550) / 1550, 12);
  });

  test("a sale in the period counts at its price", () => {
    const p = row({ trades: [trade(10, 100, 9, 100), trade(20, -40, 15, 60)] });
    expect(holdingReturn(p, 20, 20, 10, 12, TL)).toBeCloseTo((720 + 600 - 1000) / 1000, 12);
  });

  test("a new position: no start value, its cost is the buys", () => {
    const p = row({ trades: [trade(20, 100, 10, 100)] });
    expect(holdingReturn(p, 20, 20, null, 12, TL)).toBeCloseTo(0.2, 12);
  });

  test("dividends received in the period are added", () => {
    const p = row({ dividends: 80, trades: [trade(10, 100, 9, 100)] });
    const divs = dividendsAsOf(p, 53, 53) - dividendsAsOf(p, 52, 53);
    expect(divs).toBeGreaterThan(0);
    expect(holdingReturn(p, 53, 53, 10, 12, TL)).toBeCloseTo((1200 + divs - 1000) / 1000, 12);
  });

  test("12 months: trades over the four quarters qe − 3 .. qe", () => {
    const p = row({ trades: [trade(10, 100, 9, 100), trade(17, 100, 11, 200), trade(19, -50, 14, 150), trade(21, 10, 99, 160)] });
    // period Q17..Q20: start 100 @ 10 at the end of Q16; buy 100 @ 11; sell 50 @ 14; the Q21 buy is after it
    expect(holdingReturn(p, 17, 20, 10, 12, TL)).toBeCloseTo((150 * 12 + 700 - 1000 - 1100) / 2100, 12);
  });

  test("null when a needed price is missing, the period starts before the record, or nothing was put in", () => {
    const p = row({ trades: [trade(10, 100, 9, 100)] });
    expect(holdingReturn(p, 20, 20, null, 12, TL)).toBeNull(); // held at the start, no start price
    expect(holdingReturn(p, 20, 20, 10, null, TL)).toBeNull(); // no end price
    expect(holdingReturn(row({ trades: [trade(4, 100, 9, 100)] }), 4, 4, 9, 12, TL)).toBeNull(); // Q4 is the first tracked quarter
    expect(holdingReturn(row({ trades: [trade(4, 100, 9, 100)] }), 2, 5, 9, 12, TL)).toBeNull(); // 12 months from before the record
    expect(holdingReturn(row({ trades: [] }), 20, 20, 10, 12, TL)).toBeNull();
    expect(holdingReturn(p, 20, 20, 0, 12, TL)).toBeNull(); // a start worth nothing
  });
});

describe("heldSince and the share price change", () => {
  const t = [trade(4, 100, 10, 100), trade(8, -100, 20, 0), trade(10, 40, 15, 40), trade(12, 10, 15, 50)];
  test("the quarter the current holding began: after a sell-out, the buy back", () => {
    expect(heldSince(t, 6)).toBe(4);
    expect(heldSince(t, 9)).toBeNull();
    expect(heldSince(t, 13)).toBe(10);
  });
  test("price change, null without both prices", () => {
    expect(priceChange(10, 12)).toBeCloseTo(0.2, 12);
    expect(priceChange(null, 12)).toBeNull();
    expect(priceChange(0, 12)).toBeNull();
    expect(priceChange(10, null)).toBeNull();
  });
});

describe("colour scale", () => {
  const S = {
    gain: parseColor("#00875F")!,
    gainLo: parseColor("#C4ECDC")!,
    loss: parseColor("#D60F25")!,
    lossLo: parseColor("#FBCDD1")!,
  };

  test("parses hex and rgb() colours", () => {
    expect(parseColor("#00A47C")).toEqual([0, 164, 124]);
    expect(parseColor(" #abc ")).toEqual([170, 187, 204]);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseColor("")).toBeNull();
  });

  test("pale green at 0%, the poles at the clamp, and nothing beyond it", () => {
    expect(returnColor(0, 0.25, S)).toEqual(S.gainLo);
    expect(returnColor(-0.0001, 0.25, S)).not.toEqual(S.gainLo); // a loss is red however small
    expect(returnColor(0.25, 0.25, S)).toEqual(S.gain);
    expect(returnColor(-0.25, 0.25, S)).toEqual(S.loss);
    expect(returnColor(0.9, 0.25, S)).toEqual(S.gain);
    expect(returnColor(-3, 0.5, S)).toEqual(S.loss);
    expect(returnColor(0.25, 0.5, S)).not.toEqual(S.gain); // ±50% for 12 months
  });

  test("every return is green or red, deeper the bigger it is (Lab steps, not RGB)", () => {
    const g = (r: number) => returnColor(r, 0.25, S);
    const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const greenish = (c: RGB) => c[1] > c[0];
    const reddish = (c: RGB) => c[0] > c[1];
    for (const r of [0.001, 0.02, 0.1, 0.3]) expect(greenish(g(r))).toBe(true);
    for (const r of [-0.001, -0.02, -0.1, -0.3]) expect(reddish(g(r))).toBe(true);
    expect(dist(g(0.1), S.gainLo)).toBeGreaterThan(dist(g(0.02), S.gainLo));
    expect(dist(g(0.2), S.gain)).toBeLessThan(dist(g(0.1), S.gain));
  });
});

describe("label ink", () => {
  const ink: RGB = [27, 25, 22];
  const surface: RGB = [255, 252, 248];
  test("WCAG contrast", () => {
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 6);
    expect(contrast([0, 0, 0], [0, 0, 0])).toBe(1);
  });
  test("the text token with more contrast; pure black or white where neither reaches 4.5:1; always at least 4.5:1", () => {
    expect(inkFor([240, 240, 240], ink, surface).ink).toEqual(ink);
    expect(inkFor([20, 30, 40], ink, surface).ink).toEqual(surface);
    for (let v = 0; v <= 255; v += 5) {
      for (const fill of [[v, v, v], [0, v, 124], [247, v, 46]] as RGB[]) {
        expect(contrast(fill, inkFor(fill, ink, surface).ink), String(fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // a mid-tone where the dark token falls short: pure black instead
    const midFill: RGB = [125, 125, 125];
    expect(contrast(midFill, ink)).toBeLessThan(4.5);
    expect(contrast(midFill, surface)).toBeLessThan(4.5);
    expect([[0, 0, 0], [255, 255, 255]]).toContainEqual(inkFor(midFill, ink, surface).ink);
  });
});

// ---- labels ---------------------------------------------------------------------------------

describe("labelSet: only what fits", () => {
  const measure: Measure = (_f, s) => s.length * 7; // 7px a character, whatever the font
  const stock = { other: false, ticker: "AAPL", name: "Apple Computer Holdings", weight: 0.123, value: 80.2e9, count: 0 };

  test("a tiny tile has no label", () => {
    expect(labelSet(stock, 200, 23, measure)).toEqual({ tk: null, w: null, n: null });
    expect(labelSet(stock, 20, 100, measure)).toEqual({ tk: null, w: null, n: null });
  });
  test("a short tile: the ticker only; a ticker too wide: nothing", () => {
    expect(labelSet(stock, 60, 30, measure)).toEqual({ tk: "AAPL", w: null, n: null });
    expect(labelSet(stock, 38, 60, measure)).toEqual({ tk: null, w: null, n: null }); // 28px of ticker in 24px
  });
  test("then the weight; from 96 x 54 the value and the name, ellipsised", () => {
    expect(labelSet(stock, 80, 45, measure)).toEqual({ tk: "AAPL", w: "12.3%", n: null });
    expect(labelSet(stock, 95, 60, measure)).toEqual({ tk: "AAPL", w: "12.3%", n: null });
    const big = labelSet(stock, 140, 60, measure);
    expect(big.w).toBe("12.3% · $80.2B");
    expect(big.n).toBe("Apple Computer Ho…"); // 126px of room: 17 characters and the ellipsis
    expect(labelSet(stock, 300, 60, measure).n).toBe("Apple Computer Holdings");
  });
  test("Other stocks: its name, then the count and weight", () => {
    const other = { other: true, ticker: "", name: "", weight: 0.098, value: 1e9, count: 16 };
    expect(labelSet(other, 200, 60, measure)).toEqual({ tk: "Other stocks", w: "16 stocks · 9.8%", n: null });
    expect(labelSet(other, 70, 45, measure)).toEqual({ tk: "Other", w: "9.8%", n: null });
  });
  test("ellipsize keeps at least four characters, else nothing", () => {
    expect(ellipsize("n", "Microsoft", 7 * 9, measure)).toBe("Microsoft");
    expect(ellipsize("n", "Microsoft", 7 * 6, measure)).toBe("Micro…");
    expect(ellipsize("n", "Microsoft", 7 * 4, measure)).toBeNull();
  });
});

// ---- keyboard -------------------------------------------------------------------------------

describe("neighbour: arrow keys move to the tile in that direction", () => {
  // A on the left, full height; B top right (taller); C bottom right
  const rects: Rect[] = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 102, y: 0, w: 98, h: 59 },
    { x: 102, y: 61, w: 98, h: 39 },
  ];
  test("the aligned tile with the nearest edge, then the nearest centre", () => {
    expect(neighbour(rects, 0, "right")).toBe(1);
    expect(neighbour(rects, 1, "down")).toBe(2);
    expect(neighbour(rects, 2, "up")).toBe(1);
    expect(neighbour(rects, 2, "left")).toBe(0);
    expect(neighbour(rects, 1, "left")).toBe(0);
  });
  test("nothing that way: null, so the page can scroll", () => {
    expect(neighbour(rects, 1, "right")).toBeNull();
    expect(neighbour(rects, 0, "left")).toBeNull();
    expect(neighbour(rects, 0, "up")).toBeNull();
  });
  test("no tile overlaps on the other axis: the closest by gap and offset", () => {
    const r: Rect[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 20, y: 30, w: 10, h: 10 },
      { x: 60, y: 12, w: 10, h: 10 },
    ];
    expect(neighbour(r, 0, "right")).toBe(1); // gap 10 + 2 × offset 30 = 70 beats gap 50 + 2 × offset 12 = 74
  });
});
