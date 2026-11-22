import { balance, indexMode, midLayout, wideLayout, type IndexCell, type IndexItem } from "../src/home/listIndex";

// The Famous funds list index: whatever the number of lists, the cells sit on straight rows and columns.

const STYLES = [
  "Buffett inspired",
  "Moat investing",
  "Value",
  "Tiger cubs",
  "Fundamental long/short",
  "Healthcare specialists",
  "Tech & growth",
  "Venture capital",
  "Activists",
  "Macro",
  "Credit & event-driven",
  "Quant & multi-strategy",
];
const WHO = ["Family offices", "Big companies", "Sovereign & pension funds"];
const items = (styles = STYLES, who = WHO, pop = true): IndexItem[] => [
  ...(pop ? [{ name: "Most searched", group: "pop" as const }] : []),
  ...styles.map((name) => ({ name, group: "style" as const })),
  ...who.map((name) => ({ name, group: "who" as const })),
];
/** Cells per column, top to bottom. */
const columns = (cells: IndexCell[]) => {
  const by = new Map<number, IndexCell[]>();
  for (const c of cells) by.set(c.col, [...(by.get(c.col) ?? []), c]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, cs]) => cs.sort((a, b) => a.row - b.row));
};

test("balance spreads k items over c columns, the first ones longer", () => {
  expect(balance(12, 4)).toEqual([3, 3, 3, 3]);
  expect(balance(11, 4)).toEqual([3, 3, 3, 2]);
  expect(balance(9, 4)).toEqual([3, 2, 2, 2]);
  expect(balance(2, 4)).toEqual([1, 1, 0, 0]);
});

test("the mode follows the content width", () => {
  expect(indexMode(1192)).toBe("wide");
  expect(indexMode(1140)).toBe("wide");
  expect(indexMode(1139)).toBe("mid");
  expect(indexMode(760)).toBe("mid");
  expect(indexMode(759)).toBe("pick");
  expect(indexMode(368)).toBe("pick");
});

describe("wide: the groups side by side on six tracks", () => {
  test("16 lists: Most searched one tall cell, the styles 4 x 3, the investor types 1 x 3", () => {
    const L = wideLayout(items());
    expect(L.cols).toBe(6);
    expect(L.rows).toBe("auto repeat(3, var(--cell))");
    expect(L.heads.map((h) => [h.group, h.col, h.span, h.row])).toEqual([
      ["pop", 1, 1, 1],
      ["style", 2, 4, 1],
      ["who", 6, 1, 1],
    ]);
    const feat = L.cells.find((c) => c.feat)!;
    expect([feat.name, feat.col, feat.row, feat.rowSpan]).toEqual(["Most searched", 1, 2, 3]);
    const cols = columns(L.cells.filter((c) => !c.feat));
    expect(cols.map((c) => c.length)).toEqual([3, 3, 3, 3, 3]);
    // filled top to bottom, in page order, every column starting on the first list row
    expect(cols[0].map((c) => c.name)).toEqual(["Buffett inspired", "Moat investing", "Value"]);
    expect(cols.every((c) => c.map((x) => x.row).join() === "2,3,4")).toBe(true);
    expect(cols[4].map((c) => c.name)).toEqual(WHO);
  });

  test("13 lists: the frame stays (six tracks, three rows); a missing list only shortens a column", () => {
    const L = wideLayout(items(STYLES.filter((s) => !["Macro", "Activists", "Value"].includes(s))));
    expect(L.cols).toBe(6);
    expect(L.rows).toBe("auto repeat(3, var(--cell))");
    expect(columns(L.cells.filter((c) => !c.feat)).map((c) => c.length)).toEqual([3, 2, 2, 2, 3]);
  });

  test("more lists add a row, never a seventh track", () => {
    const many = [...STYLES, "A", "B", "C", "D", "E", "F"];
    const L = wideLayout(items(many));
    expect(L.cols).toBe(6);
    expect(L.rows).toBe("auto repeat(5, var(--cell))");
    expect(L.cells.find((c) => c.feat)!.rowSpan).toBe(5);
    expect(L.cells).toHaveLength(1 + many.length + WHO.length);
  });

  test("no cell shares a grid cell with another", () => {
    for (const L of [wideLayout(items()), wideLayout(items(STYLES.slice(0, 7), WHO.slice(0, 1))), midLayout(items())]) {
      const seen = new Set<string>();
      for (const c of L.cells)
        for (let r = c.row; r < c.row + c.rowSpan; r++) {
          const k = `${c.col}:${r}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
    }
  });
});

describe("mid: four tracks", () => {
  test("Most searched and the investor types on the first row, then the styles four across", () => {
    const L = midLayout(items());
    expect(L.cols).toBe(4);
    expect(L.rows).toBe("auto var(--cell) auto repeat(3, var(--cell))");
    expect(L.heads.map((h) => [h.group, h.col, h.span, h.row])).toEqual([
      ["pop", 1, 1, 1],
      ["who", 2, 3, 1],
      ["style", 1, 4, 3],
    ]);
    expect(L.cells.filter((c) => c.row === 2).map((c) => c.name)).toEqual(["Most searched", ...WHO]);
    expect(L.cells.find((c) => c.feat)!.rowSpan).toBe(1);
    const styles = L.cells.filter((c) => c.group === "style");
    expect(Math.min(...styles.map((c) => c.row))).toBe(4);
    expect(columns(styles).map((c) => c.length)).toEqual([3, 3, 3, 3]);
  });
});
