import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { NotFoundError, loadWeekly, priceMap, stockMap } from "../src/data/api";
import type { LatestPrices, PositionRow, Positions, Securities, Summary, Weekly } from "../src/data/types";
import { positionRows } from "../src/lib/live";
import { PeriodPicker } from "../src/fund/PeriodPicker";
import { PositionsPanel } from "../src/fund/PositionsPanel";
import { PositionsTable } from "../src/fund/PositionsTable";
import { defaultPeriod, neededStocks, prefetchOrder, withSortedTrades, type PeriodState, type PosRow, type Timeline } from "../src/fund/positions";
import { AUTO_FILL_MAX, CHUNK, INITIAL_ROWS, MORE_STEP, rowsAreFilling } from "../src/fund/loading";
import { createWeeklyStore, useWeeklyPrices } from "../src/fund/usePositionData";
import { installIdle } from "./idle";

vi.mock("../src/data/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/data/api")>();
  return { ...real, loadWeekly: vi.fn() };
});
const weeklyMock = vi.mocked(loadWeekly);

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(resolve(DEMO, p), "utf8")) as T;

const latest = readJson<LatestPrices>("latest_prices.json");
const summary = readJson<Summary>("fund/9100002/summary.json");
const positions: PositionRow[] = positionRows(readJson<Positions>("fund/9100002/positions.json"));
const stocks = stockMap(readJson<Securities>("securities.json"));
const prices = priceMap(latest);

afterEach(() => vi.unstubAllGlobals());

const flat = (px: number): Weekly => ({ start: "2013-01-04", close: Array.from({ length: 750 }, () => px) });

beforeAll(() => {
  // jsdom has no layout: the pill's spring-back is an Element.animate call, which is what these tests watch.
  Object.defineProperty(Element.prototype, "animate", {
    value: vi.fn(() => ({ playState: "finished" })),
    configurable: true,
    writable: true,
  });
});

/** requestIdleCallback the tests drive by hand: nothing runs "when the browser is idle" until flushIdle says so. */
let idle: ReturnType<typeof installIdle>;
const flushIdle = () => idle.flush();

beforeEach(() => {
  idle = installIdle({ fastClock: false });
  // The segmented control places its thumb in an animation frame; run it at once, inside the render's act.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  weeklyMock.mockReset();
  weeklyMock.mockImplementation(() => Promise.resolve(flat(50)));
  (Element.prototype.animate as unknown as ReturnType<typeof vi.fn>).mockClear();
});

function panel() {
  return render(
    <MemoryRouter>
      <PositionsPanel fundId={9100002} summary={summary} positions={positions} prices={prices} stocks={stocks} asof={latest.asof} />
    </MemoryRouter>,
  );
}

const rowsOf = () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr[data-t]"));
const tickers = () => rowsOf().map((r) => r.getAttribute("data-t"));
const asOfText = () => document.querySelector(".asof")?.textContent;
const selected = () => document.querySelector(".pi.on > span")?.textContent;

