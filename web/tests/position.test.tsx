import { render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { StepChart } from "../src/charts/StepChart";
import { clearDataCache } from "../src/data/api";
import type { FundsIndex, LatestPrices, Positions, Securities, Summary, TradeTuple } from "../src/data/types";
import { tidyName } from "../src/lib/format";

// The step chart is the real one; the spy only records the props the page gives it.
vi.mock("../src/charts/StepChart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/charts/StepChart")>();
  return { ...actual, StepChart: vi.fn(actual.StepChart) };
});

// ---- fixtures: the demo JSON under public/demo-data, served through a mocked fetch ----

const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;

/** Overrides value that makes a path answer HTTP 404. */
const MISSING = Symbol("missing");

/**
 * Stub fetch with the demo files; a path with no demo file answers HTTP 404. `overrides` replaces a
 * file's body (keyed by the path under demo-data; MISSING = 404); `failing` makes paths answer HTTP 500.
 * Returns every URL requested, in order.
 */
function stubData(overrides: Record<string, unknown> = {}, failing: string[] = []): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const path = url.replace(/^\/demo-data\//, "");
      if (failing.includes(path)) return { ok: false, status: 500, json: async () => ({}) };
      const override = overrides[path];
      if (override === MISSING || (!(path in overrides) && !existsSync(join(DEMO, path)))) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      const body = path in overrides ? override : demo<unknown>(path);
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return urls;
}

const FUND = 9100001; // Kelpwood Capital LP, latest period Q3 2026 (53)
const GOOGL = 6; // held since Q1 2023: New, Exit, New, Add; priced 2026-10-30
const PEABODY = 19; // sold out in Q3 2019; its latest close is from 2019-08-15
const SOLO = 6; // the stock of the one-position funds built by onePosition()

const positionsPath = (id: number) => `fund/${id}/positions.json`;

/** A positions.json holding one position, with the fields not given worked out from its trades. */
function onePosition(trades: TradeTuple[], over: Partial<Record<keyof Positions, unknown>> = {}): Positions {
  const bought = trades.filter((t) => t[1] > 0).reduce((a, t) => a + t[1], 0);
  const invested = trades.filter((t) => t[1] > 0).reduce((a, t) => a + t[1] * t[2], 0);
  const sold = trades.filter((t) => t[1] < 0).reduce((a, t) => a - t[1] * t[2], 0);
  const sharesNow = trades[trades.length - 1][5];
  const last = trades[trades.length - 1];
  const one: Record<keyof Positions, unknown> = {
    stock_id: SOLO,
    from_q: trades[0][0],
    to_q: sharesNow === 0 ? last[0] : null,
    avg_cost: invested / bought,
    avg_exit: sold > 0 ? sold / trades.filter((t) => t[1] < 0).reduce((a, t) => a - t[1], 0) : null,
    invested,
    realised: 0,
    dividends: 0,
    shares_now: sharesNow,
    cost_now: sharesNow === 0 ? 0 : invested - sold,
    last_q: last[0],
    last_type: last[1] > 0 ? "add" : sharesNow === 0 ? "exit" : "trim",
    last_pct: null,
    last_usd: -last[1] * last[2],
    trades,
    ...over,
  };
  const cols: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(one)) cols[k] = [v];
  return cols as unknown as Positions;
}

/** latest_prices.json with exactly these closes (null = no close) on `asof`. */
const pricesOf = (closes: Record<number, number | null>, asof = "2026-10-30"): LatestPrices => ({
  asof,
  stock_id: Object.keys(closes).map(Number),
  price: Object.values(closes),
  date: Object.values(closes).map((p) => (p == null ? null : asof)),
});

/** A one-position fund (id FUND) priced as given: the page under test needs nothing else changed. */
const soloFund = (trades: TradeTuple[], close: number | null, over: Partial<Record<keyof Positions, unknown>> = {}, asof?: string) => ({
  [positionsPath(FUND)]: onePosition(trades, over),
  "latest_prices.json": pricesOf({ [SOLO]: close }, asof),
});

