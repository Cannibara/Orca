import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { FundSearch } from "../src/components/FundSearch";
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
import { initials, retLabel } from "../src/home/famousChart";
import { shortNameOf } from "../src/lib/famousNames";
import Home from "../src/pages/Home";
import { fBook } from "../src/pages/homeFmt";

// ---- fixtures: the demo JSON under public/demo-data, served through a mocked fetch ----

// (not `new URL(..., import.meta.url)`: Vite rewrites that into an asset URL)
const DEMO = join(
  dirname(fileURLToPath(import.meta.url)),
  "../public/demo-data",
);
const demo = <T,>(path: string): T =>
  JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;

/**
 * Stub fetch with the demo files. `overrides` replaces a file's body (keyed by the path under
 * demo-data); `failing` makes those paths answer HTTP 500. Returns every URL requested, in order.
 */
function stubData(
  overrides: Record<string, unknown> = {},
  failing: string[] = [],
): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const path = url.replace(/^\/demo-data\//, "");
      if (failing.includes(path))
        return { ok: false, status: 500, json: async () => ({}) };
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

const call = (
  stock_id: number,
  fund_id: number,
  name: string,
  est_price: number,
  price_on_filed: number,
): CallRow => ({
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
    <MemoryRouter initialEntries={["/"]}>
      {/* the search lives in the app's top bar, above every page */}
      <header className="top">
        <FundSearch />
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/fund/:id" element={<FundStub />} />
        <Route path="/fund/:id/stock/:stockId" element={<StockStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

const TAB_NAMES = [
  "Famous funds",
  "Top funds",
  "Landscape",
  "Conviction moves",
  "Big wins & losses",
  "Crowded buys",
  "Best & worst calls",
];

/** Name in the first body row of the (only) table on screen. */
const firstFund = () =>
  within(screen.getAllByRole("row")[1]).getAllByRole("link")[0].textContent;
/** Fund names down the first column of the calls table, in order. */
const fundOrder = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("link")[1].textContent);
/** The famous lists' most popular order: the owner's rank, then the Google Trends score, then size. */
const byPopularity = (a: TopRow, b: TopRow) =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
  (b.fame ?? 0) - (a.fame ?? 0) ||
  b.book - a.book;
/** Home opens on Famous funds, on its chart: wait for the list to load. */
const famousReady = () =>
  screen.findByRole("heading", { level: 3, name: "Most searched" });
/** Famous funds shows one list at a time: pick it on the list switch. */
async function showList(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(
    within(screen.getByRole("group", { name: "List" })).getByRole("button", { name }),
  );
}
/** Famous funds' Chart | Table switch, to today's table. */
async function showTable(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Table" }),
  );
}
/** Home opens on Famous funds: switch to Top funds (its chart) and wait for the list. */
async function openTopChart(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "Top funds" }));
  await screen.findByRole("heading", { level: 3, name: "Funds over $1B" });
}
/** Top funds' Table view: switch to it and wait for the table. */
async function openTop(user: ReturnType<typeof userEvent.setup>) {
  await openTopChart(user);
  await showTable(user);
  return screen.findByRole("table", { name: "Top funds" });
}

beforeEach(() => clearDataCache());
afterEach(() => vi.unstubAllGlobals());

