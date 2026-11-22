// The Famous funds list switch as an index (owner, 2026-11-21: "it isn't symmetrical as we don't have an even
// number of sub lists"): three labelled groups on one grid of equal tracks, so 12–17 lists always make straight
// rows and columns. Popular (Most searched) is one tall cell; the styles and the investor types fill their
// columns top to bottom, so a list missing for a period only shortens a column and the frame never moves.
// Pure layout: `ListIndex.tsx` draws it, and the toolbar under it uses the same tracks.

export type IndexGroup = "pop" | "style" | "who";
export type IndexItem = { name: string; group: IndexGroup };
/** Grid lines are 1-based, as CSS has them. */
export type IndexCell = IndexItem & { col: number; row: number; rowSpan: number; feat: boolean };
export type IndexHead = { group: IndexGroup; col: number; span: number; row: number };
export type IndexLayout = {
  /** Equal tracks across the module; the toolbar uses the same ones. */
  cols: number;
  /** CSS grid-template-rows: heading rows are auto, list rows the cell height. */
  rows: string;
  heads: IndexHead[];
  cells: IndexCell[];
  /** wide: the groups side by side; mid: Popular and the investor types on one row, the styles under them. */
  mode: "wide" | "mid";
};
/** wide: six tracks; mid: four; pick: one field that opens the device's own list (a phone, a narrow window). */
export type IndexMode = IndexLayout["mode"] | "pick";

export const GROUP_LABEL: Record<IndexGroup, string> = {
  pop: "Popular",
  style: "Investing style",
  who: "Type of investor",
};

/** Content width (px) from which each layout fits its longest name ("Sovereign & pension funds") in a track. */
export const WIDE_FROM = 1140;
export const MID_FROM = 760;
export const indexMode = (width: number): IndexMode => (width >= WIDE_FROM ? "wide" : width >= MID_FROM ? "mid" : "pick");

/** k items over c columns, the first columns one longer: 11 over 4 is 3, 3, 3, 2. */
export const balance = (k: number, c: number): number[] =>
  Array.from({ length: c }, (_, i) => Math.floor(k / c) + (i < k % c ? 1 : 0));

const CELL = "var(--cell)";
const of = (items: IndexItem[], g: IndexGroup) => items.filter((i) => i.group === g);

/** Fills `ncols` columns from `col`, top to bottom from grid row `row`, balanced. */
function fill(out: IndexCell[], items: IndexItem[], col: number, ncols: number, row: number) {
  let k = 0;
  balance(items.length, ncols).forEach((h, c) => {
    for (let r = 0; r < h; r++) out.push({ ...items[k++], col: col + c, row: row + r, rowSpan: 1, feat: false });
  });
}

/**
 * Six tracks at most: Popular, the styles (at least four columns), the investor types. Three list rows while
 * that fits (12–16 lists); more lists add a row, never a seventh track.
 */
export function wideLayout(items: IndexItem[]): IndexLayout {
  const pop = of(items, "pop");
  const sty = of(items, "style");
  const who = of(items, "who");
  let n = 3;
  let sc = 0;
  let wc = 0;
  for (; ; n++) {
    sc = sty.length ? Math.max(4, Math.ceil(sty.length / n)) : 0;
    wc = who.length ? Math.ceil(who.length / n) : 0;
    if (pop.length + sc + wc <= 6 || n >= 8) break;
  }
  const heads: IndexHead[] = [];
  const cells: IndexCell[] = [];
  let col = 1;
  if (pop.length) {
    heads.push({ group: "pop", col, span: 1, row: 1 });
    cells.push({ ...pop[0], col, row: 2, rowSpan: n, feat: true });
    col += 1;
  }
  if (sc) {
    heads.push({ group: "style", col, span: sc, row: 1 });
    fill(cells, sty, col, sc, 2);
    col += sc;
  }
  if (wc) {
    heads.push({ group: "who", col, span: wc, row: 1 });
    fill(cells, who, col, wc, 2);
    col += wc;
  }
  return { cols: Math.max(1, col - 1), rows: `auto repeat(${n}, ${CELL})`, heads, cells, mode: "wide" };
}

/** Four tracks: Popular and the investor types on the first row, then the styles four across. */
export function midLayout(items: IndexItem[]): IndexLayout {
  const pop = of(items, "pop");
  const sty = of(items, "style");
  const who = of(items, "who").slice(0, 4 - pop.length);
  const heads: IndexHead[] = [];
  const cells: IndexCell[] = [];
  let row = 1;
  const rows: string[] = [];
  if (pop.length || who.length) {
    if (pop.length) {
      heads.push({ group: "pop", col: 1, span: 1, row });
      cells.push({ ...pop[0], col: 1, row: row + 1, rowSpan: 1, feat: true });
    }
    if (who.length) {
      const c0 = pop.length ? 2 : 1;
      heads.push({ group: "who", col: c0, span: 5 - c0, row });
      who.forEach((w, i) => cells.push({ ...w, col: c0 + i, row: row + 1, rowSpan: 1, feat: false }));
    }
    rows.push("auto", CELL);
    row += 2;
  }
  if (sty.length) {
    heads.push({ group: "style", col: 1, span: 4, row });
    fill(cells, sty, 1, 4, row + 1);
    const h = Math.ceil(sty.length / 4);
    rows.push("auto", `repeat(${h}, ${CELL})`);
  }
  // investor types past the first row's room (none today) join the styles' last column rather than vanish
  const extra = of(items, "who").slice(who.length);
  if (extra.length) {
    const last = Math.max(...cells.map((c) => c.row));
    extra.forEach((w, i) => cells.push({ ...w, col: 4, row: last + 1 + i, rowSpan: 1, feat: false }));
    rows.push(`repeat(${extra.length}, ${CELL})`);
  }
  return { cols: 4, rows: rows.join(" "), heads, cells, mode: "mid" };
}

export const layoutFor = (items: IndexItem[], mode: IndexLayout["mode"]): IndexLayout =>
  mode === "wide" ? wideLayout(items) : midLayout(items);
