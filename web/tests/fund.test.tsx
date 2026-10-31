import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "../src/charts/Tooltip";
import { clearDataCache } from "../src/data/api";
import type { Contrib, LatestPrices, Positions, Summary } from "../src/data/types";
import Fund from "../src/pages/Fund";

// ---- fixtures: the demo JSON under public/demo-data, served through a mocked fetch ----

// (not `new URL(..., import.meta.url)`: Vite rewrites that into an asset URL)
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

const FUND = 9100001; // Kelpwood Capital LP: 2015-2025 full years, priced 100%
const GAP_FUND = 9100008; // Gullwing Investors: the "2017 Q4" year has no chained return
const INACTIVE_FUND = 9100010; // Cobblereef Holdings: filed nothing in the latest two quarters

/** The demo summary of a fund, changed by `mutate`, keyed for stubData. */
function summaryWith(mutate: (s: Summary) => void, id = FUND): Record<string, unknown> {
  const s = demo<Summary>(`fund/${id}/summary.json`);
  mutate(s);
  return { [`fund/${id}/summary.json`]: s };
}

const nullMetrics = (s: Summary) => {
  for (const k of Object.keys(s.metrics)) (s.metrics as Record<string, unknown>)[k] = null;
};

const noPositions: Positions = {
  stock_id: [],
  from_q: [],
  to_q: [],
  avg_cost: [],
  avg_exit: [],
  invested: [],
  realised: [],
  dividends: [],
  shares_now: [],
  cost_now: [],
  last_q: [],
  last_type: [],
  last_pct: [],
  last_usd: [],
  trades: [],
};

/** latest_prices.json with exactly these closes (null = no close). */
const pricesOf = (closes: Record<number, number | null>): LatestPrices => ({
  asof: "2026-10-30",
  stock_id: Object.keys(closes).map(Number),
  price: Object.values(closes),
  date: Object.values(closes).map((p) => (p == null ? null : "2026-10-30")),
});