/** Render the whole app at `path`, as main.tsx mounts it. */
function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>,
  );
}

const positionPath = (stockId: number | string, fundId: number | string = FUND) => `/fund/${fundId}/stock/${stockId}`;

/** "TICKER · NAME" of a demo stock: the h1 of its position page. */
function titleOf(stockId: number): string {
  const sec = demo<Securities>("securities.json");
  const at = sec.stock_id.indexOf(stockId);
  return `${sec.ticker[at]} · ${tidyName(sec.name[at])}`;
}

/** Wait until the page has loaded a position (its h1 holds the ticker). */
const loaded = (name: string) => screen.findByRole("heading", { level: 1, name });

const tile = (label: string) => screen.getByText(label).closest(".kpi") as HTMLElement;
const tileValue = (label: string) => tile(label).querySelector(".kpi-v")?.textContent;
const tileSub = (label: string) => tile(label).querySelector(".kpi-n")?.textContent;
const chart = (label: string) => document.querySelector(`svg[aria-label="${label}"]`);
const notFound = () => screen.findByRole("heading", { level: 1, name: "Page not found" });

/** The cells of each body row of the trades table, oldest trade first. */
function tradeRows(): string[][] {
  const table = screen.getByRole("table", { name: "Trades by quarter" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""));
}

