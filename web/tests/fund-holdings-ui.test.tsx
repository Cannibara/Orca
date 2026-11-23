import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "../src/charts/Tooltip";
import { loadWeekly, priceMap, stockMap } from "../src/data/api";
import type { LatestPrices, PositionRow, Positions, Securities, Summary, Weekly } from "../src/data/types";
import { money } from "../src/lib/format";
import { positionRows } from "../src/lib/live";
import { priceAt, sharesAt, withSortedTrades, type Timeline } from "../src/fund/positions";
import { holdingReturn } from "../src/fund/treemap";
import { Holdings } from "./holdings-harness";
import { installIdle } from "./idle";

// The Holdings panel: the period picker drives the tree map and the Positions table below it. jsdom cannot lay
// out, so the tree map draws at its fallback size (600 x 440); e2e/smoke.spec.ts sees it in a real browser.

vi.mock("../src/data/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/data/api")>();
  return { ...real, loadWeekly: vi.fn() };
});
const weeklyMock = vi.mocked(loadWeekly);

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(resolve(DEMO, p), "utf8")) as T;
const latest = readJson<LatestPrices>("latest_prices.json");
const prices = priceMap(latest);
const stocks = stockMap(readJson<Securities>("securities.json"));
const fund = (id: number) => ({
  fundId: id,
  summary: readJson<Summary>(`fund/${id}/summary.json`),
  positions: positionRows(readJson<Positions>(`fund/${id}/positions.json`)),
});

/** A weekly file whose quarter-end closes are all `px`. */
const flat = (px: number): Weekly => ({ start: "2013-01-04", close: Array.from({ length: 750 }, () => px), q0: -60, qclose: Array.from({ length: 120 }, () => px) });

let idle: ReturnType<typeof installIdle>;
beforeEach(() => {
  idle = installIdle({ fastClock: false });
  document.documentElement.setAttribute("data-motion", "reduce"); // tiles land at once; one test turns motion back on
  weeklyMock.mockReset();
  weeklyMock.mockImplementation(() => Promise.resolve(flat(50)));
});
afterEach(() => {
  document.documentElement.removeAttribute("data-motion");
  vi.unstubAllGlobals();
});

