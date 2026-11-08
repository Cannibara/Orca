import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Stock } from "../src/data/api";
import type { Contrib, Securities, Summary } from "../src/data/types";
import {
  byMagnitude,
  driveItems,
  headline,
  itemTip,
  namedCount,
  periodRows,
  quartersIn,
  sumOf,
  tableView,
  waterfall,
  type DriveRow,
} from "../src/fund/drive";
import { buildSeries } from "../src/fund/series";

const here = dirname(fileURLToPath(import.meta.url));
const read = <T>(p: string): T => JSON.parse(readFileSync(resolve(here, "../public/demo-data", p), "utf8")) as T;
const summary = read<Summary>("fund/9100002/summary.json");
const contrib = read<Contrib>("fund/9100002/contrib.json");
const sec = read<Securities>("securities.json");
const stocks = new Map<number, Stock>(sec.stock_id.map((id, i) => [id, { ticker: sec.ticker[i], name: sec.name[i] }]));

const row = (id: number, v: number, name = "Co " + id): DriveRow => ({ id, t: "T" + id, name, v });
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("periodRows", () => {
  test("one year: every stock of that year, biggest contribution first", () => {
    const rows = periodRows(contrib, stocks, ["2025"]);
    expect(rows).toHaveLength(contrib.by_year["2025"].stock_id.length);
    expect(rows[0].t).toBe("GOOGL");
    expect(rows[0].v).toBeCloseTo(1.455, 2);
    expect(rows[rows.length - 1].t).toBe("GE");
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].v).toBeGreaterThanOrEqual(rows[i].v);
  });

  test("several years add each stock's points over the years", () => {
    const rows = periodRows(contrib, stocks, ["2020", "2021", "2022"]);
    for (const r of rows) {
      let want = 0;
      for (const y of ["2020", "2021", "2022"]) {
        const c = contrib.by_year[y];
        const i = c.stock_id.indexOf(r.id);
        if (i >= 0) want += c.points[i];
      }
      near(r.v, want);
    }
    // a stock that is in only one of the years still appears
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("names come from the securities; an unknown stock shows as #id with no name", () => {
    const c: Contrib = { years: ["2020"], by_year: { "2020": { stock_id: [4, 999], points: [1, 2], pnl: [0, 0] } } };
    const rows = periodRows(c, stocks, ["2020"]);
    expect(rows.find((r) => r.id === 4)).toMatchObject({ t: "AAPL", name: "APPLE INC" });
    expect(rows.find((r) => r.id === 999)).toMatchObject({ t: "#999", name: "" });
  });

  test("a year without contributions, or a non-finite point, adds nothing", () => {
    expect(periodRows(contrib, stocks, ["1999"])).toEqual([]);
    const c: Contrib = { years: ["2020"], by_year: { "2020": { stock_id: [1, 2], points: [Number.NaN, 3], pnl: [0, 0] } } };
    expect(periodRows(c, stocks, ["2020"]).map((r) => r.id)).toEqual([2]);
  });

  test("thousands of stocks over many years aggregate in one pass", () => {
    const by_year: Contrib["by_year"] = {};
    const labels: string[] = [];
    for (let y = 2010; y < 2025; y++) {
      const ids = Array.from({ length: 5000 }, (_, i) => i + y * 3); // overlapping ids
      by_year[String(y)] = { stock_id: ids, points: ids.map((i) => ((i * 7) % 13) / 10 - 0.6), pnl: ids.map(() => 0) };
      labels.push(String(y));
    }
    const t0 = performance.now();
    const rows = periodRows({ years: labels, by_year }, new Map(), labels);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(rows.length).toBeGreaterThan(5000);
    expect(rows[0].v).toBeGreaterThanOrEqual(rows[rows.length - 1].v);
  });
});

describe("quartersIn", () => {
  test("counts the quarters with a return inside the years", () => {
    const series = buildSeries(summary);
    expect(quartersIn(series, 2020, 2022)).toBe(12);
    expect(quartersIn(series, 2025, 2025)).toBe(4);
    expect(quartersIn(series, 2014, 2026)).toBe(series.quarters.length);
  });
});

