import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/charts/Tooltip";
import { clearDataCache } from "../src/data/api";
import type { Skill } from "../src/data/types";
import Fund from "../src/pages/Fund";

// The Analysis tab's sector choice vs stock choice panels on the demo data (spec 2026-11-21 §5).
const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");
const demo = <T,>(path: string): T => JSON.parse(readFileSync(join(DEMO, path), "utf8")) as T;
const MISSING = Symbol("missing");
const NOT_JSON = Symbol("not json");
const FUND = 9100001;

function stubData(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/^\/demo-data\//, "");
      const o = overrides[path];
      if (o === MISSING || (!(path in overrides) && !existsSync(join(DEMO, path)))) return { ok: false, status: 404, json: async () => ({}) };
      if (o === NOT_JSON) return { ok: true, status: 200, json: async () => JSON.parse("<!doctype html>") };
      return { ok: true, status: 200, json: async () => (path in overrides ? o : demo<unknown>(path)) };
    }),
  );
}

function renderAnalysis(id = FUND) {
  return render(
    <MemoryRouter initialEntries={[`/fund/${id}#analysis`]}>
      <TooltipProvider>
        <Routes>
          <Route path="/fund/:id" element={<Fund />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const panel = (title: string | RegExp) => screen.getByRole("heading", { level: 3, name: title }).closest("section") as HTMLElement;
/** Wait for the panels themselves (the loading skeletons carry the map's and the stacked graph's titles). */
const ready = () => screen.findByRole("heading", { name: "Which decisions made the gap" }, { timeout: 3000 });
const h3s = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

beforeEach(() => clearDataCache());
afterEach(() => vi.unstubAllGlobals());

describe("the sector panels on Analysis", () => {
  it("come in the spec's order around the existing panels", async () => {
    stubData();
    renderAnalysis();
    await ready();
    const order = h3s();
    const at = (t: string) => order.findIndex((x) => x?.startsWith(t));
    expect(at("What kind of investor?")).toBe(0);
    expect(at("Annual return stacked graph")).toBeLessThan(at("Sector mix over time"));
    expect(at("Sector mix over time")).toBeLessThan(at("Which decisions made the gap"));
    expect(at("Which decisions made the gap")).toBeLessThan(at("Assets under management"));
    expect(document.body.textContent).not.toMatch(/vertical/i);
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("are absent for a fund without a sector file, and for a host that answers it with a web page", async () => {
    for (const body of [MISSING, NOT_JSON]) {
      clearDataCache();
      stubData({ [`fund/${FUND}/skill.json`]: body });
      const r = renderAnalysis();
      await screen.findByRole("heading", { name: "Assets under management" });
      await waitFor(() => expect(screen.queryByRole("heading", { name: "What kind of investor?" })).toBeNull());
      expect(screen.queryByRole("heading", { name: "Annual return stacked graph" })).toBeNull();
      r.unmount();
    }
  });

  it("judge choices at industry level by default, and the switch renames every panel", async () => {
    stubData();
    renderAnalysis();
    await ready();
    const stacked = panel("Annual return stacked graph");
    expect(within(stacked).getByText(/^Industry choice, /)).toBeTruthy();
    expect(within(panel("Which decisions made the gap")).getByRole("button", { name: "Stocks vs their industry" })).toBeTruthy();
    fireEvent.click(within(panel("What kind of investor?")).getByRole("button", { name: "Sub-industry" }));
    expect(within(stacked).getByText(/^Sub-industry choice, /)).toBeTruthy();
    expect(within(panel("Which decisions made the gap")).getByRole("button", { name: "Sub-industries vs market" })).toBeTruthy();
    expect(screen.getByText(/Some sub-industries have few stocks/)).toBeTruthy();
  });

  it("stacked graph: one bar per year, a table view, and Lines with the S&P 500", async () => {
    stubData();
    renderAnalysis();
    await ready();
    const p = panel("Annual return stacked graph");
    const years = demo<Skill>(`fund/${FUND}/skill.json`).years.name;
    expect(p.querySelectorAll(".hit")).toHaveLength(years.length);
    expect(p.querySelector(".hit")!.getAttribute("aria-label")).toMatch(/^2014: whole market [+−]\d+\.\d%, industry choice [+−]?\d+\.\d pts, stock choice/);
    fireEvent.click(within(p).getByRole("button", { name: "Table view" }));
    expect(within(p).getAllByRole("row")).toHaveLength(years.length + 1);
    fireEvent.click(within(p).getByRole("button", { name: "Chart view" }));
    fireEvent.click(within(p).getByRole("button", { name: "Lines" }));
    expect(within(p).getByText("S&P 500")).toBeTruthy();
    expect(within(p).getByText("Their industries")).toBeTruthy();
    expect(p.querySelectorAll("path.ln")).toHaveLength(4);
  });

  it("mix: three levels, chips that pick a sector out, and the big switches listed", async () => {
    stubData();
    renderAnalysis();
    await ready();
    const p = panel("Sector mix over time");
    fireEvent.click(within(p).getByRole("button", { name: "Industry" }));
    expect(screen.getByRole("heading", { name: "Industry mix over time" })).toBeTruthy();
    const chip = within(p).getAllByRole("button", { pressed: false }).find((b) => b.classList.contains("chip"))!;
    fireEvent.click(chip);
    expect(within(p).getByText(/picked out, tap again to clear/)).toBeTruthy();
    expect(p.querySelectorAll(".rot li").length).toBeGreaterThan(0);
  });

  it("decisions: stocks by what they added, then the industries against the market with a total", async () => {
    stubData();
    renderAnalysis();
    await ready();
    const p = panel("Which decisions made the gap");
    expect(within(p).getByText(/biggest picks beat their own industry/)).toBeTruthy();
    expect(within(p).getByText("All picks")).toBeTruthy();
    fireEvent.click(within(p).getByRole("button", { name: "Industries vs market" }));
    expect(within(p).getByText("All industries")).toBeTruthy();
    expect(within(p).getByText(/of their money went to/)).toBeTruthy();
  });

  it("the map says too early to tell for a fund with too few picks", async () => {
    const s = demo<Skill>(`fund/${FUND}/skill.json`);
    for (const t of ["1", "2", "3"] as const) s.tiers[t].n = 5;
    stubData({ [`fund/${FUND}/skill.json`]: s });
    renderAnalysis();
    await ready();
    expect(within(panel("What kind of investor?")).getByText(/needs 3 years of trades and 20 picks/)).toBeTruthy();
    // the switch still drives the other panels
    expect(within(panel("What kind of investor?")).getByRole("button", { name: "Sector" })).toBeTruthy();
  });
});
