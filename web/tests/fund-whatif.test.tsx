import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { priceMap, stockMap } from "../src/data/api";
import type { Exits, ExitsSummary, ExitStatus, LatestPrices, PositionRow, Positions, Securities, Trade } from "../src/data/types";
import { missed, positionRows } from "../src/lib/live";
import { WhatIf } from "../src/pages/FundTables";

// "What if they'd kept it": the sales section at the foot of the fund page (src/pages/FundTables.tsx).
// The positions table above it is src/fund/PositionsTable and has its own tests (fund-positions-ui).

// ---- fixtures -----------------------------------------------------------------

const FUND = 42;
const ASOF = "2026-10-30"; // 13.83 years after 2013-01-01

type Props = ComponentProps<typeof WhatIf>;

/** A buy (delta > 0) or sale (delta < 0) at quarter q. */
const trade = (q: number, delta: number, px: number, sharesAfter: number): Trade => ({ q, delta, px, low: null, high: null, sharesAfter });

/** A position held now (100 shares, cost 1,000, one buy) unless `over` says otherwise. */
function pos(stock_id: number, over: Partial<PositionRow> = {}): PositionRow {
  return {
    stock_id,
    from_q: 10,
    to_q: null,
    avg_cost: 10,
    avg_exit: null,
    invested: 1000,
    realised: 0,
    dividends: 0,
    shares_now: 100,
    cost_now: 1000,
    last_q: 53,
    last_type: "add",
    last_pct: 0.1,
    last_usd: 100,
    trades: [trade(10, 100, 10, 100)],
    ...over,
  };
}

/** A position sold out: nothing held, `realised` made. */
const sold = (stock_id: number, realised: number, over: Partial<PositionRow> = {}): PositionRow =>
  pos(stock_id, { shares_now: 0, cost_now: 0, to_q: 49, realised, last_type: "exit", last_pct: null, last_usd: -2000, last_q: 49, ...over });

type ExitIn = {
  stock_id: number;
  status?: ExitStatus;
  sold_shares: number;
  sold_usd: number;
  one_y?: number | null;
  spy_one_y?: number | null;
};

function exitsOf(rows: ExitIn[], summary: Partial<ExitsSummary> = {}): Exits {
  return {
    rows: {
      stock_id: rows.map((r) => r.stock_id),
      status: rows.map((r) => r.status ?? "sold_all"),
      sold_shares: rows.map((r) => r.sold_shares),
      sold_usd: rows.map((r) => r.sold_usd),
      avg_exit: rows.map((r) => r.sold_usd / r.sold_shares),
      last_sale_q: rows.map(() => 40),
      one_y: rows.map((r) => r.one_y ?? null),
      spy_one_y: rows.map((r) => r.spy_one_y ?? null),
    },
    summary: { buys_12m: null, sells_12m: null, beat_spy_pct: null, ...summary },
  };
}

const NO_EXITS = exitsOf([]);

/** Every stock S<id> "Company <id>", for ids 1..n. */
const stocksTo = (n: number): Props["stocks"] =>
  new Map(Array.from({ length: n }, (_, i) => [i + 1, { ticker: `S${i + 1}`, name: `Company ${i + 1}` }]));

