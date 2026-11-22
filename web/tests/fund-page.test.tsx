import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { TooltipProvider } from "../src/charts/Tooltip";
import { clearDataCache, priceMap } from "../src/data/api";
import type { FundsIndex, LatestPrices, Positions, Summary } from "../src/data/types";
import { fundTitle } from "../src/lib/format";
import { positionRows, profitablePct } from "../src/lib/live";
import Fund from "../src/pages/Fund";

// The shell of the fund page (src/pages/Fund.tsx): loading, not found, failure, the title, the order of
// the sections and the state the panels share. What each panel draws is tested panel by panel
// (fund-returns-ui, fund-drive-ui, fund-aum-ui, fund-positions-ui, fund-whatif); here a panel is
// only checked to be there and to be wired to the page.

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

const FUND = 9100001; // Kelpwood Capital LP: 2014-2026 H1, 22 positions ever, priced 100%
const OTHER_FUND = 9100002; // Halyard Point Partners: the same years
const INACTIVE_FUND = 9100010; // Cobblereef Holdings: filed nothing in the latest two quarters; years end in 2023

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

/** The demo fund with 21 years: eight made-up ones (2006-2013) in front of its 13, so that the 15-year window leaves some out. */
const longHistory = (s: Summary) => {
  const extra = Array.from({ length: 8 }, (_, i) => String(2006 + i));
  const years = s.years as Record<keyof Summary["years"], unknown[]>;
  for (const key of Object.keys(years) as (keyof Summary["years"])[]) {
    const first = key === "ret" || key === "approx_ret" ? 0.05 : years[key][0];
    years[key] = [...extra.map((label) => (key === "label" ? label : first)), ...years[key]];
  }
};

const noYears = (s: Summary) => {
  const years = s.years as Record<keyof Summary["years"], unknown[]>;
  for (const key of Object.keys(years) as (keyof Summary["years"])[]) years[key] = [];
};