beforeEach(() => {
  clearDataCache();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------------------

describe("Position page", () => {
  it("renders trades table rows", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    await loaded("GOOGL · Alphabet");

    const table = screen.getByRole("table", { name: "Trades by quarter" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Quarter",
      "Move",
      "Shares",
      "Est. price (VWAP)",
      "Quarter range",
      "$ value",
      "Shares after",
    ]);
    // Oldest first; a stock bought again after a full exit is "New" again. The quarter is "Q2 ’25", the move
    // a tinted word box and the value whole millions, like the fund page's positions table.
    expect(tradeRows()).toEqual([
      ["Q1 ’23", "New", "+12,916,044", "$111", "$97.59–$121", "$1,431m", "12,916,044"],
      ["Q2 ’23", "Sold all", "−12,916,044", "$135", "$110–$153", "$1,744m", "0"],
      ["Q4 ’24", "New", "+12,543,441", "$283", "$223–$343", "$3,554m", "12,543,441"],
      ["Q2 ’25", "Added", "+5,200,998", "$219", "$174–$258", "$1,137m", "17,744,439"],
    ]);
  });

  it("shows each move in a tinted box and the shares signed, in the gain or loss colour", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    await loaded("GOOGL · Alphabet");
    const table = screen.getByRole("table", { name: "Trades by quarter" });
    const rows = within(table).getAllByRole("row").slice(1);
    // New and Added are tinted as gains, Sold all as neutral; Trimmed would be a loss.
    expect(rows.map((r) => r.querySelector(".lc")?.className)).toEqual(["lc add", "lc sold", "lc add", "lc add"]);
    expect(rows.map((r) => r.querySelectorAll("td")[2].querySelector("span")?.className)).toEqual(["up", "down", "up", "up"]);
    // The head of the table names the columns of every row; none is left out at any width (the wrapper scrolls instead).
    expect(within(table).getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.getByRole("region", { name: "Trades by quarter, scrollable" })).toContainElement(table);
  });

  it("tints a trim as a loss", async () => {
    stubData(
      soloFund(
        [
          [0, 100, 10, 9, 11, 100],
          [4, -40, 12, 11, 13.5, 60],
        ],
        20,
      ),
    );
    renderApp(positionPath(SOLO));
    await loaded("GOOGL · Alphabet");
    const rows = within(screen.getByRole("table", { name: "Trades by quarter" })).getAllByRole("row").slice(1);
    expect(rows[1].querySelector(".lc")).toHaveClass("trim");
    expect(rows[1].querySelectorAll("td")[2].querySelector("span")).toHaveClass("down");
  });

  it("puts the sector, the years held and the latest price in three pills under the title", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    const h1 = await loaded("GOOGL · Alphabet");
    const pills = Array.from(h1.closest(".pos-head")!.querySelectorAll(".pos-meta .pill")).map((p) => p.textContent);
    expect(pills).toEqual(["Sector Tech", "Held Q1 2023 – now", "Latest price $137 · 30 Oct 2026"]);
    expect(screen.getByRole("group", { name: "This position" })).toBeInTheDocument();
  });

  it("shows a quarter range of dashes and a trim when a quarter has no prices", async () => {
    stubData(
      soloFund(
        [
          [0, 100, 10, null, null, 100],
          [4, -40, 12, 11, 13.5, 60],
        ],
        20,
      ),
    );
    renderApp(positionPath(SOLO));
    await loaded("GOOGL · Alphabet");
    expect(tradeRows()).toEqual([
      ["Q1 ’13", "New", "+100", "$10.00", "—", "$1,000", "100"], // under a million: plain dollars, not "$0m"
      ["Q1 ’14", "Trimmed", "−40", "$12.00", "$11.00–$13.50", "$480", "60"],
    ]);
  });

  it("names the position: back link, ticker, name, sector, years held and the latest price with its date", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    const h1 = await loaded("GOOGL · Alphabet");

    const back = screen.getByRole("link", { name: "← Kelpwood Capital LP" });
    expect(back).toHaveAttribute("href", `/fund/${FUND}`);
    expect(h1.querySelector(".mono")).toHaveTextContent("GOOGL");
    const meta = h1.closest(".pos-head")!.querySelector(".pos-meta") as HTMLElement;
    expect(meta.textContent).toBe("Sector TechHeld Q1 2023 – nowLatest price $137 · 30 Oct 2026");
  });

  it("shows how long a closed position was held and the age of a stale price (R5)", async () => {
    stubData();
    renderApp(positionPath(PEABODY));
    const h1 = await loaded(titleOf(PEABODY));
    const meta = h1.closest(".pos-head")!.querySelector(".pos-meta") as HTMLElement;
    expect(meta.textContent).toMatch(/Held Q4 2017 – Q3 2019/);
    expect(meta.textContent).toMatch(/Latest price \$351 · 15 Aug 2019/);
    expect(tileValue("Shares now")).toBe("0");
    expect(tileSub("Shares now")).toBe("fully sold");
  });

  it("shows the tiles of an open position from its file and the live price", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    await loaded("GOOGL · Alphabet");

    expect(tileValue("Shares now")).toBe("17,744,439");
    expect(tileSub("Shares now")).toBe("worth $2.43B");
    expect(tileValue("Avg cost")).toBe("$200");
    expect(tileSub("Avg cost")).toBe("avg of estimated buy prices");
    expect(tileValue("$ in")).toBe("$6.12B");
    // realised + shares now x price - cost now + dividends = 312.7M + 2,431.8M - 4,690.6M + 50.9M
    expect(tileValue("Total P&L")).toBe("−$1.90B");
    expect(tile("Total P&L").querySelector(".kpi-v")).toHaveClass("down");
    expect(tileSub("Total P&L")).toBe("−31% on $ in · incl. $51M dividends");
    expect(tileValue("IRR")).toMatch(/^[+−]\d+%$/);
    expect(tileSub("IRR")).toBe("mid-quarter trade dates");
  });

  // One buy of 100 shares at $10 on 2013-02-14 (mid Q1 2013) held to 2014-01-01 (321 days = 321 / 365 years):
  // a price of P turns $1,000 into 100 P over 0.879452 years, so IRR = (P / 10)^(1 / 0.879452) - 1.
  it.each([
    [20, "+120%"],
    [15, "+59%"],
    [5, "−55%"],
  ])("irr tile uses live price (%s)", async (price, expected) => {
    stubData(soloFund([[0, 100, 10, 9, 11, 100]], price, {}, "2014-01-01"));
    renderApp(positionPath(SOLO));
    await loaded("GOOGL · Alphabet");
    expect(tileValue("IRR")).toBe(expected);
    expect(tile("IRR").querySelector(".kpi-v")).toHaveClass(price > 10 ? "up" : "down");
  });

  it("total P&L is realised + unrealised + dividends at the live price, with the return on dollars in", async () => {
    stubData(soloFund([[0, 100, 10, 9, 11, 100]], 20, { dividends: 50 }, "2014-01-01"));
    renderApp(positionPath(SOLO));
    await loaded("GOOGL · Alphabet");
    expect(tileValue("Shares now")).toBe("100");
    expect(tileSub("Shares now")).toBe("worth $2,000");
    expect(tileValue("Avg cost")).toBe("$10.00");
    expect(tileValue("$ in")).toBe("$1,000");
    expect(tileValue("Total P&L")).toBe("+$1,050"); // 0 realised + (100 x 20 - 1,000) + 50
    expect(tile("Total P&L").querySelector(".kpi-v")).toHaveClass("up");
    expect(tileSub("Total P&L")).toBe("+105% on $ in · incl. $50 dividends");
  });

  it("a closed position needs no price: IRR from its trades alone", async () => {
    // Bought 100 at $10 in Q1 2013 (2013-02-14), sold all at $20 in Q1 2014 (2014-02-14): exactly 365 days, doubled.
    stubData(
      soloFund(
        [
          [0, 100, 10, 9, 11, 100],
          [4, -100, 20, 18, 22, 0],
        ],
        null,
        { realised: 1000 },
      ),
    );
    renderApp(positionPath(SOLO));
    await loaded("GOOGL · Alphabet");
    expect(tileValue("IRR")).toBe("+100%");
    expect(tileValue("Total P&L")).toBe("+$1,000");
    expect(tileValue("Shares now")).toBe("0");
    expect(tileSub("Shares now")).toBe("fully sold");
  });

  it("shows a dash wherever the missing latest price is needed", async () => {
    stubData(soloFund([[0, 100, 10, 9, 11, 100]], null, { dividends: 50 }));
    renderApp(positionPath(SOLO));
    const h1 = await loaded("GOOGL · Alphabet");
    expect(h1.closest(".pos-head")!.querySelector(".pos-meta")!.textContent).toMatch(/Latest price —$/);
    expect(tileValue("Total P&L")).toBe("—");
    expect(tileSub("Total P&L")).toBe("incl. $50 dividends");
    expect(tileValue("IRR")).toBe("—");
    expect(tileSub("Shares now")).toBeUndefined();
    // what does not depend on the price is still there
    expect(tileValue("Shares now")).toBe("100");
    expect(tileValue("$ in")).toBe("$1,000");
    expect(tradeRows()).toHaveLength(1);
  });

  it("draws the price chart and the shares chart, the shares running to the latest filed quarter for an open position (R28)", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    await loaded("GOOGL · Alphabet");

    expect(screen.getByRole("heading", { level: 2, name: "Price and estimated trades" })).toBeInTheDocument();
    expect(chart("Weekly price with estimated trade prices")).not.toBeNull();
    expect(chart("Shares held by quarter")).not.toBeNull();
    expect(document.querySelectorAll("path.mk")).toHaveLength(4); // one triangle per trade

    const props = vi.mocked(StepChart).mock.lastCall![0];
    expect(props.quarters).toEqual([40, 41, 47, 49]);
    expect(props.shares).toEqual([12916044, 0, 12543441, 17744439]);
    expect(props.endQ).toBe(demo<Summary>(`fund/${FUND}/summary.json`).period_q); // 53
  });

  it("the shares chart of a closed position ends in the quarter of its exit (R28)", async () => {
    stubData();
    renderApp(positionPath(PEABODY));
    await screen.findByRole("table", { name: "Trades by quarter" });
    expect(vi.mocked(StepChart).mock.lastCall![0].endQ).toBe(26);
  });

  it("says there is no price history when the stock has no weekly file (R28), and still shows the rest", async () => {
    stubData({ [`stock/${GOOGL}/weekly.json`]: MISSING });
    renderApp(positionPath(GOOGL));
    await loaded("GOOGL · Alphabet");
    expect(screen.getByText("No price history")).toBeInTheDocument();
    expect(chart("Weekly price with estimated trade prices")).toBeNull();
    expect(chart("Shares held by quarter")).not.toBeNull();
    expect(tradeRows()).toHaveLength(4);
    expect(tileValue("Shares now")).toBe("17,744,439");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a loading line first", async () => {
    stubData();
    renderApp(positionPath(GOOGL));
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    await loaded("GOOGL · Alphabet");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["the fund's summary", `fund/${FUND}/summary.json`],
    ["the securities list", "securities.json"],
    ["the latest prices", "latest_prices.json"],
    ["the stock's weekly prices", `stock/${GOOGL}/weekly.json`],
  ])("a failed load of %s is a one-line alert, never a blank page", async (_name, path) => {
    stubData({}, [path]);
    renderApp(positionPath(GOOGL));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't load this position/);
    expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
  });

  it("a missing shared file is a failed load, not an unknown position", async () => {
    stubData({ "securities.json": MISSING });
    renderApp(positionPath(GOOGL));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
  });

  it("a stock missing from securities.json is shown by its id", async () => {
    const sec = demo<Securities>("securities.json");
    const at = sec.stock_id.indexOf(GOOGL);
    const without: Securities = {
      stock_id: sec.stock_id.filter((_, i) => i !== at),
      ticker: sec.ticker.filter((_, i) => i !== at),
      name: sec.name.filter((_, i) => i !== at),
      sector: sec.sector.filter((_, i) => i !== at),
    };
    stubData({ "securities.json": without });
    renderApp(positionPath(GOOGL));
    const h1 = await loaded(`#${GOOGL}`);
    expect(h1.closest(".pos-head")!.querySelector(".pos-meta")!.textContent).toMatch(/^Sector —Held/);
  });
});