describe("headline", () => {
  const rows = [row(1, 5.04), row(2, 1), row(3, -2.26)];
  test("a winner and a loser", () => {
    expect(headline(rows, "2020 to 2022", 12)).toEqual({
      span: "2020 to 2022",
      meta: "3 years, 12 quarters",
      text: "Co 1 added 5.0 points, but Co 3 took away 2.3.",
    });
  });
  test("no loser: the most of N stocks", () => {
    expect(headline([row(1, 2), row(2, 1)], "2020", 4).text).toBe("Co 1 added 2.0 points, the most of 2 stocks.");
  });
  test("nothing added", () => {
    expect(headline([row(1, -0.5), row(2, -3)], "2020", 4).text).toBe("No stock added to return. Co 2 took away 3.0 points.");
  });
  test("singular years and quarters, and the ticker stands in for a missing name", () => {
    const h = headline([{ id: 1, t: "#1", name: "", v: 1 }], "2019", 1);
    expect(h.meta).toBe("0.3 years, 1 quarter");
    expect(h.text).toBe("#1 added 1.0 points, the most of 1 stock.");
    expect(headline(rows, "2019", 4).meta).toBe("1 year, 4 quarters");
  });
});

describe("driveItems", () => {
  const many = Array.from({ length: 30 }, (_, i) => row(i, (i % 2 ? 1 : -1) * (30 - i)));
  const byMag = byMagnitude(many);

  test("the number of named stocks follows the width, 4 to 10", () => {
    expect(namedCount(280)).toBe(4);
    expect(namedCount(480)).toBe(4);
    expect(namedCount(1000)).toBe(7);
    expect(namedCount(1400)).toBe(10);
    expect(namedCount(5000)).toBe(10);
  });

  test("named stocks are the biggest movers, shown by value; the rest are grouped with their sum", () => {
    const items = driveItems(byMag, 1000);
    expect(items).toHaveLength(8);
    const named = items.slice(0, 7);
    expect(named.map((i) => Math.abs(i.v)).sort((a, b) => b - a)).toEqual([30, 29, 28, 27, 26, 25, 24]);
    for (let i = 1; i < named.length; i++) expect(named[i - 1].v).toBeGreaterThanOrEqual(named[i].v);
    const other = items[7];
    expect(other).toMatchObject({ t: "Other", name: "Other stocks", other: true, n: 23 });
    near(other.v, sumOf(byMag.slice(7)));
    expect(other.list?.[0]).toBe(byMag[7]);
  });

  test("a single leftover stock gets its own bar instead of a group of one", () => {
    const five = byMagnitude(many.slice(0, 5));
    const items = driveItems(five, 480);
    expect(items).toHaveLength(5);
    expect(items.some((i) => i.other)).toBe(false);
  });

  test("everything named: no group", () => {
    expect(driveItems(byMagnitude(many.slice(0, 3)), 480).some((i) => i.other)).toBe(false);
  });
});

