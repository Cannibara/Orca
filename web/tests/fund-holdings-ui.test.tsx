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

  test("the caption and the legend name the prices, the holdings and the two ends the colours compare", async () => {
    const f = fund(9100002);
    mount();
    await settle();
    const book = f.positions.reduce((s, p) => s + p.shares_now * (prices.get(p.stock_id) ?? 0), 0);
    expect(document.querySelector(".tm-cap")?.textContent).toBe(`${money(book)} at prices of 30 Oct 2026 across 9 holdings`);
    expect(document.querySelector(".tm-lt")?.textContent).toBe("Colour: the fund's return on each holding, Q1 ’26 → 30 Oct 2026");
    expect(Array.from(document.querySelectorAll(".tm-ticks span")).map((s) => s.textContent)).toEqual(["−25%", "0%", "+25%"]);
    const keys = document.querySelector(".tm-keys")!;
    expect(keys).toHaveTextContent("No price data");
    expect(keys).toHaveTextContent("Other stocks");
  });

  test("the colours ask only for the weekly files of the tiles; until they are in, a tile says it is loading", async () => {
    const waiting: (() => void)[] = [];
    weeklyMock.mockImplementation(() => new Promise<Weekly>((ok) => waiting.push(() => ok(flat(50)))));
    mount();
    const f = fund(9100002);
    const held = f.summary.holdings_now.stock_id;
    expect(weeklyMock).toHaveBeenCalledTimes(8); // demand runs eight at a time
    for (const c of weeklyMock.mock.calls) expect(c).toHaveLength(1); // demand, not the background plan
    expect(tiles()[0].getAttribute("aria-label")).toMatch(/fund's return loading$/);
    expect(screen.getByRole("group", { name: /^Holdings at Q2 ’26/ })).toHaveAttribute("aria-busy", "true");
    for (let i = 0; i < 5; i++)
      await act(async () => {
        waiting.splice(0).forEach((go) => go());
        await new Promise((r) => setTimeout(r, 0));
      });
    expect(weeklyMock.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([...held].sort((a, b) => a - b));
    await waitFor(() => expect(tiles()[0].getAttribute("aria-label")).not.toMatch(/loading$/));
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

  test("labels: the ticker, the weight, and on a big tile the value and the name", async () => {
    mount();
    await settle();
    const big = tiles()[0];
    const texts = Array.from(big.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts[0]).toMatch(/^[A-Z.]+$/);
    expect(texts[1]).toMatch(/^\d+\.\d% · \$[\d.]+[KMB]$/);
    expect(texts[2]).not.toBe("");
    expect(document.body.textContent).not.toMatch(/NaN|undefined|Infinity/);
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
    expect(document.querySelector(".tm-lt")?.textContent).toBe("Colour: the fund's return on each holding, Q2 ’25 → 30 Oct 2026");
    expect(Array.from(document.querySelectorAll(".tm-ticks span")).map((s) => s.textContent)).toEqual(["−50%", "0%", "+50%"]);
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
    expect(document.querySelector(".tm-lt")?.textContent).toBe("Colour: the fund's return on each holding, Q4 ’25 → Q1 ’26");
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
    const w0 = width(tile(key));
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    await waitFor(() => expect(document.querySelector(".tm-lt")?.textContent).toContain("Q4 ’25 → Q1 ’26"));
    const wMid = width(tile(key));
    await act(async () => void (await new Promise((r) => setTimeout(r, 800))));
    const w1 = width(tile(key));
    return { w0, wMid, w1 };
  }

  test("a period change tweens a tile from where it was to where it goes", async () => {
    document.documentElement.removeAttribute("data-motion");
    const { w0, wMid, w1 } = await stepBack();
    expect(Math.abs(w1 - w0)).toBeGreaterThan(4); // the step moves this tile
    expect(Math.abs(wMid - w0)).toBeLessThan(Math.abs(wMid - w1)); // just after: still near where it was
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