function renderFund(id: string | number = FUND, { withTooltip = false } = {}) {
  const page = (
    <MemoryRouter
      initialEntries={[`/fund/${id}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/fund/:id" element={<Fund />} />
      </Routes>
    </MemoryRouter>
  );
  // App.tsx mounts the one TooltipProvider; the page never does.
  return render(withTooltip ? <TooltipProvider>{page}</TooltipProvider> : page);
}

/** Wait until the page has loaded fund `name`. */
const loaded = (name: string) => screen.findByRole("heading", { level: 1, name });

const tile = (label: string) => screen.getByText(label).closest(".tile") as HTMLElement;
const tileValue = (label: string) => tile(label).querySelector(".v")?.textContent;
const tileSub = (label: string) => tile(label).querySelector(".d")?.textContent;

const chart = (label: string) => document.querySelector(`svg[aria-label="${label}"]`) as SVGSVGElement;
const section = (name: string) => screen.getByRole("region", { name });
/** The tickers down the left of a contributions chart, top to bottom. */
const barLabels = (label: string) => Array.from(chart(label).querySelectorAll("text.lab")).map((t) => t.textContent);

beforeEach(() => clearDataCache());
afterEach(() => vi.unstubAllGlobals());

describe("Fund page", () => {
  describe("header", () => {
    it("shows the name, filing line and the headline figures", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(screen.getByText("13F-HR · Period Q2 2026 · Filed 11 Aug 2026")).toBeInTheDocument();
      const meta = document.querySelector(".meta") as HTMLElement;
      expect(meta.textContent).toContain("13F book $24.0B");
      expect(meta.textContent).toContain("Live value $28.3B"); // holdings_now at latest_prices.json
      expect(meta.textContent).toContain("10 holdings");
      expect(meta.textContent).toContain("100% of book priced");
      expect(meta.textContent).toContain("Tracked since Q1 2014");
      expect(document.querySelector(".badge")).toBeNull();
      expect(screen.queryByText(/unpriced/)).toBeNull();
    });

    it.each([
      [0.75, "75% of book priced"],
      [0.57, "57% of book priced"], // 0.57 * 100 is 56.99999999999999
      [0.799, "79% of book priced"], // never rounds up to a "80%" warning
    ])("coverage badge below 80%% (priced_pct %s)", async (priced, text) => {
      stubData(summaryWith((s) => (s.priced_pct = priced)));
      renderFund();
      await loaded("Kelpwood Capital LP");
      const badge = screen.getByText(text);
      expect(badge).toHaveClass("badge");
      expect(screen.getAllByText(/of book priced/)).toHaveLength(1);
    });

    it("shows plain coverage from 80% up, rounded down so it never overstates", async () => {
      stubData(summaryWith((s) => (s.priced_pct = 0.995)));
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect((document.querySelector(".meta") as HTMLElement).textContent).toContain("99% of book priced");
      expect(document.querySelector(".badge")).toBeNull();
    });

    it.each([
      [1, { 2: 5, 3: 6, 4: null }, "$170", "1 holding unpriced"],
      [2, { 2: 5, 3: null, 4: null }, "$50", "2 holdings unpriced"],
    ])("live value skips %i unpriced holding(s) and says so", async (_n, closes, value, note) => {
      stubData({
        ...summaryWith((s) => {
          s.holdings_now = { stock_id: [2, 3, 4], shares: [10, 20, 5], cost: [1, 1, 1] };
          s.n_holdings = 3;
        }),
        "latest_prices.json": pricesOf(closes),
      });
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect((document.querySelector(".meta") as HTMLElement).textContent).toContain(`Live value ${value}`);
      expect(screen.getByText(note)).toBeInTheDocument();
    });

    it("notes that an inactive fund filed nothing in the latest two quarters", async () => {
      stubData();
      renderFund(INACTIVE_FUND);
      await loaded("Cobblereef Holdings");
      expect(screen.getByText(/filed nothing in the latest two quarters/i)).toBeInTheDocument();
    });

    it("has no inactive note for an active fund", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(screen.queryByText(/filed nothing/i)).toBeNull();
    });
  });

  describe("tiles", () => {
    it("renders performance tiles", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      for (const label of [
        "Return per year",
        "Sharpe ratio",
        "Sortino ratio",
        "Volatility",
        "Max drawdown",
        "Calmar ratio",
        "Best / worst year",
        "Years positive",
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(tileValue("Return per year")).toBe("+5.2%");
      expect(tileSub("Return per year")).toBe("2015–2025");
      expect(tileValue("Sharpe ratio")).toBe("0.30");
      expect(tileValue("Sortino ratio")).toBe("0.58");
      expect(tileValue("Volatility")).toBe("13.0%");
      expect(tileValue("Max drawdown")).toBe("−18.2%");
      expect(tileValue("Calmar ratio")).toBe("0.28");
      expect(tileValue("Best / worst year")).toBe("+48% / −10%");
      expect(tileSub("Best / worst year")).toBe("2023 / 2017");
      expect(tileValue("Years positive")).toBe("7 of 11");
      expect(tileSub("Years positive")).toBe("quarters positive: 51%");
    });

    it("renders how-they-trade tiles, with the profitable share at the latest prices", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(tileValue("Turnover per year")).toBe("49%");
      expect(tileValue("Avg hold length")).toBe("7.8 yrs");
      expect(tileSub("Avg hold length")).toBe("sold positions only: 6.3 yrs");
      expect(tileValue("Positions profitable")).toBe("59%"); // 13 of 22 positions have a positive total
    });

    it("renders dashes when metrics are null", async () => {
      stubData({ ...summaryWith(nullMetrics), [`fund/${FUND}/positions.json`]: noPositions });
      renderFund();
      await loaded("Kelpwood Capital LP");
      // the metric tiles under the header (the tables further down have tiles of their own)
      const values = ["Performance", "How they trade"].flatMap((group) =>
        Array.from(screen.getByRole("group", { name: group }).querySelectorAll(".v")).map((v) => v.textContent),
      );
      expect(values).toHaveLength(11);
      expect(values.every((v) => v === "—")).toBe(true);
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
      // The charts still draw the years, and the default year falls back to the last label (R14).
      expect(screen.getByRole("heading", { name: "What drove 2026 H1" })).toBeInTheDocument();
    });

    it("shows a dash for the profitable share when no position has a computable total", async () => {
      stubData({ [`fund/${FUND}/positions.json`]: noPositions });
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(tileValue("Positions profitable")).toBe("—");
      expect(tileValue("Sharpe ratio")).toBe("0.30");
    });

    it("states that the figures are 13F estimates", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(
        screen.getByText(
          "All figures are 13F estimates built from quarter-end holdings, so risk numbers understate swings inside a quarter. Sharpe and Sortino use 3-month T-bill rates as the risk-free rate.",
        ),
      ).toBeInTheDocument();
    });
  });

  describe("gains vs inflows", () => {
    it("draws a stacked chart of gains and inflows with end values", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const panel = section("Gains vs inflows");
      expect(within(panel).getByText("Investment gains")).toBeInTheDocument(); // legend
      expect(within(panel).getByText("Net inflows")).toBeInTheDocument();
      expect(chart("Investment gains and net inflows by year").querySelectorAll("rect.hit")).toHaveLength(13);
      expect(within(panel).getByText("$24.0B")).toBeInTheDocument(); // the last year's end value on top
    });

    it("table toggle shows the numbers and brings the chart back", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const panel = section("Gains vs inflows");
      await user.click(within(panel).getByRole("button", { name: "Show the numbers" }));
      expect(chart("Investment gains and net inflows by year")).toBeNull();
      const table = within(panel).getByRole("table");
      const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual([
        "Year",
        "Start value",
        "Investment gains",
        "Net inflows",
        "End value",
        "Dividends (in returns)",
      ]);
      const rows = within(table).getAllByRole("row");
      expect(rows).toHaveLength(14); // header + 13 years
      expect(within(rows[10]).getAllByRole("cell").map((c) => c.textContent)).toEqual([
        "2023",
        "$14.1B",
        "+$6.38B",
        "−$4.20B",
        "$16.3B",
        "$157M",
      ]);
      await user.click(within(panel).getByRole("button", { name: "Show the chart" }));
      expect(within(panel).queryByRole("table")).toBeNull();
      expect(chart("Investment gains and net inflows by year")).not.toBeNull();
    });
  });

  describe("annual returns", () => {
    it("selects the latest full year by default (R14) and marks it", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(screen.getByRole("heading", { name: "What drove 2025" })).toBeInTheDocument();
      const hits = Array.from(chart("Annual return by year (13F estimate)").querySelectorAll("rect.hit"));
      expect(hits).toHaveLength(13);
      expect(hits.filter((h) => h.getAttribute("aria-pressed") === "true").map((h) => h.getAttribute("aria-label")))
        .toEqual(["2025: Return (13F estimate) −2.7%"]);
      expect(screen.getByRole("button", { name: "2025" })).toHaveAttribute("aria-pressed", "true");
    });

    it("draws bars only for years with a chained return but chips for every year (R24)", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund(GAP_FUND);
      await loaded("Gullwing Investors");
      const hits = Array.from(chart("Annual return by year (13F estimate)").querySelectorAll("rect.hit"));
      expect(hits).toHaveLength(9);
      expect(hits.some((h) => h.getAttribute("aria-label")?.startsWith("2017 Q4"))).toBe(false);
      const chips = within(screen.getByRole("group", { name: "Pick a year" })).getAllByRole("button");
      expect(chips.map((c) => c.textContent)).toEqual([
        "2017 Q4",
        "2018",
        "2019",
        "2020",
        "2021",
        "2022",
        "2023",
        "2024",
        "2025",
        "2026 H1",
      ]);

      await user.click(chips[0]);
      expect(screen.getByRole("heading", { name: "What drove 2017 Q4" })).toBeInTheDocument();
      expect(chips[0]).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/The chained quarterly return for 2017 Q4 is —\./)).toBeInTheDocument();
      // no bar for that year, so no bar is pressed
      const after = Array.from(chart("Annual return by year (13F estimate)").querySelectorAll("rect.hit"));
      expect(after.some((h) => h.getAttribute("aria-pressed") === "true")).toBe(false);
    });

    it("clicking a bar selects its year", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const bar = screen.getByRole("button", { name: /^2023: / });
      await user.click(bar);
      expect(screen.getByRole("heading", { name: "What drove 2023" })).toBeInTheDocument();
      expect(bar).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "2023" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "2025" })).toHaveAttribute("aria-pressed", "false");
    });

    it("table toggle lists every year with its return", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund(GAP_FUND);
      await loaded("Gullwing Investors");
      const panel = section("Annual returns");
      await user.click(within(panel).getByRole("button", { name: "Show the numbers" }));
      expect(chart("Annual return by year (13F estimate)")).toBeNull();
      const rows = within(within(panel).getByRole("table")).getAllByRole("row");
      expect(rows).toHaveLength(11); // header + 10 years
      expect(within(rows[0]).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
        "Year",
        "Return (13F estimate)",
      ]);
      expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2017 Q4", "—"]);
      expect(within(rows[2]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2018", "+19.5%"]);
      // the year chips stay while the table shows
      expect(within(panel).getByRole("group", { name: "Pick a year" })).toBeInTheDocument();
      await user.click(within(panel).getByRole("button", { name: "Show the chart" }));
      expect(chart("Annual return by year (13F estimate)")).not.toBeNull();
    });

    it("shows no chart, and no toggle, when no year has a chained return", async () => {
      stubData(
        summaryWith((s) => {
          s.years.ret = s.years.ret.map(() => null);
        }),
      );
      renderFund();
      await loaded("Kelpwood Capital LP");
      const panel = section("Annual returns");
      expect(chart("Annual return by year (13F estimate)")).toBeNull();
      expect(within(panel).getByText("No annual returns yet")).toBeInTheDocument();
      expect(within(panel).queryByRole("button", { name: "Show the numbers" })).toBeNull();
      expect(within(panel).getAllByRole("button")).toHaveLength(13); // the chips remain
    });
  });

  describe("what drove the year", () => {
    it("clicking a year updates contributions heading", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(screen.getByRole("heading", { name: "What drove 2025" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "2023" }));
      expect(screen.getByRole("heading", { name: "What drove 2023" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "What drove 2025" })).toBeNull();
      expect(chart("Contribution to 2023 return by stock")).not.toBeNull();
    });

    it("contribution bars sorted descending", async () => {
      // stock ids 3, 2, 4, 5 are MSFT, NVDA, AAPL, AVGO; the file lists them out of order
      const contrib: Contrib = {
        years: ["2025"],
        by_year: { "2025": { stock_id: [3, 2, 4, 5], points: [-1.5, 4, 0.5, 2.5], pnl: [-1, 2, 3, 4] } },
      };
      stubData({ [`fund/${FUND}/contrib.json`]: contrib });
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(barLabels("Contribution to 2025 return by stock")).toEqual(["NVDA", "AVGO", "AAPL", "MSFT"]);
      const hits = chart("Contribution to 2025 return by stock").querySelectorAll("rect.hit");
      expect(Array.from(hits).map((h) => h.getAttribute("aria-label"))).toEqual([
        "NVDA +4.0 pts",
        "AVGO +2.5 pts",
        "AAPL +0.5 pts",
        "MSFT −1.5 pts",
      ]);
    });

    it("lists every stock of the demo year, largest contribution first", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const labels = barLabels("Contribution to 2025 return by stock");
      expect(labels).toEqual(["XOM", "HD", "PLD", "UNH", "NFLX", "GOOGL", "CAT", "COST", "V", "NEE", "AVGO", "TSLA", "LLY"]);
    });

    it("tooltip names the company and gives the dollar P&L", async () => {
      stubData();
      renderFund(FUND, { withTooltip: true });
      await loaded("Kelpwood Capital LP");
      const xom = screen.getByRole("img", { name: /^XOM / });
      fireEvent.focus(xom);
      const tip = document.getElementById("tip") as HTMLElement;
      expect(tip).not.toHaveAttribute("hidden");
      expect(tip.textContent).toContain("XOM · ");
      expect(tip.textContent).toContain("+$1.10B"); // pnl 1,097,495,997 dollars
      expect(tip.textContent).toContain("P&L");
      expect(tip.textContent).toContain("+6.9 pts");
    });

    it("adds up the contributions next to the chained return", async () => {
      const contrib: Contrib = {
        years: ["2025"],
        by_year: { "2025": { stock_id: [2, 3], points: [3.2, -1], pnl: [1, -1] } },
      };
      stubData({
        [`fund/${FUND}/contrib.json`]: contrib,
        ...summaryWith((s) => {
          s.years.ret[s.years.label.indexOf("2025")] = 0.0213;
        }),
      });
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(
        screen.getByText(
          "Contributions add up to +2.2 pts, an approximate return. The chained quarterly return for 2025 is +2.1%.",
        ),
      ).toBeInTheDocument();
    });

    it("says so, in one line, for a year with no positions", async () => {
      const contrib = demo<Contrib>(`fund/${FUND}/contrib.json`);
      contrib.by_year["2023"] = { stock_id: [], points: [], pnl: [] };
      stubData({ [`fund/${FUND}/contrib.json`]: contrib });
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      await user.click(screen.getByRole("button", { name: "2023" }));
      expect(screen.getByRole("heading", { name: "What drove 2023" })).toBeInTheDocument();
      expect(screen.getByText("No positions this year")).toBeInTheDocument();
      expect(chart("Contribution to 2023 return by stock")).toBeNull();
      expect(screen.queryByText(/The chained quarterly return for/)).toBeNull();
    });
  });

  describe("positions and what-if tables", () => {
    it("mounts both tables below the charts, from one fetch of positions and one of exits", async () => {
      const urls = stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const drove = screen.getByRole("heading", { name: /^What drove / });
      const owned = screen.getByRole("heading", { name: "Every stock they've owned" });
      const whatIf = screen.getByRole("heading", { name: "What if they'd kept it" });
      expect(drove.compareDocumentPosition(owned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(owned.compareDocumentPosition(whatIf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(section("Every stock they've owned")).getAllByRole("row")).toHaveLength(23); // 22 positions
      expect(within(section("What if they'd kept it")).getAllByRole("row")).toHaveLength(23); // 22 sales
      expect(tileValue("Profitable")).toBe("59%"); // as "Positions profitable" above
      expect(urls.filter((u) => u.endsWith(`/fund/${FUND}/positions.json`))).toHaveLength(1);
      expect(urls.filter((u) => u.endsWith(`/fund/${FUND}/exits.json`))).toHaveLength(1);
    });

    it("computes them at the page's latest prices", async () => {
      const lp = demo<LatestPrices>("latest_prices.json");
      stubData({ "latest_prices.json": { ...lp, price: lp.price.map(() => 1) } }); // every stock at $1
      renderFund();
      await loaded("Kelpwood Capital LP");
      const owned = section("Every stock they've owned");
      expect(within(owned).getAllByText("$1.00").length).toBeGreaterThan(0);
      expect(tileValue("Profitable")).toBe(tileValue("Positions profitable")); // one share of positions in profit, two tiles
      expect(tileValue("Profitable")).not.toBe("59%"); // the share at the demo's own prices
    });

    it("a failed exits file is a failed load, like the other files of the fund", async () => {
      stubData({}, [`fund/${FUND}/exits.json`]);
      renderFund();
      expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't load this fund/);
    });
  });

  describe("loading, errors and unknown funds", () => {
    it("shows a loading line first", async () => {
      stubData();
      renderFund();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      await loaded("Kelpwood Capital LP");
      expect(screen.queryByRole("status")).toBeNull();
    });

    it.each(["abc", "12abc", "1.5", "-3", "9100001x"])("non-numeric id %s renders the not-found view", async (id) => {
      const urls = stubData();
      renderFund(id);
      expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
      expect(urls).toEqual([]); // nothing is requested for an id that cannot be a fund
    });

    it("unknown fund renders the not-found view", async () => {
      stubData();
      renderFund(424242);
      expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a failed load is a one-line alert, never a blank page", async () => {
      stubData({}, [`fund/${FUND}/summary.json`]);
      renderFund();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/Couldn't load this fund/);
      expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
    });

    it("a missing shared file is a failed load, not an unknown fund", async () => {
      stubData({ "latest_prices.json": MISSING });
      renderFund();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
    });

    it("navigating to another fund starts from that fund's own default year", async () => {
      stubData();
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={[`/fund/${FUND}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Link to={`/fund/${GAP_FUND}`}>Other fund</Link>
          <Routes>
            <Route path="/fund/:id" element={<Fund />} />
          </Routes>
        </MemoryRouter>,
      );
      await loaded("Kelpwood Capital LP");
      await user.click(screen.getByRole("button", { name: "2023" }));
      expect(screen.getByRole("heading", { name: "What drove 2023" })).toBeInTheDocument();
      await user.click(screen.getByRole("link", { name: "Other fund" }));
      await loaded("Gullwing Investors");
      expect(screen.getByRole("heading", { name: "What drove 2025" })).toBeInTheDocument(); // not the 2023 picked on the other fund
    });
  });
});
