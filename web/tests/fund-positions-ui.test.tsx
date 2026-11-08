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
import { defaultPeriod, type PeriodState, type PosRow, type Timeline } from "../src/fund/positions";
import { useWeeklyPrices } from "../src/fund/usePositionData";

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

beforeEach(() => {
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

  test("the newest quarter needs no weekly file", () => {
    panel();
    expect(weeklyMock).not.toHaveBeenCalled();
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
    const { result } = renderHook(() => useWeeklyPrices(ids));
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
  const rows = Array.from({ length: 400 }, (_, i) => mk(i + 1));

  test("draws 150 rows, then more on request; sorting always covers all rows", () => {
    render(
      <MemoryRouter>
        <PositionsTable fundId={1} rows={rows} pending={false} failed={0} mode="quarter" latest={new Map()} />
      </MemoryRouter>,
    );
    expect(rowsOf()).toHaveLength(150);
    expect(screen.getByText("150 of 400 positions shown")).toBeInTheDocument();
    // default sort is Weight descending (value order): T0400 first even though it is the last row of the input
    expect(tickers()[0]).toBe("T0400");
    fireEvent.click(screen.getByRole("button", { name: "Stock" }));
    expect(tickers()[0]).toBe("T0001");
    fireEvent.click(screen.getByRole("button", { name: "Show 150 more" }));
    expect(rowsOf()).toHaveLength(300);
    fireEvent.click(screen.getByRole("button", { name: "Show 100 more" }));
    expect(rowsOf()).toHaveLength(400);
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
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
