import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { clearDataCache } from "../src/data/api";
import type {
  CallRow,
  ConvictionRow,
  FundsIndex,
  LatestPrices,
  RowsFile,
  TopList,
  TopRow,
} from "../src/data/types";
import Home from "../src/pages/Home";

// ---- fixtures: the demo JSON under public/demo-data, served through a mocked fetch ----

// (not `new URL(..., import.meta.url)`: Vite rewrites that into an asset URL)
const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;

/**
 * Stub fetch with the demo files. `overrides` replaces a file's body (keyed by the path under
 * demo-data); `failing` makes those paths answer HTTP 500. Returns every URL requested, in order.
 */
function stubData(overrides: Record<string, unknown> = {}, failing: string[] = []): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const path = url.replace(/^\/demo-data\//, "");
      if (failing.includes(path)) return { ok: false, status: 500, json: async () => ({}) };
      const body = path in overrides ? overrides[path] : demo<unknown>(path);
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return urls;
}

/** The demo's latest prices with some stocks' close replaced (null = no close). */
function pricesWith(changes: Record<number, number | null>): LatestPrices {
  const lp = demo<LatestPrices>("latest_prices.json");
  for (const [id, price] of Object.entries(changes)) {
    const i = lp.stock_id.indexOf(Number(id));
    lp.price[i] = price;
    if (price == null) lp.date[i] = null;
  }
  return lp;
}

const call = (stock_id: number, fund_id: number, name: string, est_price: number, price_on_filed: number): CallRow => ({
  stock_id,
  fund_id,
  name,
  q: 53,
  est_price,
  price_on_filed,
  filed: "2026-08-11",
});

