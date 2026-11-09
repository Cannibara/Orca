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
import { fBook } from "../src/pages/homeFmt";

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
  it("\"/\" jumps to the search, except while typing in a text field", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    expect(box).not.toHaveFocus();
    await user.keyboard("/");
    expect(box).toHaveFocus();
    expect(box).toHaveValue(""); // the key opens the field, it is not typed into it
    await user.keyboard("a/b");
    expect(box).toHaveValue("a/b"); // inside the field a slash is just a character
  });

  it("shows five tabs in order", async () => {
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
    const t10 = demo<TopList>("home/top_10y.json");
    const tMax = demo<TopList>("home/top_max.json");
    renderHome();
    await screen.findByRole("table");
    expect(firstFund()).toBe(t3.eligible[0].name); // 3 years is the pressed chip

    for (const [chip, file, list] of [
      ["1 year", "top_1y", t1],
      ["5 years", "top_5y", t5],
      ["10 years", "top_10y", t10],
      ["Since start", "top_max", tMax],
      ["3 years", "top_3y", t3],
    ] as const) {
      await user.click(screen.getByRole("button", { name: chip }));
      expect(screen.getByRole("button", { name: chip })).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(firstFund()).toBe(list.eligible[0].name));
      expect(urls).toContain(`/demo-data/home/${file}.json`);
    }
    // the demo lists lead with different funds, so the checks above could not pass by accident
    expect(new Set([t1, t3, t5, t10, tMax].map((t) => t.eligible[0].name)).size).toBeGreaterThan(1);
  });

  it("the 15-year tab says why no fund qualifies yet", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole("table", { name: "Top funds" });
    await user.click(screen.getByRole("button", { name: "15 years" }));
    expect(await screen.findByText("No fund has 15 years of 13F data yet: the SEC's data starts in 2013.")).toBeInTheDocument();
  });

  it("opens with the research heading and no rules line or subtitle", async () => {
    stubData();
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "Fund Manager Research" })).toBeInTheDocument();
    expect(screen.getByText("Quarterly 13F Data from SEC.gov")).toBeInTheDocument();
    await screen.findByRole("table", { name: "Top funds" });
    expect(screen.queryByText(/Who qualifies/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Orca estimates what they paid/)).not.toBeInTheDocument();
  });

  it("top funds sort by any column, largest first, and back on a second click", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    stubData();
    const user = userEvent.setup();
    renderHome();
    const table = await screen.findByRole("table", { name: "Top funds" });
    const names = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("link")[0].textContent);
    const byBook = [...t3.eligible].sort((a, b) => b.book - a.book).map((r) => r.name);
    await user.click(within(table).getByRole("button", { name: "AUM" }));
    expect(names()).toEqual(byBook);
    expect(within(table).getByRole("columnheader", { name: "AUM" })).toHaveAttribute("aria-sort", "descending");
    await user.click(within(table).getByRole("button", { name: "AUM" }));
    expect(names()).toEqual([...byBook].reverse());
    await user.click(within(table).getByRole("button", { name: "Fund" }));
    expect(names()).toEqual([...t3.eligible].map((r) => r.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("top funds show 100 funds a page, with page buttons above and below the table", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const many: TopRow[] = Array.from({ length: 250 }, (_, i) => ({
      ...t3.eligible[0],
      fund_id: 100000 + i,
      name: `Fund ${String(i + 1).padStart(3, "0")}`,
      ann_return: 0.5 - i / 1000,
    }));
    stubData({ "home/top_3y.json": { ...t3, eligible: many } });
    const user = userEvent.setup();
    renderHome();
    const table = await screen.findByRole("table", { name: "Top funds" });
    const rows = () => within(table).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(100);
    const pagers = screen.getAllByRole("navigation", { name: "Pages of funds" });
    expect(pagers).toHaveLength(2);
    expect(pagers[0]).toHaveTextContent("Showing 1–100 of 250 funds");
    expect(within(pagers[0]).getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(within(pagers[1]).getByRole("button", { name: "Next" }));
    expect(screen.getAllByRole("navigation", { name: "Pages of funds" })[0]).toHaveTextContent("Showing 101–200 of 250 funds");
    expect(within(rows()[0]).getAllByRole("link")[0]).toHaveTextContent("Fund 101");

    await user.click(within(pagers[0]).getByRole("button", { name: "Next" }));
    expect(rows()).toHaveLength(50);
    expect(within(screen.getAllByRole("navigation", { name: "Pages of funds" })[1]).getByRole("button", { name: "Next" })).toBeDisabled();

    // a new order starts again at the first page
    await user.click(within(table).getByRole("button", { name: "Fund" }));
    expect(screen.getAllByRole("navigation", { name: "Pages of funds" })[0]).toHaveTextContent("Showing 1–100 of 250 funds");
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
      "AUM",
      "Positions",
      "Return / yr",
      "Max Drawdown",
      "Sharpe",
    ]);
    const row = within(giants).getAllByRole("row")[1];
    expect(within(row).getByRole("link", { name: "Vanguard-like Giant" })).toHaveAttribute("href", "/fund/7");
    expect(within(row).getAllByText("—")).toHaveLength(2); // missing max drawdown and Sharpe
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
    await screen.findByRole("table", { name: "Top funds" });

    const rules: [string, RegExp, string[]][] = [
      [
        "Conviction moves",
        /Moves of ≥ 3% of a fund's AUM that are at least twice its biggest single-stock move of the 4 quarters before/,
        ["Fund", "Stock", "Move", "Weight now", "$ bought / sold", "Est. price", "Price now", "Since"],
      ],
      ["Big wins & losses", /Largest single-position gains and losses in Q2 2026, among funds that qualify for Top funds\./, ["Fund", "Stock", "Quarter P&L"]],
      ["Crowded buys", /Stocks bought by several concentrated active funds in the same quarter \(Q2 2026\)\./, ["Stock", "Funds buying", "Total bought", "Avg weight after"]],
      ["Best & worst calls", /New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or concentrated active funds\./, ["Stock", "Fund", "Bought", "Est. buy price", "Price now", "Since fund's buy", "Since 13F went public"]],
    ];
    for (const [tab, rule, headers] of rules) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByText(rule)).toBeInTheDocument();
      const table = (await screen.findAllByRole("table"))[0];
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(headers);
      // no SPY benchmark column or rule anywhere on Home
      expect(screen.queryAllByRole("columnheader", { name: /spy|s&p/i })).toHaveLength(0);
      expect(document.querySelector(".home .ps")?.textContent).not.toMatch(/spy|s&p/i);
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

  it("conviction lists the moves most unusual for their fund first, in dollars, with the price now and the move since", async () => {
    const rows: ConvictionRow[] = [
      { fund_id: 9100006, name: "Brinestone Value Partners", stock_id: 5, q: 53, move: "new", usd: 60e6, weight_after: 0.0924, change_pts: 9.24, est_price: 50, score: 6 },
      { fund_id: 9100006, name: "Brinestone Value Partners", stock_id: 7, q: 53, move: "trim", usd: -50e6, weight_after: 0.03, change_pts: -5.0, est_price: 20, score: 3 },
      { fund_id: 9100003, name: "Lanternfish Capital Management", stock_id: 13, q: 53, move: "exit", usd: -45e6, weight_after: 0, change_pts: -9.6, est_price: 100, score: 2.2 },
    ];
    const file: RowsFile<ConvictionRow> = { latest_q: 53, rows };
    const urls = stubData({ "home/conviction_q.json": file, "latest_prices.json": pricesWith({ 13: 80, 5: null }) });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByText(/Q2 2026 filings/);
    expect(urls).toContain("/demo-data/home/conviction_q.json");
    const table = screen.getByRole("table", { name: "Conviction moves" });
    expect(within(table).queryByRole("columnheader", { name: /vs|score|quarter/i })).toBeNull();
    const [added, trimmed, exit] = within(table).getAllByRole("row").slice(1); // the file's order
    expect(within(exit).getByText("Sold all")).toBeInTheDocument();
    expect(within(exit).getByText("Sold all").closest(".lc")).toHaveClass("sold"); // the grey tint
    expect(within(exit).getByRole("img", { name: "Sold all, −9.6% of the fund's AUM" })).toHaveClass("lc");
    expect(within(exit).getByText("0%")).toBeInTheDocument();
    expect(within(exit).getByText("−9.6%")).toBeInTheDocument(); // the weight change, in the move box
    expect(within(exit).getByText("−$45m")).toBeInTheDocument();
    expect(within(exit).getByText("$100")).toBeInTheDocument();
    expect(within(exit).getByText("$80.00")).toBeInTheDocument(); // the price now
    expect(within(exit).getByText("−20%")).toBeInTheDocument(); // 80 / 100 - 1
    expect(within(exit).getByRole("link", { name: /UNH/ })).toHaveAttribute("href", "/fund/9100003/stock/13");
    expect(within(added).getByText("New")).toBeInTheDocument();
    expect(within(added).getByText("New").closest(".lc")).toHaveClass("add"); // the blue tint
    expect(within(added).getByRole("img", { name: "New, +9.2% of the fund's AUM" })).toBeInTheDocument();
    expect(within(added).getByText("+$60m")).toBeInTheDocument();
    expect(within(added).getByText("9%")).toBeInTheDocument();
    expect(within(added).getByText("+9.2%")).toBeInTheDocument();
    expect(within(added).getAllByText("—")).toHaveLength(2); // no price now, so no move since
    expect(within(trimmed).getByText("Trimmed").closest(".lc")).toHaveClass("trim"); // a tinted box: orange for a cut
    expect(within(trimmed).getByText("−5.0%")).toBeInTheDocument();
  });

  it("names each fund over its reported book on the lists that carry the fund's name as a link", async () => {
    const funds = demo<FundsIndex>("funds.json");
    const lantern = funds.book[funds.id.indexOf(9100003)];
    const rows: ConvictionRow[] = [
      { fund_id: 9100003, name: "Lanternfish Capital Management", stock_id: 13, q: 53, move: "new", usd: 60e6, weight_after: 0.06, change_pts: 6, est_price: 10, score: 3 },
    ];
    stubData({ "home/conviction_q.json": { latest_q: 53, rows } });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    const row = (await screen.findAllByRole("row"))[1];
    const link = within(row).getByRole("link", { name: "Lanternfish Capital Management" });
    expect(link.parentElement).toHaveClass("stk");
    expect(link.nextElementSibling).toHaveTextContent(fBook(lantern)); // the muted line, outside the link
  });

  it("shows no book line when the fund index could not be loaded, and the list still works", async () => {
    stubData({}, ["funds.json"]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    const row = (await screen.findAllByRole("row"))[1];
    expect(within(row).getAllByRole("link")).toHaveLength(2); // stock and fund
    expect(row.querySelector(".sub")).toBeNull();
  });

  it("shows skeleton rows with a status while a list loads, and keeps the period control", async () => {
    stubData();
    renderHome();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
    await screen.findByRole("table", { name: "Top funds" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an empty list is the dashed state card, not a table of headings", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole("table", { name: "Top funds" });
    await user.click(screen.getByRole("button", { name: "15 years" }));
    const msg = await screen.findByText("No fund has 15 years of 13F data yet: the SEC's data starts in 2013.");
    expect(msg.closest(".state")).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("an error is the error state with the same words as before", async () => {
    stubData({}, ["home/crowded.json"]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Crowded buys" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("state", "err");
    expect(alert).toHaveTextContent("Couldn't load this list.");
    expect(alert).toHaveTextContent("Check your connection and reload the page.");
  });

  it("conviction shows the same page bar in both views, even on a single page", async () => {
    const row = (q: number): ConvictionRow => ({
      fund_id: 9100003, name: "Lanternfish Capital Management", stock_id: 13, q, move: "new",
      usd: 60e6, weight_after: 0.06, change_pts: 6, est_price: 10, score: 3,
    });
    stubData({
      "home/conviction_q.json": { latest_q: 53, rows: [row(53), { ...row(53), stock_id: 5 }] },
      "home/conviction_y.json": { latest_q: 53, rows: [row(51)] },
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByRole("table", { name: "Conviction moves" });
    let bars = screen.getAllByRole("navigation", { name: "Pages of moves" });
    expect(bars).toHaveLength(2); // above and below the table
    expect(bars[0]).toHaveTextContent("Showing 1–2 of 2 moves");
    expect(bars[0]).toHaveTextContent("Page 1 of 1");
    expect(within(bars[0]).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(bars[0]).getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Last 4 quarters" }));
    await screen.findByText(/The 4 quarters to Q2 2026/);
    bars = screen.getAllByRole("navigation", { name: "Pages of moves" });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveTextContent("Showing 1–1 of 1 moves");
  });

  it("conviction sorts by any column", async () => {
    const row = (stock_id: number, usd: number, score: number): ConvictionRow => ({
      fund_id: 9100003, name: "Lanternfish Capital Management", stock_id, q: 53, move: usd < 0 ? "exit" : "new",
      usd, weight_after: 0.05, change_pts: usd < 0 ? -8 : usd / 1e7, est_price: 10, score,
    });
    const file: RowsFile<ConvictionRow> = { latest_q: 53, rows: [row(13, 40e6, 9), row(5, -80e6, 7), row(7, 60e6, 8)] };
    stubData({ "home/conviction_q.json": file });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    const table = await screen.findByRole("table", { name: "Conviction moves" });
    const dollars = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getByText(/\$\d+m/).textContent);
    expect(dollars()).toEqual(["+$40m", "−$80m", "+$60m"]); // the file's order
    await user.click(within(table).getByRole("button", { name: "$ bought / sold" }));
    expect(dollars()).toEqual(["+$60m", "+$40m", "−$80m"]);
    await user.click(within(table).getByRole("button", { name: "$ bought / sold" }));
    expect(dollars()).toEqual(["−$80m", "+$40m", "+$60m"]);
    // the Move column sorts by the signed change in the fund's AUM: the biggest buy first, a sale last, and back again
    const moves = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getByRole("img").textContent);
    await user.click(within(table).getByRole("button", { name: "Move" }));
    expect(moves()).toEqual(["New+6.0%", "New+4.0%", "Sold all−8.0%"]);
    await user.click(within(table).getByRole("button", { name: "Move" }));
    expect(moves()).toEqual(["Sold all−8.0%", "New+4.0%", "New+6.0%"]);
  });

  it("conviction's last 4 quarters view loads its own file and shows each move's quarter", async () => {
    const year: RowsFile<ConvictionRow> = {
      latest_q: 53,
      rows: [
        { fund_id: 9100003, name: "Lanternfish Capital Management", stock_id: 13, q: 51, move: "new", usd: 70e6, weight_after: 0.07, change_pts: 7, est_price: 90, score: 5 },
      ],
    };
    const urls = stubData({ "home/conviction_y.json": year });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByRole("table", { name: "Conviction moves" });
    await user.click(screen.getByRole("button", { name: "Last 4 quarters" }));
    expect(screen.getByRole("button", { name: "Last 4 quarters" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText(/The 4 quarters to Q2 2026/);
    expect(urls).toContain("/demo-data/home/conviction_y.json");
    const table = screen.getByRole("table", { name: "Conviction moves" });
    expect(within(table).getByRole("columnheader", { name: "Quarter" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Weight after" })).toBeInTheDocument();
    expect(within(within(table).getAllByRole("row")[1]).getByText("Q4 2025")).toBeInTheDocument();
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
    expect(cells[2].textContent).toBe("$9.2B");
    expect(cells[3].textContent).toBe("8%");
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
    expect(within(row).getByRole("link", { name: /Visa/ })).toHaveAttribute("href", "/fund/9100001/stock/16"); // the name tidied, as on the fund page
    expect(within(row).getByRole("link", { name: "Kelpwood Capital LP" })).toHaveAttribute("href", "/fund/9100001");
    // the quarter of the buy sits in a purchase box: the word "Bought" and "Q2 ’26"
    const bought = within(row).getByRole("img", { name: "Bought in Q2 2026" });
    expect(bought).toHaveClass("lc", "add");
    expect(bought).toHaveTextContent("BoughtQ2 ’26");
    expect(within(row).getByText("$10.00")).toBeInTheDocument(); // est. buy price
    expect(within(row).getByText("$12.00")).toBeInTheDocument(); // price now
    expect(within(row).getByText("+20%")).toBeInTheDocument(); // 12 / 10 - 1
    expect(within(row).getByText("+20%").closest(".lc")).toHaveClass("add"); // the fund's buy, in a blue-tinted box
    expect(within(row).getByText("+9%")).toBeInTheDocument(); // 12 / 11 - 1
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
    stubData({}, ["home/conviction_q.json"]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t load/i);
    expect(screen.getAllByRole("tab")).toHaveLength(5); // the page is still there
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