// ---------------------------------------------------------------------------------------

describe("routes and the not-found page", () => {
  /** Requests for anything under fund/ or stock/ (funds.json is the index and is allowed). */
  const dataRequests = (urls: string[]) => urls.filter((u) => /\/(fund|stock)\//.test(u));

  it("unknown fund shows not found, without fetching the fund's files", async () => {
    const urls = stubData();
    renderApp("/fund/999999");
    expect(await notFound()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dataRequests(urls)).toEqual([]);
  });

  it("unknown fund shows not found on a position route too", async () => {
    const urls = stubData();
    renderApp(positionPath(GOOGL, 999999));
    expect(await notFound()).toBeInTheDocument();
    expect(dataRequests(urls)).toEqual([]);
  });

  it.each([
    ["the fund page", "/fund/9100001"],
    ["a position page", positionPath(GOOGL)],
  ])("funds.json decides whether a fund exists, not a 404 (R29): %s", async (_name, path) => {
    // The files of the fund exist (a static host's fallback would answer them), but the index does not list it.
    const index = demo<FundsIndex>("funds.json");
    const keep = index.id.map((id) => id !== FUND);
    const unlisted: FundsIndex = {
      v: index.v,
      id: index.id.filter((_, i) => keep[i]),
      name: index.name.filter((_, i) => keep[i]),
      book: index.book.filter((_, i) => keep[i]),
      n: index.n.filter((_, i) => keep[i]),
    };
    const urls = stubData({ "funds.json": unlisted });
    renderApp(path);
    expect(await notFound()).toBeInTheDocument();
    expect(dataRequests(urls)).toEqual([]);
  });

  it.each([
    ["the fund page", "/fund/9100001"],
    ["a position page", positionPath(GOOGL)],
  ])("a fund listed in funds.json whose own file is gone is not found too: %s", async (_name, path) => {
    stubData({ [`fund/${FUND}/summary.json`]: MISSING });
    renderApp(path);
    expect(await notFound()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("unknown stock shows not found", async () => {
    const urls = stubData();
    renderApp(positionPath(999999));
    expect(await notFound()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(urls.some((u) => u.includes("stock/999999"))).toBe(false); // nothing is asked of a stock the fund never held
  });

  it("a stock this fund never held is not found even though the stock exists", async () => {
    const held = new Set(demo<Positions>(positionsPath(FUND)).stock_id);
    const other = demo<Securities>("securities.json").stock_id.find((id) => !held.has(id));
    expect(other).toBeDefined(); // the demo fund does not own every demo stock
    stubData();
    renderApp(positionPath(other!));
    expect(await notFound()).toBeInTheDocument();
  });

  it.each(["abc", "6abc", "1.5", "-6", "0x6"])("stock id %s is not found without a request", async (id) => {
    const urls = stubData();
    renderApp(positionPath(id));
    expect(await notFound()).toBeInTheDocument();
    expect(urls).toEqual([]);
  });

  it("a fund id that is not a number is not found without a request", async () => {
    const urls = stubData();
    renderApp(positionPath(GOOGL, "abc"));
    expect(await notFound()).toBeInTheDocument();
    expect(urls).toEqual([]);
  });

  it("an unknown path shows the not-found page", async () => {
    stubData();
    renderApp("/no/such/page");
    expect(await notFound()).toBeInTheDocument();
  });

  it("the not-found page says so and links home", async () => {
    stubData();
    renderApp("/no/such/page");
    await notFound();
    expect(screen.getByText(/We couldn't find that page/)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
  });

  it("the not-found page is the artifact's empty state: a card with an icon, the heading, a line and one action", async () => {
    stubData();
    renderApp("/no/such/page");
    const h1 = await notFound();
    const card = h1.closest(".pg-state") as HTMLElement;
    expect(card.querySelector(".ic svg")).not.toBeNull();
    expect(within(card).getAllByRole("link")).toHaveLength(1);
  });

  it("/how-it-works renders the methodology page", async () => {
    const urls = stubData();
    renderApp("/how-it-works");
    expect(screen.getByRole("heading", { level: 1, name: "How Orca estimates fund results" })).toBeInTheDocument();
    for (const h of ["What a 13F covers", "Trade prices", "P&L per stock", "Fund returns", "What if they'd kept it", "Not investment advice"]) {
      expect(screen.getByRole("heading", { level: 2, name: h })).toBeInTheDocument();
    }
    expect(urls).toEqual([]); // it is static text
  });

  it("the methodology page carries the formulas", () => {
    stubData();
    renderApp("/how-it-works");
    const formulas = Array.from(document.querySelectorAll(".formula")).map((f) => f.textContent);
    expect(formulas).toEqual([
      "typical price = (high + low + close) ÷ 3\nquarter VWAP  = Σ(typical price × volume) ÷ Σ volume",
      "buy:  cost += shares bought × VWAP\nsell: realised += shares sold × (VWAP − avg cost)\nunrealised = shares held × latest price − cost\ntotal = realised + unrealised + dividends",
      "quarter return = (end value − start value − net buying + dividends)\n                 ÷ (start value + ½ × net buying)\nyear = the four quarters chained",
    ]);
  });

  it("the methodology page is a heading block and six sections; the formulas can be focused to scroll", () => {
    stubData();
    renderApp("/how-it-works");
    const sections = Array.from(document.querySelectorAll(".method-page .prose > section"));
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual([
      "What a 13F covers",
      "Trade prices",
      "P&L per stock",
      "Fund returns",
      "What if they'd kept it",
      "Not investment advice",
    ]);
    // The section numbers are drawn by CSS, so they are not part of any heading's name.
    sections.forEach((s) => expect(s.querySelector("h2")!.textContent).not.toMatch(/^\d/));
    document.querySelectorAll(".formula").forEach((f) => expect(f).toHaveAttribute("tabindex", "0"));
  });

  it("method page ends with not-advice line", async () => {
    stubData();
    renderApp("/how-it-works");
    const prose = document.querySelector(".prose") as HTMLElement;
    const last = prose.lastElementChild as HTMLElement;
    expect(within(last).getByRole("heading", { level: 2, name: "Not investment advice" })).toBeInTheDocument();
    expect(last.querySelector("p")?.textContent).toBe(
      "Orca is research software. Nothing here is a recommendation to buy or sell anything.",
    );
    expect(prose.textContent?.trim().endsWith("Nothing here is a recommendation to buy or sell anything.")).toBe(true);
  });
});