describe("PositionsPanel at the newest quarter", () => {
  test("title, as-of date, the 13 columns in order, 38px rows' content and Weight descending by default", () => {
    panel();
    expect(screen.getByRole("heading", { name: "Positions" })).toBeInTheDocument();
    expect(asOfText()).toBe("Positions and prices as of 30 Oct 2026");
    const heads = Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(heads).toEqual([
      "Stock",
      "Held",
      "Weight",
      "Return",
      "IRR",
      "Value",
      "Avg cost",
      "Price",
      "Avg exit",
      "Last change",
      "Realised",
      "Unrealised",
      "Total P&L",
    ]);
    expect(document.querySelectorAll("colgroup col")).toHaveLength(13);
    expect(screen.getByRole("columnheader", { name: "Weight" })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Stock" })).toHaveAttribute("aria-sort", "none");
    // the demo fund holds 9 positions now; sold-out ones are not in the newest quarter's view
    expect(rowsOf()).toHaveLength(9);
    expect(tickers()[0]).toBe("GOOGL");
    expect(screen.getByRole("region", { name: "Positions table, scrollable" })).toHaveAttribute("tabindex", "0");
  });

  test("the first row prints the artifact's figures: whole numbers, money in millions, tinted change boxes", () => {
    panel();
    const cells = Array.from(rowsOf()[0].querySelectorAll("td")).map((td) => td.textContent);
    // Stock, Held, Weight, Return, IRR, Value, Avg cost, Price, Avg exit, Last change, Realised, Unrealised, Total
    expect(cells.slice(1)).toEqual(["Q3 ’20", "25%", "−5%", "−5%", "$2,968m", "$158", "$137", "–", "–", "+$469m", "−$789m", "−$235m"]);
    const ge = rowsOf().find((r) => r.getAttribute("data-t") === "GE")!;
    expect(within(ge).getByText("Added")).toBeInTheDocument();
    expect(ge.querySelector(".lc.add b")?.textContent).toBe("+6.0%");
  });

  test("the newest quarter needs no weekly file before the browser is idle; then the background prefetch begins", async () => {
    panel();
    expect(weeklyMock).not.toHaveBeenCalled();
    await flushIdle();
    expect(weeklyMock).toHaveBeenCalled();
  });

  test("clicking a heading sorts every row; clicking it again reverses; text starts ascending", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Stock" }));
    expect(screen.getByRole("columnheader", { name: "Stock" })).toHaveAttribute("aria-sort", "ascending");
    const t = tickers() as string[];
    expect(t).toEqual([...t].sort());
    fireEvent.click(screen.getByRole("button", { name: "Stock" }));
    expect(tickers()).toEqual([...t].reverse());
    fireEvent.click(screen.getByRole("button", { name: "Total P&L" }));
    expect(screen.getByRole("columnheader", { name: "Total P&L" })).toHaveAttribute("aria-sort", "descending");
  });

  test("a row opens into the price chart and the trades, with a link to the full page; Enter, Space and the arrows work", async () => {
    panel();
    const first = rowsOf()[0];
    expect(first).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    const link = await screen.findByRole("link", { name: "Open full page" });
    const id = positions.find((p) => stocks.get(p.stock_id)?.ticker === "GOOGL")!.stock_id;
    expect(link).toHaveAttribute("href", `/fund/9100002/stock/${id}`);
    await screen.findByRole("img", { name: /share price with the fund's buys and sells/ });
    expect(weeklyMock).toHaveBeenCalledTimes(1);
    expect(weeklyMock).toHaveBeenCalledWith(id);
    expect(document.querySelector(".xtbl caption")?.textContent).toMatch(/^When the fund bought and sold /);
    expect(document.querySelectorAll(".xtbl tbody tr").length).toBe(positions.find((p) => p.stock_id === id)!.trades.length);
    // Space closes it again
    fireEvent.keyDown(first, { key: " " });
    expect(first).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(first, { key: "Enter" });
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".xrow")).toHaveLength(1);
    await screen.findByRole("img", { name: /share price/ });
    // ArrowDown skips the opened panel and lands on the next position
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowsOf()[1]);
    fireEvent.keyDown(rowsOf()[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  test("a stock without a weekly file says so", async () => {
    weeklyMock.mockImplementation(() => Promise.reject(new NotFoundError("x/weekly.json")));
    panel();
    fireEvent.click(rowsOf()[0]);
    expect(await screen.findByText("No price history for this stock.")).toBeInTheDocument();
    expect(document.querySelectorAll(".xtbl tbody tr").length).toBeGreaterThan(0);
  });
});

describe("the period picker", () => {
  test("starts on the newest quarter with three periods in full and peeks either side", () => {
    panel();
    expect(selected()).toBe("Q2 ’26");
    const pills = Array.from(document.querySelectorAll(".ptrack .pi:not(.hole)")).map((p) =>
      p.textContent?.replace(/\s+/g, " ").trim().slice(0, 6),
    );
    expect(pills).toHaveLength(4); // the window is Q3 ’25 (peek) .. Q2 ’26, then an empty slot past the newest
    expect(document.querySelectorAll(".ptrack .pi.hole")).toHaveLength(1);
    expect(document.querySelectorAll(".ptrack .pi.edge")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Later quarter" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Later quarter" })).not.toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Pick a quarter" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Quarter" })).toHaveAttribute("title", "Scroll with the mouse wheel to change quarter");
  });

  test("stepping back loads the weekly files it needs, keeps the old rows meanwhile and shows 'Loading prices…'", async () => {
    const waiting: (() => void)[] = [];
    weeklyMock.mockImplementation(() => new Promise<Weekly>((ok) => waiting.push(() => ok(flat(50)))));
    panel();
    const before = tickers();
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    expect(selected()).toBe("Q1 ’26");
    expect(asOfText()).toBe("Positions and prices as of 31 Mar 2026");
    expect(screen.getByRole("status")).toHaveTextContent("Loading prices…");
    expect(tickers()).toEqual(before); // the previous quarter's rows stay until the prices are in
    expect(weeklyMock.mock.calls.length).toBeGreaterThan(0);
    await act(async () => {
      for (let i = 0; i < 40 && waiting.length; i++) {
        waiting.splice(0).forEach((f) => f());
        await Promise.resolve();
      }
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByRole("region", { name: "Positions table, scrollable" })).toHaveAttribute("aria-busy", "false");
    expect(rowsOf().length).toBeGreaterThan(0);
  });

  test("at the ends the arrows stay clickable, the period does not change and the selected pill springs back", () => {
    panel();
    const later = screen.getByRole("button", { name: "Later quarter" });
    fireEvent.click(later);
    expect(selected()).toBe("Q2 ’26");
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1);
    const keyframes = (Element.prototype.animate as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Keyframe[];
    expect(keyframes[1].transform).toBe("translateX(14px) scaleX(1.06)"); // towards the missing side
  });

  test("the mouse wheel over the header or the tools steps through periods: down goes back in time", async () => {
    panel();
    fireEvent.wheel(document.querySelector(".ptools")!, { deltaY: 120 });
    expect(selected()).toBe("Q1 ’26");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    await new Promise((r) => setTimeout(r, 70)); // steps come no faster than every 60ms
    fireEvent.wheel(document.querySelector("#posPanel > .ph")!, { deltaY: -120 });
    expect(selected()).toBe("Q2 ’26");
    // up at the newest: no change, a jiggle
    (Element.prototype.animate as unknown as ReturnType<typeof vi.fn>).mockClear();
    await new Promise((r) => setTimeout(r, 70)); // steps come no faster than every 60ms
    fireEvent.wheel(document.querySelector(".ptools")!, { deltaY: -120 });
    expect(selected()).toBe("Q2 ’26");
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1);
  });

  test("wheel lines and pages count as pixels: one line is 16px, which is under the step", async () => {
    panel();
    await new Promise((r) => setTimeout(r, 70));
    fireEvent.wheel(document.querySelector(".ptools")!, { deltaY: 1, deltaMode: 1 }); // 16px
    expect(selected()).toBe("Q2 ’26");
    fireEvent.wheel(document.querySelector(".ptools")!, { deltaY: 1, deltaMode: 1 }); // 32px in total
    expect(selected()).toBe("Q1 ’26");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  test("Year: full years, the part year named by the quarters it covers, the as-of date of the year's last quarter", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(selected()).toBe("2025");
    expect(screen.getByRole("group", { name: "Year" })).toBeVisible();
    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>(".psel-o option")).map((o) => o.textContent);
    expect(opts[0]).toBe("2026 H1");
    expect(opts.at(-1)).toBe("2014");
    expect(opts).toHaveLength(13);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(asOfText()).toBe("Positions and prices as of 31 Dec 2025");
    fireEvent.change(screen.getByRole("combobox", { name: "Pick a year" }), { target: { value: "2026" } });
    expect(selected()).toBe("2026 H1");
    expect(asOfText()).toBe("Positions and prices as of 30 Oct 2026");
    expect(screen.getByRole("button", { name: "Later year" })).toHaveAttribute("aria-disabled", "true");
  });

  test("Custom shows the strip of quarters, hides the stepper, and the Last change column becomes Change", () => {
    panel();
    expect(screen.getByRole("columnheader", { name: "Last change" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByRole("group", { name: /Custom period for the positions table/ })).toBeInTheDocument();
    expect(document.querySelector(".stepper")).toHaveAttribute("hidden");
    expect(screen.getByRole("columnheader", { name: "Change" })).toBeInTheDocument();
    // the strip starts on the last four quarters: Q3 ’25 .. Q2 ’26
    expect(screen.getByRole("slider", { name: "Start of the period" })).toHaveAttribute("aria-valuetext", "Q3 ’25");
    expect(screen.getByRole("slider", { name: "End of the period" })).toHaveAttribute("aria-valuetext", "Q2 ’26");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Start of the period" }), { key: "ArrowLeft" });
    expect(screen.getByRole("slider", { name: "Start of the period" })).toHaveAttribute("aria-valuetext", "Q2 ’25");
    // wheeling over the custom period does nothing
    fireEvent.wheel(document.querySelector(".ptools")!, { deltaY: 120 });
    expect(asOfText()).toBe("Positions and prices as of 30 Oct 2026");
  });

  test("PeriodPicker alone: the select picks a quarter and the pills move", () => {
    const tl: Timeline = { qmin: 4, latest: 53, asof: "2026-10-30" };
    let state: PeriodState = defaultPeriod(tl);
    const onChange = vi.fn((s: PeriodState) => (state = s));
    const { rerender } = render(<PeriodPicker state={state} onChange={onChange} tl={tl} asOf="30 Oct 2026" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Pick a quarter" }), { target: { value: "40" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pq: 40, mode: "quarter" }));
    rerender(<PeriodPicker state={state} onChange={onChange} tl={tl} asOf="31 Dec 2023" />);
    // five slots: the edge of one period, three in full with the selected one in the middle, the edge of the next
    const labels = Array.from(document.querySelectorAll(".ptrack .pi > span")).map((s) => s.textContent);
    expect(labels).toEqual(["Q3 ’22", "Q4 ’22", "Q1 ’23", "Q2 ’23", "Q3 ’23"]);
  });
});

describe("weekly price loading", () => {
  test("at most 8 files in flight at once; everything loads; a missing file is null", async () => {
    let inFlight = 0;
    let peak = 0;
    weeklyMock.mockImplementation((id: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<Weekly>((ok, no) =>
        setTimeout(() => {
          inFlight--;
          if (id === 7) no(new NotFoundError("weekly"));
          else ok(flat(id));
        }, 5),
      );
    });
    const ids = Array.from({ length: 30 }, (_, i) => i + 1);
    const store = createWeeklyStore();
    const { result } = renderHook(() => useWeeklyPrices(store, ids));
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false), { timeout: 3000 });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    expect(result.current.weekly.size).toBe(30);
    expect(result.current.weekly.get(7)).toBeNull();
    expect(result.current.weekly.get(8)?.close[0]).toBe(8);
    expect(result.current.failed).toBe(0); // a 404 is "no file", not a failure
  });

  test("other failures count as failed and the panel says its prices fell back to trade prices", async () => {
    weeklyMock.mockImplementation(() => Promise.reject(new Error("HTTP 500")));
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not be loaded/));
    expect(rowsOf().length).toBeGreaterThan(0);
  });
});