describe("Home", () => {
  it('"/" jumps to the search, except while typing in a text field', async () => {
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

  it("shows seven tabs in order", async () => {
    stubData();
    renderHome();
    await famousReady();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(TAB_NAMES);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(
      tabs.slice(1).every((t) => t.getAttribute("aria-selected") === "false"),
    ).toBe(true);
  });

  it("search filters and navigates", async () => {
    stubData();
    const user = userEvent.setup();
    const funds = demo<FundsIndex>("funds.json");
    const word = funds.name[0].split(" ")[0]; // a first word only one demo fund has
    renderHome();
    await user.type(
      screen.getByRole("searchbox", { name: /search a fund/i }),
      word.toLowerCase(),
    );
    const list = await screen.findByRole("list", { name: "Matching funds" });
    expect(
      within(list).getByRole("link", { name: new RegExp(funds.name[0]) }),
    ).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(`Fund page ${funds.id[0]}`),
    ).toBeInTheDocument();
  });

  it("search opens a clicked match, caps the list and says when nothing matches", async () => {
    stubData();
    const user = userEvent.setup();
    const funds = demo<FundsIndex>("funds.json");
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });

    await user.type(box, "zzzz");
    expect(await screen.findByText(/No fund matches/)).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Matching funds" }),
    ).not.toBeInTheDocument();

    // "a" is in every demo name: the list is capped at 8 of the 12 funds
    await user.clear(box);
    await user.type(box, "a");
    const list = await screen.findByRole("list", { name: "Matching funds" });
    expect(within(list).getAllByRole("link")).toHaveLength(8);

    await user.clear(box);
    await user.type(box, "Tern");
    const tern = funds.id[funds.name.indexOf("Tern Harbor Equity")];
    await user.click(
      await within(
        await screen.findByRole("list", { name: "Matching funds" }),
      ).findByRole("link", { name: /Tern Harbor Equity/ }),
    );
    expect(await screen.findByText(`Fund page ${tern}`)).toBeInTheDocument();
  });

  it("search results close on Escape and when focus leaves the box, and come back on typing or focus", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    const results = () =>
      screen.queryByRole("list", { name: "Matching funds" });

    await user.type(box, "Ter");
    expect(
      await screen.findByRole("list", { name: "Matching funds" }),
    ).toBeInTheDocument();

    // Escape closes the list but keeps the text and the focus; typing opens it again
    await user.keyboard("{Escape}");
    expect(results()).toBeNull();
    expect(box).toHaveValue("Ter");
    expect(box).toHaveFocus();
    await user.keyboard("n");
    expect(
      await screen.findByRole("list", { name: "Matching funds" }),
    ).toBeInTheDocument();

    // clicking elsewhere closes it; focusing the box again opens it
    await user.click(document.body);
    expect(results()).toBeNull();
    expect(box).toHaveValue("Tern");
    await user.click(box);
    expect(results()).not.toBeNull();

    // moving focus within the box (the button, then a result) keeps it open; tabbing out closes it
    await user.tab();
    expect(screen.getByRole("button", { name: "Search" })).toHaveFocus();
    expect(results()).not.toBeNull();
    await user.tab();
    const link = within(results()!).getByRole("link", {
      name: /Tern Harbor Equity/,
    });
    expect(link).toHaveFocus();
    expect(results()).not.toBeNull();
    await user.tab(); // the second result
    expect(results()).not.toBeNull();
    await user.tab(); // out of the box (the search is in the top bar), onto the page below: its open tab
    expect(box).not.toHaveFocus();
    expect(screen.getByRole("tab", { name: "Famous funds" })).toHaveFocus();
    expect(results()).toBeNull();
  });

  it("Escape from a result puts the focus back in the search box", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    const box = screen.getByRole("searchbox", { name: /search a fund/i });
    await user.type(box, "Tern");
    await screen.findByRole("list", { name: "Matching funds" });
    await user.tab(); // Search
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
    const cells = within(await openTop(user)).getAllByRole("row")[1];
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
    await openTop(user);
    expect(firstFund()).toBe(shortNameOf(t3.eligible[0].fund_id, t3.eligible[0].name)); // 3 years is the pressed chip

    for (const [chip, file, list] of [
      ["1 year", "top_1y", t1],
      ["5 years", "top_5y", t5],
      ["10 years", "top_10y", t10],
      ["Since start", "top_max", tMax],
      ["3 years", "top_3y", t3],
    ] as const) {
      await user.click(screen.getByRole("button", { name: chip }));
      expect(screen.getByRole("button", { name: chip })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await waitFor(() => expect(firstFund()).toBe(shortNameOf(list.eligible[0].fund_id, list.eligible[0].name)));
      expect(urls).toContain(`/demo-data/home/${file}.json`);
    }
    // the demo lists lead with different funds, so the checks above could not pass by accident
    expect(
      new Set([t1, t3, t5, t10, tMax].map((t) => t.eligible[0].name)).size,
    ).toBeGreaterThan(1);
  });

  it("the list switch offers Most searched then one list per style, in order; each list's table has Top funds' columns, the manager and links to the fund", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const famous = t3.famous ?? [];
    expect(new Set(famous.map((f) => f.group)).size).toBeGreaterThan(1);
    // the demo lists a fund too young for Top funds, so this tab is more than a filter of that one
    const t1 = demo<TopList>("home/top_1y.json");
    expect(
      (t1.famous ?? []).some(
        (f) => !t1.eligible.some((e) => e.fund_id === f.fund_id),
      ),
    ).toBe(true);
    stubData();
    const user = userEvent.setup();
    renderHome();
    const panel = (
      await screen.findByRole("heading", { level: 2, name: "Famous funds" })
    ).closest("section")!;
    await famousReady();
    const order = ["Value", "Tiger cubs", "Tech & growth"].filter((g) =>
      famous.some((f) => f.group === g),
    );
    expect(
      within(within(panel).getByRole("group", { name: "List" }))
        .getAllByRole("button")
        .map((b) => b.querySelector(".nm")?.textContent),
    ).toEqual(["Most searched", ...order]);
    await showTable(user);
    for (const group of order) {
      await showList(user, group);
      // one list at a time
      expect(
        within(panel)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual([group]);
      const table = within(panel).getByRole("table", { name: group });
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((h) => h.querySelector(".sort")?.textContent),
      ).toEqual([
        "Fund most popular",
        "Return / yr",
        "AUM",
        "Positions",
        "Max drawdown",
        "Sharpe",
      ]);
      // a list opens with its most popular fund first: the owner's rank, Google Trends score, then size
      const best = famous.filter((f) => f.group === group).sort(byPopularity);
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(
        best.map((f) => shortNameOf(f.fund_id, f.name)),
      );
      if (best[0].manager)
        expect(
          within(rows[0]).getByText(new RegExp(`^${best[0].manager}`)),
        ).toBeInTheDocument();
    }
    // Kelpwood is in two lists, and in Most searched
    for (const list of ["Tech & growth", "Tiger cubs", "Most searched"]) {
      await showList(user, list);
      expect(
        within(panel).getAllByRole("link", { name: "Kelpwood Capital" }), // the short name; the legal one is its title
      ).toHaveLength(1);
    }
    // a fund that stopped filing is listed, with its last quarter by its manager
    await showList(user, "Value");
    expect(
      within(within(panel).getByRole("table", { name: "Value" })).getByText(
        "Mara Cobble · filed until Q4 2023",
      ),
    ).toBeInTheDocument();
    await showList(user, order[0]);
    const first = within(
      within(panel).getByRole("table", { name: order[0] }),
    ).getAllByRole("link")[0];
    const id = famous.find((f) => f.name === first.getAttribute("title"))!.fund_id; // the legal name is the title
    await user.click(first);
    expect(await screen.findByText(`Fund page ${id}`)).toBeInTheDocument();
  });

  it("the Fund heading cycles A to Z, Z to A and most popular, in every list", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const value = (t3.famous ?? []).filter((f) => f.group === "Value");
    expect(value.length).toBeGreaterThan(2);
    // the table shows the chart's short names (owner, 2026-11-23)
    const byName = value
      .map((f) => shortNameOf(f.fund_id, f.name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const popular = value
      .slice()
      .sort(byPopularity)
      .map((f) => shortNameOf(f.fund_id, f.name));
    stubData();
    const user = userEvent.setup();
    renderHome();
    await famousReady();
    await showTable(user);
    await showList(user, "Value");
    const table = screen.getByRole("table", { name: "Value" });
    const names = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getByRole("link").textContent);
    const fund = () => within(table).getByRole("button", { name: /^Fund/ });
    expect(names()).toEqual(popular);
    await user.click(
      within(table).getByRole("button", { name: "Return / yr" }),
    );
    expect(names()).not.toEqual(popular);
    await user.click(fund()); // from another column: A to Z first
    expect(names()).toEqual(byName);
    await user.click(fund());
    expect(names()).toEqual([...byName].reverse());
    await user.click(fund());
    expect(names()).toEqual(popular);
    expect(fund()).toHaveTextContent("most popular");
  });

  it("Most searched comes first: the owner's order, then the most searched famous funds, once each, with no score shown", async () => {
    const t1 = demo<TopList>("home/top_1y.json");
    const read = [
      ...new Map(
        (t1.famous ?? [])
          .filter((r) => r.search != null)
          .map((r) => [r.fund_id, r]),
      ).values(),
    ].sort(byPopularity);
    // the demo ranks Mara Cobble ahead of higher Google scores, and Saltglass, which has no score
    expect(read.slice(0, 2).map((r) => r.manager)).toEqual(["Mara Cobble", "Ada Brine"]);
    expect(read.length).toBeGreaterThan(3);
    stubData();
    const user = userEvent.setup();
    renderHome();
    await famousReady();
    await showTable(user);
    await user.click(screen.getByRole("button", { name: "1 year" }));
    const table = await screen.findByRole("table", { name: "Most searched" });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(read.length + 1),
    );
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.querySelector(".sort")?.textContent),
    ).toEqual([
      "Fund most popular",
      "Return / yr",
      "AUM",
      "Positions",
      "Max drawdown",
      "Sharpe",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(
      read.map((r) => shortNameOf(r.fund_id, r.name)),
    );
    // the list's line is not shown; it describes the section for screen readers
    expect(
      screen.getByRole("heading", { level: 2, name: "Famous funds" }).closest("section"),
    ).toHaveAccessibleDescription("The famous funds investors look up most.");
    expect(screen.queryByText(/Google Trends/)).toBeNull();
  });

  it("a famous list's table pages on its own, 10 funds a page; a new list starts on page 1; the switches survive a tab change", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const row = (t3.famous ?? [])[0];
    expect(row.search).toBeNull(); // so these lists have no Most searched
    const many = (group: string, n: number, base: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...row,
        group,
        fund_id: base + i,
        name: `${group} ${String(i + 1).padStart(2, "0")}`,
        ann_return: 0.5 - i / 100,
      }));
    const t1 = demo<TopList>("home/top_1y.json");
    stubData({
      "home/top_3y.json": {
        ...t3,
        famous: [...many("Value", 25, 1000), ...many("Macro", 12, 2000)],
      },
    });
    const user = userEvent.setup();
    renderHome();
    // no Most searched: the first list opens, on the chart's scrolling window
    await screen.findByRole("heading", { level: 3, name: "Value" });
    expect(
      screen.getByRole("region", { name: "Funds 1 to 20 of 25, scrollable" }),
    ).toBeInTheDocument();
    await showTable(user);
    const names = () =>
      within(screen.getByRole("table"))
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getByRole("link").textContent);
    expect(names()).toHaveLength(10);
    expect(screen.getByText("Showing 1–10 of 25 funds")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(names()[0]).toBe("Value 11");
    await showList(user, "Macro");
    expect(screen.getByText("Showing 1–10 of 12 funds")).toBeInTheDocument();
    expect(names()[0]).toBe("Macro 01");
    await showList(user, "Value");
    expect(names()[0]).toBe("Value 01"); // back on page 1
    // the one period switch: the 1-year file has no Macro
    await user.click(screen.getByRole("button", { name: "1 year" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "List" })).queryByRole(
          "button",
          { name: "Macro" },
        ),
      ).toBeNull(),
    );
    const groups = new Set((t1.famous ?? []).map((f) => f.group));
    for (const g of groups)
      expect(
        within(screen.getByRole("group", { name: "List" })).getByRole("button", {
          name: g,
        }),
      ).toBeInTheDocument();
    expect(
      await screen.findByRole("table", { name: "Value" }),
    ).toBeInTheDocument(); // Value is in both files, so it stays
    await user.click(screen.getByRole("tab", { name: "Top funds" }));
    expect(screen.getByRole("button", { name: "1 year" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Famous funds" }));
    expect(
      await screen.findByRole("table", { name: "Value" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "View" })).getByRole("button", {
        name: "Table",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("famous funds explain a file built before the list existed", async () => {
    stubData({
      "home/top_3y.json": {
        ...demo<TopList>("home/top_3y.json"),
        famous: undefined,
      },
    });
    renderHome();
    expect(
      await screen.findByText(
        "The famous funds list arrives with the next data update.",
      ),
    ).toBeInTheDocument();
  });

  it("the 15-year tab says why no fund qualifies", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await openTop(user);
    await user.click(screen.getByRole("button", { name: "15 years" }));
    expect(await screen.findByText("No fund has 15 years of 13F history that meets the list's rules.")).toBeInTheDocument();
  });

  it("opens with the research heading and no rules line or subtitle", async () => {
    stubData();
    renderHome();
    expect(
      screen.getByRole("heading", { level: 1, name: "Fund Manager Research" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Quarterly 13F Data from SEC.gov"),
    ).toBeInTheDocument();
    await famousReady();
    expect(screen.queryByText(/Who qualifies/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Orca estimates what they paid/),
    ).not.toBeInTheDocument();
  });

  it("top funds sort by any column, largest first, and back on a second click", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    stubData();
    const user = userEvent.setup();
    renderHome();
    const table = await openTop(user);
    const names = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("link")[0].textContent);
    const byBook = [...t3.eligible]
      .sort((a, b) => b.book - a.book)
      .map((r) => shortNameOf(r.fund_id, r.name));
    await user.click(within(table).getByRole("button", { name: "AUM" }));
    expect(names()).toEqual(byBook);
    expect(
      within(table).getByRole("columnheader", { name: "AUM" }),
    ).toHaveAttribute("aria-sort", "descending");
    await user.click(within(table).getByRole("button", { name: "AUM" }));
    expect(names()).toEqual([...byBook].reverse());
    await user.click(within(table).getByRole("button", { name: "Fund" }));
    expect(names()).toEqual(
      [...t3.eligible]
        .map((r) => shortNameOf(r.fund_id, r.name))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
  });

  it("top funds' table shows 80 funds a page, with page buttons below it", async () => {
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
    const table = await openTop(user);
    const rows = () => within(table).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(80);
    const pager = () => screen.getByRole("navigation", { name: "Pages of funds" });
    expect(pager()).toHaveTextContent("Showing 1–80 of 250 funds");
    expect(within(pager()).getByRole("button", { name: "Previous" })).toBeDisabled();
    // the page buttons come after the table, not before it
    expect(table.compareDocumentPosition(pager()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // the Fund column has the chart's width (rankTable.css), so the columns keep their places from page to page
    expect(table.querySelector("th.c-fund")).not.toBeNull();

    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(pager()).toHaveTextContent("Showing 81–160 of 250 funds");
    expect(within(rows()[0]).getAllByRole("link")[0]).toHaveTextContent("Fund 081");

    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(rows()).toHaveLength(10);
    expect(within(pager()).getByRole("button", { name: "Next" })).toBeDisabled();

    // a new order starts again at the first page
    await user.click(within(table).getByRole("button", { name: "Fund" }));
    expect(pager()).toHaveTextContent("Showing 1–80 of 250 funds");
  });

  it("top funds open on a chart like Famous funds: heading for screen readers (no standfirst, count or lead line), short names, S&P line, source and rules", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    stubData();
    const user = userEvent.setup();
    renderHome();
    await openTopChart(user);
    const section = screen.getByRole("region", { name: "Top funds" });
    expect(within(section).getByRole("heading", { level: 2, name: "Top funds" })).toBeInTheDocument();
    // no standfirst or fund count (owner, 2026-11-23): the axis says what the bars are
    expect(section).not.toHaveTextContent(/Estimated return a year over/);
    expect(section).not.toHaveTextContent(`${t3.eligible.length} funds`);
    expect(section.querySelector(".fc-axl")).toHaveTextContent("Estimated return a year");
    // no card: the same module as Famous funds, and Chart is the pressed view
    expect(section).toHaveClass("ranked");
    expect(section.querySelector(".panel")).toBeNull();
    expect(
      within(within(section).getByRole("group", { name: "View" })).getByRole("button", { name: "Chart" }),
    ).toHaveAttribute("aria-pressed", "true");
    // best first, one row per fund, each a link to its fund, named short ("… Capital LP" → "… Capital")
    const best = [...t3.eligible].sort((a, b) => b.ann_return - a.ann_return);
    const rows = section.querySelectorAll<HTMLAnchorElement>(".fc a.fc-row");
    expect(rows).toHaveLength(best.length);
    expect(rows[0]).toHaveAttribute("href", `/fund/${best[0].fund_id}`);
    expect(rows[0].getAttribute("aria-label")).toMatch(new RegExp(`^1 of ${best.length}\\. `));
    expect(section.querySelector(".fam-lead")).toBeNull(); // no summary line under the list's name
    const kelp = [...rows].find((r) => r.getAttribute("href") === "/fund/9100001")!;
    expect(kelp.querySelector(".nm")).toHaveTextContent(/^Kelpwood Capital$/);
    // every row has its photo or initials: a fund that is not famous has its own name's initials
    const famousIds = new Set((t3.famous ?? []).map((f) => f.fund_id));
    const plain = best.find((r) => !famousIds.has(r.fund_id))!;
    const plainRow = [...rows].find((r) => r.getAttribute("href") === `/fund/${plain.fund_id}`)!;
    expect(plainRow.querySelector(".fc-face.init")).toHaveTextContent(initials(shortNameOf(plain.fund_id, plain.name)));
    expect(section.querySelector(".fc .spl")).not.toBeNull();
    expect(section.querySelector(".fam-src")).toHaveTextContent(/AUM ≥ \$1B.*Source: SEC 13F filings/);
    // fewer funds than a page: no page buttons
    expect(within(section).queryByRole("navigation", { name: "Pages of funds" })).toBeNull();
  });

  it("top funds' chart shows 20 funds in its window and 80 a page, with Next for the rest", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const many: TopRow[] = Array.from({ length: 250 }, (_, i) => ({
      ...t3.eligible[0],
      fund_id: 100000 + i,
      name: `Fund ${String(i + 1).padStart(3, "0")} LLC`,
      ann_return: 0.5 - i / 300,
    }));
    stubData({ "home/top_3y.json": { ...t3, eligible: many } });
    const user = userEvent.setup();
    renderHome();
    await openTopChart(user);
    const section = screen.getByRole("region", { name: "Top funds" });
    const rows = () => [...section.querySelectorAll<HTMLAnchorElement>(".fc a.fc-row")];
    expect(screen.getByRole("region", { name: "Funds 1 to 20 of 250, scrollable" })).toHaveStyle({ height: "920px" });
    expect(rows()).toHaveLength(80);
    expect(section.querySelector(".fc-cap")).toHaveTextContent("Showing 1–20 of 250 · one scale for this page");
    expect(rows()[0].querySelector(".lab.lead")).not.toBeNull(); // the best of the whole list
    const pager = () => within(section).getByRole("navigation", { name: "Pages of funds" });
    expect(within(pager()).getByText("Page 1 of 4")).toBeInTheDocument();
    expect(within(pager()).getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("region", { name: "Funds 81 to 100 of 250, scrollable" })).toBeInTheDocument();
    expect(rows()).toHaveLength(80);
    expect(rows()[0]).toHaveAttribute("href", "/fund/100080");
    expect(rows()[0].getAttribute("aria-label")).toMatch(/^81 of 250\. Fund 081, /);
    expect(rows()[0].querySelector(".lab.lead")).toBeNull(); // only the list's best has the lead label
    expect(section.querySelector(".fc-cap")).toHaveTextContent("Showing 81–100 of 250 · one scale for this page");

    // the last page holds what is left, and fits without scrolling
    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    await user.click(within(pager()).getByRole("button", { name: "Next" }));
    expect(rows()).toHaveLength(10);
    expect(section.querySelector(".fc-cap")).toHaveTextContent("Showing 241–250 of 250");
    expect(within(pager()).getByRole("button", { name: "Next" })).toBeDisabled();

    // a new period starts again on page 1
    await user.click(screen.getByRole("button", { name: "5 years" }));
    await waitFor(() => expect(section.querySelector(".fc-cap")).toHaveTextContent(/^Showing 1–\d+ of \d+$/));
    await user.click(screen.getByRole("button", { name: "3 years" }));
    expect(await within(section).findByText("Page 1 of 4")).toBeInTheDocument();
  });

  it("top funds show the person and photo of a famous fund, and initials for any other", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const famous = (t3.famous ?? []).find((f) => f.manager && t3.eligible.some((e) => e.fund_id === f.fund_id))!;
    expect(famous).toBeDefined();
    stubData();
    const user = userEvent.setup();
    renderHome();
    await openTopChart(user);
    const row = document.querySelector<HTMLAnchorElement>(`.top-funds a.fc-row[href="/fund/${famous.fund_id}"]`)!;
    expect(row.getAttribute("aria-label")).toContain(famous.manager!);
    expect(row.querySelector(".fc-face")).not.toBeNull();
    // the table keeps the person under the fund's name
    const table = await (async () => {
      await showTable(user);
      return screen.findByRole("table", { name: "Top funds" });
    })();
    expect(within(table).getAllByText(famous.manager!).length).toBeGreaterThan(0);
  });

  it("the ranked table sits on the chart's grid: short names and photos, the return to one decimal, the S&P 500 over its heading; a row opens its fund", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    stubData();
    const user = userEvent.setup();
    renderHome();
    const table = await openTop(user);
    const best = [...t3.eligible].sort((a, b) => b.ann_return - a.ann_return);
    const rows = within(table).getAllByRole("row").slice(1);
    const first = rows[0];
    expect(within(first).getAllByRole("link")[0]).toHaveTextContent(shortNameOf(best[0].fund_id, best[0].name));
    expect(within(first).getAllByRole("link")[0]).toHaveAttribute("title", best[0].name);
    expect(first.querySelector("td.c-ret")).toHaveTextContent(retLabel(best[0].ann_return));
    expect(first.querySelector(".rk-bar")).toBeNull(); // the bars are the chart's
    if (t3.spx?.ann_return != null)
      expect(within(table).getByRole("columnheader", { name: /Return \/ yr/ }).querySelector(".rk-spx")).toHaveTextContent(
        /^S&P 500 \+\d+\.\d%$/,
      );
    // every fund has its photo or its initials
    rows.forEach((r) => expect(r.querySelector(".fc-face")).not.toBeNull());
    // a click anywhere on the row opens the fund
    await user.click(first.querySelector("td.c-aum")!);
    expect(await screen.findByText(`Fund page ${best[0].fund_id}`)).toBeInTheDocument();
  });

  it("on a phone the ranked table sorts from a Sort by menu", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    try {
      const t3 = demo<TopList>("home/top_3y.json");
      stubData();
      const user = userEvent.setup();
      renderHome();
      await user.click(screen.getByRole("tab", { name: "Top funds" }));
      await screen.findByRole("heading", { level: 3, name: "Funds over $1B" });
      await user.click(within(screen.getByRole("group", { name: "View" })).getAllByRole("button")[1]);
      const table = await screen.findByRole("table", { name: "Top funds" });
      expect(document.querySelector(".rk")).toHaveClass("phone");
      const menu = screen.getByRole("combobox", { name: "Sort by" });
      expect(menu).toHaveValue("ret:-1");
      expect(within(menu).queryByRole("option", { name: "Most popular" })).toBeNull(); // Famous funds only
      await user.selectOptions(menu, "book:-1");
      const names = within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("link")[0].textContent);
      expect(names).toEqual([...t3.eligible].sort((a, b) => b.book - a.book).map((r) => shortNameOf(r.fund_id, r.name)));
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it("top funds' table has the list's columns, and index giants are not listed", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    const giant: TopRow = {
      ...t3.eligible[0],
      fund_id: 7,
      name: "Vanguard-like Giant",
      sharpe: null,
      max_dd: null,
    };
    stubData({ "home/top_3y.json": { ...t3, giants: [giant] } });
    const user = userEvent.setup();
    renderHome();
    const main = await openTop(user);
    expect(screen.queryByRole("heading", { name: "Index giants" })).toBeNull();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.queryByText("Vanguard-like Giant")).toBeNull();
    expect(
      within(main)
        .getAllByRole("columnheader")
        .map((h) => h.querySelector(".sort")?.textContent),
    ).toEqual([
      "Fund",
      "Return / yr",
      "AUM",
      "Positions",
      "Max drawdown",
      "Sharpe",
    ]);
    await user.click(screen.getByRole("button", { name: "Chart" }));
    expect(document.querySelector('a.fc-row[href="/fund/7"]')).toBeNull();
  });

  it("top funds' table shows a dash for a missing drawdown and Sharpe", async () => {
    const t3 = demo<TopList>("home/top_3y.json");
    stubData({ "home/top_3y.json": { ...t3, eligible: [{ ...t3.eligible[0], sharpe: null, max_dd: null }] } });
    const user = userEvent.setup();
    renderHome();
    const table = await openTop(user);
    expect(within(within(table).getAllByRole("row")[1]).getAllByText("—")).toHaveLength(2);
  });

  it("each tab states its rule and shows its list", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await famousReady();

    const rules: [string, RegExp, string[]][] = [
      [
        "Conviction moves",
        /Moves of ≥ 3% of a fund's AUM that are at least twice its biggest single-stock move of the 4 quarters before/,
        [
          "Fund",
          "Stock",
          "Weight",
          "$ bought / sold",
          "Est. price",
          "Price now",
          "Since",
        ],
      ],
      [
        "Big wins & losses",
        /Largest single-position gains and losses in Q2 2026, among funds that qualify for Top funds\./,
        ["Fund", "Stock", "Quarter P&L"],
      ],
      [
        "Crowded buys",
        /Stocks bought by several concentrated active funds in the same quarter \(Q2 2026\)\./,
        ["Stock", "Funds buying", "Total bought", "Avg weight after"],
      ],
      [
        "Best & worst calls",
        /New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or concentrated active funds\./,
        [
          "Stock",
          "Fund",
          "Bought",
          "Est. buy price",
          "Price now",
          "Since fund's buy",
          "Since 13F went public",
        ],
      ],
    ];
    for (const [tab, rule, headers] of rules) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByRole("tab", { name: tab })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(await screen.findByText(rule)).toBeInTheDocument();
      const table = (await screen.findAllByRole("table"))[0];
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((h) => h.querySelector(".sort")?.textContent),
      ).toEqual(headers);
      // no SPY benchmark column or rule anywhere on Home
      expect(
        screen.queryAllByRole("columnheader", { name: /spy|s&p/i }),
      ).toHaveLength(0);
      expect(document.querySelector(".home .ps")?.textContent).not.toMatch(
        /spy|s&p/i,
      );
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
    expect(
      within(loss).getByRole("link", { name: /^Seastack/ }),
    ).toHaveAttribute("href", "/fund/9100009");
  });

  it("conviction lists the moves most unusual for their fund first, in dollars, with the price now and the move since", async () => {
    const rows: ConvictionRow[] = [
      {
        fund_id: 9100006,
        name: "Brinestone Value Partners",
        stock_id: 5,
        q: 53,
        move: "new",
        usd: 60e6,
        weight_after: 0.0924,
        change_pts: 9.24,
        est_price: 50,
        score: 6,
      },
      {
        fund_id: 9100006,
        name: "Brinestone Value Partners",
        stock_id: 7,
        q: 53,
        move: "trim",
        usd: -50e6,
        weight_after: 0.03,
        change_pts: -5.0,
        est_price: 20,
        score: 3,
      },
      {
        fund_id: 9100003,
        name: "Lanternfish Capital Management",
        stock_id: 13,
        q: 53,
        move: "exit",
        usd: -45e6,
        weight_after: 0,
        change_pts: -9.6,
        est_price: 100,
        score: 2.2,
      },
    ];
    const file: RowsFile<ConvictionRow> = { latest_q: 53, rows };
    const urls = stubData({
      "home/conviction_q.json": file,
      "latest_prices.json": pricesWith({ 13: 80, 5: null }),
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByText(/Q2 2026 filings/);
    expect(urls).toContain("/demo-data/home/conviction_q.json");
    const table = screen.getByRole("table", { name: "Conviction moves" });
    expect(
      within(table).queryByRole("columnheader", { name: /vs|score|quarter/i }),
    ).toBeNull();
    const [added, trimmed, exit] = within(table).getAllByRole("row").slice(1); // the file's order
    expect(within(exit).getByText("10% → 0%")).toBeInTheDocument(); // 9.6 points given up: all striped orange
    expect(exit.querySelector(".mb.mbx")).toHaveClass("dn");
    expect(exit.querySelector(".wcell")).toHaveAttribute(
      "title",
      expect.stringContaining("−9.6% of the fund's AUM"),
    );
    expect(within(exit).getByText("−$45m")).toBeInTheDocument();
    expect(within(exit).getByText("$100")).toBeInTheDocument();
    expect(within(exit).getByText("$80.00")).toBeInTheDocument(); // the price now
    expect(within(exit).getByText("−20%")).toBeInTheDocument(); // 80 / 100 - 1
    expect(within(exit).getByRole("link", { name: /UNH/ })).toHaveAttribute(
      "href",
      "/fund/9100003/stock/13",
    );
    expect(within(added).getByText("0% → 9%")).toBeInTheDocument();
    expect(added.querySelector(".mb.mbx")).toHaveClass("up"); // blue stripes for weight added
    expect(added.querySelector(".mb:not(.mbx)")).toBeNull(); // nothing held before: no solid part
    expect(within(added).getByText("+$60m")).toBeInTheDocument();
    expect(within(added).getAllByText("—")).toHaveLength(2); // no price now, so no move since
    expect(within(trimmed).getByText("8% → 3%")).toBeInTheDocument();
    expect(trimmed.querySelector(".mb.mbx")).toHaveClass("dn"); // orange stripes for a cut
  });

  it("names each fund over its reported book on the lists that carry the fund's name as a link", async () => {
    const funds = demo<FundsIndex>("funds.json");
    const lantern = funds.book[funds.id.indexOf(9100003)];
    const rows: ConvictionRow[] = [
      {
        fund_id: 9100003,
        name: "Lanternfish Capital Management",
        stock_id: 13,
        q: 53,
        move: "new",
        usd: 60e6,
        weight_after: 0.06,
        change_pts: 6,
        est_price: 10,
        score: 3,
      },
    ];
    stubData({ "home/conviction_q.json": { latest_q: 53, rows } });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    const row = (await screen.findAllByRole("row"))[1];
    const link = within(row).getByRole("link", {
      name: "Lanternfish Capital Management",
    });
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
    await famousReady();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an empty list is the dashed state card, not a table of headings", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await openTop(user);
    await user.click(screen.getByRole("button", { name: "15 years" }));
    const msg = await screen.findByText("No fund has 15 years of 13F history that meets the list's rules.");
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
    expect(alert).toHaveTextContent(
      "Check your connection and reload the page.",
    );
  });

  it("conviction shows the same page bar in both views, even on a single page", async () => {
    const row = (q: number): ConvictionRow => ({
      fund_id: 9100003,
      name: "Lanternfish Capital Management",
      stock_id: 13,
      q,
      move: "new",
      usd: 60e6,
      weight_after: 0.06,
      change_pts: 6,
      est_price: 10,
      score: 3,
    });
    stubData({
      "home/conviction_q.json": {
        latest_q: 53,
        rows: [row(53), { ...row(53), stock_id: 5 }],
      },
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
    expect(
      within(bars[0]).getByRole("button", { name: "Previous" }),
    ).toBeDisabled();
    expect(
      within(bars[0]).getByRole("button", { name: "Next" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Last 4 quarters" }));
    await screen.findByText(/The 4 quarters to Q2 2026/);
    bars = screen.getAllByRole("navigation", { name: "Pages of moves" });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveTextContent("Showing 1–1 of 1 moves");
  });

  it("conviction sorts by any column", async () => {
    const row = (
      stock_id: number,
      usd: number,
      score: number,
    ): ConvictionRow => ({
      fund_id: 9100003,
      name: "Lanternfish Capital Management",
      stock_id,
      q: 53,
      move: usd < 0 ? "exit" : "new",
      usd,
      weight_after: 0.05,
      change_pts: usd < 0 ? -8 : usd / 1e7,
      est_price: 10,
      score,
    });
    const file: RowsFile<ConvictionRow> = {
      latest_q: 53,
      rows: [row(13, 40e6, 9), row(5, -80e6, 7), row(7, 60e6, 8)],
    };
    stubData({ "home/conviction_q.json": file });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    const table = await screen.findByRole("table", {
      name: "Conviction moves",
    });
    const dollars = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getByText(/\$\d+m/).textContent);
    expect(dollars()).toEqual(["+$40m", "−$80m", "+$60m"]); // the file's order
    await user.click(
      within(table).getByRole("button", { name: "$ bought / sold" }),
    );
    expect(dollars()).toEqual(["+$60m", "+$40m", "−$80m"]);
    await user.click(
      within(table).getByRole("button", { name: "$ bought / sold" }),
    );
    expect(dollars()).toEqual(["−$80m", "+$40m", "+$60m"]);
    // the Weight column sorts by the signed change in the fund's AUM: the biggest buy first, a sale last, and back again
    const moves = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.querySelector(".wn")?.textContent);
    await user.click(within(table).getByRole("button", { name: "Weight" }));
    expect(moves()).toEqual(["0% → 5%", "1% → 5%", "13% → 0%"]);
    await user.click(within(table).getByRole("button", { name: "Weight" }));
    expect(moves()).toEqual(["13% → 0%", "1% → 5%", "0% → 5%"]);
  });

  it("conviction's last 4 quarters view loads its own file and shows each move's quarter", async () => {
    const year: RowsFile<ConvictionRow> = {
      latest_q: 53,
      rows: [
        {
          fund_id: 9100003,
          name: "Lanternfish Capital Management",
          stock_id: 13,
          q: 51,
          move: "new",
          usd: 70e6,
          weight_after: 0.07,
          change_pts: 7,
          est_price: 90,
          score: 5,
        },
      ],
    };
    const urls = stubData({ "home/conviction_y.json": year });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    await screen.findByRole("table", { name: "Conviction moves" });
    await user.click(screen.getByRole("button", { name: "Last 4 quarters" }));
    expect(
      screen.getByRole("button", { name: "Last 4 quarters" }),
    ).toHaveAttribute("aria-pressed", "true");
    await screen.findByText(/The 4 quarters to Q2 2026/);
    expect(urls).toContain("/demo-data/home/conviction_y.json");
    const table = screen.getByRole("table", { name: "Conviction moves" });
    expect(
      within(table).getByRole("columnheader", { name: "Quarter" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Weight" }),
    ).toBeInTheDocument();
    expect(
      within(within(table).getAllByRole("row")[1]).getByText("Q4 2025"),
    ).toBeInTheDocument();
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
      "home/calls_q.json": {
        latest_q: 53,
        rows: [call(16, 9100001, "Kelpwood Capital LP", 10, 11)],
      },
      "latest_prices.json": pricesWith({ 16: 12 }),
    });
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Best & worst calls" }));
    const row = (await screen.findAllByRole("row"))[1];
    expect(within(row).getByRole("link", { name: /Visa/ })).toHaveAttribute(
      "href",
      "/fund/9100001/stock/16",
    ); // the name tidied, as on the fund page
    expect(
      within(row).getByRole("link", { name: "Kelpwood Capital LP" }),
    ).toHaveAttribute("href", "/fund/9100001");
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
      "home/calls_q.json": {
        latest_q: 53,
        rows: [call(16, 9100001, "Kelpwood Capital LP", 10, 11)],
      },
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
    expect(screen.getByRole("button", { name: "Best calls" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(fundOrder()).toEqual(["Fund A", "Fund C", "Fund B", "Fund Gone"]),
    );
    await user.click(screen.getByRole("button", { name: "Worst calls" }));
    expect(screen.getByRole("button", { name: "Worst calls" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
    expect(
      screen.getByRole("button", { name: "Last quarter's buys" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      screen.getByRole("button", { name: "Last 4 quarters' buys" }),
    );
    await waitFor(() => expect(urls).toContain("/demo-data/home/calls_y.json"));
    await waitFor(() =>
      expect(screen.getAllByRole("row")).toHaveLength(
        demo<RowsFile<CallRow>>("home/calls_y.json").rows.length + 1,
      ),
    );
  });

  it("a list that fails to load shows one error line, not a blank page", async () => {
    stubData({}, ["home/conviction_q.json"]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Conviction moves" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn.t load/i,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(7); // the page is still there
    await user.click(screen.getByRole("tab", { name: "Top funds" })); // and the other lists still work
    expect(await screen.findByRole("heading", { level: 3, name: "Funds over $1B" })).toBeInTheDocument();
  });

  it("search says so when the fund index fails to load", async () => {
    stubData({}, ["funds.json"]);
    const user = userEvent.setup();
    renderHome();
    // the fund list is fetched when the reader reaches for the search
    await user.click(screen.getByRole("searchbox", { name: /search a fund/i }));
    expect(
      await screen.findByText(/search isn.t available/i),
    ).toBeInTheDocument();
    await famousReady(); // lists unaffected
  });
});

describe("Landscape", () => {
  const map = () => screen.findByRole("group", { name: /^All 13F filers: each tile/ });
  const tiles = (el: Element, kind: string) => [...el.querySelectorAll(`g.tile[data-kind="${kind}"]`)];

  it("draws every current filer under its type, zooms into a group and back out", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Landscape" }));
    const svg = await map();
    const file = demo<{ funds: { fund_id: number[] }; n_filers: number }>("home/landscape.json");
    // the demo's filers are few enough for a tile each, or a group's tile where a group is too small to open
    await waitFor(() => expect(tiles(svg, "fund").length + tiles(svg, "box").length).toBeGreaterThan(0));
    expect(tiles(svg, "fund").length).toBeLessThanOrEqual(file.funds.fund_id.length);
    expect(screen.getByText(new RegExp(`^${file.n_filers} filers with`))).toBeInTheDocument();
    expect(screen.getByText(/counted twice/)).toBeInTheDocument();
    const head = tiles(svg, "grp").find((t) => t.getAttribute("aria-label")?.startsWith("Asset managers"))!;
    await user.click(head);
    const crumbs = screen.getByRole("navigation", { name: "Zoom" });
    expect(within(crumbs).getByRole("button", { name: "All 13F filers" })).toBeInTheDocument();
    expect(within(crumbs).getByText("Asset managers")).toHaveAttribute("aria-current", "location");
    const zoomed = screen.getByRole("group", { name: /^Asset managers: each tile/ });
    expect(tiles(zoomed, "fund").map((t) => t.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Seastack/)]),
    );
    await user.keyboard("{Escape}"); // the clicked heading has the focus: Escape zooms out
    expect(await map()).toBeInTheDocument();
    const again = tiles(await map(), "grp").find((t) => t.getAttribute("aria-label")?.startsWith("Asset managers"))!;
    await user.click(again);
    await user.click(within(screen.getByRole("navigation", { name: "Zoom" })).getByRole("button", { name: "All 13F filers" }));
    expect(await map()).toBeInTheDocument();
  });

  it("opens a filer's fund page from its tile", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Landscape" }));
    const svg = await map();
    await waitFor(() => expect(tiles(svg, "fund").length).toBeGreaterThan(0));
    const seastack = tiles(svg, "fund").find((t) => t.getAttribute("aria-label")?.startsWith("Seastack"))!;
    await user.click(seastack);
    expect(await screen.findByText("Fund page 9100009")).toBeInTheDocument();
  });

  it("keeps the period the other tabs use", async () => {
    stubData();
    const user = userEvent.setup();
    renderHome();
    await famousReady();
    await user.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "5 years" }));
    await user.click(screen.getByRole("tab", { name: "Landscape" }));
    await map();
    const period = within(screen.getByRole("group", { name: "Period" }));
    expect(period.getByRole("button", { name: "5 years" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: /return a year over 5 years/ })).toBeInTheDocument();
  });

  it("says it comes with the next data update before the pipeline has published it", async () => {
    stubData();
    const inner = globalThis.fetch as unknown as (url: string) => Promise<unknown>;
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("home/landscape.json") ? { ok: false, status: 404, json: async () => ({}) } : inner(url),
    );
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole("tab", { name: "Landscape" }));
    expect(await screen.findByText(/arrives with the next data update/)).toBeInTheDocument();
  });
});
