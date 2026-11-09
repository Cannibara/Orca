import { aumAria, aumLayout, aumParts, aumRows, aumTotals } from "../src/fund/aum";
import { textW } from "../src/fund/geometry";
import type { YearPoint } from "../src/fund/series";

/** A year in dollars; the end book is start + inflows + gains unless given. */
function yp(label: string, start: number, inflows: number, gains: number, over: Partial<YearPoint> = {}): YearPoint {
  return {
    label,
    part: false,
    year: parseInt(label, 10),
    ret: 0,
    start,
    end: start + inflows + gains,
    gains,
    inflows,
    qCount: 4,
    ...over,
  };
}

const B = 1e9;
const M = 1e6;

/** Growing book: `n` years from `first`, each adding `inflow` and earning `rate` on the start book. */
function grow(n: number, first: number, inflow: number, rate: number, startYear = 2012): YearPoint[] {
  const out: YearPoint[] = [];
  let book = 0;
  for (let i = 0; i < n; i++) {
    const g = i === 0 ? 0 : book * rate;
    const f = i === 0 ? first : inflow;
    out.push(yp(String(startYear + i), book, f, g));
    book = book + f + g;
  }
  return out;
}

describe("aumParts", () => {
  test("a year of inflows and gains stacks the carried book, the inflows and the gains", () => {
    const p = aumParts(yp("2020", 2 * B, 0.5 * B, 0.3 * B), false);
    expect(p).toMatchObject({ c: 2 * B, f: 0.5 * B, g: 0.3 * B, loss: 0, out: 0, first: false, top: 2.8 * B, gross: 2.8 * B, S0: 2 * B, E: 2.8 * B });
  });

  test("a loss is taken off the top of the stack and drawn as a dotted box above the bar", () => {
    const p = aumParts(yp("2021", 4 * B, 0.2 * B, -0.5 * B), false);
    // the loss eats the inflows first, then the carried book
    expect(p.f).toBe(0);
    expect(p.c).toBeCloseTo(3.7 * B, 3);
    expect(p.loss).toBe(0.5 * B);
    expect(p.top).toBeCloseTo(3.7 * B, 3);
    expect(p.gross).toBeCloseTo(4.2 * B, 3);
    expect(p.top).toBeCloseTo(p.E, 3);
  });

  test("an outflow is taken off the gains first, then the inflows, then the carried book", () => {
    const p = aumParts(yp("2019", 3 * B, -0.4 * B, 0.1 * B), false);
    expect(p.g).toBe(0);
    expect(p.f).toBe(0);
    expect(p.out).toBe(0.4 * B);
    expect(p.c).toBeCloseTo(2.7 * B, 3);
    expect(p.top).toBeCloseTo(p.E, 3);
    expect(p.gross).toBeCloseTo(3.1 * B, 3);
  });

  test("the solid part of every bar is the book at year end", () => {
    for (const y of [yp("a", 5 * B, 1 * B, -3 * B), yp("b", 5 * B, -2 * B, -1 * B), yp("c", 5 * B, -2 * B, 1.5 * B), yp("d", 5 * B, 2 * B, 1 * B)]) {
      const p = aumParts(y, false);
      expect(p.top).toBeCloseTo(y.end, 3);
    }
  });

  test("the first year of the series, from no book, is one block of the end book", () => {
    const p = aumParts(yp("2014", 0, 1.879 * B, -0.384 * B), true);
    expect(p).toMatchObject({ first: true, c: 1.495 * B - 0 + 0, f: 0, g: 0, loss: 0, out: 0 });
    expect(p.c).toBeCloseTo(1.495 * B, 0);
    expect(p.top).toBe(p.E);
    expect(p.gross).toBe(p.E);
  });

  test("the first rule needs the first year of the whole series and no book at the start", () => {
    // not the first year of the series (the window starts later): a normal stack
    expect(aumParts(yp("2020", 0, 1 * B, 0), false).first).toBe(false);
    // the first year, but it already had a book
    expect(aumParts(yp("2014", 2 * B, 1 * B, 0), true).first).toBe(false);
    // $100K or less counts as no book
    expect(aumParts(yp("2014", 1e5, 1 * B, 0), true).first).toBe(true);
    expect(aumParts(yp("2014", 1e5 + 1, 1 * B, 0), true).first).toBe(false);
  });
});