/** The page as App.tsx mounts it: under the one TooltipProvider, at /fund/:id{hash}. `extra` renders above the routes. */
function renderFund(id: string | number = FUND, extra: ReactNode = null, hash = "") {
  return render(
    <MemoryRouter initialEntries={[`/fund/${id}${hash}`]}>
      <TooltipProvider>
        {extra}
        <Routes>
          <Route path="/fund/:id" element={<Fund />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** The Analysis tab of a fund page: key figures, Assets under management, Return constituents, What if. */
const renderAnalysis = (id: string | number = FUND, extra: ReactNode = null) => renderFund(id, extra, "#analysis");

/** Wait until the page has loaded fund `name`. */
const loaded = (name: string) => screen.findByRole("heading", { level: 1, name });
const notFound = () => screen.findByRole("heading", { level: 1, name: "Page not found" });

/** A tile of the key figures strip, found by its label (the first text of its label line, before the "Whole period" tag). */
const tile = (label: string) => {
  const found = Array.from(document.querySelectorAll<HTMLElement>(".kpi")).find((k) => k.querySelector(".kpi-l")?.firstChild?.textContent === label);
  if (!found) throw new Error(`no key figure tile "${label}"`);
  return found;
};
const tileValue = (label: string) => tile(label).querySelector(".kpi-v")?.textContent;
const tileSub = (label: string) => tile(label).querySelector(".kpi-n")?.textContent;
/** One of the three ratios of the Risk-adjusted return tile: "Sharpe", "Sortino" or "Calmar". */
const ratioValue = (name: string) =>
  Array.from(tile("Risk-adjusted return").querySelectorAll(".kpi-trio > div")).find((d) => d.querySelector("dt")?.textContent === name)?.querySelector("dd")?.textContent;
/** The whole-period tiles of the Analysis tab: the three ratios and the profitable share. */
const analysisWhole = () => [ratioValue("Sharpe"), ratioValue("Sortino"), ratioValue("Calmar"), tileValue("Positions profitable")];
/** The whole-period tiles of the Holdings tab: turnover and hold length. */
const holdingsWhole = () => [tileValue("Turnover per year"), tileValue("Average hold length")];
/** The labels of the tiles on the open tab, in order. */
const tileLabels = () => within(region("Key figures")).getAllByRole("article").map((a) => a.querySelector(".kpi-l")?.firstChild?.textContent);

const region = (name: string) => screen.getByRole("region", { name });
/** The bars of Annual returns, as their labels. */
const bars = () => Array.from(document.querySelectorAll<SVGElement>("#retPanel rect.hit"));
const pressedBars = () => bars().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label")?.split(":")[0]);
const bar = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}: `) });
const drovTitle = (span: string) => screen.getByRole("heading", { name: `Return constituents ${span}` });
const kpiCaption = () => document.querySelector(".kpi-cap")?.textContent;
/** The caption above the Holdings tab's key figures when the bracket spans `span`. */
const holdingsCaption = (span: string) =>
  `Annualised return and Max drawdown follow the Annual returns bracket: ${span}. Turnover per year and Average hold length cover the whole tracked period.`;
/** The caption above the Analysis tab's key figures when the bracket spans `span`. */
const analysisCaption = (span: string) =>
  `Years positive and Volatility follow the Annual returns bracket: ${span}. Risk-adjusted return and Positions profitable cover the whole tracked period.`;
/** The span the bracket names in that caption, e.g. "2014 to 2026 H1". */
const kpiSpan = () => document.querySelector(".kpi-cap b")?.textContent;
const handle = (name: string) => screen.getByRole("slider", { name });
/** Open a tab of the fund page by clicking it. */
const openTab = (user: ReturnType<typeof userEvent.setup>, name: "Holdings" | "Analysis" | "About") =>
  user.click(screen.getByRole("tab", { name: name === "Holdings" ? /^Holdings/ : name }));

const COULDNT_LOAD = "Couldn't load this fund. Check your connection and reload the page.";

beforeEach(() => {
  clearDataCache();
  document.title = "Orca";
});
afterEach(() => vi.unstubAllGlobals());

describe("Fund page", () => {
  describe("loading, errors and unknown funds", () => {
    it("shows a loading line first, then the page", async () => {
      stubData();
      renderFund();
      expect(screen.getByRole("status")).toHaveTextContent("Loading…");
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      await loaded("Kelpwood Capital LP");
      expect(screen.queryByText("Loading…")).toBeNull(); // (the period stepper of Return constituents is an <output>, a status too)
    });

    it("titles the tab '{name} 13F holdings and returns · Orca' once the fund has loaded, not before", async () => {
      stubData();
      renderFund();
      expect(document.title).toBe("Orca"); // still loading: the title is left as it was
      await loaded("Kelpwood Capital LP");
      await waitFor(() => expect(document.title).toBe(fundTitle("Kelpwood Capital LP")));
    });

    it("the <h1> is the fund's name and nothing else", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const h1s = screen.getAllByRole("heading", { level: 1 });
      expect(h1s).toHaveLength(1);
      expect(h1s[0]).toHaveTextContent(/^Kelpwood Capital LP$/);
    });

    it.each(["abc", "12abc", "1.5", "-3", "9100001x"])("non-numeric id %s renders the not-found view", async (id) => {
      const urls = stubData();
      renderFund(id);
      expect(await notFound()).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(urls).toEqual([]); // nothing is requested for an id that cannot be a fund
      await waitFor(() => expect(document.title).toBe("Not found · Orca"));
    });

    it("an id funds.json does not list renders the not-found view and requests nothing of that fund (R29)", async () => {
      const urls = stubData();
      renderFund(424242);
      expect(await notFound()).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(urls.filter((u) => /\/(fund|stock)\//.test(u))).toEqual([]);
      expect(screen.queryByRole("heading", { level: 1, name: "Kelpwood Capital LP" })).toBeNull();
    });

    it("funds.json decides, not a 404: a fund the index leaves out is not found even when its files are served (R29)", async () => {
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
      renderFund(FUND);
      expect(await notFound()).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(urls.filter((u) => /\/(fund|stock)\//.test(u))).toEqual([]); // the files exist, and are not even asked for
    });

    it.each(["summary", "positions", "contrib", "exits"])(
      "a fund funds.json lists whose own %s file is gone is not found, not a failed load",
      async (file) => {
        stubData({ [`fund/${FUND}/${file}.json`]: MISSING });
        renderFund();
        expect(await notFound()).toBeInTheDocument();
        expect(screen.queryByRole("alert")).toBeNull();
      },
    );

    it.each(["summary", "positions", "contrib", "exits"])("a failed %s file is a one-line alert, never a blank page", async (file) => {
      stubData({}, [`fund/${FUND}/${file}.json`]);
      renderFund();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(COULDNT_LOAD);
      expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    });

    it.each(["funds.json", "securities.json", "latest_prices.json"])("a failed shared file (%s) is a failed load too", async (file) => {
      stubData({}, [file]);
      renderFund();
      expect(await screen.findByRole("alert")).toHaveTextContent(COULDNT_LOAD);
      expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
    });

    it.each(["securities.json", "latest_prices.json"])("a missing shared file (%s) is a failed load, not an unknown fund", async (file) => {
      stubData({ [file]: MISSING });
      renderFund();
      expect(await screen.findByRole("alert")).toHaveTextContent(COULDNT_LOAD);
      expect(screen.queryByRole("heading", { name: "Page not found" })).toBeNull();
    });
  });

  describe("the sections", () => {
    it("three tabs under the header: Holdings (no hash), Analysis and About; the source note on each", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const tabs = within(screen.getByRole("tablist", { name: "Fund sections" })).getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Holdings10", "Analysis", "About"]);
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
      const panel = screen.getByRole("tabpanel");
      expect(panel).toHaveAttribute("id", "fund-panel-holdings");
      expect(panel).toHaveAccessibleName(/^Holdings\s*10$/);
      expect(document.querySelector(".fp-foot")).toHaveTextContent(/^Source: SEC Form 13F-HR filings/);
    });

    it("Holdings: key figures, the Holdings panel, Annual returns, then Positions, and nothing else", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const panel = screen.getByRole("tabpanel");
      expect(within(panel).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Holdings", "Annual returns", "Positions"]);
      const inOrder = [region("Key figures"), region("Holdings"), region("Annual returns"), region("Positions")];
      inOrder.slice(1).forEach((el, i) => {
        expect(inOrder[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, `section ${i + 1} follows section ${i}`).toBeTruthy();
      });
      expect(screen.queryByRole("heading", { name: /^Return constituents/ })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Assets under management" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "About" })).toBeNull();
    });

    it("Analysis: key figures, Assets under management, Return constituents and What if, top to bottom", async () => {
      stubData();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(screen.getByRole("tab", { name: "Analysis" })).toHaveAttribute("aria-selected", "true");
      const heading = (name: string | RegExp) => screen.getByRole("heading", { name });
      const inOrder = [region("Key figures"), heading("Assets under management"), heading(/^Return constituents /), heading("What if they'd kept it")];
      inOrder.slice(1).forEach((el, i) => {
        expect(inOrder[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING, `section ${i + 1} follows section ${i}`).toBeTruthy();
      });
      for (const name of ["Assets under management", "Return constituents 2025", "What if they'd kept it"]) expect(region(name)).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Positions" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Annual returns" })).toBeNull();
      expect(document.querySelector(".fp-foot")).toBeInTheDocument();
    });

    it("About: the About panel, and nothing else", async () => {
      stubData();
      renderFund(FUND, null, "#about");
      await loaded("Kelpwood Capital LP");
      expect(screen.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
      expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["About"]);
      expect(screen.queryByRole("heading", { name: "Assets under management" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Annual returns" })).toBeNull();
      expect(document.querySelector(".fp-foot")).toBeInTheDocument();
    });

    it("a click on a tab opens it and puts it in the URL's hash; the page's shared state survives the trip", async () => {
      stubData();
      const user = userEvent.setup();
      let hash = "";
      function Spy() {
        hash = useLocation().hash;
        return null;
      }
      renderFund(FUND, <Spy />);
      await loaded("Kelpwood Capital LP");
      await user.click(bar("2023"));
      // the Holdings period picked survives a trip to another tab too
      await user.click(screen.getByRole("button", { name: "Year" }));
      await openTab(user, "Analysis");
      expect(hash).toBe("#analysis");
      expect(drovTitle("2023")).toBeInTheDocument(); // the year picked on Holdings' Annual returns
      expect(screen.queryByRole("heading", { name: "Annual returns" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Positions" })).toBeNull();
      await openTab(user, "About");
      expect(hash).toBe("#about");
      expect(region("About")).toBeInTheDocument();
      await openTab(user, "Holdings");
      expect(hash).toBe("#holdings");
      expect(region("Positions")).toBeInTheDocument();
      expect(pressedBars()).toEqual(["2023"]);
      expect(screen.getByRole("button", { name: "Year" })).toHaveAttribute("aria-pressed", "true");
      await openTab(user, "Analysis");
      expect(drovTitle("2023")).toBeInTheDocument();
    });

    it("header: the filing line, the book, and the positions count from positions.json", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const meta = document.querySelector(".fh .meta") as HTMLElement;
      expect(meta).toHaveTextContent("$24.0B reported book");
      expect(meta).toHaveTextContent("10 holdings now, 22 positions ever"); // 22 positions in positions.json
      expect(meta).toHaveTextContent("Updated 11 Aug 2026 · Q2 filing");
      expect(screen.getByRole("tab", { name: /^Holdings\s*10$/ })).toBeInTheDocument(); // the count of holdings now, as in the line above
    });

    it("key figures: four tiles on Holdings and four on Analysis; the first two of each follow the Annual returns bracket", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(tileLabels()).toEqual(["Annualised return", "Max drawdown", "Turnover per year", "Average hold length"]);
      expect(kpiCaption()).toBe(holdingsCaption("2014 to 2026 H1"));
      await openTab(user, "Analysis");
      expect(tileLabels()).toEqual(["Years positive", "Volatility", "Risk-adjusted return", "Positions profitable"]);
      expect(kpiCaption()).toBe(analysisCaption("2014 to 2026 H1"));
    });

    it("Annual returns draws a bar for each year and selects the latest full year (R14)", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(bars()).toHaveLength(13);
      expect(pressedBars()).toEqual(["2025"]); // not 2026 H1: a part year
      expect(within(region("Annual returns")).getByRole("button", { name: "15 years" })).toHaveAttribute("aria-pressed", "true");
    });

    it("the default year of a fund that stopped filing is its last full year", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis(INACTIVE_FUND);
      await loaded("Cobblereef Holdings");
      expect(drovTitle("2023")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(/filed nothing in the latest two quarters/i);
      await openTab(user, "Holdings");
      expect(pressedBars()).toEqual(["2023"]);
    });

    it("Return constituents names the selected year and draws its stocks, with company names tidied", async () => {
      stubData();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      const drive = region("Return constituents 2025");
      expect(within(drive).getByRole("group", { name: "Contribution to return by stock, percentage points, as a waterfall" })).toBeInTheDocument();
      expect(drive.querySelector(".headline")).toHaveTextContent(/Exxon Mobil added 6\.9 points/); // XOM, "EXXON MOBIL CORP" in securities.json
    });

    it("Assets under management shows the book at the end of the last year", async () => {
      stubData();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(region("Assets under management")).toHaveTextContent("Book at the end of 2026 H1$24.0B");
    });

    it("Positions shows the holdings of the newest quarter at the latest prices, with names tidied", async () => {
      stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const panel = region("Positions");
      expect(panel).toHaveTextContent("Positions and prices as of 30 Oct 2026"); // latest_prices.json asof
      const table = within(panel).getByRole("table", { name: "Positions" });
      expect(within(table).getAllByRole("row")).toHaveLength(11); // header + the 10 holdings
      expect(within(table).getByText("Home Depot")).toBeInTheDocument(); // "HOME DEPOT INC" in securities.json
    });

    it("What if they'd kept it lists each of the 22 sales", async () => {
      stubData();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(within(region("What if they'd kept it")).getAllByRole("row")).toHaveLength(23);
    });

    it("asks for the fund's files, the three shared files and (on Analysis) the sector files, each once, and for nothing else", async () => {
      const urls = stubData();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      const base = "/demo-data";
      const expected = [
        "funds.json",
        "securities.json",
        "latest_prices.json",
        `fund/${FUND}/summary.json`,
        `fund/${FUND}/positions.json`,
        `fund/${FUND}/contrib.json`,
        `fund/${FUND}/exits.json`,
        // the sector panels: the fund's file, then the map's peers (funds.json is already loaded)
        `fund/${FUND}/skill.json`,
        "sectors/scores.json",
        "home/top_max.json",
      ].map((p) => `${base}/${p}`);
      await screen.findByRole("heading", { name: "Which decisions made the gap" }, { timeout: 3000 }); // the panels, not their skeletons
      expect([...urls].sort()).toEqual([...expected].sort());
    });

    it("on Holdings it also asks for the weekly files of the stocks it holds now (the tree map's colours), each once", async () => {
      const urls = stubData();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const held = demo<Summary>(`fund/${FUND}/summary.json`).holdings_now.stock_id;
      await waitFor(() => expect(urls.filter((u) => u.includes("/stock/")).length).toBe(held.length));
      const weekly = urls.filter((u) => u.includes("/stock/"));
      expect(new Set(weekly).size).toBe(weekly.length);
      expect(weekly.map((u) => Number(/stock\/(\d+)\//.exec(u)![1])).sort((a, b) => a - b)).toEqual([...held].sort((a, b) => a - b));
    });

    it("the latest prices reach the positions, the what-if and the profitable share", async () => {
      const lp = demo<LatestPrices>("latest_prices.json");
      stubData({ "latest_prices.json": { ...lp, price: lp.price.map(() => 1) } }); // every stock at $1
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      const column = (table: HTMLElement, header: string) => {
        const at = within(table).getAllByRole("columnheader").findIndex((h) => h.textContent === header);
        expect(at, header).toBeGreaterThanOrEqual(0);
        return Array.from(table.querySelectorAll("tbody tr")).map((r) => r.querySelectorAll("td")[at]?.textContent);
      };
      const held = column(within(region("Positions")).getByRole("table", { name: "Positions" }), "Price");
      expect(held).toHaveLength(10);
      expect(held.every((p) => p === "$1")).toBe(true);
      await user.click(screen.getByRole("tab", { name: "Analysis" }));
      const sales = column(within(region("What if they'd kept it")).getByRole("table", { name: "Sold or trimmed stocks" }), "Price");
      expect(sales).toHaveLength(22);
      expect(sales.every((p) => p === "$1")).toBe(true);
      const positions = positionRows(demo<Positions>(`fund/${FUND}/positions.json`));
      const prices = new Map(lp.stock_id.map((id) => [id, 1] as [number, number]));
      const share = profitablePct(positions, prices) as number;
      expect(tileValue("Positions profitable")).toBe(`${Math.round(share * 100)}%`);
      expect(tileValue("Positions profitable")).not.toBe("59%"); // the share at the demo's own prices
    });
  });

  describe("key figures", () => {
    it("Holdings shows the bracket's return and drawdown, then turnover and hold length; Analysis the bracket's years positive and volatility, then the risk ratios and profitable share", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(tileLabels()).toEqual(["Annualised return", "Max drawdown", "Turnover per year", "Average hold length"]);
      expect(kpiCaption()).toBe(holdingsCaption("2014 to 2026 H1"));
      expect(tileValue("Turnover per year")).toBe("49%");
      expect(tileValue("Average hold length")).toBe("7.8 yrs");
      expect(tileSub("Average hold length")).toBe("sold positions only: 6.3 yrs");
      await openTab(user, "Analysis");
      expect(tileLabels()).toEqual(["Years positive", "Volatility", "Risk-adjusted return", "Positions profitable"]);
      expect(kpiCaption()).toBe(analysisCaption("2014 to 2026 H1"));
      expect(ratioValue("Sharpe")).toBe("0.30");
      expect(ratioValue("Sortino")).toBe("0.58");
      expect(ratioValue("Calmar")).toBe("0.28");
      expect(tileValue("Positions profitable")).toBe("59%"); // 13 of 22 positions have a positive total at the latest prices
      // the old "More figures" section is gone
      expect(screen.queryByRole("heading", { name: "More figures" })).toBeNull();
    });

    it("the demo fund Halyard Point Partners reads Sharpe −0.01, Sortino −0.01, Calmar 0.02, turnover 40%, hold 8.0 yrs", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis(OTHER_FUND);
      await loaded("Halyard Point Partners");
      expect(analysisWhole().slice(0, 3)).toEqual(["−0.01", "−0.01", "0.02"]);
      const positions = positionRows(demo<Positions>(`fund/${OTHER_FUND}/positions.json`));
      const share = profitablePct(positions, priceMap(demo<LatestPrices>("latest_prices.json"))) as number;
      expect(tileValue("Positions profitable")).toBe(`${Math.round(share * 100)}%`);
      expect(tileValue("Positions profitable")).toBe("50%");
      await openTab(user, "Holdings");
      expect(holdingsWhole()).toEqual(["40%", "8.0 yrs"]);
      expect(tileSub("Average hold length")).toBe("sold positions only: 6.9 yrs");
    });

    it("the whole-period tiles do not follow the Annual returns bracket", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      const analysisBefore = analysisWhole();
      const years = tileValue("Years positive");
      await openTab(user, "Holdings");
      const holdingsBefore = holdingsWhole();
      const first = tileValue("Annualised return");
      fireEvent.keyDown(handle("End of the annualised return span"), { key: "ArrowLeft" });
      fireEvent.keyDown(handle("End of the annualised return span"), { key: "ArrowLeft" });
      expect(kpiSpan()).toBe("2014 to 2024");
      expect(tileValue("Annualised return")).not.toBe(first);
      expect(holdingsWhole()).toEqual(holdingsBefore);
      await openTab(user, "Analysis");
      expect(kpiSpan()).toBe("2014 to 2024"); // Analysis' span tiles follow the bracket set on Holdings
      expect(tileValue("Years positive")).not.toBe(years);
      expect(analysisWhole()).toEqual(analysisBefore);
    });

    it("reads – where a metric is null, and nothing prints NaN, undefined or null anywhere on the page", async () => {
      stubData({ ...summaryWith(nullMetrics), [`fund/${FUND}/positions.json`]: noPositions });
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(analysisWhole()).toEqual(["–", "–", "–", "–"]);
      expect(tile("Positions profitable").querySelector(".kpi-bar")).toBeNull();
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
      // the years still draw, and the default year is the latest full one
      expect(drovTitle("2025")).toBeInTheDocument();
      await openTab(user, "Holdings");
      expect(holdingsWhole()).toEqual(["–", "–"]);
      expect(tileSub("Average hold length")).toBe("sold positions only: –");
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
    });

    it("shows a dash for the profitable share when no position has a computable total", async () => {
      stubData({ [`fund/${FUND}/positions.json`]: noPositions });
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(tileValue("Positions profitable")).toBe("–");
      expect(tile("Positions profitable").querySelector(".kpi-bar")).toBeNull();
      expect(ratioValue("Sharpe")).toBe("0.30");
      expect(screen.getByRole("tab", { name: /^Holdings\s*10$/ })).toBeInTheDocument(); // from summary.json, not from the positions list
    });
  });

  describe("a fund with nothing to chart", () => {
    it("without a year the page still draws, with no selected year and no stray values", async () => {
      stubData(
        summaryWith(noYears),
      );
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(screen.getByRole("heading", { name: "Return constituents" })).toBeInTheDocument();
      expect(kpiCaption()).toBe("No year with a return yet.");
      expect(["Years positive", "Volatility"].map(tileValue)).toEqual(["–", "–"]);
      expect(analysisWhole()).toEqual(["0.30", "0.58", "0.28", "59%"]); // the whole period needs no year
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
      expect(region("What if they'd kept it")).toBeInTheDocument(); // the lower sections do not depend on the years
      await openTab(user, "Holdings");
      expect(within(region("Annual returns")).getByText("No annual returns yet")).toBeInTheDocument();
      expect(bars()).toHaveLength(0);
      expect(kpiCaption()).toBe("No year with a return yet.");
      expect(["Annualised return", "Max drawdown"].map(tileValue)).toEqual(["–", "–"]);
      expect(holdingsWhole()).toEqual(["49%", "7.8 yrs"]);
      expect(region("Positions")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
    });

    it("with no year that has a return, the years are named but no bar is drawn", async () => {
      stubData(
        summaryWith((s) => {
          s.years.ret = s.years.ret.map(() => null);
        }),
      );
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(within(region("Annual returns")).getByText("No annual returns yet")).toBeInTheDocument();
      expect(bars()).toHaveLength(0);
      expect(kpiCaption()).toBe("No year with a return yet.");
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
      await openTab(user, "Analysis");
      expect(kpiCaption()).toBe("No year with a return yet.");
      expect(drovTitle("2025")).toBeInTheDocument(); // the default year does not need a return (R14)
      expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
    });
  });

  describe("state shared by the panels", () => {
    it("clicking a year bar in Annual returns changes the Return constituents title to that year", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      expect(drovTitle("2025")).toBeInTheDocument();
      await openTab(user, "Holdings");
      await user.click(bar("2023"));
      expect(pressedBars()).toEqual(["2023"]);
      await openTab(user, "Analysis");
      expect(drovTitle("2023")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Return constituents 2025" })).toBeNull();
      expect(handle("Start of the period")).toHaveAttribute("aria-valuetext", "2023");
      expect(handle("End of the period")).toHaveAttribute("aria-valuetext", "2023");
    });

    it("a bar is selected from the keyboard too", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      act(() => bar("2019").focus());
      await user.keyboard("{Enter}");
      expect(pressedBars()).toEqual(["2019"]);
      await openTab(user, "Analysis");
      expect(drovTitle("2019")).toBeInTheDocument();
    });

    it("selecting a bar resets the Return constituents period to that single year", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      // widen the period to 2024 to 2025 with the left handle of the strip
      fireEvent.keyDown(handle("Start of the period"), { key: "ArrowLeft" });
      expect(drovTitle("2024 to 2025")).toBeInTheDocument();
      await openTab(user, "Holdings");
      expect(pressedBars()).toEqual(["2025"]); // the selected year is still 2025

      await user.click(bar("2023"));
      await openTab(user, "Analysis");
      expect(drovTitle("2023")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /^Return constituents 2024/ })).toBeNull();
      expect(handle("Start of the period")).toHaveAttribute("aria-valuetext", "2023");
      expect(handle("End of the period")).toHaveAttribute("aria-valuetext", "2023");
    });

    it("selecting the already selected bar still resets a widened period", async () => {
      stubData();
      const user = userEvent.setup();
      renderAnalysis();
      await loaded("Kelpwood Capital LP");
      fireEvent.keyDown(handle("End of the period"), { key: "ArrowRight" });
      expect(drovTitle("2025 to 2026 H1")).toBeInTheDocument();
      await openTab(user, "Holdings");
      await user.click(bar("2025"));
      await openTab(user, "Analysis");
      expect(drovTitle("2025")).toBeInTheDocument();
    });

    it("the bracket of Annual returns sets the years the key figures describe, on both tabs", async () => {
      stubData();
      const user = userEvent.setup();
      renderFund();
      await loaded("Kelpwood Capital LP");
      expect(kpiCaption()).toBe(holdingsCaption("2014 to 2026 H1"));
      const before = within(region("Key figures")).getAllByRole("article")[0].textContent;
      fireEvent.keyDown(handle("Start of the annualised return span"), { key: "ArrowRight" });
      expect(kpiCaption()).toBe(holdingsCaption("2015 to 2026 H1"));
      fireEvent.keyDown(handle("End of the annualised return span"), { key: "ArrowLeft" });
      expect(kpiCaption()).toBe(holdingsCaption("2015 to 2025"));
      expect(within(region("Key figures")).getAllByRole("article")[0].textContent).not.toBe(before);
      await openTab(user, "Analysis");
      expect(kpiCaption()).toBe(analysisCaption("2015 to 2025"));
      // the bracket does not move the year selected for Return constituents
      expect(drovTitle("2025")).toBeInTheDocument();
    });

    describe("the window of years (15 years / Max)", () => {
      const seg = (name: string) => within(region("Annual returns")).getByRole("button", { name });

      it("the 15-year window leaves the oldest years out and Max brings them back", async () => {
        stubData(summaryWith(longHistory));
        const user = userEvent.setup();
        renderFund();
        await loaded("Kelpwood Capital LP");
        expect(bars()).toHaveLength(15);
        expect(kpiSpan()).toBe("2012 to 2026 H1");
        await user.click(seg("Max"));
        expect(bars()).toHaveLength(21);
        expect(kpiSpan()).toBe("2006 to 2026 H1");
        await openTab(user, "Analysis");
        expect(kpiSpan()).toBe("2006 to 2026 H1"); // the window picked on Holdings holds on Analysis too
      });

      it("a selected year still in the new window stays selected", async () => {
        stubData(summaryWith(longHistory));
        const user = userEvent.setup();
        renderFund();
        await loaded("Kelpwood Capital LP");
        await user.click(bar("2023"));
        await user.click(seg("Max"));
        expect(pressedBars()).toEqual(["2023"]);
        await openTab(user, "Analysis");
        expect(drovTitle("2023")).toBeInTheDocument();
        await openTab(user, "Holdings");
        await user.click(seg("15 years"));
        expect(pressedBars()).toEqual(["2023"]);
        await openTab(user, "Analysis");
        expect(drovTitle("2023")).toBeInTheDocument();
      });

      it("a selected year the window drops falls back to the latest full year in it", async () => {
        stubData(summaryWith(longHistory));
        const user = userEvent.setup();
        renderFund();
        await loaded("Kelpwood Capital LP");
        await user.click(seg("Max"));
        await user.click(bar("2007")); // only in Max
        expect(pressedBars()).toEqual(["2007"]);
        await openTab(user, "Analysis");
        expect(drovTitle("2007")).toBeInTheDocument();

        await openTab(user, "Holdings");
        await user.click(seg("15 years"));
        expect(pressedBars()).toEqual(["2025"]); // a valid year again: the latest full one, not the part year 2026 H1
        await openTab(user, "Analysis");
        expect(drovTitle("2025")).toBeInTheDocument();
        expect(handle("Start of the period")).toHaveAttribute("aria-valuetext", "2025");
        expect(handle("End of the period")).toHaveAttribute("aria-valuetext", "2025");
      });

      it("the Return constituents period survives a change of window when its years are still in it", async () => {
        stubData(summaryWith(longHistory));
        const user = userEvent.setup();
        renderAnalysis();
        await loaded("Kelpwood Capital LP");
        fireEvent.keyDown(handle("Start of the period"), { key: "ArrowLeft" });
        expect(drovTitle("2024 to 2025")).toBeInTheDocument();
        await openTab(user, "Holdings");
        await user.click(seg("Max"));
        expect(pressedBars()).toEqual(["2025"]);
        await openTab(user, "Analysis");
        expect(drovTitle("2024 to 2025")).toBeInTheDocument();
      });
    });

    describe("one fund per key", () => {
      it("moving to another fund starts again: its own default year, the 15-year window and the whole bracket", async () => {
        stubData();
        const user = userEvent.setup();
        renderFund(FUND, <Link to={`/fund/${OTHER_FUND}#analysis`}>Other fund</Link>);
        await loaded("Kelpwood Capital LP");
        await user.click(bar("2023"));
        await user.click(within(region("Annual returns")).getByRole("button", { name: "Max" }));
        fireEvent.keyDown(handle("Start of the annualised return span"), { key: "ArrowRight" });
        expect(kpiSpan()).toBe("2015 to 2026 H1");
        await openTab(user, "Analysis");
        expect(drovTitle("2023")).toBeInTheDocument();

        await user.click(screen.getByRole("link", { name: "Other fund" }));
        await loaded("Halyard Point Partners");
        expect(drovTitle("2025")).toBeInTheDocument(); // not the 2023 picked on the other fund, which this one also has
        expect(kpiCaption()).toBe(analysisCaption("2014 to 2026 H1"));
        await openTab(user, "Holdings");
        expect(pressedBars()).toEqual(["2025"]);
        expect(within(region("Annual returns")).getByRole("button", { name: "15 years" })).toHaveAttribute("aria-pressed", "true");
        expect(kpiCaption()).toBe(holdingsCaption("2014 to 2026 H1"));
        await waitFor(() => expect(document.title).toBe(fundTitle("Halyard Point Partners")));
      });

      it("moving to a fund that is not found drops the fund that was on screen", async () => {
        stubData();
        const user = userEvent.setup();
        renderAnalysis(FUND, <Link to="/fund/424242">Unknown fund</Link>);
        await loaded("Kelpwood Capital LP");
        await user.click(screen.getByRole("link", { name: "Unknown fund" }));
        expect(await notFound()).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Annual returns" })).toBeNull();
      });
    });
  });
});
