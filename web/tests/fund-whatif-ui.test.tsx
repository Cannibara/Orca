import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { loadWeekly, priceMap, stockMap } from "../src/data/api";
import type { Exits, LatestPrices, Positions, Securities, Summary, Weekly } from "../src/data/types";
import { missed, positionRows } from "../src/lib/live";
import { PositionsPanel } from "../src/fund/PositionsPanel";
import { WhatIfPanel } from "../src/fund/WhatIfPanel";
import { AUTO_FILL_MAX, CHUNK, INITIAL_ROWS, MORE_STEP } from "../src/fund/loading";
import { installIdle } from "./idle";
import { ASOF, FUND, NEWEST, NO_EXITS, exitsOf, pos, pricesOf, sold, stocksTo, summaryOf, trade, type ExitIn } from "./fund-whatif-fixtures";

// "What if they'd kept it" (src/fund/WhatIfPanel.tsx): the sales table at the foot of the fund page.
// The pure model has its own tests (fund-whatif.test.ts); the Positions table above it is src/fund/PositionsTable.

vi.mock("../src/data/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/data/api")>();
  return { ...real, loadWeekly: vi.fn() };
});
const weeklyMock = vi.mocked(loadWeekly);
const flat = (px: number): Weekly => ({ start: "2013-01-04", close: Array.from({ length: 750 }, () => px) });

beforeAll(() => {
  // jsdom has no layout and no Element.animate: the period picker of the Positions panel calls it
  Object.defineProperty(Element.prototype, "animate", { value: vi.fn(() => ({ playState: "finished" })), configurable: true, writable: true });
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  weeklyMock.mockReset();
  weeklyMock.mockImplementation(() => Promise.resolve(flat(50)));
});

afterEach(() => vi.unstubAllGlobals());

// ---- helpers --------------------------------------------------------------------

type Props = ComponentProps<typeof WhatIfPanel>;

/** Shares are counted in millions so the $ missed / dodged column (whole millions) has something to print. */
const M = 1e6;

function Landed() {
  const { id, stockId } = useParams();
  return <p>{`Position page: stock ${stockId} of fund ${id}`}</p>;
}