describe("aumTotals and aumRows", () => {
  const years = [yp("2023", 1 * B, 0.5 * B, 0.2 * B), yp("2024", 1.7 * B, -0.1 * B, 0.4 * B), yp("2025", 2 * B, 0.2 * B, -0.35 * B, { part: true })];

  test("the end book is the last year's; flows and gains are summed over the window", () => {
    const t = aumTotals(years);
    expect(t.end).toBeCloseTo(1.85 * B, 3);
    expect(t.flows).toBeCloseTo(0.6 * B, 3);
    expect(t.gains).toBeCloseTo(0.25 * B, 3);
    expect(aumTotals([])).toEqual({ end: 0, flows: 0, gains: 0 });
  });

  test("table rows print dollars in adaptive units with printed signs", () => {
    const rows = aumRows(years);
    expect(rows[0]).toEqual({ label: "2023", part: false, start: "$1.00B", flows: "+$500M", gains: "+$200M", change: "+$700M", end: "$1.70B" });
    expect(rows[1].flows).toBe("−$100M");
    expect(rows[2]).toMatchObject({ part: true, gains: "−$350M", change: "−$150M", end: "$1.85B" });
  });

  test("a figure that prints as zero has no sign", () => {
    expect(aumRows([yp("2020", 1 * B, 0, 0)])[0]).toMatchObject({ flows: "$0", gains: "$0", change: "$0" });
  });
});

describe("aumAria", () => {
  test("is the artifact's sentence with dollars in adaptive units", () => {
    expect(aumAria(yp("2022", 2.976 * B, 2.36 * B, -0.782 * B))).toBe("2022: book $2.98B to $4.55B; net inflows +$2.36B; gains −$782M");
    expect(aumAria(yp("2026 H1", 10.891 * B, 2.343 * B, -2.093 * B, { part: true }))).toBe("2026 H1: book $10.9B to $11.1B; net inflows +$2.34B; gains −$2.09B, part year");
  });
});