function FundStub() {
  const { id } = useParams();
  return <p>Fund page {id}</p>;
}
function StockStub() {
  const { id, stockId } = useParams();
  return (
    <p>
      Stock page {id}/{stockId}
    </p>
  );
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/fund/:id" element={<FundStub />} />
        <Route path="/fund/:id/stock/:stockId" element={<StockStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

const TAB_NAMES = [
  "Top funds",
  "Conviction moves",
  "Big wins & losses",
  "Just filed",
  "Crowded buys",
  "Best & worst calls",
];

/** Name in the first body row of the (only) table on screen. */
const firstFund = () => within(screen.getAllByRole("row")[1]).getAllByRole("link")[0].textContent;
/** Fund names down the first column of the calls table, in order. */
const fundOrder = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("link")[1].textContent);

beforeEach(() => clearDataCache());
afterEach(() => vi.unstubAllGlobals());

describe("Home", () => {
  it("shows six tabs in order", async () => {
    stubData();
    renderHome();
    await screen.findByRole("table"); // Top funds has loaded
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(TAB_NAMES);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs.slice(1).every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("search filters and navigates", async () => {
    stubData();
    const user = userEvent.setup();
    const funds = demo<FundsIndex>("funds.json");
    const word = funds.name[0].split(" ")[0]; // a first word only one demo fund has
    renderHome();
    await user.type(screen.getByRole("searchbox", { name: /search a fund/i }), word.toLowerCase());
    const list = await screen.findByRole("list", { name: "Matching funds" });
    expect(within(list).getByRole("link", { name: new RegExp(funds.name[0]) })).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(await screen.findByText(`Fund page ${funds.id[0]}`)).toBeInTheDocument();
  });

  it("search opens a clicked match, caps the list and says when nothing matches", async () => {
    stubData();
    const user = userEvent.setup();
    const funds = demo<FundsIndex>("funds.json");
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });

    await user.type(box, "zzzz");
    expect(await screen.findByText(/No fund matches/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Matching funds" })).not.toBeInTheDocument();

    // "a" is in every demo name: the list is capped at 8 of the 12 funds
    await user.clear(box);
    await user.type(box, "a");
    const list = await screen.findByRole("list", { name: "Matching funds" });
    expect(within(list).getAllByRole("link")).toHaveLength(8);

    await user.clear(box);
    await user.type(box, "Tern");
    const tern = funds.id[funds.name.indexOf("Tern Harbor Equity")];
    await user.click(await within(await screen.findByRole("list", { name: "Matching funds" })).findByRole("link", { name: /Tern Harbor Equity/ }));
    expect(await screen.findByText(`Fund page ${tern}`)).toBeInTheDocument();
  });

  it("search results close on Escape and when focus leaves the box, and come back on typing or focus", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    const results = () => screen.queryByRole("list", { name: "Matching funds" });

    await user.type(box, "Ter");
    expect(await screen.findByRole("list", { name: "Matching funds" })).toBeInTheDocument();

    // Escape closes the list but keeps the text and the focus; typing opens it again
    await user.keyboard("{Escape}");
    expect(results()).toBeNull();
    expect(box).toHaveValue("Ter");
    expect(box).toHaveFocus();
    await user.keyboard("n");
    expect(await screen.findByRole("list", { name: "Matching funds" })).toBeInTheDocument();

    // clicking elsewhere closes it; focusing the box again opens it
    await user.click(document.body);
    expect(results()).toBeNull();
    expect(box).toHaveValue("Tern");
    await user.click(box);
    expect(results()).not.toBeNull();

    // moving focus within the box (the button, then a result) keeps it open; tabbing out closes it
    await user.tab();
    expect(screen.getByRole("button", { name: "Open fund" })).toHaveFocus();
    expect(results()).not.toBeNull();
    await user.tab();
    const link = within(results()!).getByRole("link", { name: /Tern Harbor Equity/ });
    expect(link).toHaveFocus();
    expect(results()).not.toBeNull();
    await user.tab(); // the second result
    expect(results()).not.toBeNull();
    await user.tab(); // out of the box, onto the tabs
    expect(screen.getByRole("tab", { name: "Top funds" })).toHaveFocus();
    expect(results()).toBeNull();
  });

  it("Escape from a result puts the focus back in the search box", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    await user.type(box, "Tern");
    await screen.findByRole("list", { name: "Matching funds" });
    await user.tab(); // Open fund
    await user.tab(); // the first result
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("list", { name: "Matching funds" })).toBeNull();
    expect(box).toHaveFocus();
  });

  it("counts positions with thousands separators and the right plural, in the search results and in the Top funds list", async () => {
    const funds = demo<FundsIndex>("funds.json");
    funds.n[funds.name.indexOf("Kelpwood Capital LP")] = 16000;
    funds.n[funds.name.indexOf("Tern Harbor Equity")] = 1;
    const t3 = demo<TopList>("home/top_3y.json");
    t3.eligible[0] = { ...t3.eligible[0], n_positions: 16000 };
    stubData({ "funds.json": funds, "home/top_3y.json": t3 });
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    await user.type(box, "Kelpwood");
    expect(await screen.findByText(/· 16,000 positions$/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "Tern H");
    expect(await screen.findByText(/· 1 position$/)).toBeInTheDocument();
    const cells = within(await screen.findByRole("table", { name: "Top funds" })).getAllByRole("row")[1];
    expect(within(cells).getByText("16,000")).toBeInTheDocument();
  });

  it("top funds period switch reloads list", async () => {
    const urls = stubData();
    const user = userEvent.setup();
    const t1 = demo<TopList>("home/top_1y.json");
    const t3 = demo<TopList>("home/top_3y.json");
    const t5 = demo<TopList>("home/top_5y.json");
    const tMax = demo<TopList>("home/top_max.json");
    renderHome();
    await screen.findByRole("table");
    expect(firstFund()).toBe(t3.eligible[0].name); // 3 years is the pressed chip

    for (const [chip, file, list] of [
      ["1 year", "top_1y", t1],
      ["5 years", "top_5y", t5],
      ["Since start", "top_max", tMax],
      ["3 years", "top_3y", t3],
    ] as const) {
      await user.click(screen.getByRole("button", { name: chip }));
      expect(screen.getByRole("button", { name: chip })).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(firstFund()).toBe(list.eligible[0].name));
      expect(urls).toContain(`/demo-data/home/${file}.json`);
    }
    // the demo lists lead with different funds, so the checks above could not pass by accident
    expect(new Set([t1, t3, t5, tMax].map((t) => t.eligible[0].name)).size).toBeGreaterThan(1);
  });

  it("top funds lists index giants under their own heading and uses the right columns", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const giant: TopRow = { ...t3.eligible[0], fund_id: 7, name: "Vanguard-like Giant", sharpe: null, max_dd: null };
    stubData({ "home/top_3y.json": { ...t3, giants: [giant] } });
    renderHome();
    await screen.findByRole("heading", { name: "Index giants" });
    const [main, giants] = screen.getAllByRole("table");
    expect(within(main).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Fund",
      "13F book",
      "Positions",
      "Return / yr",
      "Worst drop",
      "Sharpe",
    ]);
    const row = within(giants).getAllByRole("row")[1];
    expect(within(row).getByRole("link", { name: "Vanguard-like Giant" })).toHaveAttribute("href", "/fund/7");
    expect(within(row).getAllByText("—")).toHaveLength(2); // missing worst drop and Sharpe
  });

  it("has no giants heading when there are no giants", async () => {
    stubData();
    renderHome();
    await screen.findByRole("table");
    expect(screen.queryByRole("heading", { name: "Index giants" })).not.toBeInTheDocument();
  });

  it("each tab states its rule and shows its list", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await screen.findByText(/Who qualifies: 13F book ≥ \$1B/);

    const rules: [string, RegExp, string[]][] = [
      ["Conviction moves", /Funds: concentrated active managers \(4–60 positions/, ["Fund", "Stock", "Move", "Weight now", "Change", "Est. price", "Since"]],
      ["Big wins & losses", /Largest single-position gains and losses in Q2 2026, among funds that qualify for Top funds\./, ["Fund", "Stock", "Quarter P&L"]],
      ["Just filed", /Newest 13F filings, each with its headline change\./, ["Fund", "Filed", "Period", "13F book", "Headline change"]],
      ["Crowded buys", /Stocks bought by several concentrated active funds in the same quarter \(Q2 2026\)\./, ["Stock", "Funds buying", "Total bought", "Avg weight after"]],
      ["Best & worst calls", /New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or Conviction moves\./, ["Stock", "Fund", "Bought", "Est. buy price", "Price now", "Since fund's buy", "Since 13F went public"]],
    ];
    for (const [tab, rule, headers] of rules) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByText(rule)).toBeInTheDocument();
      const table = (await screen.findAllByRole("table"))[0];
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(headers);
      // no SPY benchmark column or rule anywhere on Home
      expect(screen.queryAllByRole("columnheader", { name: /spy|s&p/i })).toHaveLength(0);
      expect(document.querySelector(".rule")?.textContent).not.toMatch(/spy|s&p/i);
    }
  });

  it("big wins & losses shows wins and losses as two lists", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Big wins & losses" }));
    const wins = await screen.findByRole("table", { name: "Biggest wins" });
    const losses = screen.getByRole("table", { name: "Biggest losses" });
    expect(within(wins).getAllByRole("row")).toHaveLength(26); // header + 25 demo wins
    const loss = within(losses).getAllByRole("row")[1];
    expect(within(loss).getAllByRole("cell")[2].textContent).toMatch(/^−\$/); // a loss reads as a negative amount
    expect(within(loss).getByRole("link", { name: /^Seastack/ })).toHaveAttribute("href", "/fund/9100009");
  });

  it("conviction shows weight, change and the move since the estimated trade price", async () => {
    const rows: ConvictionRow[] = [
      { fund_id: 9100003, name: "Lanternfish Capital Management", stock_id: 13, move: "exit", weight_now: 0, change_pts: -9.6, est_price: 100, q: 53 },
      { fund_id: 9100006, name: "Brinestone Value Partners", stock_id: 5, move: "new", weight_now: 0.0924, change_pts: 9.24, est_price: 50, q: 53 },
    ];
    const file: RowsFile<ConvictionRow> = { latest_q: 53, rows };
    stubData({ "home/conviction.json": file, "latest_prices.json": pricesWith({ 13: 80, 5: null }) });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByText(/Q2 2026 filings/);
    const [exit, added] = (await screen.findAllByRole("row")).slice(1);
    expect(within(exit).getByText("Exit")).toBeInTheDocument();
    expect(within(exit).getByText("0.0%")).toBeInTheDocument();
    expect(within(exit).getByText("−9.6 pts")).toBeInTheDocument();
    expect(within(exit).getByText("$100")).toBeInTheDocument();
    expect(within(exit).getByText("−20.0%")).toBeInTheDocument(); // 80 / 100 - 1
    expect(within(exit).getByRole("link", { name: /UNH/ })).toHaveAttribute("href", "/fund/9100003/stock/13");
    expect(within(added).getByText("New")).toBeInTheDocument();
    expect(within(added).getByText("9.2%")).toBeInTheDocument();
    expect(within(added).getByText("+9.2 pts")).toBeInTheDocument();
    expect(within(added).getByText("—")).toBeInTheDocument(); // no latest price for this stock
  });

  it("just filed names the headline stock and its change", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Just filed" }));
    const first = (await screen.findAllByRole("row"))[1];
    const cells = within(first).getAllByRole("cell");
    expect(within(cells[0]).getByRole("link", { name: "Orcinus Lane Capital" })).toHaveAttribute("href", "/fund/9100011");
    expect(cells[1].textContent).toBe("14 Oct 2026");
    expect(cells[2].textContent).toBe("Q3 2026"); // period_q 54
    expect(cells[3].textContent).toBe("$14.2B");
    expect(within(cells[4]).getByRole("link", { name: /JPM/ })).toHaveAttribute("href", "/fund/9100011/stock/15");
    expect(cells[4].textContent).toContain("−8.2 pts");
  });

  it("crowded buys lists funds buying, total bought and average weight", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Crowded buys" }));
    const first = (await screen.findAllByRole("row"))[1];
    const cells = within(first).getAllByRole("cell");
    expect(cells[0].textContent).toContain("AVGO");
    expect(cells[1].textContent).toBe("5");
    expect(cells[2].textContent).toBe("$9.24B");
    expect(cells[3].textContent).toBe("8.3%");
  });

  it("calls computes since-buy from latest price", async () => {
    stubData({
      "home/calls_q.json": { latest_q: 53, rows: [call(16, 9100001, "Kelpwood Capital LP", 10, 11)] },
      "latest_prices.json": pricesWith({ 16: 12 }),
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    const row = (await screen.findAllByRole("row"))[1];
    expect(within(row).getByRole("link", { name: /VISA INC/ })).toHaveAttribute("href", "/fund/9100001/stock/16");
    expect(within(row).getByRole("link", { name: "Kelpwood Capital LP" })).toHaveAttribute("href", "/fund/9100001");
    expect(within(row).getByText("Q2 2026")).toBeInTheDocument();
    expect(within(row).getByText("$10.00")).toBeInTheDocument(); // est. buy price
    expect(within(row).getByText("$12.00")).toBeInTheDocument(); // price now
    expect(within(row).getByText("+20.0%")).toBeInTheDocument(); // 12 / 10 - 1
    expect(within(row).getByText("+9.1%")).toBeInTheDocument(); // 12 / 11 - 1
  });

  it("calls shows a dash where the latest price is missing", async () => {
    stubData({
      "home/calls_q.json": { latest_q: 53, rows: [call(16, 9100001, "Kelpwood Capital LP", 10, 11)] },
      "latest_prices.json": pricesWith({ 16: null }),
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    const row = (await screen.findAllByRole("row"))[1];
    // price now, % since fund's buy, % since filed
    expect(within(row).getAllByText("—")).toHaveLength(3);
    expect(within(row).queryByText(/%/)).not.toBeInTheDocument();
  });

  it("calls orders best by live move descending and worst ascending, unpriced last", async () => {
    stubData({
      "home/calls_q.json": {
        latest_q: 53,
        rows: [
          call(2, 9100001, "Fund C", 100, 100), // +10%
          call(3, 9100002, "Fund Gone", 100, 100), // no price
          call(4, 9100003, "Fund B", 100, 100), // -20%
          call(5, 9100004, "Fund A", 100, 100), // +50%
        ],
      },
      "latest_prices.json": pricesWith({ 2: 110, 3: null, 4: 80, 5: 150 }),
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Best calls" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(fundOrder()).toEqual(["Fund A", "Fund C", "Fund B", "Fund Gone"]));
    await user.click(screen.getByRole("button", { name: "Worst calls" }));
    expect(screen.getByRole("button", { name: "Worst calls" })).toHaveAttribute("aria-pressed", "true");
    expect(fundOrder()).toEqual(["Fund B", "Fund C", "Fund A", "Fund Gone"]);
  });

  it("calls window chips load last quarter's or the last four quarters' file", async () => {
    const urls = stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    await screen.findByRole("table");
    expect(urls).toContain("/demo-data/home/calls_q.json");
    expect(urls).not.toContain("/demo-data/home/calls_y.json");
    expect(screen.getByRole("button", { name: "Last quarter's buys" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Last 4 quarters' buys" }));
    await waitFor(() => expect(urls).toContain("/demo-data/home/calls_y.json"));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(demo<RowsFile<CallRow>>("home/calls_y.json").rows.length + 1));
  });

  it("a list that fails to load shows one error line, not a blank page", async () => {
    stubData({}, ["home/conviction.json"]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t load/i);
    expect(screen.getAllByRole("tab")).toHaveLength(6); // the page is still there
    await user.click(screen.getByRole("tab", { name: "Top funds" })); // and the other lists still work
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("search says so when the fund index fails to load", async () => {
    stubData({}, ["funds.json"]);
    renderHome();
    expect(await screen.findByText(/search isn.t available/i)).toBeInTheDocument();
    await screen.findByRole("table"); // lists unaffected
  });
});