function mount(id = 9100002) {
  const f = fund(id);
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Holdings {...f} prices={prices} stocks={stocks} asof={latest.asof} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const tiles = () => Array.from(document.querySelectorAll<SVGGElement>("svg.tm g.tile:not(.out)"));
const tile = (ticker: string) => tiles().find((t) => /^[^,:]+/.exec(t.getAttribute("aria-label") ?? "")?.[0] === ticker)!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
/** The return a tile's label prints after its dollar value ("$2.97B · +4.1%"); null when it prints none. */
const labelReturn = (g: SVGGElement): string | null => {
  const text = [".l-w", ".l-v"].map((c) => g.querySelector(c)!.textContent).join(" ");
  return /\$[\d.,]+[KMB]? · ([+−]?\d+\.\d%)/.exec(text)?.[1] ?? null;
};
/** The return in the tile's aria-label: the figure its colour and tooltip use. */
const ariaReturn = (g: SVGGElement): string | null => /fund's return ([+−]?\d+\.\d%) over/.exec(g.getAttribute("aria-label") ?? "")?.[1] ?? null;
const tableValue = (ticker: string) => {
  const heads = Array.from(document.querySelectorAll("#posPanel thead th")).map((th) => th.textContent);
  const tr = document.querySelector(`#posPanel tbody tr[data-t="${ticker}"]`)!;
  return tr.querySelectorAll("td")[heads.indexOf("Value")].textContent;
};

describe("Holdings panel at the newest quarter", () => {
  test("one tile per holding, the same figures as the Positions table below", async () => {
    mount();
    await settle();
    expect(screen.getByRole("heading", { name: "Holdings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Positions" })).toBeInTheDocument();
    expect(document.querySelector("#holdPanel .asof")?.textContent).toBe("Holdings and prices as of 30 Oct 2026");
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#posPanel tbody tr[data-t]"));
    expect(tiles()).toHaveLength(rows.length); // 9 holdings, the one under 1% shown as itself
    for (const r of rows) {
      const t = r.getAttribute("data-t")!;
      expect(tile(t).getAttribute("aria-label")).toContain(`: ${tableValue(t)}, `);
    }
    // biggest first, and one Tab stop: the biggest
    expect(tiles().map((t) => t.getAttribute("tabindex"))).toEqual(["0", ...Array(rows.length - 1).fill("-1")]);
  });

  test("no legend or caption on the page; a screen reader still gets the colours' meaning and the caption", async () => {
    const f = fund(9100002);
    mount();
    await settle();
    const book = f.positions.reduce((s, p) => s + p.shares_now * (prices.get(p.stock_id) ?? 0), 0);
    const cap = document.querySelector(".tm-cap")!;
    expect(cap.textContent).toBe(`${money(book)} at prices of 30 Oct 2026 across 9 holdings`);
    // both visually hidden, in one line
    const said = cap.closest(".vh")!;
    expect(said.querySelector(".tm-lt")?.textContent).toBe("Colour, and the % after each value: the fund's return on each holding, Q1 ’26 → 30 Oct 2026");
    expect(said.textContent).toContain("from a loss of 25% or more in red");
    expect(document.querySelector(".tm-leg, .tm-ticks, .tm-keys")).toBeNull();
  });

  test("the colours ask only for the weekly files of the tiles; until they are in nothing is drawn, then the tiles come in their colours", async () => {
    const waiting: (() => void)[] = [];
    weeklyMock.mockImplementation(() => new Promise<Weekly>((ok) => waiting.push(() => ok(flat(50)))));
    mount();
    const f = fund(9100002);
    const held = f.summary.holdings_now.stock_id;
    expect(weeklyMock).toHaveBeenCalledTimes(8); // demand runs eight at a time
    for (const c of weeklyMock.mock.calls) expect(c).toHaveLength(1); // demand, not the background plan
    expect(tiles()).toHaveLength(0); // no tile in a neutral colour that changes later
    expect(document.querySelector(".tm-msg")?.textContent).toBe("Loading prices…");
    expect(screen.getByRole("group", { name: /^Holdings at Q2 ’26/ })).toHaveAttribute("aria-busy", "true");
    for (let i = 0; i < 5; i++)
      await act(async () => {
        waiting.splice(0).forEach((go) => go());
        await new Promise((r) => setTimeout(r, 0));
      });
    expect(weeklyMock.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([...held].sort((a, b) => a - b));
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    expect(tiles()[0].getAttribute("aria-label")).not.toMatch(/loading$/);
    expect(document.querySelector(".tm-msg")).toBeNull();
    expect(screen.getByRole("group", { name: /^Holdings at Q2 ’26/ })).toHaveAttribute("aria-busy", "false");
  });

  test("a tile's colour is the fund's return on it: start at the last quarter-end close, end at today's price", async () => {
    const f = fund(9100002);
    mount();
    await settle();
    const tl: Timeline = { qmin: f.summary.tracked_since_q, latest: f.summary.period_q, asof: latest.asof };
    const weekly = new Map(f.positions.map((p) => [p.stock_id, flat(50)] as [number, Weekly]));
    for (const p of withSortedTrades(f.positions).filter((x) => sharesAt(x.trades, tl.latest) > 0)) {
      const start = priceAt(p, tl.latest - 1, { tl, prices, weekly });
      const r = holdingReturn(p, tl.latest, tl.latest, start, prices.get(p.stock_id) ?? null, tl);
      const t = stocks.get(p.stock_id)!.ticker;
      const pctText = r === null ? "not available" : `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r * 100).toFixed(1)}% over the quarter`;
      expect(tile(t).getAttribute("aria-label")).toMatch(new RegExp(`fund's return ${pctText.replace(/[+.%]/g, "\\$&")}$`));
    }
    // a tile with a return is filled; the hollow outline is for no return at all
    expect(tiles().filter((t) => t.classList.contains("nul"))).toHaveLength(0);
  });

  test("labels: the ticker, the weight and value, and on a big tile the name", async () => {
    mount();
    await settle();
    const big = tiles()[0];
    const texts = Array.from(big.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts[0]).toMatch(/^[A-Z.]+$/);
    expect(texts[1]).toMatch(/^\d+\.\d% · \$[\d.]+[KMB] · [+−]\d+\.\d%$/); // weight, value, and the return beside them
    expect(texts[2]).not.toBe("");
    expect(document.body.textContent).not.toMatch(/NaN|undefined|Infinity/);
  });

  test("the return on a label is the figure the tile's colour, tooltip and aria-label use", async () => {
    mount();
    await settle();
    expect(labelReturn(tiles()[0])).not.toBeNull();
    let shown = 0;
    for (const t of tiles()) {
      const r = labelReturn(t);
      if (r === null) continue;
      expect(r, t.getAttribute("aria-label")!).toBe(ariaReturn(t));
      shown++;
    }
    expect(shown).toBeGreaterThan(3);
    act(() => tiles()[0].focus());
    const rows = Array.from(document.querySelectorAll("#tip .v")).map((v) => [v.querySelector(".vl")?.textContent, v.querySelector(".vv")?.textContent]);
    expect(rows).toContainEqual(["Fund's return, quarter", labelReturn(tiles()[0])]);
  });

  test("an older quarter and a 12-month period show the return of their own period", async () => {
    mount();
    await settle();
    for (const step of ["quarter", "year"] as const) {
      if (step === "year") {
        fireEvent.click(screen.getByRole("button", { name: "Year" }));
        await settle();
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
        await settle();
      }
      await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
      await waitFor(() => expect(tiles()[0].getAttribute("aria-label")).not.toMatch(/loading$/));
      let shown = 0;
      for (const t of tiles()) {
        const r = labelReturn(t);
        if (r === null) continue;
        expect(r, `${step}: ${t.getAttribute("aria-label")}`).toBe(ariaReturn(t));
        shown++;
      }
      expect(shown, step).toBeGreaterThan(0);
    }
  });

  test("every tile that has a label shows its dollar value: the table's Value for that stock", async () => {
    mount();
    await settle();
    for (const t of tiles()) {
      const ticker = t.querySelector("text.l-tk")!.textContent!;
      if (ticker === "") continue;
      const shown = [".l-w", ".l-v"].map((c) => t.querySelector(c)!.textContent!).join(" ");
      if (t.classList.contains("oth")) expect(shown, ticker).toMatch(/\$/);
      else expect(shown, ticker).toContain(tableValue(ticker));
    }
  });

  test("hover or focus shows the shared tooltip with the tile's figures", async () => {
    mount();
    await settle();
    const t = tiles()[0];
    act(() => t.focus());
    const tip = document.getElementById("tip")!;
    expect(tip).not.toHaveAttribute("hidden");
    const labels = Array.from(tip.querySelectorAll(".vl")).map((l) => l.textContent);
    expect(labels).toEqual(["Value", "Weight", "Fund's return, quarter", "Share price, quarter", "Held since"]);
    expect(tip.querySelector(".t")?.textContent).toMatch(/^[A-Z.]+ · /);
    act(() => t.blur());
    expect(tip).toHaveAttribute("hidden");
    fireEvent.pointerEnter(tiles()[1], { clientX: 10, clientY: 10 });
    expect(tip).not.toHaveAttribute("hidden");
  });

  test("keyboard: one Tab stop; the arrows move to the tile that way, Home and End to the first and last", async () => {
    mount();
    await settle();
    const all = tiles();
    act(() => all[0].focus());
    const rect = (g: SVGGElement) => {
      const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform")!)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    fireEvent.keyDown(all[0], { key: "ArrowRight" });
    const right = document.activeElement as SVGGElement;
    expect(right).not.toBe(all[0]);
    expect(rect(right).x).toBeGreaterThan(rect(all[0]).x);
    expect(right.getAttribute("tabindex")).toBe("0");
    expect(all.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    fireEvent.keyDown(right, { key: "End" });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    // nothing to the left of the first tile: the key is left alone, so it can scroll the page
    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    act(() => void all[0].dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(all[0]);
  });
});

describe("Holdings panel: periods", () => {
  test("Year mode: 12-month returns, the scale at ±50%, the legend's start a year back", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    await settle();
    expect(document.querySelector(".tm-lt")?.textContent).toBe("Colour, and the % after each value: the fund's return on each holding, Q2 ’25 → 30 Oct 2026");
    expect(document.querySelector(".tm-sc")?.textContent).toContain("a loss of 50% or more");
    await waitFor(() => expect(tiles()[0].getAttribute("aria-label")).toMatch(/over 12 months$|not available$/));
    act(() => tiles()[0].focus());
    expect(Array.from(document.querySelectorAll("#tip .vl")).map((l) => l.textContent)).toContain("Fund's return, 12 months");
  });

  test("an older quarter: quarter-end prices, and the table and the tiles move together", async () => {
    mount();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    await settle();
    await waitFor(() => expect(document.querySelector(".tm-cap")?.textContent).toMatch(/at quarter-end prices across \d+ holdings?/));
    expect(document.querySelector("#holdPanel .asof")?.textContent).toBe("Holdings and prices as of 31 Mar 2026");
    expect(document.querySelector(".tm-lt")?.textContent).toBe("Colour, and the % after each value: the fund's return on each holding, Q4 ’25 → Q1 ’26");
    for (const r of Array.from(document.querySelectorAll<HTMLElement>("#posPanel tbody tr[data-t]"))) {
      const t = r.getAttribute("data-t")!;
      if (tableValue(t) === "–") continue; // sold out in the quarter: not a tile
      if (!tile(t)) {
        // under 1% of the book: in the Other stocks tile
        expect(tiles().at(-1)?.getAttribute("aria-label")).toMatch(/^Other stocks: /);
        continue;
      }
      expect(tile(t).getAttribute("aria-label")).toContain(`: ${tableValue(t)}, `);
    }
  });

  test("with the published quarter-end closes an older quarter's tiles add up to the fund's book at that quarter end", async () => {
    weeklyMock.mockImplementation(async (id: number) => readJson<Weekly>(`stock/${id}/weekly.json`));
    const f = fund(9100002);
    mount();
    await settle();
    for (const label of ["Q1 ’26", "Q4 ’25", "Q3 ’25"]) {
      fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
      await waitFor(() => expect(document.querySelector(".tm-lt")?.textContent).toMatch(new RegExp(`→ ${label}$`)));
      const q = f.summary.period_q - ["Q1 ’26", "Q4 ’25", "Q3 ’25"].indexOf(label) - 1;
      const end = f.summary.quarters.end[f.summary.quarters.q.indexOf(q)];
      expect(document.querySelector(".tm-cap")?.textContent).toMatch(new RegExp(`^\\${money(end)} at quarter-end prices`));
    }
  });

  test("the first tracked quarter has nothing to compare with: hollow tiles that say why", async () => {
    mount();
    await settle();
    const f = fund(9100002);
    fireEvent.change(screen.getByRole("combobox", { name: "Pick a quarter" }), { target: { value: String(f.summary.tracked_since_q) } });
    await settle();
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    await waitFor(() => expect(tiles().every((t) => t.classList.contains("nul"))).toBe(true));
    for (const t of tiles()) expect(labelReturn(t), "no return to print, and no dash in its place").toBeNull();
    act(() => tiles()[0].focus());
    expect(document.querySelector("#tip .x")?.textContent).toBe("The data starts at Q1 ’14: there is no Q4 ’13 price to compare.");
  });

  test("holdings under 1% of the book share one Other stocks tile, last, hatched, with their tickers in its tooltip", async () => {
    mount(9100006); // three holdings under 1%
    await settle();
    const other = tiles().at(-1)!;
    expect(other).toHaveClass("oth");
    expect(other.getAttribute("aria-label")).toMatch(/^Other stocks: 3 holdings under 1% each, \$[\d.]+[KMB]?, \d\.\d% of the book$/);
    expect(other.querySelector("rect")?.style.fill).toMatch(/^url\(#tmh/);
    expect(document.querySelector(".tm-cap")?.textContent).toMatch(/across 10 holdings · 3 under 1% grouped as Other stocks$/);
    act(() => other.focus());
    expect(document.querySelector("#tip .t")?.textContent).toBe("Other stocks");
    expect(document.querySelector("#tip .x")?.textContent).toMatch(/^Each under 1% of the book: [A-Z.]+, [A-Z.]+, [A-Z.]+\.$/);
    expect(within(document.getElementById("tip")!).getByText("Stocks").nextSibling?.textContent).toBe("3");
  });
});

describe("Holdings panel: motion", () => {
  const width = (g: SVGGElement) => Number(g.querySelector("rect")!.getAttribute("width"));
  /** The largest tile's width before a step back, just after the new layout lands, and once it has settled. */
  async function stepBack() {
    mount();
    await settle();
    await waitFor(() => expect(tiles()[0].getAttribute("aria-label")).not.toMatch(/loading$/));
    const key = tiles()[0].getAttribute("aria-label")!.split(",")[0];
    // the first draw grows in: let it finish before measuring where the tile starts
    await act(async () => void (await new Promise((r) => setTimeout(r, 800))));
    const w0 = width(tile(key));
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    await waitFor(() => expect(document.querySelector(".tm-lt")?.textContent).toContain("Q4 ’25 → Q1 ’26"));
    const wMid = width(tile(key));
    const fillMid = tile(key).querySelector<SVGRectElement>("rect.tr")!.style.fill;
    const tkMid = tile(key).querySelector("text.l-tk")!.getAttribute("opacity"); // the ticker did not change: it stays
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    const wlab300 = tile(key).querySelector("text.l-w")!.getAttribute("opacity"); // in full by the midway point
    await act(async () => void (await new Promise((r) => setTimeout(r, 800))));
    const w1 = width(tile(key));
    const fill1 = tile(key).querySelector<SVGRectElement>("rect.tr")!.style.fill;
    return { w0, wMid, w1, fillMid, fill1, tkMid, wlab300 };
  }

  test("on landing the tiles grow in, already in their final colours, with their words in by the midway point", async () => {
    document.documentElement.removeAttribute("data-motion");
    mount();
    await settle();
    await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
    const t = tiles()[0];
    const fill = () => t.querySelector<SVGRectElement>("rect.tr")!.style.fill;
    const first = fill();
    expect(first).toMatch(/^rgb\(/); // the colour it keeps, from the first frame
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    const early = Number(t.querySelector("rect.tr")!.getAttribute("width"));
    expect(t.querySelector("text.l-tk")!.textContent).not.toBe(""); // the words are set...
    expect(Number(t.querySelector("text.l-tk")!.getAttribute("opacity"))).toBeLessThan(0.1); // ...but not shown while the box is on its way
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    expect(t.querySelector("text.l-tk")!.getAttribute("opacity")).toBe("1"); // in full by 250 ms
    expect(Number(t.querySelector("rect.tr")!.getAttribute("width"))).toBeGreaterThan(early);
    await act(async () => void (await new Promise((r) => setTimeout(r, 500))));
    const late = Number(t.querySelector("rect.tr")!.getAttribute("width"));
    expect(early).toBeLessThan(late);
    expect(fill()).toBe(first); // no colour animation
  });

  test("the grow-in survives the box being measured wider than the fallback (a real page's first re-measure)", async () => {
    document.documentElement.removeAttribute("data-motion");
    // jsdom cannot lay out: every element reports 900 px, as a desktop page would. The first render still uses 600.
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
    try {
      mount();
      await settle();
      await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
      const t = tiles()[0];
      await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
      const early = Number(t.querySelector("rect.tr")!.getAttribute("width"));
      await act(async () => void (await new Promise((r) => setTimeout(r, 800))));
      const late = Number(t.querySelector("rect.tr")!.getAttribute("width"));
      expect(early).toBeLessThan(late * 0.9); // still growing, not snapped to its final size
      const right = Math.max(...tiles().map((g) => Number(/translate\(([-\d.]+)/.exec(g.getAttribute("transform") ?? "")?.[1]) + width(g)));
      expect(right).toBeGreaterThan(890); // laid out for the measured 900, not the fallback 600
    } finally {
      if (real) Object.defineProperty(HTMLElement.prototype, "clientWidth", real);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  test("a fractional box (browser zoom) still draws when the prices come in after the box is measured", async () => {
    // At 90% zoom the box is 1149.6 px: clientWidth rounds it to 1150, the width hook floors the
    // ResizeObserver's 1149.6 to 1149. The two must count as the same size, or nothing is ever drawn.
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const sizes: Record<string, [number, number]> = { "tm-box": [1150, 1149.6], holdPanel: [1192, 1191.6] };
    const which = (el: Element) => (el.classList.contains("tm-box") ? "tm-box" : el.id === "holdPanel" ? "holdPanel" : null);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const k = which(this);
        return k ? sizes[k][0] : 0;
      },
    });
    const observed: { cb: ResizeObserverCallback; el: Element }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(el: Element) {
          observed.push({ cb: this.cb, el });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    weeklyMock.mockImplementation(() => gate.then(() => flat(50)));
    try {
      mount();
      await settle();
      act(() => {
        for (const { cb, el } of observed) {
          const k = which(el);
          if (k) cb([{ contentRect: { width: sizes[k][1] } } as ResizeObserverEntry], {} as ResizeObserver);
        }
      });
      await settle();
      expect(tiles()).toHaveLength(0); // prices still loading
      release();
      await waitFor(() => expect(tiles().length).toBeGreaterThan(0));
      expect(document.querySelector("svg.tm")!.getAttribute("width")).toBe("1149");
    } finally {
      if (real) Object.defineProperty(HTMLElement.prototype, "clientWidth", real);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  test("a period change moves a tile from where it was to where it goes, and its colour changes at once", async () => {
    document.documentElement.removeAttribute("data-motion");
    const { w0, wMid, w1, fillMid, fill1, tkMid, wlab300 } = await stepBack();
    expect(fillMid).toBe(fill1); // no colour tween
    expect(tkMid).toBe("1");
    expect(wlab300).toBe("1");
    expect(Math.abs(w1 - w0)).toBeGreaterThan(4); // the step moves this tile
    // just after: on its way, not yet where it goes (a fast-out curve, so it may be past halfway)
    expect(wMid).not.toBe(w1);
    expect(Math.min(w0, w1) - 0.5).toBeLessThanOrEqual(wMid);
    expect(wMid).toBeLessThanOrEqual(Math.max(w0, w1) + 0.5);
    expect(Number.isFinite(w1)).toBe(true);
  });

  test("reduced motion puts it in place at once", async () => {
    const { w0, wMid, w1 } = await stepBack();
    expect(Math.abs(w1 - w0)).toBeGreaterThan(4);
    expect(wMid).toBe(w1);
  });
});

describe("Holdings panel: a fund with no priced holding", () => {
  test("says so, with no caption", async () => {
    const f = fund(9100002);
    const none: PositionRow[] = f.positions.map((p) => ({ ...p }));
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Holdings {...f} positions={none} prices={new Map()} stocks={stocks} asof={latest.asof} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByText("The fund held no priced stock at the end of this period.")).toBeInTheDocument();
    expect(document.querySelector(".tm-cap")?.textContent).toBe("");
    expect(idle).toBeDefined();
  });
});