function renderWhatIf(props: Partial<Props> = {}) {
  const all: Props = {
    fundId: FUND,
    positions: [],
    exits: NO_EXITS,
    prices: new Map(),
    stocks: stocksTo(20),
    asof: ASOF,
    summary: summaryOf(),
    ...props,
  };
  return render(
    <MemoryRouter initialEntries={[`/fund/${FUND}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/fund/:id" element={<WhatIfPanel {...all} />} />
        <Route path="/fund/:id/stock/:stockId" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SALES = "Sold or trimmed stocks";
type Cells = Record<string, string>;

const salesTable = () => screen.getByRole("table", { name: SALES });
const bodyRows = (): HTMLElement[] => Array.from(salesTable().querySelectorAll<HTMLElement>("tbody tr[data-t]"));

/** The body rows of the table as {column header: cell text}. */
function rowsOf(): Cells[] {
  const heads = within(salesTable()).getAllByRole("columnheader").map((h) => h.textContent as string);
  return bodyRows().map((r) => Object.fromEntries(within(r).getAllByRole("cell").map((c, i) => [heads[i], c.textContent as string])));
}

/** Tickers down the Stock column, top to bottom. */
const tickersOf = (): string[] => bodyRows().map((r) => r.getAttribute("data-t") as string);

function rowOf(ticker: string): Cells {
  const at = tickersOf().indexOf(ticker);
  expect(at, `${ticker} in ${SALES}`).toBeGreaterThanOrEqual(0);
  return rowsOf()[at];
}

const trOf = (ticker: string): HTMLElement => bodyRows()[tickersOf().indexOf(ticker)];
const sortButton = (header: string) => within(salesTable()).getByRole("button", { name: header });

const tileOf = (label: string): HTMLElement => screen.getByText(label).closest(".wi-tile") as HTMLElement;
const tileValue = (label: string) => tileOf(label).querySelector(".wi-v")?.textContent;
const tileSub = (label: string) => tileOf(label).querySelector(".wi-n")?.textContent;

// ---- the section ------------------------------------------------------------------

describe("What if they'd kept it", () => {
  // missed = sold shares at today's price less what they sold for, in millions
  //   S1 +1,000 · S2 +110 · S3 −1,000 · S4 −140 · S5 no price
  const exits = exitsOf(
    [
      { stock_id: 1, sold_shares: 100 * M, sold_usd: 1000 * M },
      { stock_id: 2, sold_shares: 100 * M, sold_usd: 1000 * M, status: "trimmed" },
      { stock_id: 3, sold_shares: 100 * M, sold_usd: 2000 * M },
      { stock_id: 4, sold_shares: 50 * M, sold_usd: 1000 * M },
      { stock_id: 5, sold_shares: 10 * M, sold_usd: 100 * M },
    ],
    { beat_spy_pct: 0.25, buys_12m: 0.1, sells_12m: 0.04 },
  );
  const prices = pricesOf({ 1: 20, 2: 11.1, 3: 10, 4: 17.2 });

  it("is a named panel: heading and one-line subtitle, no explanation under the table", () => {
    renderWhatIf({ exits, prices });
    const section = screen.getByRole("region", { name: "What if they'd kept it" });
    expect(section).toHaveAttribute("id", "whatIfPanel");
    expect(within(section).getByRole("heading", { level: 3, name: "What if they'd kept it" })).toBeInTheDocument();
    expect(
      within(section).getByText("For every stock they sold or trimmed: what it did afterwards, and what holding on would have earned."),
    ).toBeInTheDocument();
    expect(within(section).getByRole("table", { name: SALES })).toBeInTheDocument();
    expect(within(section).queryByText(/IRR uses mid-quarter trade dates/)).toBeNull();
  });

  it("has no period picker", () => {
    renderWhatIf({ exits, prices });
    expect(screen.queryByRole("button", { name: /quarter|year|custom/i })).not.toBeInTheDocument();
  });

  it("has one sortable column for each figure, in this order, and no Last change $", () => {
    renderWhatIf({ exits, prices });
    expect(within(salesTable()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Stock",
      "Status",
      "Sale proceeds",
      "Avg cost",
      "Price",
      "Avg exit",
      "Return",
      "IRR actual",
      "IRR if held",
      "Last change",
      "Since sale",
      "1y after",
      "SPY 1y after",
      "$ missed / dodged",
    ]);
    expect(within(salesTable()).getAllByRole("button")).toHaveLength(14);
    expect(salesTable().querySelectorAll("colgroup col")).toHaveLength(14); // always all of them
  });

  it("stacks the ticker over the company name", () => {
    renderWhatIf({ exits, prices });
    const stk = trOf("S4").querySelector(".stk") as HTMLElement;
    expect(stk.querySelector("b")?.textContent).toBe("S4");
    expect(stk.querySelector("span")?.textContent).toBe("Company 4");
  });

  it("default sort is $ missed descending, with signed whole-million amounts and the unpriced last", async () => {
    renderWhatIf({ exits, prices });
    expect(tickersOf()).toEqual(["S1", "S2", "S4", "S3", "S5"]);
    expect(rowsOf().map((r) => r["$ missed / dodged"])).toEqual(["+$1,000m", "+$110m", "−$140m", "−$1,000m", "–"]);
    expect(screen.getByRole("columnheader", { name: "$ missed / dodged" })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Stock" })).toHaveAttribute("aria-sort", "none");

    await userEvent.click(sortButton("$ missed / dodged"));
    expect(tickersOf()).toEqual(["S3", "S4", "S2", "S1", "S5"]); // the unpriced stays last when ascending
    expect(screen.getByRole("columnheader", { name: "$ missed / dodged" })).toHaveAttribute("aria-sort", "ascending");

    await userEvent.click(sortButton("$ missed / dodged"));
    expect(tickersOf()).toEqual(["S1", "S2", "S4", "S3", "S5"]);
  });

  it("sorts on any column: text ascending first, numbers largest first, missing values last either way", async () => {
    renderWhatIf({ exits, prices });
    await userEvent.click(sortButton("Stock"));
    expect(tickersOf()).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    await userEvent.click(sortButton("Stock"));
    expect(tickersOf()).toEqual(["S5", "S4", "S3", "S2", "S1"]);

    await userEvent.click(sortButton("Status")); // "Sold all" before "Trimmed"
    expect(tickersOf()).toEqual(["S1", "S3", "S4", "S5", "S2"]);

    await userEvent.click(sortButton("Sale proceeds")); // $1,000m, $1,000m, $2,000m, $1,000m, $100m: ties keep the list's order
    expect(tickersOf()).toEqual(["S3", "S1", "S2", "S4", "S5"]);
    await userEvent.click(sortButton("Sale proceeds"));
    expect(tickersOf()).toEqual(["S5", "S1", "S2", "S4", "S3"]);

    // Since sale: S1 +100% · S2 +11% · S3 −50% · S4 −14% · S5 no price
    await userEvent.click(sortButton("Since sale"));
    expect(tickersOf()).toEqual(["S1", "S2", "S4", "S3", "S5"]);
    await userEvent.click(sortButton("Since sale"));
    expect(tickersOf()).toEqual(["S3", "S4", "S2", "S1", "S5"]);
  });

  it("colours a miss with the loss colour and a dodge with the gain colour, printing the sign", () => {
    renderWhatIf({ exits, prices });
    const figure = (t: string) => trOf(t).querySelector(".mv") as HTMLElement;
    expect(figure("S1")).toHaveClass("loss"); // missed, "+$1,000m"
    expect(figure("S1").textContent).toBe("+$1,000m");
    expect(figure("S4")).toHaveClass("gain"); // dodged, "−$140m"
    expect(figure("S4").textContent).toBe("−$140m");
    expect(figure("S5")).not.toHaveClass("loss");
    expect(figure("S5")).not.toHaveClass("gain"); // unknown: no colour
    expect(figure("S5").textContent).toBe("–");
  });

  it("shows Status in the same grey box for Sold all and Trimmed", () => {
    renderWhatIf({ exits, prices });
    expect(trOf("S1").querySelector(".st")).toHaveClass("sold");
    expect(trOf("S2").querySelector(".st")).toHaveClass("sold");
  });

  describe("tiles", () => {
    it("missed and dodged tiles add up, with the wording of R25 and the sign printed", () => {
      renderWhatIf({ exits, prices });
      expect(screen.getByRole("group", { name: "What-if statistics" })).toBeInTheDocument();
      expect(tileValue("Sold too early")).toBe("+$1.11B"); // 1,000 + 110 million
      expect(tileSub("Sold too early")).toBe("gains missed after selling");
      expect(tileValue("Losses dodged")).toBe("−$1.14B"); // 1,000 + 140 million
      expect(tileSub("Losses dodged")).toBe("drops avoided by selling");
      expect(tileOf("Sold too early").querySelector(".wi-v")).toHaveClass("loss");
      expect(tileOf("Losses dodged").querySelector(".wi-v")).toHaveClass("gain");
    });

    it("shows the share of sales that beat SPY the next year", () => {
      const withReturns = exitsOf(
        [
          { stock_id: 1, sold_shares: 100, sold_usd: 1000, one_y: 0.3, spy_one_y: 0.1 },
          { stock_id: 2, sold_shares: 100, sold_usd: 1000, one_y: 0.0, spy_one_y: 0.1 },
          { stock_id: 3, sold_shares: 100, sold_usd: 1000, one_y: null, spy_one_y: null },
        ],
        { beat_spy_pct: 0.5 },
      );
      renderWhatIf({ exits: withReturns, prices });
      expect(tileValue("Sold stocks that beat SPY next year")).toBe("50%");
      expect(tileSub("Sold stocks that beat SPY next year")).toBe("of 2 sold stocks"); // S3 has no return a year on
    });

    it("calls the sells smart when they trailed the buys, costly otherwise", () => {
      const { unmount } = renderWhatIf({ exits, prices });
      expect(tileValue("Buys vs sells, next 12 months")).toBe("+10% vs +4%");
      expect(tileSub("Buys vs sells, next 12 months")).toBe("Sells were smart: +6.0 pts gap");
      expect(tileOf("Buys vs sells, next 12 months").querySelector(".wi-v")).toHaveClass("gain");
      unmount();

      renderWhatIf({ exits: { ...exits, summary: { ...exits.summary, buys_12m: 0.02, sells_12m: 0.05 } }, prices });
      expect(tileSub("Buys vs sells, next 12 months")).toBe("Sells were costly: −3.0 pts gap");
      expect(tileOf("Buys vs sells, next 12 months").querySelector(".wi-v")).toHaveClass("loss");
    });

    it("dashes the tiles that have nothing to average", () => {
      renderWhatIf({ exits: { ...exits, summary: { buys_12m: null, sells_12m: 0.05, beat_spy_pct: null } }, prices });
      expect(tileValue("Buys vs sells, next 12 months")).toBe("–");
      expect(tileSub("Buys vs sells, next 12 months")).toBeUndefined();
      expect(tileValue("Sold stocks that beat SPY next year")).toBe("–");
    });

    it("reads $0 in no colour when nothing was sold", () => {
      renderWhatIf({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
      expect(tileValue("Sold too early")).toBe("$0");
      expect(tileValue("Losses dodged")).toBe("$0");
      // nothing missed and nothing dodged: neither is orange nor blue
      expect(tileOf("Sold too early").querySelector(".wi-v")).toHaveAttribute("class", "wi-v");
      expect(tileOf("Losses dodged").querySelector(".wi-v")).toHaveAttribute("class", "wi-v");
    });
  });

  describe("cells", () => {
    it("fills the columns of a sale", () => {
      const p = sold(2, 1000);
      const e = exitsOf([{ stock_id: 2, sold_shares: 1234567.4, sold_usd: 1234567.4 * 10, status: "trimmed", one_y: 0.12, spy_one_y: -0.04 }]);
      renderWhatIf({ positions: [p], exits: e, prices: pricesOf({ 2: 12.5 }) });
      const row = rowOf("S2");
      expect(row["Status"]).toBe("Trimmed");
      expect(row["Sale proceeds"]).toBe("$12m"); // 1,234,567.4 × 10
      expect(row["Avg exit"]).toBe("$20"); // the position's own sells, as the Positions table reads them
      expect(row["Price"]).toBe("$13"); // whole dollars
      expect(row["Since sale"]).toBe("+25%");
      expect(row["1y after"]).toBe("+12%");
      expect(row["SPY 1y after"]).toBe("−4%");
      expect(row["$ missed / dodged"]).toBe("+$3m"); // 1,234,567.4 × (12.5 − 10)
    });

    it("labels a position sold out 'Sold all'", () => {
      renderWhatIf({ exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 1000 }]), prices });
      expect(rowOf("S1")["Status"]).toBe("Sold all");
    });

    it("takes avg cost, return, IRRs and the price from the same stock's position (R20)", () => {
      // bought 100 at $10 in Q3 2015 (q 10), sold all at $20 in Q2 2025 (q 49); the stock is $40 now
      renderWhatIf({
        positions: [sold(1, 1000)],
        exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]),
        prices: pricesOf({ 1: 40 }),
      });
      const row = rowOf("S1");
      expect(row["Avg cost"]).toBe("$10");
      expect(row["Price"]).toBe("$40");
      expect(row["Avg exit"]).toBe("$20");
      expect(row["Return"]).toBe("+100%"); // 1,000 made on 1,000 in
      expect(row["IRR actual"]).toBe("+7%"); // 1,000 -> 2,000 over 9.75 years
      expect(row["IRR if held"]).toBe("+13%"); // 1,000 -> 4,000 over 11.2 years
      expect(row["Since sale"]).toBe("+100%");
      expect(row["$ missed / dodged"]).toBe("$0m"); // 100 shares x $20 is under half a million: no sign, no colour
    });

    it("shows the last change like the Positions table: a tinted box with the word and the weight change, and its quarter", () => {
      // S1's 100 shares at $20 are 2,000 of a 5,000 book (S2 holds 300 shares at $10): the weight falls by 40 points
      renderWhatIf({
        positions: [sold(1, 1000), pos(2, { trades: [trade(10, 300, 10, 300)] })],
        exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]),
        prices: pricesOf({ 1: 40, 2: 10 }),
      });
      const box = trOf("S1").querySelector(".lc") as HTMLElement;
      expect(box).toHaveClass("trim");
      expect(box.querySelector(".lw")?.textContent).toBe("Sold all");
      expect(box.querySelector("b")?.textContent).toBe("−40.0%");
      expect(trOf("S1").querySelector(".lq")?.textContent).toBe("Q2 ’25");
    });

    it("words the last change of the position: New, Added, Trimmed or Sold all, tinted by what was done", () => {
      const positions = [
        pos(1, { trades: [trade(NEWEST, 100, 10, 100)] }),
        sold(2, 100),
        pos(3, { trades: [trade(10, 100, 10, 100), trade(52, 35, 10, 135)] }),
        pos(4, { trades: [trade(10, 100, 10, 100), trade(51, -32, 10, 68)] }),
      ];
      const e = exitsOf([1, 2, 3, 4].map((stock_id) => ({ stock_id, sold_shares: 10, sold_usd: 100 })));
      renderWhatIf({ positions, exits: e, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
      const word = (t: string) => trOf(t).querySelector(".lc .lw")?.textContent;
      expect([1, 2, 3, 4].map((i) => word(`S${i}`))).toEqual(["New", "Sold all", "Added", "Trimmed"]);
      expect(trOf("S1").querySelector(".lc")).toHaveClass("add");
      expect(trOf("S2").querySelector(".lc")).toHaveClass("trim");
      expect(trOf("S3").querySelector(".lc")).toHaveClass("add");
      expect(trOf("S4").querySelector(".lc")).toHaveClass("sold"); // a trim: grey
      expect(["S1", "S2", "S3", "S4"].map((t) => trOf(t).querySelector(".lq")?.textContent)).toEqual(["Q2 ’26", "Q2 ’25", "Q1 ’26", "Q4 ’25"]);
    });

    it("sorts the last change by its weight change, an unknown one last", async () => {
      const positions = [
        pos(1, { trades: [trade(10, 100, 10, 100), trade(52, 100, 10, 200)] }), // added: plus
        sold(2, 100), // sold all: the largest minus
        pos(3, { trades: [trade(10, 100, 10, 100), trade(51, -10, 10, 90)] }), // trimmed: small minus
      ];
      const e = exitsOf([1, 2, 3, 4].map((stock_id) => ({ stock_id, sold_shares: 10, sold_usd: 100 }))); // S4: no position
      renderWhatIf({ positions, exits: e, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
      await userEvent.click(sortButton("Last change"));
      expect(tickersOf()).toEqual(["S1", "S3", "S2", "S4"]);
      await userEvent.click(sortButton("Last change"));
      expect(tickersOf()).toEqual(["S2", "S3", "S1", "S4"]);
    });

    it("shows a dash for each cell that needs a price or a position it does not have, and never NaN", () => {
      // S1: sold out, no price. S2: no position in the list at all.
      renderWhatIf({
        positions: [sold(1, 500)],
        exits: exitsOf([
          { stock_id: 1, sold_shares: 100, sold_usd: 2000 },
          { stock_id: 2, sold_shares: 100, sold_usd: 2000 },
        ]),
        prices: new Map(),
      });
      const noPrice = rowOf("S1");
      expect(noPrice["Price"]).toBe("–");
      expect(noPrice["Since sale"]).toBe("–");
      expect(noPrice["$ missed / dodged"]).toBe("–");
      expect(noPrice["IRR if held"]).toBe("–");
      expect(noPrice["IRR actual"]).toBe("+7%"); // nothing is held, so the price is not needed
      expect(noPrice["Return"]).toBe("+100%");

      const noPosition = rowOf("S2");
      for (const header of ["Avg cost", "Return", "IRR actual", "IRR if held", "Last change", "Price"]) {
        expect(noPosition[header], header).toBe("–");
      }
      expect(noPosition["Sale proceeds"]).toBe("$0m");
      expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    });

    it("names a stock the securities file does not know by its id", () => {
      renderWhatIf({ exits: exitsOf([{ stock_id: 77777, sold_shares: 10, sold_usd: 100 }]), stocks: new Map() });
      expect(tickersOf()).toEqual(["#77777"]);
      expect(trOf("#77777").querySelector(".stk b")?.textContent).toBe("#77777");
    });
  });

  describe("opening a position", () => {
    const withPositions = () => ({
      exits,
      prices,
      positions: [sold(1, 1000), sold(2, 1000), sold(3, 1000), sold(4, 1000)],
    });

    it("opens the price chart and the trades under the row on click, and 'Open full page' goes to the position page", async () => {
      renderWhatIf(withPositions());
      await userEvent.click(within(salesTable()).getByText("Company 4"));
      const row = trOf("S4");
      expect(row).toHaveAttribute("aria-expanded", "true");
      expect(trOf("S1")).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/^Position page/)).not.toBeInTheDocument(); // it opened in place
      const chart = await screen.findByRole("img", { name: /Company 4 share price with the fund's buys and sells/ });
      expect(chart.querySelectorAll(".mk.buy")).toHaveLength(1);
      expect(chart.querySelectorAll(".mk.sell")).toHaveLength(1);
      const trades = screen.getByRole("table", { name: "When the fund bought and sold Company 4" });
      expect(within(trades).getAllByRole("row")).toHaveLength(3); // head + the sale + the buy
      const link = screen.getByRole("link", { name: "Open full page" });
      expect(link).toHaveAttribute("href", `/fund/${FUND}/stock/4`);

      await userEvent.click(link);
      expect(await screen.findByText("Position page: stock 4 of fund 42")).toBeInTheDocument();
    });

    it("opens and closes on Enter and Space, one row at a time", async () => {
      renderWhatIf(withPositions());
      trOf("S2").focus();
      await userEvent.keyboard("{Enter}");
      expect(trOf("S2")).toHaveAttribute("aria-expanded", "true");
      await userEvent.keyboard(" ");
      expect(trOf("S2")).toHaveAttribute("aria-expanded", "false");
      await userEvent.keyboard("{Enter}");
      trOf("S1").focus();
      await userEvent.keyboard("{Enter}");
      expect(trOf("S1")).toHaveAttribute("aria-expanded", "true");
      expect(trOf("S2")).toHaveAttribute("aria-expanded", "false");
      expect(salesTable().querySelectorAll("tr.xrow")).toHaveLength(1);
    });

    it("moves between rows with ArrowDown and ArrowUp, over an opened row", async () => {
      renderWhatIf(withPositions());
      trOf("S1").focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(trOf("S2")).toHaveFocus();
      await userEvent.keyboard("{Enter}"); // S2 opens: its panel sits between S2 and S4
      await userEvent.keyboard("{ArrowDown}");
      expect(trOf("S4")).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}{ArrowUp}");
      expect(trOf("S1")).toHaveFocus();
      await userEvent.keyboard("{ArrowUp}");
      expect(trOf("S1")).toHaveFocus(); // the first row stays
    });

    it("lets a row with no position open too (no trades to show)", async () => {
      renderWhatIf({ exits: exitsOf([{ stock_id: 2, sold_shares: 100, sold_usd: 2000 }]), prices: pricesOf({ 2: 5 }) });
      await userEvent.click(within(salesTable()).getByText("Company 2"));
      expect(trOf("S2")).toHaveAttribute("aria-expanded", "true");
      expect(await screen.findByRole("link", { name: "Open full page" })).toBeInTheDocument();
    });
  });

  it("says so when nothing was sold", () => {
    renderWhatIf({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
    expect(within(salesTable()).getByText("They have not sold or trimmed anything yet.")).toBeInTheDocument();
    expect(within(salesTable()).getAllByRole("row")).toHaveLength(2); // header + the one line
  });
});

// ---- a long list of sales ---------------------------------------------------------------

describe("a long list of sales draws its rows in chunks", () => {
  /** n sales, each of a stock with a close and a position. Stock i is sold at $10; it is 5 + (i mod 9) now. */
  const many = (n: number): Pick<Props, "exits" | "prices" | "stocks" | "positions"> => ({
    exits: exitsOf(Array.from({ length: n }, (_, i): ExitIn => ({ stock_id: i + 1, sold_shares: 10 * M, sold_usd: 100 * M }))),
    prices: new Map(Array.from({ length: n }, (_, i) => [i + 1, 5 + (i % 9)] as [number, number])),
    stocks: stocksTo(n),
    positions: Array.from({ length: n }, (_, i) => sold(i + 1, 100)),
  });
  // the cap, one "Show more" step and a remainder of 40
  const TOTAL = AUTO_FILL_MAX + MORE_STEP + 40;
  const footer = () => document.querySelector(".wi-more")?.textContent;
  const showMore = () => screen.queryByRole("button", { name: /^Show / });
  const n = (v: number) => v.toLocaleString("en-US");
  const label = (left: number) => `Show ${n(Math.min(MORE_STEP, left))} more` + (left > MORE_STEP ? ` · ${n(left)} left` : "");
  let idle: ReturnType<typeof installIdle>;
  beforeEach(() => void (idle = installIdle()));
  afterEach(() => void vi.restoreAllMocks());

  it("draws no more than the first rows at first, then the rest in idle time up to the cap, and says so meanwhile", async () => {
    renderWhatIf(many(AUTO_FILL_MAX - 30));
    expect(bodyRows()).toHaveLength(INITIAL_ROWS);
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - 30 - INITIAL_ROWS} more…`);
    expect(salesTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    await idle.flush();
    expect(bodyRows()).toHaveLength(INITIAL_ROWS + CHUNK);
    await idle.flushAll();
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX - 30);
    expect(footer()).toBeUndefined(); // everything fits under the cap: no button, ever
    expect(showMore()).not.toBeInTheDocument();
    expect(salesTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
    expect(idle.pending.size).toBe(0);
  });

  it("stops filling at the cap; 'Show N more · M left' adds the next rows at once, in the same order, until none are left", async () => {
    renderWhatIf(many(TOTAL));
    await idle.flushAll();
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX);
    expect(showMore()).toBeInTheDocument();
    expect(footer()).toBe(label(TOTAL - AUTO_FILL_MAX));
    expect(salesTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
    const before = tickersOf();
    await userEvent.click(showMore()!);
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    expect(tickersOf().slice(0, AUTO_FILL_MAX)).toEqual(before); // the rows already there stay where they were
    expect(footer()).toBe("Show 40 more");
    expect(idle.pending.size).toBe(0);
    await userEvent.click(showMore()!);
    expect(bodyRows()).toHaveLength(TOTAL);
    expect(document.querySelector(".wi-more")).toBeNull();
  }, 30000);

  it("keeps the sort order while rows are added, and sorting covers all rows, not the ones drawn", async () => {
    // S99 misses by far the most, and is the last of 170 in ticker order: beyond the first rows of either order that matters
    const long = many(170);
    long.prices.set(99, 1000);
    renderWhatIf(long);
    await idle.flushAll();
    expect(bodyRows()).toHaveLength(170);
    expect(tickersOf()[0]).toBe("S99"); // the default order is $ missed descending
    const values = rowsOf().map((r) => Number(r["$ missed / dodged"].replace(/[+$m,]/g, "").replace("−", "-")));
    expect(values).toEqual([...values].sort((a, b) => b - a)); // descending from the first row to the last

    // a new order starts again from the first rows
    await userEvent.click(sortButton("Stock"));
    expect(bodyRows()).toHaveLength(INITIAL_ROWS);
    expect(tickersOf()[0]).toBe("S1");
    expect(tickersOf()).not.toContain("S99"); // last in ticker order: not drawn yet
    expect(footer()).toBe(`Loading ${170 - INITIAL_ROWS} more…`);
    await idle.flushAll();
    expect(bodyRows()).toHaveLength(170);
    expect(tickersOf()[169]).toBe("S99");

    // and back: the best of all 170 is on top at once, though it was in the undrawn part of the previous order
    await userEvent.click(sortButton("$ missed / dodged"));
    expect(bodyRows()).toHaveLength(INITIAL_ROWS);
    expect(tickersOf()[0]).toBe("S99");
    await idle.flushAll();
    expect(bodyRows()).toHaveLength(170);
  }, 30000);

  it("a sort starts again from the first rows, forgets what a click added, and still covers all rows beyond the cap", async () => {
    renderWhatIf(many(TOTAL));
    await idle.flushAll();
    await userEvent.click(showMore()!);
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    await userEvent.click(sortButton("Stock"));
    expect(bodyRows()).toHaveLength(INITIAL_ROWS);
    const byTicker = Array.from({ length: TOTAL }, (_, i) => "S" + (i + 1)).sort();
    expect(tickersOf()).toEqual(byTicker.slice(0, INITIAL_ROWS));
    await idle.flushAll();
    expect(tickersOf()).toEqual(byTicker.slice(0, AUTO_FILL_MAX));
    expect(footer()).toBe(label(TOTAL - AUTO_FILL_MAX));
    await userEvent.click(showMore()!);
    await userEvent.click(showMore()!);
    expect(tickersOf()).toEqual(byTicker);
  }, 30000);

  it("adds up the tiles over every sale, not the rows drawn", () => {
    renderWhatIf(many(400));
    // stock i misses (i mod 9) - 5 dollars a share on 10M shares: 44 full cycles of -5 -4 -3 -2 -1 0 +1 +2 +3 and four more (-5 -4 -3 -2)
    expect(tileValue("Sold too early")).toBe("+$2.64B"); // 44 x (1 + 2 + 3) x 10M
    expect(tileValue("Losses dodged")).toBe("−$6.74B"); // (44 x 15 + 14) x 10M
  });

  it("re-renders none of the drawn rows when the next chunk arrives or more are shown", async () => {
    // memoised rows: the cells of a row already there are the very same DOM nodes after the next chunk
    renderWhatIf(many(TOTAL));
    const first = bodyRows()[0];
    const cell = first.querySelector("td:last-child") as HTMLElement;
    await idle.flushAll();
    await userEvent.click(showMore()!);
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX + MORE_STEP);
    expect(bodyRows()[0]).toBe(first);
    expect(first.querySelector("td:last-child")).toBe(cell);
  }, 30000);

  it("keeps first paint to the first rows on a fund with 3,000 sales, and never draws them all without a click", async () => {
    const t0 = performance.now();
    const { unmount } = renderWhatIf(many(3000));
    const first = performance.now() - t0;
    expect(bodyRows()).toHaveLength(INITIAL_ROWS);
    expect(footer()).toBe(`Loading ${AUTO_FILL_MAX - INITIAL_ROWS} more…`);
    // a generous bound for jsdom: the point is that 3,000 rows are not drawn at once (that takes many times longer)
    expect(first).toBeLessThan(3000);
    await idle.flush(); // the rest follows by itself, in chunks ...
    expect(bodyRows()).toHaveLength(INITIAL_ROWS + CHUNK);
    await idle.flushAll(); // ... up to the cap
    expect(bodyRows()).toHaveLength(AUTO_FILL_MAX);
    expect(footer()).toBe(label(3000 - AUTO_FILL_MAX));
    expect(footer()).toMatch(/^Show \d+ more · [\d,]+ left$/);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    unmount();
    expect(idle.pending.size).toBe(0);
  }, 30000);
});