const pricesOf = (closes: Record<number, number>): Map<number, number> =>
  new Map(Object.entries(closes).map(([id, p]) => [Number(id), p]));

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
    ...props,
  };
  return render(
    <MemoryRouter initialEntries={[`/fund/${FUND}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/fund/:id" element={<WhatIf {...all} />} />
        <Route path="/fund/:id/stock/:stockId" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SALES = "Sold or trimmed stocks";

type Cells = Record<string, string>;

const salesTable = () => screen.getByRole("table", { name: SALES });

/** The body rows of the table as {column header: cell text}. */
function rowsOf(): Cells[] {
  const table = salesTable();
  const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent as string);
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => Object.fromEntries(within(r).getAllByRole("cell").map((c, i) => [heads[i], c.textContent as string])));
}

/** Tickers down the Stock column, top to bottom. */
const tickersOf = (): string[] =>
  within(salesTable())
    .getAllByRole("row")
    .slice(1)
    .map((r) => (r.querySelector(".mono") as HTMLElement).textContent as string);

/** One row of the table, by its ticker. */
function rowOf(ticker: string): Cells {
  const at = tickersOf().indexOf(ticker);
  expect(at, `${ticker} in ${SALES}`).toBeGreaterThanOrEqual(0);
  return rowsOf()[at];
}

const sortButton = (header: string) => within(salesTable()).getByRole("button", { name: header });

const tileOf = (label: string): HTMLElement => screen.getByText(label).closest(".tile") as HTMLElement;
const tileValue = (label: string) => tileOf(label).querySelector(".v")?.textContent;
const tileSub = (label: string) => tileOf(label).querySelector(".d")?.textContent;

// ---- the section ------------------------------------------------------------------

describe("What if they'd kept it", () => {
  // missed = sold shares at today's price less what they sold for
  //   S1 +1,000 · S2 +110 · S3 −1,000 · S4 −140 · S5 no price
  const exits = exitsOf(
    [
      { stock_id: 1, sold_shares: 100, sold_usd: 1000 },
      { stock_id: 2, sold_shares: 100, sold_usd: 1000, status: "trimmed" },
      { stock_id: 3, sold_shares: 100, sold_usd: 2000 },
      { stock_id: 4, sold_shares: 50, sold_usd: 1000 },
      { stock_id: 5, sold_shares: 10, sold_usd: 100 },
    ],
    { beat_spy_pct: 0.25, buys_12m: 0.1, sells_12m: 0.04 },
  );
  const prices = pricesOf({ 1: 20, 2: 11.1, 3: 10, 4: 17.2 });

  it("is a named section: heading, one-line intro and the explanation under the table", () => {
    renderWhatIf({ exits, prices });
    const section = screen.getByRole("region", { name: "What if they'd kept it" });
    expect(within(section).getByRole("heading", { level: 2, name: "What if they'd kept it" })).toBeInTheDocument();
    expect(
      within(section).getByText("For every stock they sold or trimmed: what it did afterwards, and what holding on would have earned."),
    ).toBeInTheDocument();
    expect(within(section).getByRole("table", { name: SALES })).toBeInTheDocument();
    expect(within(section).getByText(/^IRR uses mid-quarter trade dates and today's price for anything still held/)).toBeInTheDocument();
    expect(within(section).getByText(/All figures are 13F estimates\.$/)).toBeInTheDocument();
  });

  it("has one sortable column for each figure, in this order", () => {
    renderWhatIf({ exits, prices });
    expect(within(salesTable()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Stock",
      "Status",
      "Shares sold",
      "Avg cost",
      "Current price",
      "Avg exit",
      "Return",
      "IRR actual",
      "IRR if held",
      "Last change",
      "Last change $",
      "Since sale",
      "1y after",
      "SPY 1y after",
      "$ missed / dodged",
    ]);
    expect(within(salesTable()).getAllByRole("button")).toHaveLength(15);
  });

  it("default sort is $ missed descending, with signed amounts and the unpriced last", async () => {
    renderWhatIf({ exits, prices });
    expect(tickersOf()).toEqual(["S1", "S2", "S4", "S3", "S5"]);
    expect(rowsOf().map((r) => r["$ missed / dodged"])).toEqual(["+$1,000", "+$110", "−$140", "−$1,000", "—"]);
    expect(screen.getByRole("columnheader", { name: "$ missed / dodged" })).toHaveAttribute("aria-sort", "descending");

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

    await userEvent.click(sortButton("Shares sold")); // 100, 100, 100, 50, 10: ties keep the list's order
    expect(tickersOf()).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    await userEvent.click(sortButton("Shares sold"));
    expect(tickersOf()).toEqual(["S5", "S4", "S1", "S2", "S3"]);

    // Since sale: S1 +100% · S2 +11% · S3 −50% · S4 −14% · S5 no price
    await userEvent.click(sortButton("Since sale"));
    expect(tickersOf()).toEqual(["S1", "S2", "S4", "S3", "S5"]);
    await userEvent.click(sortButton("Since sale"));
    expect(tickersOf()).toEqual(["S3", "S4", "S2", "S1", "S5"]);
  });

  it("colours a miss red and a dodge green", () => {
    renderWhatIf({ exits, prices });
    const cells = within(salesTable())
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell").slice(-1)[0].firstElementChild);
    expect(cells[0]).toHaveClass("down"); // S1 missed
    expect(cells[2]).toHaveClass("up"); // S4 dodged
    expect(cells[4]).not.toHaveAttribute("class"); // S5 unknown
  });

  describe("tiles", () => {
    it("missed and dodged tiles add up, with the wording of R25", () => {
      renderWhatIf({ exits, prices });
      expect(screen.getByRole("group", { name: "What-if statistics" })).toBeInTheDocument();
      expect(tileValue("Sold too early")).toBe("$1,110"); // 1,000 + 110
      expect(tileSub("Sold too early")).toBe("gains missed after selling");
      expect(tileValue("Losses dodged")).toBe("$1,140"); // 1,000 + 140, unsigned
      expect(tileSub("Losses dodged")).toBe("drops avoided by selling");
      expect(tileOf("Sold too early").querySelector(".v")).toHaveClass("down");
      expect(tileOf("Losses dodged").querySelector(".v")).toHaveClass("up");
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
      unmount();

      renderWhatIf({ exits: { ...exits, summary: { ...exits.summary, buys_12m: 0.02, sells_12m: 0.05 } }, prices });
      expect(tileSub("Buys vs sells, next 12 months")).toBe("Sells were costly: −3.0 pts gap");
    });

    it("dashes the tiles that have nothing to average", () => {
      renderWhatIf({ exits: { ...exits, summary: { buys_12m: null, sells_12m: 0.05, beat_spy_pct: null } }, prices });
      expect(tileValue("Buys vs sells, next 12 months")).toBe("—");
      expect(tileSub("Buys vs sells, next 12 months")).toBeUndefined();
      expect(tileValue("Sold stocks that beat SPY next year")).toBe("—");
    });

    it("reads $0 in no colour when nothing was sold", () => {
      renderWhatIf({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
      expect(tileValue("Sold too early")).toBe("$0");
      expect(tileValue("Losses dodged")).toBe("$0");
      // nothing missed and nothing dodged: neither is red or green
      expect(tileOf("Sold too early").querySelector(".v")).toHaveAttribute("class", "v");
      expect(tileOf("Losses dodged").querySelector(".v")).toHaveAttribute("class", "v");
    });
  });

  describe("cells", () => {
    it("fills the columns of a sale", () => {
      const e = exitsOf([{ stock_id: 2, sold_shares: 1234567.4, sold_usd: 1234567.4 * 10, status: "trimmed", one_y: 0.12, spy_one_y: -0.04 }]);
      renderWhatIf({ exits: e, prices: pricesOf({ 2: 12.5 }) });
      const row = rowOf("S2");
      expect(row["Stock"]).toBe("S2 Company 2");
      expect(row["Status"]).toBe("Trimmed");
      expect(row["Shares sold"]).toBe("1,234,567");
      expect(row["Avg exit"]).toBe("$10.00");
      expect(row["Current price"]).toBe("$12.50");
      expect(row["Since sale"]).toBe("+25%");
      expect(row["1y after"]).toBe("+12%");
      expect(row["SPY 1y after"]).toBe("−4%");
      expect(row["$ missed / dodged"]).toBe("+$3.1M"); // 1,234,567.4 × (12.5 − 10)
    });

    it("labels a position sold out 'Sold all'", () => {
      renderWhatIf({ exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 1000 }]), prices });
      expect(rowOf("S1")["Status"]).toBe("Sold all");
    });

    it("takes avg cost, return, IRRs and the last change from the same stock's position (R20)", () => {
      // bought 100 at $10 in Q1 2013 (q 0), sold all at $20 in Q1 2014 (q 4); the stock is $40 now
      const p = sold(1, 1000, {
        from_q: 0,
        to_q: 4,
        avg_exit: 20,
        last_q: 4,
        trades: [trade(0, 100, 10, 100), trade(4, -100, 20, 0)],
      });
      renderWhatIf({
        positions: [p],
        exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]),
        prices: pricesOf({ 1: 40 }),
      });
      const row = rowOf("S1");
      expect(row["Avg cost"]).toBe("$10.00");
      expect(row["Current price"]).toBe("$40.00");
      expect(row["Avg exit"]).toBe("$20.00");
      expect(row["Return"]).toBe("+100%"); // 1,000 made on 1,000 in
      expect(row["IRR actual"]).toBe("+100%"); // 1,000 → 2,000 in a year
      expect(row["IRR if held"]).toBe("+11%"); // 1,000 → 4,000 over 13.7 years
      expect(row["Last change"]).toBe("Sold all Q1 2014");
      expect(row["Last change $"]).toBe("−$2,000");
      expect(row["Since sale"]).toBe("+100%");
      expect(row["$ missed / dodged"]).toBe("+$2,000");
    });

    it("words the last change of the position: New, Sold all or the change in shares, with its quarter", () => {
      const positions = [
        pos(1, { last_type: "new", last_pct: null, last_q: 53, last_usd: 5000 }),
        sold(2, 100, { last_type: "exit", last_pct: null, last_q: 49, last_usd: -7000 }),
        pos(3, { last_type: "add", last_pct: 0.35, last_q: 52, last_usd: 3500 }),
        pos(4, { last_type: "trim", last_pct: -0.32, last_q: 51, last_usd: -2400 }),
      ];
      const e = exitsOf([1, 2, 3, 4].map((stock_id) => ({ stock_id, sold_shares: 10, sold_usd: 100 })));
      renderWhatIf({ positions, exits: e, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
      expect(rowOf("S1")["Last change"]).toBe("New Q2 2026");
      expect(rowOf("S2")["Last change"]).toBe("Sold all Q2 2025");
      expect(rowOf("S3")["Last change"]).toBe("+35% Q1 2026");
      expect(rowOf("S4")["Last change"]).toBe("−32% Q4 2025");
      expect(rowOf("S1")["Last change $"]).toBe("+$5,000");
      expect(rowOf("S2")["Last change $"]).toBe("−$7,000");
    });

    it("sorts the last change with a new position above every add and a sale of everything below every trim", async () => {
      const positions = [
        pos(1, { last_type: "new", last_pct: null, last_usd: 5000 }),
        sold(2, 100, { last_type: "exit", last_pct: null }),
        pos(3, { last_type: "add", last_pct: 0.35 }),
        pos(4, { last_type: "trim", last_pct: -0.32, last_usd: -2400 }),
      ];
      const e = exitsOf([1, 2, 3, 4].map((stock_id) => ({ stock_id, sold_shares: 10, sold_usd: 100 })));
      renderWhatIf({ positions, exits: e, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
      await userEvent.click(sortButton("Last change"));
      expect(tickersOf()).toEqual(["S1", "S3", "S4", "S2"]);
    });

    it("shows a dash for each cell that needs a price or a position it does not have", () => {
      // S1: sold out, no price. S2: no position in the list at all.
      const p = sold(1, 500, { trades: [trade(0, 100, 10, 100), trade(4, -100, 20, 0)] });
      renderWhatIf({
        positions: [p],
        exits: exitsOf([
          { stock_id: 1, sold_shares: 100, sold_usd: 2000 },
          { stock_id: 2, sold_shares: 100, sold_usd: 2000 },
        ]),
        prices: new Map(),
      });
      const noPrice = rowOf("S1");
      expect(noPrice["Current price"]).toBe("—");
      expect(noPrice["Since sale"]).toBe("—");
      expect(noPrice["$ missed / dodged"]).toBe("—");
      expect(noPrice["IRR if held"]).toBe("—");
      expect(noPrice["IRR actual"]).toBe("+100%"); // nothing is held, so the price is not needed
      expect(noPrice["Return"]).toBe("+50%");

      const noPosition = rowOf("S2");
      for (const header of ["Avg cost", "Return", "IRR actual", "IRR if held", "Last change", "Last change $", "Current price"]) {
        expect(noPosition[header], header).toBe("—");
      }
      expect(noPosition["Shares sold"]).toBe("100");
      expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    });

    it("names a stock the securities file does not know by its id", () => {
      renderWhatIf({ exits: exitsOf([{ stock_id: 77777, sold_shares: 10, sold_usd: 100 }]), stocks: new Map() });
      expect(tickersOf()).toEqual(["#77777"]);
      expect(rowOf("#77777")["Stock"]).toBe("#77777");
    });
  });

  describe("opening a position", () => {
    it("opens the position page of a row on click", async () => {
      renderWhatIf({ exits, prices });
      await userEvent.click(within(salesTable()).getByText("Company 4"));
      expect(await screen.findByText("Position page: stock 4 of fund 42")).toBeInTheDocument();
    });

    it("opens it on Enter too", async () => {
      renderWhatIf({ exits, prices });
      const row = within(salesTable()).getAllByRole("row")[2]; // S2, second by $ missed
      expect(row).toHaveAttribute("tabindex", "0");
      row.focus();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByText("Position page: stock 2 of fund 42")).toBeInTheDocument();
    });
  });

  it("says so when nothing was sold", () => {
    renderWhatIf({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
    expect(within(salesTable()).getByText("They have not sold or trimmed anything yet.")).toBeInTheDocument();
    expect(within(salesTable()).getAllByRole("row")).toHaveLength(2); // header + the one line
  });

  describe("a long list of sales", () => {
    /** n sales, each of a stock with a close. */
    const many = (n: number): Pick<Props, "exits" | "prices" | "stocks"> => ({
      exits: exitsOf(Array.from({ length: n }, (_, i): ExitIn => ({ stock_id: i + 1, sold_shares: 10, sold_usd: 100 }))),
      prices: new Map(Array.from({ length: n }, (_, i) => [i + 1, 5 + (i % 9)] as [number, number])),
      stocks: stocksTo(n),
    });
    const bodyRows = () => salesTable().querySelectorAll("tbody tr:not([aria-hidden])").length;

    it("virtualises 2,000 sales", () => {
      renderWhatIf(many(2000));
      const rendered = salesTable().querySelectorAll("tr").length;
      expect(rendered).toBeGreaterThan(2); // a window of rows, not none
      expect(rendered).toBeLessThan(100);
      expect(salesTable()).toHaveAttribute("aria-rowcount", "2001");
      // the tiles add up every sale, not the rows in view: a stock at 5 + (i mod 9) against $10 a share sold at
      expect(tileValue("Sold too early")).toBe("$13K"); // 222 full cycles of +10 +20 +30
      expect(tileValue("Losses dodged")).toBe("$33K"); // 222 cycles of 50 + 40 + 30 + 20 + 10, and 50 + 40 of the last two
    });

    it("is virtual only above 500 rows", () => {
      const { unmount } = renderWhatIf(many(500));
      expect(salesTable()).not.toHaveAttribute("aria-rowcount");
      expect(bodyRows()).toBe(500);
      unmount();

      renderWhatIf(many(501));
      expect(salesTable()).toHaveAttribute("aria-rowcount", "502");
      expect(bodyRows()).toBeLessThan(100);
    });
  });
});

// ---- the demo fund --------------------------------------------------------------------

describe("the demo fund", () => {
  const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
  const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;
  const fundId = 9100001;
  const positions = positionRows(demo<Positions>(`fund/${fundId}/positions.json`));
  const exits = demo<Exits>(`fund/${fundId}/exits.json`);
  const latest = demo<LatestPrices>("latest_prices.json");
  const stocks = stockMap(demo<Securities>("securities.json"));
  const prices = priceMap(latest);

  it("lists every sale, the one that was most missed first", () => {
    renderWhatIf({ fundId, positions, exits, prices, stocks, asof: latest.asof });
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
    renderWhatIf({ fundId, positions, exits, prices, stocks, asof: latest.asof });
    const soldAll = rowsOf().filter((r) => r["Status"] === "Sold all");
    expect(soldAll.length).toBeGreaterThan(0);
    const differing = soldAll.filter((r) => r["IRR actual"] !== "—" && r["IRR if held"] !== "—" && r["IRR actual"] !== r["IRR if held"]);
    expect(differing.length).toBeGreaterThan(0);
  });
});