describe("waterfall", () => {
  const rows = [row(1, 3), row(2, 1.5), row(3, -2), row(4, -0.5)];
  const items = driveItems(byMagnitude(rows), 480);
  const total = sumOf(rows);

  test("one bar per item and a total; connectors between neighbours; the total bar is dark", () => {
    const w = waterfall(items, total, 480);
    expect(w.bars).toHaveLength(5);
    expect(w.conns).toHaveLength(4);
    expect(w.bars.map((b) => b.cls)).toEqual(["gain", "gain", "loss", "loss", "tot"]);
    expect(w.bars[4].label).toBe("+2.0");
    expect(w.bars[4].tick).toBe("Total");
    // connectors sit at the running total: heights above the zero line are proportional to it, and the last one is the total
    const scale = (w.zeroY - w.conns[0].y) / 3;
    expect(Math.abs((w.zeroY - w.conns[3].y) / total - scale)).toBeLessThan(0.05);
    expect(Math.abs((w.zeroY - w.conns[1].y) / 4.5 - scale)).toBeLessThan(0.05);
  });

  test("the axis shows from 480 px, names under the bars from 720 px", () => {
    expect(waterfall(items, total, 479).ticks).toBeNull();
    const wide = waterfall(items, total, 480);
    expect(wide.ticks?.length).toBeGreaterThan(2);
    expect(wide.ticks?.map((t) => t.text)).toContain("0");
    expect(wide.bars[0].nm).toBeNull();
    const full = waterfall(items, total, 720);
    expect(full.bars[0].nm).toBe("Co 1");
    expect(full.H).toBe(360);
    expect(waterfall(items, total, 400).H).toBe(300);
  });

  test("a long name is cut to its band with an ellipsis", () => {
    const long = [row(1, 3, "A very long company name indeed Holdings"), row(2, -1, "Short")];
    const w = waterfall(driveItems(byMagnitude(long), 740), 2, 740);
    const nm = w.bars[0].nm ?? "";
    expect(nm.endsWith("…")).toBe(true);
    expect(nm.length).toBeLessThan("A very long company name indeed Holdings".length);
    expect(w.bars[1].nm).toBe("Short");
  });

  test("a near-zero bar keeps a hairline height", () => {
    const w = waterfall(driveItems(byMagnitude([row(1, 3), row(2, 0.0001)]), 480), 3.0001, 480);
    expect(w.bars[1].d).toMatch(/^M/);
    expect(w.bars[1].label).toBe("0.0");
  });

  test("each bar has an accessible name with its points", () => {
    const w = waterfall(items, total, 480);
    expect(w.bars[0].aria).toBe("Co 1 (T1): +3.00 percentage points");
    expect(w.bars[4].aria).toBe("Total of listed stocks: +2.00 percentage points");
    const g = waterfall(driveItems(byMagnitude(Array.from({ length: 9 }, (_, i) => row(i, i + 1))), 480), 45, 480);
    expect(g.bars[4].aria).toBe("Other stocks, 5 smaller contributors: +15.00 percentage points");
  });

  test("the values are laid out between the axis ends", () => {
    const w = waterfall(items, total, 480);
    for (const b of w.bars) {
      expect(b.labelY).toBeGreaterThan(0);
      expect(b.labelY).toBeLessThan(w.H);
    }
    // a gain's bar rises above the zero line, a loss's hangs below it
    expect(w.bars[0].up).toBe(true);
    expect(w.bars[3].up).toBe(false);
  });
});

describe("itemTip", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row(i, i + 1));
  const items = driveItems(byMagnitude(rows), 480);
  test("a stock names its ticker and the period", () => {
    expect(itemTip(items[0], "2020 to 2022")).toEqual({
      title: "Co 8",
      color: "var(--gain)",
      value: "+9.00 points",
      note: "T8 in 2020 to 2022",
    });
  });
  test("the group lists up to four tickers and the count of the rest", () => {
    const other = items[items.length - 1];
    const t = itemTip(other, "2022");
    expect(t.title).toBe("Other stocks");
    expect(t.note).toBe("5 smaller contributors: T4, T3, T2, T1, and 1 more");
  });
  test("the total names the period it sums", () => {
    const t = itemTip({ t: "Total", name: "Total of listed", v: -2.5, tot: true }, "2022");
    expect(t).toMatchObject({ title: "Total of listed stocks", value: "−2.50 points", note: "The sum of every contribution in 2022" });
  });
  test("a losing stock is coloured as a loss", () => {
    expect(itemTip(row(1, -1), "2020").color).toBe("var(--loss)");
  });
});

describe("tableView", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(i, 10 - i * 0.02)); // 10 down to -9.98
  const byMag = byMagnitude(rows);
  test("a short list is shown whole", () => {
    const v = tableView(rows.slice(0, 50), byMagnitude(rows.slice(0, 50)), false);
    expect(v.rows).toHaveLength(50);
    expect(v.hidden).toBe(0);
  });
  test("a long list shows its biggest movers (winners and losers), the rest as one sum", () => {
    const v = tableView(rows, byMag, false);
    expect(v.rows).toHaveLength(200);
    expect(v.hidden).toBe(800);
    // still ordered by value, and the worst stock is among them
    for (let i = 1; i < v.rows.length; i++) expect(v.rows[i - 1].v).toBeGreaterThanOrEqual(v.rows[i].v);
    expect(v.rows[v.rows.length - 1].id).toBe(999);
    near(sumOf(v.rows) + v.hiddenSum, v.total);
  });
  test("show all returns every row", () => {
    const v = tableView(rows, byMag, true);
    expect(v.rows).toHaveLength(1000);
    expect(v.hidden).toBe(0);
  });
});