// ---- the demo fund: the two tables agree --------------------------------------------------

describe("the demo fund", () => {
  const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
  const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;
  const fundId = 9100002;
  const positions = positionRows(demo<Positions>(`fund/${fundId}/positions.json`));
  const exits = demo<Exits>(`fund/${fundId}/exits.json`);
  const summary = demo<Summary>(`fund/${fundId}/summary.json`);
  const latest = demo<LatestPrices>("latest_prices.json");
  const stocks = stockMap(demo<Securities>("securities.json"));
  const prices = priceMap(latest);

  function both() {
    return render(
      <MemoryRouter>
        <PositionsPanel fundId={fundId} summary={summary} positions={positions} prices={prices} stocks={stocks} asof={latest.asof} />
        <WhatIfPanel fundId={fundId} positions={positions} exits={exits} prices={prices} stocks={stocks} asof={latest.asof} summary={summary} />
      </MemoryRouter>,
    );
  }

  /** {ticker: {column header: cell text}} of a panel's table. */
  function figures(panel: string): Map<string, Cells> {
    const table = document.querySelector(`#${panel} table`) as HTMLElement;
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent as string);
    const out = new Map<string, Cells>();
    for (const tr of Array.from(table.querySelectorAll<HTMLElement>("tbody tr[data-t]"))) {
      const cells = Array.from(tr.querySelectorAll("td")).map((td, i) => [heads[i], td.textContent as string]);
      out.set(tr.getAttribute("data-t") as string, Object.fromEntries(cells));
    }
    return out;
  }

  it("lists every sale, the one that was most missed first, with no NaN", () => {
    renderWhatIf({ fundId, positions, exits, prices, stocks, asof: latest.asof, summary });
    expect(tickersOf()).toHaveLength(exits.rows.stock_id.length);
    const expected = exits.rows.stock_id
      .map((id, i) => ({ ticker: stocks.get(id)?.ticker, m: missed(exits.rows.sold_shares[i], exits.rows.sold_usd[i], prices.get(id)) }))
      .filter((r): r is { ticker: string; m: number } => r.m !== null);
    expect(expected.length).toBeGreaterThan(0);
    const best = expected.reduce((a, b) => (b.m > a.m ? b : a));
    expect(tickersOf()[0]).toBe(best.ticker);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("IRR if held differs from IRR actual on a sold-out stock", () => {
    renderWhatIf({ fundId, positions, exits, prices, stocks, asof: latest.asof, summary });
    const soldAll = rowsOf().filter((r) => r["Status"] === "Sold all");
    expect(soldAll.length).toBeGreaterThan(0);
    const differing = soldAll.filter((r) => r["IRR actual"] !== "–" && r["IRR if held"] !== "–" && r["IRR actual"] !== r["IRR if held"]);
    expect(differing.length).toBeGreaterThan(0);
  });

  it("prints the same Return, IRR, Avg cost, Price and Avg exit as the Positions table for every stock in both", async () => {
    both();
    await act(async () => {});
    const pos = figures("posPanel");
    const sales = figures("whatIfPanel");
    expect(sales.size).toBe(exits.rows.stock_id.length);
    let compared = 0;
    for (const [ticker, w] of sales) {
      const p = pos.get(ticker);
      if (!p) continue; // sold out in an earlier quarter: not in the Positions table at the newest quarter
      compared++;
      for (const col of ["Return", "IRR", "Avg cost", "Price"] as const) {
        expect(w[col === "IRR" ? "IRR actual" : col], `${ticker} ${col}`).toBe(p[col]);
      }
      if (p["Avg exit"] !== "–") expect(w["Avg exit"], `${ticker} Avg exit`).toBe(p["Avg exit"]);
    }
    expect(compared).toBeGreaterThan(5);
  });
});