describe("aumLayout", () => {
  const demo = grow(13, 1.5 * B, 0.7 * B, 0.08);

  test("draws one hit column per year with the aria label", () => {
    const L = aumLayout({ years: demo, offset: 0 }, 1100);
    expect(L.hits).toHaveLength(13);
    expect(L.hits[0].label).toBe(aumAria(demo[0]));
    expect(L.hits[1].x).toBeGreaterThan(L.hits[0].x);
    expect(L.H).toBe(360);
  });

  test("the chart is shorter below 520 px and the axis goes away", () => {
    const L = aumLayout({ years: demo, offset: 0 }, 400);
    expect(L.H).toBe(300);
    expect(L.G.axis).toBe(false);
  });

  test("a wide chart labels every bar in full; a narrow one drops the dollar sign, then turns the labels", () => {
    const wide = aumLayout({ years: demo, offset: 0 }, 1100);
    expect(wide.form).toBe("full");
    expect(wide.rot).toBe(false);
    expect(wide.labels).toHaveLength(13);
    expect(wide.labels[0].text.startsWith("$")).toBe(true);

    const mid = aumLayout({ years: demo, offset: 0 }, 540);
    expect(mid.form).toBe("short");
    expect(mid.labels.every((l) => !l.text.startsWith("$"))).toBe(true);

    const narrow = aumLayout({ years: demo, offset: 0 }, 400);
    expect(narrow.form).toBe("short");
    expect(narrow.rot).toBe(true);
    expect(narrow.labels.every((l) => l.rot)).toBe(true);
  });

  test("the first bar of the series is one block in the carried-over colour", () => {
    const L = aumLayout({ years: [yp("2014", 0, 1.9 * B, -0.4 * B), ...grow(3, 0, 1 * B, 0.1, 2015).map((y, i) => ({ ...y, start: i === 0 ? 1.5 * B : y.start }))], offset: 0 }, 900);
    expect(L.parts[0].first).toBe(true);
    const first = L.segs.filter((s) => s.i === 0);
    expect(first.map((s) => s.cls)).toEqual(["corp"]);
    // when the window starts later, the same year is an ordinary stack
    const later = aumLayout({ years: [yp("2014", 0, 1.9 * B, -0.4 * B)], offset: 3 }, 900);
    expect(later.parts[0].first).toBe(false);
  });

  test("a loss and an outflow are dotted boxes above the solid part", () => {
    const years = [yp("2019", 1 * B, 1 * B, 0), yp("2020", 2 * B, -0.5 * B, -0.4 * B)];
    const L = aumLayout({ years, offset: 0 }, 900);
    expect(L.segs.filter((s) => s.i === 1).map((s) => s.cls)).toEqual(["corp", "rm-loss", "rm-out"]);
  });

  test("every windowed year is drawn, including one with no return", () => {
    const years = [yp("2013", 0, 1 * B, 0, { ret: null }), yp("2014", 1 * B, 0.2 * B, 0.1 * B, { ret: null })];
    const L = aumLayout({ years, offset: 1 }, 700);
    expect(L.hits).toHaveLength(2);
    expect(L.parts[0].first).toBe(false); // offset 1: not the series' first year
    expect(L.segs.some((s) => s.i === 0)).toBe(true);
  });

  test("ticks are in dollars, start at $0 and cover the tallest bar including the dotted boxes", () => {
    const years = [yp("2020", 5 * B, 0, -2 * B), yp("2021", 3 * B, 0, 0.5 * B)];
    const L = aumLayout({ years, offset: 0 }, 900);
    expect(L.ticks[0].text).toBe("$0");
    expect(L.ticks[0].y).toBeCloseTo(L.z, 0);
    expect(L.ticks[L.ticks.length - 1].v).toBeGreaterThanOrEqual(5 * B);
    expect(L.ticks.map((t) => t.text)).toEqual(["$0", "$2B", "$4B", "$6B"]);
  });

  test("labels never overlap each other and sit inside the chart", () => {
    for (const W of [280, 400, 520, 700, 1100]) {
      for (const n of [1, 5, 13, 15, 30]) {
        const years = grow(n, 1 * B, 0.4 * B, 0.1);
        const L = aumLayout({ years, offset: 0 }, W);
        expect(L.labels.length).toBeGreaterThan(0);
        const boxes = L.labels.map((l) => {
          const w = textW(l.text, l.size);
          return l.rot ? { x0: l.x - l.size, x1: l.x + 1, y0: l.y - w, y1: l.y } : { x0: l.x - w / 2, x1: l.x + w / 2, y0: l.y - l.size, y1: l.y };
        });
        boxes.forEach((a, i) => {
          expect(a.y0).toBeGreaterThanOrEqual(0);
          expect(a.x0).toBeGreaterThanOrEqual(-1);
          expect(a.x1).toBeLessThanOrEqual(W + 1);
          boxes.slice(i + 1).forEach((b) => {
            const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
            expect(apart).toBe(true);
          });
        });
      }
    }
  });

  test("the newest year and the biggest book get a label first", () => {
    const years = grow(30, 1 * B, 0.4 * B, 0.1);
    const L = aumLayout({ years, offset: 0 }, 700);
    expect(L.labels.some((l) => l.i === 29)).toBe(true);
  });

  test("x labels thin out instead of colliding", () => {
    const L = aumLayout({ years: grow(30, 1 * B, 0.4 * B, 0.1), offset: 0 }, 500);
    expect(L.xItems.length).toBeGreaterThan(2);
    expect(L.xItems.length).toBeLessThan(30);
    expect(L.xItems.some((x) => x.i === 29)).toBe(true);
  });

  test("a part year keeps its label and says so in the aria text", () => {
    const years = [...grow(2, 1 * B, 0.1 * B, 0.1), yp("2014 H1", 1.3 * B, 0.1 * B, 0.05, { part: true })];
    const L = aumLayout({ years, offset: 0 }, 900);
    expect(L.hits[2].label.endsWith(", part year")).toBe(true);
    expect(L.xItems.map((x) => x.text)).toContain("2014 H1");
  });
});