describe("a fund with thousands of positions", () => {
  const mk = (i: number): PosRow => {
    const pos = {
      stock_id: i,
      from_q: 10,
      to_q: null,
      avg_cost: 10,
      avg_exit: null,
      invested: 1000,
      realised: 0,
      dividends: 0,
      shares_now: 1,
      cost_now: 10,
      last_q: 53,
      last_type: "new",
      last_pct: null,
      last_usd: 1,
      trades: [],
    } as PositionRow;
    return {
      id: i,
      pos,
      ticker: "T" + String(i).padStart(4, "0"),
      name: "Company " + i,
      from: 10,
      to: null,
      open: true,
      px: 10,
      val: 100 + i,
      w: i / 100,
      ac: 10,
      ax: null,
      ret: i / 1000,
      re: 0,
      unreal: 5,
      total: i,
      tag: null,
      dw: null,
      irr: () => null,
    };
  };
  // The cap, one "Show more" step and a remainder of 40: the table has to be told apart at every stage.
  const TOTAL = AUTO_FILL_MAX + MORE_STEP + 40;
  const rows = Array.from({ length: TOTAL }, (_, i) => mk(i + 1));
  // jsdom draws rows far slower than a browser: give the pacing a fast clock, so chunks stay CHUNK unless a test says otherwise
  beforeEach(() => void vi.spyOn(performance, "now").mockReturnValue(1000));
  afterEach(() => void vi.restoreAllMocks());

  const table = (r: PosRow[] = rows, failed = 0) => (
    <MemoryRouter>
      <PositionsTable fundId={1} rows={r} pending={false} failed={failed} mode="quarter" latest={new Map()} />
    </MemoryRouter>
  );
  const byWeight = rows.map((r) => r.ticker).reverse(); // Weight descending: the last row first
  const byTicker = [...byWeight].sort();
  const footer = () => document.querySelector(".t-more")?.textContent;
  const showMore = () => screen.queryByRole("button", { name: /^Show / });
  const n = (v: number) => v.toLocaleString("en-US");
  const label = (left: number) => `Show ${n(Math.min(MORE_STEP, left))} more` + (left > MORE_STEP ? ` · ${n(left)} left` : "");
  /** Idle until the automatic fill is done. */
  const fill = () => idle.flushAll();

  test("the numbers: a first page of a few screens, an automatic fill of a few hundred rows, a click adds more", () => {
    expect(INITIAL_ROWS).toBeGreaterThanOrEqual(30); // at least two screens of the table
    expect(INITIAL_ROWS).toBeLessThanOrEqual(100);
    expect(AUTO_FILL_MAX).toBeGreaterThan(INITIAL_ROWS);
    expect(AUTO_FILL_MAX).toBeLessThan(1000);
    expect(CHUNK).toBeLessThanOrEqual(INITIAL_ROWS);
    expect(MORE_STEP).toBeGreaterThanOrEqual(CHUNK);
  });

  test("nothing but the first rows before the browser is idle: no more rows, no button, a quiet line says what is coming", () => {
    render(table());
    expect(rowsOf()).toHaveLength(INITIAL_ROWS);
    expect(tickers()).toEqual(byWeight.slice(0, INITIAL_ROWS));
    expect(idle.pending.size).toBe(1); // the first chunk is only waiting for idle
    expect(showMore()).toBeNull();
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - INITIAL_ROWS} more…`);
    expect(document.querySelector(".t-more .btn, .t-more svg, .t-more [role=progressbar]")).toBeNull(); // quiet: no spinner
  });

  test("once idle, rows follow CHUNK at a time in the sorted order up to the cap, and the line counts down", async () => {
    render(table());
    await flushIdle();
    expect(rowsOf()).toHaveLength(INITIAL_ROWS + CHUNK);
    expect(tickers()).toEqual(byWeight.slice(0, INITIAL_ROWS + CHUNK));
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - INITIAL_ROWS - CHUNK} more…`);
    await fill();
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX);
    expect(tickers()).toEqual(byWeight.slice(0, AUTO_FILL_MAX));
    expect(idle.pending.size).toBe(0); // and nothing more is scheduled: the rest waits for a click
  });

  test("at the cap the line gives way to 'Show N more · M left'; the rows beyond it are not drawn", async () => {
    render(table());
    await fill();
    expect(footer()).toBe(label(TOTAL - AUTO_FILL_MAX));
    expect(showMore()).toBeInTheDocument();
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX);
  });

  test("'Show more' adds MORE_STEP rows at once, in the sorted order of all rows; the last click says just how many are left", async () => {
    render(table());
    await fill();
    fireEvent.click(showMore()!);
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    expect(tickers()).toEqual(byWeight.slice(0, AUTO_FILL_MAX + MORE_STEP));
    expect(footer()).toBe("Show 40 more"); // the last 40: no '· left' when that is all there is
    expect(idle.pending.size).toBe(0); // clicking does not restart the automatic fill
    fireEvent.click(showMore()!);
    expect(rowsOf()).toHaveLength(TOTAL);
    expect(tickers()).toEqual(byWeight);
    expect(document.querySelector(".t-more")).toBeNull(); // everything is shown: no button, no line
  });

  test("the button is there only once the cap is reached: clicking cannot jump ahead of the fill", async () => {
    render(table());
    expect(showMore()).toBeNull();
    await flushIdle();
    expect(showMore()).toBeNull();
  });

  test("what a click added survives re-renders that keep the same rows", async () => {
    const view = render(table());
    await fill();
    fireEvent.click(showMore()!);
    view.rerender(table(rows, 3)); // another prop changed, the rows are the very same
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    expect(footer()).toBe("Show 40 more");
    await act(async () => void fireEvent.click(rowsOf()[0])); // opening a row is a re-render too
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
  });

  test("a re-sort starts again from the first rows, whatever was added, and the order covers every row", async () => {
    render(table());
    await fill();
    fireEvent.click(showMore()!);
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    fireEvent.click(screen.getByRole("button", { name: "Stock" }));
    expect(rowsOf()).toHaveLength(INITIAL_ROWS); // a click's rows are forgotten with the order they belonged to
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - INITIAL_ROWS} more…`);
    expect(tickers()).toEqual(byTicker.slice(0, INITIAL_ROWS)); // the smallest tickers of ALL rows, drawn or not before
    await fill();
    expect(tickers()).toEqual(byTicker.slice(0, AUTO_FILL_MAX));
    expect(footer()).toBe(label(TOTAL - AUTO_FILL_MAX));
    fireEvent.click(screen.getByRole("button", { name: "Stock" })); // descending
    expect(tickers()).toEqual([...byTicker].reverse().slice(0, INITIAL_ROWS));
    await fill();
    fireEvent.click(showMore()!);
    fireEvent.click(showMore()!);
    expect(tickers()).toEqual([...byTicker].reverse());
  });

  test("a new period (new rows) starts again from the first rows", async () => {
    const { rerender } = render(table());
    await fill();
    fireEvent.click(showMore()!);
    rerender(table(rows.slice(0, AUTO_FILL_MAX + 60)));
    expect(rowsOf()).toHaveLength(INITIAL_ROWS);
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - INITIAL_ROWS} more…`);
    await fill();
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX);
    expect(footer()).toBe("Show 60 more");
  });

  test("a table that fits under the cap fills in completely by itself, with no button at all", async () => {
    render(table(rows.slice(0, AUTO_FILL_MAX - 20)));
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - 20 - INITIAL_ROWS} more…`);
    await fill();
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX - 20);
    expect(document.querySelector(".t-more")).toBeNull();
    expect(showMore()).toBeNull();
    expect(idle.pending.size).toBe(0);
  });

  test("a table that fits in the first rows has no footer and schedules nothing", () => {
    render(table(rows.slice(0, INITIAL_ROWS)));
    expect(rowsOf()).toHaveLength(INITIAL_ROWS);
    expect(document.querySelector(".t-more")).toBeNull();
    expect(idle.pending.size).toBe(0);
  });

  test("a row that is open stays open while chunks arrive and rows are added, and the rows before it are not redrawn", async () => {
    render(table());
    const first = rowsOf()[0];
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-expanded", "true");
    await fill();
    fireEvent.click(showMore()!);
    expect(rowsOf()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    expect(rowsOf()[0]).toBe(first); // the same element: React kept it
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelectorAll(".xrow")).toHaveLength(1);
  });

  test("every chunk is CHUNK rows, however slow the clock: the browser slices the work, the size does not shrink", async () => {
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
    render(table());
    await flushIdle();
    expect(rowsOf()).toHaveLength(INITIAL_ROWS + CHUNK);
    await flushIdle();
    expect(rowsOf()).toHaveLength(INITIAL_ROWS + 2 * CHUNK);
  });

  test("unmounting stops the fill: the idle callback is cancelled", () => {
    const { unmount } = render(table());
    expect(idle.pending.size).toBe(1);
    unmount();
    expect(idle.pending.size).toBe(0);
  });

  test("while rows are still being added the page says so (the price prefetch waits for it); not at the cap, not after unmount", async () => {
    const { unmount } = render(table());
    expect(rowsAreFilling()).toBe(true);
    await flushIdle();
    expect(rowsAreFilling()).toBe(true);
    await fill();
    expect(rowsAreFilling()).toBe(false); // the button waits for a click: nothing is being added by itself
    unmount();
    expect(rowsAreFilling()).toBe(false);
    const again = render(table());
    expect(rowsAreFilling()).toBe(true);
    again.unmount(); // unmounted in the middle of a fill
    expect(rowsAreFilling()).toBe(false);
  });

  test("'Loading prices…' says how far the files are", () => {
    render(
      <MemoryRouter>
        <PositionsTable fundId={1} rows={rows.slice(0, 5)} pending failed={0} progress={{ done: 120, total: 340 }} mode="quarter" latest={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading prices… 120 of 340");
  });

  test("an empty period says the fund held nothing", () => {
    render(
      <MemoryRouter>
        <PositionsTable fundId={1} rows={[]} pending={false} failed={0} mode="year" latest={new Map()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("The fund held nothing in this period.")).toBeInTheDocument();
  });
});

describe("background prefetch of every position's weekly file", () => {
  const sorted = withSortedTrades(positions);
  const tl: Timeline = { qmin: summary.tracked_since_q, latest: summary.period_q, asof: latest.asof };
  const plan = prefetchOrder(sorted, tl, prices);
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  /** Weekly loads that stay in flight until the test lets them go. */
  function held() {
    const open: { id: number; go: () => void }[] = [];
    weeklyMock.mockImplementation((id: number) => new Promise<Weekly>((ok) => open.push({ id, go: () => ok(flat(id)) })));
    const release = async (n = Infinity) => {
      open.splice(0, n).forEach((o) => o.go());
      await flush();
    };
    return { open, release };
  }
  const calledIds = () => weeklyMock.mock.calls.map((c) => c[0]);
  const errors = () => vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).connection;
    delete (document as unknown as Record<string, unknown>).hidden;
    vi.restoreAllMocks();
  });

  test("starts when the browser is idle: held positions first, low fetch priority, three at a time, every position once", async () => {
    const { open, release } = held();
    panel();
    expect(weeklyMock).not.toHaveBeenCalled();
    await flushIdle();
    expect(calledIds()).toEqual(plan.slice(0, 3));
    expect(plan.slice(0, 9).every((id) => positions.find((p) => p.stock_id === id)!.shares_now > 0)).toBe(true); // the 9 held now come first
    for (const c of weeklyMock.mock.calls) expect(c[1]).toEqual({ priority: "low" });
    expect(open).toHaveLength(3);
    for (let i = 0; i < 30 && calledIds().length < plan.length; i++) {
      await release();
      expect(open.length).toBeLessThanOrEqual(3);
    }
    expect(calledIds()).toEqual(plan);
  });

  test("when the table has rows still to draw, the prefetch waits until it is done with them", async () => {
    // 120 held positions: the table draws 50, then 25, 25 and 20 more in idle time
    const held = sorted.find((p) => p.shares_now > 0)!;
    const many = Array.from({ length: 120 }, (_, i) => ({ ...held, stock_id: 1000 + i }));
    const prices2 = new Map(many.map((p) => [p.stock_id, 10 + (p.stock_id % 7)] as [number, number]));
    const stocks2 = new Map(many.map((p) => [p.stock_id, { ticker: "X" + p.stock_id, name: "X" + p.stock_id }] as const));
    render(
      <MemoryRouter>
        <PositionsPanel fundId={9100002} summary={summary} positions={many} prices={prices2} stocks={stocks2} asof={latest.asof} />
      </MemoryRouter>,
    );
    expect(rowsOf()).toHaveLength(INITIAL_ROWS);
    for (let i = 0; i < 3; i++) {
      await flushIdle(); // a chunk of rows, and the prefetch asking whether it may begin yet
      expect(weeklyMock).not.toHaveBeenCalled();
    }
    expect(rowsOf()).toHaveLength(120);
    await flushIdle(); // the rows are all in: now the prices
    expect(weeklyMock).toHaveBeenCalled();
    expect(weeklyMock.mock.calls[0][1]).toEqual({ priority: "low" });
  });

  test("Save-Data and 2G: no background prefetch at all", async () => {
    for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
      weeklyMock.mockClear();
      const { unmount } = panel();
      await flushIdle();
      await flush();
      expect(weeklyMock).not.toHaveBeenCalled();
      unmount();
    }
  });

  test("a hidden tab pauses it; it resumes when the tab is visible again", async () => {
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const { open, release } = held();
    panel();
    await flushIdle();
    expect(weeklyMock).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(calledIds()).toEqual(plan.slice(0, 3));
    hidden = true;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await release();
    expect(calledIds()).toHaveLength(3); // nothing new while hidden
    expect(open).toHaveLength(0);
    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(calledIds()).toEqual(plan.slice(0, 6));
  });

  test("unmounting cancels it: nothing more is requested, nothing is set after, no warnings", async () => {
    const err = errors();
    const { open, release } = held();
    const view = panel();
    await flushIdle();
    expect(calledIds()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" })); // demand in flight as well
    await flush();
    const calls = calledIds().length;
    expect(calls).toBeGreaterThan(3);
    view.unmount();
    expect(idle.pending.size).toBe(0);
    await release();
    await release();
    await flush();
    expect(calledIds()).toHaveLength(calls);
    expect(open).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
  });

  test("unmounting before the idle moment leaves no callback behind and requests nothing", async () => {
    const view = panel();
    expect(idle.pending.size).toBeGreaterThan(0);
    view.unmount();
    expect(idle.pending.size).toBe(0);
    await flushIdle();
    expect(weeklyMock).not.toHaveBeenCalled();
  });

  test("a new fund (the panel is keyed by it) starts a plan of its own and drops the old one", async () => {
    const { release } = held();
    const props = { summary, positions, prices, stocks, asof: latest.asof };
    const view = render(
      <MemoryRouter>
        <PositionsPanel fundId={9100002} {...props} />
      </MemoryRouter>,
    );
    await flushIdle();
    expect(calledIds()).toEqual(plan.slice(0, 3));
    view.rerender(
      <MemoryRouter>
        <PositionsPanel fundId={9100003} {...props} />
      </MemoryRouter>,
    );
    expect(idle.pending.size).toBeGreaterThan(0); // the new panel waits for idle
    await flushIdle();
    expect(calledIds()).toEqual([...plan.slice(0, 3), ...plan.slice(0, 3)]); // it begins at the top again
    await release(); // everything in flight lands: the old panel starts nothing more, the new one carries on
    expect(calledIds()).toEqual([...plan.slice(0, 3), ...plan.slice(0, 3), ...plan.slice(3, 6)]);
  });

  test("stepping back after the prefetch has finished makes no new requests and never shows 'Loading prices…'", async () => {
    panel();
    await flushIdle();
    await waitFor(() => expect(weeklyMock).toHaveBeenCalledTimes(plan.length));
    await flush();
    const calls = weeklyMock.mock.calls.length;
    for (const label of ["Q1 ’26", "Q4 ’25", "Q3 ’25", "Q2 ’25"]) {
      fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
      expect(selected()).toBe(label);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("region", { name: "Positions table, scrollable" })).toHaveAttribute("aria-busy", "false");
      expect(rowsOf().length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.queryByRole("status")).toBeNull();
    await flush();
    expect(weeklyMock).toHaveBeenCalledTimes(calls);
  });

  test("a missing file (404) is remembered as 'no price history': not retried, not reported", async () => {
    weeklyMock.mockImplementation(() => Promise.reject(new NotFoundError("x/weekly.json")));
    panel();
    await flushIdle();
    await waitFor(() => expect(weeklyMock).toHaveBeenCalledTimes(plan.length));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    await flush();
    expect(weeklyMock).toHaveBeenCalledTimes(plan.length);
    expect(screen.queryByRole("status")).toBeNull(); // neither "Loading prices…" nor the could-not-be-loaded note
    expect(rowsOf().length).toBeGreaterThan(0);
  });

  test("stepping back before it has finished: the loads under way are waited for, the rest jump the plan, the count moves", async () => {
    const { open, release } = held();
    panel();
    await flushIdle();
    const underWay = calledIds();
    expect(underWay).toEqual(plan.slice(0, 3));
    const before = tickers();
    fireEvent.click(screen.getByRole("button", { name: "Earlier quarter" }));
    const need = neededStocks(sorted, tl.latest - 1, tl.latest - 1, tl);
    expect(need.length).toBeGreaterThan(8);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(`Loading prices… 0 of ${need.length}`);
    expect(tickers()).toEqual(before); // the previous rows stay
    await flush();
    // each file is requested once: the three under way are not asked for again, and demand is not held up
    // by the background plan's three slots
    const ids = calledIds();
    expect(new Set(ids).size).toBe(ids.length);
    const demandCalls = weeklyMock.mock.calls.filter((c) => c.length === 1).map((c) => c[0]);
    expect(demandCalls.length).toBe(5); // 8 demand loads in flight: the 3 promoted ones and 5 new
    expect(demandCalls.every((id) => need.includes(id))).toBe(true);
    expect(underWay.every((id) => need.includes(id))).toBe(true);
    expect(weeklyMock.mock.calls.filter((c) => c.length === 2)).toHaveLength(3); // no new background load while demand waits
    // some arrive: the count follows (it updates a few times a second, and at once at the end)
    await release(6);
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Loading prices… [1-9]\d* of /));
    for (let i = 0; i < 40 && screen.queryByRole("status"); i++) await release();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(open.length).toBeLessThanOrEqual(3);
    expect(rowsOf().length).toBeGreaterThan(0);
  });

  test("opening a row asks for its file ahead of the plan", async () => {
    const { release } = held();
    panel();
    await flushIdle();
    const last = rowsOf().at(-1)!;
    const id = positions.find((p) => stocks.get(p.stock_id)?.ticker === last.getAttribute("data-t"))!.stock_id;
    expect(calledIds()).not.toContain(id);
    fireEvent.click(last);
    await flush();
    expect(weeklyMock).toHaveBeenLastCalledWith(id); // demand: no low priority
    await release();
    await screen.findByRole("img", { name: /share price/ });
  });
});
