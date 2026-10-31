import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentProps } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { priceMap, stockMap } from "../src/data/api";
import type { Exits, ExitsSummary, ExitStatus, LatestPrices, PositionRow, Positions, Securities, Trade } from "../src/data/types";
import { positionRows, totalPnl } from "../src/lib/live";
import { FundTables } from "../src/pages/FundTables";

// ---- fixtures -----------------------------------------------------------------

const FUND = 42;
const ASOF = "2026-10-30"; // 13.83 years after 2013-01-01

type Props = ComponentProps<typeof FundTables>;

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

function renderTables(props: Partial<Props> = {}) {
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
        <Route path="/fund/:id" element={<FundTables {...all} />} />
        <Route path="/fund/:id/stock/:stockId" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

const POSITIONS = "Positions by stock";
const SALES = "Sold or trimmed stocks";

type Cells = Record<string, string>;

/** The body rows of a table as {column header: cell text}. */
function rowsOf(name: string): Cells[] {
  const table = screen.getByRole("table", { name });
  const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent as string);
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => Object.fromEntries(within(r).getAllByRole("cell").map((c, i) => [heads[i], c.textContent as string])));
}

/** Tickers down the Stock column, top to bottom. */
const tickersOf = (name: string): string[] =>
  within(screen.getByRole("table", { name }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => (r.querySelector(".mono") as HTMLElement).textContent as string);

/** One row of a table, by its ticker. */
function rowOf(name: string, ticker: string): Cells {
  const at = tickersOf(name).indexOf(ticker);
  expect(at, `${ticker} in ${name}`).toBeGreaterThanOrEqual(0);
  return rowsOf(name)[at];
}

/** The sort button of a column header of one table (both tables have a Stock and a Last change column). */
const sortButton = (table: string, header: string) => within(screen.getByRole("table", { name: table })).getByRole("button", { name: header });

const tileOf = (label: string): HTMLElement => screen.getByText(label).closest(".tile") as HTMLElement;
const tileValue = (label: string) => tileOf(label).querySelector(".v")?.textContent;
const tileSub = (label: string) => tileOf(label).querySelector(".d")?.textContent;

// ---- every stock they've owned ---------------------------------------------------

describe("Every stock they've owned", () => {
  // totals at these prices: S2 +2,000 · S1 +500 · S5 +100 · S3 −300 · S4 unknown (held, no price)
  const positions = [pos(1), pos(2), sold(3, -300), pos(4, { realised: 50 }), sold(5, 100)];
  const prices = pricesOf({ 1: 15, 2: 30, 3: 10, 5: 10 });

  it("default sort is total P&L descending, a total that cannot be known last", async () => {
    renderTables({ positions, prices });
    expect(tickersOf(POSITIONS)).toEqual(["S2", "S1", "S5", "S3", "S4"]);
    expect(rowsOf(POSITIONS).map((r) => r["Total P&L"])).toEqual(["+$2,000", "+$500", "+$100", "−$300", "—"]);
    expect(screen.getByRole("columnheader", { name: "Total P&L" })).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(screen.getByRole("button", { name: "Total P&L" }));
    expect(tickersOf(POSITIONS)).toEqual(["S3", "S5", "S1", "S2", "S4"]); // still last when ascending
    expect(screen.getByRole("columnheader", { name: "Total P&L" })).toHaveAttribute("aria-sort", "ascending");

    await userEvent.click(screen.getByRole("button", { name: "Total P&L" }));
    expect(tickersOf(POSITIONS)).toEqual(["S2", "S1", "S5", "S3", "S4"]);
  });

  it("sorts on any column: text ascending first, numbers largest first, missing values last either way", async () => {
    renderTables({ positions, prices });
    await userEvent.click(sortButton(POSITIONS, "Stock"));
    expect(tickersOf(POSITIONS)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    await userEvent.click(sortButton(POSITIONS, "Stock"));
    expect(tickersOf(POSITIONS)).toEqual(["S5", "S4", "S3", "S2", "S1"]);

    // Unrealised: only S1 and S2 have one (S3 and S5 are sold, S4 has no price); ties keep the list's order
    await userEvent.click(sortButton(POSITIONS, "Unrealised"));
    expect(tickersOf(POSITIONS)).toEqual(["S2", "S1", "S3", "S4", "S5"]);
    await userEvent.click(sortButton(POSITIONS, "Unrealised"));
    expect(tickersOf(POSITIONS)).toEqual(["S1", "S2", "S3", "S4", "S5"]);

    await userEvent.click(sortButton(POSITIONS, "Realised"));
    expect(tickersOf(POSITIONS)).toEqual(["S5", "S4", "S1", "S2", "S3"]); // +100, +50, 0, 0, −300
  });

  it("sold filter shows closed only", async () => {
    renderTables({ positions, prices });
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Sold" }));
    expect(screen.getByRole("button", { name: "Sold" })).toHaveAttribute("aria-pressed", "true");
    expect(tickersOf(POSITIONS)).toEqual(["S5", "S3"]); // sorted as before
    for (const r of rowsOf(POSITIONS)) expect(r["Held"]).toMatch(/→ Q\d \d{4}$/); // none is "now"
  });

  it("still-held filter shows positions with shares only", async () => {
    renderTables({ positions, prices });
    await userEvent.click(screen.getByRole("button", { name: "Still held" }));
    expect(screen.getByRole("button", { name: "Still held" })).toHaveAttribute("aria-pressed", "true");
    expect(tickersOf(POSITIONS)).toEqual(["S2", "S1", "S4"]);
    for (const r of rowsOf(POSITIONS)) expect(r["Held"]).toMatch(/→ now$/);

    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(tickersOf(POSITIONS)).toHaveLength(5);
  });

  it("says so when a filter leaves nothing", async () => {
    renderTables({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
    await userEvent.click(screen.getByRole("button", { name: "Sold" }));
    expect(within(screen.getByRole("table", { name: POSITIONS })).getByText("No stock to show here.")).toBeInTheDocument();
  });

  it("shows dash for missing price", () => {
    renderTables({ positions, prices });
    const row = rowOf(POSITIONS, "S4"); // held, not in latest prices
    expect(row["Current price"]).toBe("—");
    expect(row["Unrealised"]).toBe("—");
    expect(row["IRR"]).toBe("—");
    expect(row["Return"]).toBe("—");
    expect(row["Total P&L"]).toBe("—");
    expect(row["Realised"]).toBe("+$50"); // what does not need a price is still there
    expect(row["Avg cost"]).toBe("$10.00");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("fills the price-based cells for a priced position", () => {
    renderTables({ positions, prices });
    const row = rowOf(POSITIONS, "S1");
    expect(row["Stock"]).toBe("S1 Company 1");
    expect(row["Held"]).toBe("Q3 2015 → now");
    expect(row["Avg cost"]).toBe("$10.00");
    expect(row["Current price"]).toBe("$15.00");
    expect(row["Avg exit"]).toBe("—"); // never sold
    expect(row["Return"]).toBe("+50%");
    expect(row["IRR"]).toBe("+4%"); // 1,000 out in Q3 2015, 1,500 back at 13.83 years
    expect(row["$ in"]).toBe("$1,000");
    expect(row["Realised"]).toBe("$0");
    expect(row["Unrealised"]).toBe("+$500");
    expect(row["Total P&L"]).toBe("+$500");
    const closed = rowOf(POSITIONS, "S3");
    expect(closed["Held"]).toBe("Q3 2015 → Q2 2025");
    expect(closed["Unrealised"]).toBe("—"); // nothing is held, so nothing is unrealised
    expect(closed["Total P&L"]).toBe("−$300");
  });

  it("words the last change: New, Sold all, or the change in shares, each with its quarter", () => {
    const rows = [
      pos(1, { last_type: "new", last_pct: null, last_q: 53, last_usd: 5000 }),
      sold(2, 100, { last_type: "exit", last_pct: null, last_q: 49, last_usd: -7000 }),
      pos(3, { last_type: "add", last_pct: 0.35, last_q: 52, last_usd: 3500 }),
      pos(4, { last_type: "trim", last_pct: -0.32, last_q: 51, last_usd: -2400 }),
    ];
    renderTables({ positions: rows, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
    expect(rowOf(POSITIONS, "S1")["Last change"]).toBe("New Q2 2026");
    expect(rowOf(POSITIONS, "S2")["Last change"]).toBe("Sold all Q2 2025");
    expect(rowOf(POSITIONS, "S3")["Last change"]).toBe("+35% Q1 2026");
    expect(rowOf(POSITIONS, "S4")["Last change"]).toBe("−32% Q4 2025");
    expect(rowOf(POSITIONS, "S1")["Last change $"]).toBe("+$5,000");
    expect(rowOf(POSITIONS, "S2")["Last change $"]).toBe("−$7,000");
  });

  it("sorts the last change with a new position above every add and a sale below every trim", async () => {
    const rows = [
      pos(1, { last_type: "new", last_pct: null, last_usd: 5000 }),
      sold(2, 100, { last_type: "exit", last_pct: null }),
      pos(3, { last_type: "add", last_pct: 0.35 }),
      pos(4, { last_type: "trim", last_pct: -0.32, last_usd: -2400 }),
    ];
    renderTables({ positions: rows, prices: pricesOf({ 1: 10, 2: 10, 3: 10, 4: 10 }) });
    await userEvent.click(sortButton(POSITIONS, "Last change"));
    expect(tickersOf(POSITIONS)).toEqual(["S1", "S3", "S4", "S2"]);
  });

  describe("stat tiles", () => {
    // S1 +500 (+50%) · S2 −200 (−20%) · S3 +700 (+70%) · S4 held, no price · S5 −300 (−30%)
    const rows = [pos(1), pos(2), sold(3, 700), pos(4), sold(5, -300)];
    const closes = pricesOf({ 1: 15, 2: 8, 3: 10, 5: 10 });

    it("adds up the whole fund at the latest prices", () => {
      renderTables({ positions: rows, prices: closes });
      expect(tileValue("Profitable")).toBe("50%");
      expect(tileSub("Profitable")).toBe("2 of 4"); // S4 has no total, so it is not counted
      expect(tileValue("Realised P&L")).toBe("+$400");
      expect(tileValue("Unrealised P&L")).toBe("+$300"); // S4 skipped
      expect(tileSub("Unrealised P&L")).toBe("at latest prices");
      expect(tileValue("Avg winner / loser")).toBe("+60% / −25%");
      expect(tileValue("$ won per $ lost")).toBe("2.40×"); // 1,200 won, 500 lost
      expect(tileValue("Best position")).toBe("S3");
      expect(tileSub("Best position")).toBe("+$700");
      expect(tileValue("Worst position")).toBe("S5");
      expect(tileSub("Worst position")).toBe("−$300");
    });

    it("does not follow the filter", async () => {
      renderTables({ positions: rows, prices: closes });
      await userEvent.click(screen.getByRole("button", { name: "Sold" }));
      expect(tileValue("Profitable")).toBe("50%");
      expect(tileValue("Realised P&L")).toBe("+$400");
    });

    it("dashes what has no losers", () => {
      renderTables({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
      expect(tileValue("$ won per $ lost")).toBe("—");
      expect(tileValue("Avg winner / loser")).toBe("+50% / —");
    });

    it("shows dashes without positions", () => {
      renderTables();
      for (const label of ["Profitable", "Avg winner / loser", "$ won per $ lost", "Best position", "Worst position"]) {
        expect(tileValue(label), label).toMatch(/^—( \/ —)?$/);
      }
      expect(tileValue("Realised P&L")).toBe("$0");
      expect(within(screen.getByRole("table", { name: POSITIONS })).getByText("No stock to show here.")).toBeInTheDocument();
    });
  });

  describe("opening a position", () => {
    it("opens the position page of a row on click", async () => {
      renderTables({ positions, prices });
      await userEvent.click(within(screen.getByRole("table", { name: POSITIONS })).getByText("Company 2"));
      expect(await screen.findByText("Position page: stock 2 of fund 42")).toBeInTheDocument();
    });

    it("opens it on Enter too", async () => {
      renderTables({ positions, prices });
      const row = within(screen.getByRole("table", { name: POSITIONS })).getAllByRole("row")[2]; // S1, second by total
      expect(row).toHaveAttribute("tabindex", "0");
      row.focus();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByText("Position page: stock 1 of fund 42")).toBeInTheDocument();
    });
  });

  describe("large funds", () => {
    /** n positions, one in five sold out, each with a price. */
    const many = (n: number): Pick<Props, "positions" | "prices" | "stocks"> => ({
      positions: Array.from({ length: n }, (_, i) => (i % 5 === 0 ? sold(i + 1, i % 2 ? 300 : -300) : pos(i + 1))),
      prices: new Map(Array.from({ length: n }, (_, i) => [i + 1, 8 + (i % 7)] as [number, number])),
      stocks: stocksTo(n),
    });

    it("virtualises 16k rows", () => {
      renderTables(many(16_000));
      const table = screen.getByRole("table", { name: POSITIONS });
      const rendered = table.querySelectorAll("tr").length;
      expect(rendered).toBeGreaterThan(2); // a window of rows, not none
      expect(rendered).toBeLessThan(100);
      expect(table).toHaveAttribute("aria-rowcount", "16001");
      expect(tileValue("Profitable")).toMatch(/^\d+%$/);
    });

    it("is virtual only above 500 rows", async () => {
      const bodyRows = () => screen.getByRole("table", { name: POSITIONS }).querySelectorAll("tbody tr:not([aria-hidden])").length;
      const { unmount } = renderTables(many(500));
      expect(screen.getByRole("table", { name: POSITIONS })).not.toHaveAttribute("aria-rowcount");
      expect(bodyRows()).toBe(500);
      unmount();

      renderTables(many(501));
      expect(screen.getByRole("table", { name: POSITIONS })).toHaveAttribute("aria-rowcount", "502");
      expect(bodyRows()).toBeLessThan(100);

      // 101 of the 501 are sold out: that filter fits in a plain table again
      await userEvent.click(screen.getByRole("button", { name: "Sold" }));
      expect(screen.getByRole("table", { name: POSITIONS })).not.toHaveAttribute("aria-rowcount");
      expect(bodyRows()).toBe(101);
    });
  });
});

// ---- what if they'd kept it ---------------------------------------------------------

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

  it("default sort is $ missed descending, with signed amounts and the unpriced last", async () => {
    renderTables({ exits, prices });
    expect(tickersOf(SALES)).toEqual(["S1", "S2", "S4", "S3", "S5"]);
    expect(rowsOf(SALES).map((r) => r["$ missed / dodged"])).toEqual(["+$1,000", "+$110", "−$140", "−$1,000", "—"]);
    expect(screen.getByRole("columnheader", { name: "$ missed / dodged" })).toHaveAttribute("aria-sort", "descending");

    await userEvent.click(sortButton(SALES, "$ missed / dodged"));
    expect(tickersOf(SALES)).toEqual(["S3", "S4", "S2", "S1", "S5"]);
  });

  it("colours a miss red and a dodge green", () => {
    renderTables({ exits, prices });
    const cells = within(screen.getByRole("table", { name: SALES }))
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell").slice(-1)[0].firstElementChild);
    expect(cells[0]).toHaveClass("down"); // S1 missed
    expect(cells[2]).toHaveClass("up"); // S4 dodged
    expect(cells[4]).not.toHaveAttribute("class"); // S5 unknown
  });

  it("missed and dodged tiles add up", () => {
    renderTables({ exits, prices });
    expect(tileValue("Sold too early")).toBe("$1,110"); // 1,000 + 110
    expect(tileValue("Losses dodged")).toBe("$1,140"); // 1,000 + 140, unsigned
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
    renderTables({ exits: withReturns, prices });
    expect(tileValue("Sold stocks that beat SPY next year")).toBe("50%");
    expect(tileSub("Sold stocks that beat SPY next year")).toBe("of 2 sold stocks"); // S3 has no return a year on
  });

  it("calls the sells smart when they trailed the buys, costly otherwise", () => {
    const { unmount } = renderTables({ exits, prices });
    expect(tileValue("Buys vs sells, next 12 months")).toBe("+10% vs +4%");
    expect(tileSub("Buys vs sells, next 12 months")).toBe("Sells were smart: +6.0 pts gap");
    unmount();

    renderTables({ exits: { ...exits, summary: { ...exits.summary, buys_12m: 0.02, sells_12m: 0.05 } }, prices });
    expect(tileSub("Buys vs sells, next 12 months")).toBe("Sells were costly: −3.0 pts gap");
  });

  it("dashes the tiles that have nothing to average", () => {
    renderTables({ exits: { ...exits, summary: { buys_12m: null, sells_12m: 0.05, beat_spy_pct: null } }, prices });
    expect(tileValue("Buys vs sells, next 12 months")).toBe("—");
    expect(tileSub("Buys vs sells, next 12 months")).toBeUndefined();
    expect(tileValue("Sold stocks that beat SPY next year")).toBe("—");
  });

  it("fills the columns of a sale", () => {
    const e = exitsOf([{ stock_id: 2, sold_shares: 1234567.4, sold_usd: 1234567.4 * 10, status: "trimmed", one_y: 0.12, spy_one_y: -0.04 }]);
    renderTables({ exits: e, prices: pricesOf({ 2: 12.5 }) });
    const row = rowOf(SALES, "S2");
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
    renderTables({ exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 1000 }]), prices });
    expect(rowOf(SALES, "S1")["Status"]).toBe("Sold all");
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
    renderTables({
      positions: [p],
      exits: exitsOf([{ stock_id: 1, sold_shares: 100, sold_usd: 2000 }]),
      prices: pricesOf({ 1: 40 }),
    });
    const row = rowOf(SALES, "S1");
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
    expect(rowOf(POSITIONS, "S1")["IRR"]).toBe("+100%"); // the same figure as IRR actual
  });

  it("shows a dash for each cell that needs a price or a position it does not have", () => {
    // S1: sold out, no price. S2: no position in the list at all.
    const p = sold(1, 500, { trades: [trade(0, 100, 10, 100), trade(4, -100, 20, 0)] });
    renderTables({
      positions: [p],
      exits: exitsOf([
        { stock_id: 1, sold_shares: 100, sold_usd: 2000 },
        { stock_id: 2, sold_shares: 100, sold_usd: 2000 },
      ]),
      prices: new Map(),
    });
    const noPrice = rowOf(SALES, "S1");
    expect(noPrice["Current price"]).toBe("—");
    expect(noPrice["Since sale"]).toBe("—");
    expect(noPrice["$ missed / dodged"]).toBe("—");
    expect(noPrice["IRR if held"]).toBe("—");
    expect(noPrice["IRR actual"]).toBe("+100%"); // nothing is held, so the price is not needed
    expect(noPrice["Return"]).toBe("+50%");

    const noPosition = rowOf(SALES, "S2");
    for (const header of ["Avg cost", "Return", "IRR actual", "IRR if held", "Last change", "Last change $", "Current price"]) {
      expect(noPosition[header], header).toBe("—");
    }
    expect(noPosition["Shares sold"]).toBe("100");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("opens the position page of a row", async () => {
    renderTables({ exits, prices });
    await userEvent.click(within(screen.getByRole("table", { name: SALES })).getByText("Company 4"));
    expect(await screen.findByText("Position page: stock 4 of fund 42")).toBeInTheDocument();
  });

  it("says so when nothing was sold", () => {
    renderTables({ positions: [pos(1)], prices: pricesOf({ 1: 15 }) });
    expect(within(screen.getByRole("table", { name: SALES })).getByText("They have not sold or trimmed anything yet.")).toBeInTheDocument();
    expect(tileValue("Sold too early")).toBe("$0");
    expect(tileValue("Losses dodged")).toBe("$0");
  });

  it("virtualises a long list of sales", () => {
    const n = 2000;
    const rows = Array.from({ length: n }, (_, i): ExitIn => ({ stock_id: i + 1, sold_shares: 10, sold_usd: 100 }));
    renderTables({
      exits: exitsOf(rows),
      prices: new Map(Array.from({ length: n }, (_, i) => [i + 1, 5 + (i % 9)] as [number, number])),
      stocks: stocksTo(n),
    });
    const rendered = screen.getByRole("table", { name: SALES }).querySelectorAll("tr").length;
    expect(rendered).toBeGreaterThan(2);
    expect(rendered).toBeLessThan(100);
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

  it("lists every position by total P&L, best first, and every sale by $ missed", () => {
    renderTables({ fundId, positions, exits, prices, stocks, asof: latest.asof });
    const expected = positions
      .map((p) => ({ ticker: stocks.get(p.stock_id)?.ticker, total: totalPnl(p, prices.get(p.stock_id)) as number }))
      .sort((a, b) => b.total - a.total)
      .map((p) => p.ticker);
    expect(tickersOf(POSITIONS)).toEqual(expected);
    expect(tickersOf(SALES)).toHaveLength(exits.rows.stock_id.length);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("IRR if held differs from IRR actual on a sold-out stock", () => {
    renderTables({ fundId, positions, exits, prices, stocks, asof: latest.asof });
    const soldAll = rowsOf(SALES).filter((r) => r["Status"] === "Sold all");
    expect(soldAll.length).toBeGreaterThan(0);
    const differing = soldAll.filter((r) => r["IRR actual"] !== "—" && r["IRR if held"] !== "—" && r["IRR actual"] !== r["IRR if held"]);
    expect(differing.length).toBeGreaterThan(0);
  });
});