describe("aumLayout at other scales", () => {
  test("a $300M fund: axis in millions, labels in millions, bars use the whole height", () => {
    const years = grow(10, 100 * M, 15 * M, 0.05);
    const L = aumLayout({ years, offset: 0 }, 1100);
    const top = years[9].end;
    expect(top).toBeGreaterThan(280 * M);
    expect(top).toBeLessThan(420 * M);
    expect(L.ticks.every((t) => /^\$\d+(\.\d+)?M$|^\$0$/.test(t.text))).toBe(true);
    expect(L.ticks.map((t) => t.text)).toEqual(["$0", "$100M", "$200M", "$300M", "$400M"]);
    expect(L.labels.length).toBe(10);
    expect(L.labels.every((l) => /^\$\d+(\.\d+)?M$/.test(l.text))).toBe(true);
    // the tallest bar reaches at least 70% of the axis
    const axisTop = L.ticks[L.ticks.length - 1].v;
    expect(top / axisTop).toBeGreaterThan(0.7);
    // the axis text fits in the 52 px margin
    for (const t of L.ticks) expect(textW(t.text, 11)).toBeLessThan(42);
  });

  test("a $500B fund: axis in billions without absurd decimals, labels stay short", () => {
    const years = grow(15, 100 * B, 10 * B, 0.05);
    const L = aumLayout({ years, offset: 0 }, 1100);
    expect(years[14].end).toBeGreaterThan(350 * B);
    expect(years[14].end).toBeLessThan(500 * B);
    for (const t of L.ticks) {
      expect(t.text).toMatch(/^\$(0|\d+(\.\d+)?B)$/);
      expect(textW(t.text, 11)).toBeLessThan(42);
    }
    expect(L.labels.length).toBeGreaterThan(8);
    for (const l of L.labels) {
      expect(l.text).toMatch(/^\$\d+(\.\d+)?B$/);
      expect(l.text.length).toBeLessThanOrEqual(7);
    }
    expect(L.ticks[L.ticks.length - 1].v).toBeGreaterThanOrEqual(years[14].end);
  });

  test("a $500B fund and a $300M fund at phone width stay legible", () => {
    for (const years of [grow(15, 100 * B, 10 * B, 0.05), grow(15, 100 * M, 15 * M, 0.05)]) {
      const L = aumLayout({ years, offset: 0 }, 360);
      expect(L.rot).toBe(true);
      expect(L.labels.length).toBeGreaterThan(3);
      // the top margin has room for the longest rotated label
      const longest = Math.max(...L.labels.map((l) => textW(l.text, l.size)));
      const topY = Math.min(...L.labels.map((l) => l.y - textW(l.text, l.size)));
      expect(topY).toBeGreaterThanOrEqual(-1);
      expect(longest).toBeLessThan(60);
    }
  });

  test("a single year and a fund with no growth do not break the geometry", () => {
    const one = aumLayout({ years: [yp("2020", 0, 3 * M, 0)], offset: 0 }, 600);
    expect(one.hits).toHaveLength(1);
    expect(Number.isFinite(one.z)).toBe(true);
    const flat = aumLayout({ years: [yp("2020", 0, 0, 0), yp("2021", 0, 0, 0)], offset: 0 }, 600);
    expect(flat.ticks.length).toBeGreaterThan(1);
    expect(flat.segs.every((s) => !s.d.includes("NaN"))).toBe(true);
    for (const l of flat.labels) expect(Number.isFinite(l.y)).toBe(true);
  });

  test("path data has no NaN for any window", () => {
    for (const years of [grow(1, 1 * B, 0, 0), grow(15, 200 * M, 50 * M, -0.1), grow(30, 3 * B, 1 * B, 0.2)]) {
      const L = aumLayout({ years, offset: 0 }, 500);
      expect(L.segs.every((s) => !s.d.includes("NaN"))).toBe(true);
    }
  });
});
