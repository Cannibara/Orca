import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { TooltipProvider } from "../src/charts/Tooltip";
import type { Stock } from "../src/data/api";
import type { Contrib, Securities, Summary } from "../src/data/types";
import { DrivePanel } from "../src/fund/DrivePanel";
import { buildSeries, windowYears } from "../src/fund/series";
import type { Span } from "../src/fund/span";

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/clientY.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventShim extends MouseEvent {}
    Object.defineProperty(window, "PointerEvent", { value: PointerEventShim, configurable: true });
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const read = <T,>(p: string): T => JSON.parse(readFileSync(resolve(here, "../public/demo-data", p), "utf8")) as T;
const summary = read<Summary>("fund/9100002/summary.json");
const contrib = read<Contrib>("fund/9100002/contrib.json");
const sec = read<Securities>("securities.json");
const stocks = new Map<number, Stock>(sec.stock_id.map((id, i) => [id, { ticker: sec.ticker[i], name: sec.name[i] }]));
const series = buildSeries(summary);
const win = windowYears(series, "15");

type Over = { sel?: string | null; cr?: Span | null; contrib?: Contrib; onCr?: (s: Span) => void };

/** The panel with its period kept in state, as the page does. */
function Host({ sel = "2025", cr: cr0 = null, contrib: c = contrib, onCr }: Over) {
  const [cr, setCr] = useState<Span | null>(cr0);
  return (
    <TooltipProvider>
      <DrivePanel
        series={series}
        win={win}
        contrib={c}
        stocks={stocks}
        sel={sel}
        cr={cr}
        onCr={(s) => {
          onCr?.(s);
          setCr(s);
        }}
      />
    </TooltipProvider>
  );
}

const panel = () => document.getElementById("drvPanel") as HTMLElement;
const tip = () => document.getElementById("tip") as HTMLElement;
const hits = () => Array.from(panel().querySelectorAll<SVGElement>("svg.wf .hit"));
const handle = (d: "a" | "b") => panel().querySelector<SVGElement>(`.scr-h[data-d="${d}"]`) as SVGElement;

describe("DrivePanel", () => {
  test("title, subtitle, stepper, strip and the one-line headline for the selected year", () => {
    render(<Host />);
    expect(screen.getByRole("heading", { name: "Return Constituents 2025" })).toBeInTheDocument();
    expect(screen.queryByText(/Contribution to return, percentage points/)).toBeNull(); // no explanation under the title
    const stepper = screen.getByRole("group", { name: "Period" });
    expect(stepper.querySelector("output")).toHaveTextContent("2025");
    const head = panel().querySelector(".headline") as HTMLElement;
    expect(head.querySelector("b")).toHaveTextContent("2025");
    expect(head.querySelector(".hmeta")).toHaveTextContent("1 year, 4 quarters");
    expect(head).toHaveTextContent(/added 1\.5 points, but .* took away 5\.3\./);
    // the strip covers every year of the window, the period is the 2025 slot
    expect(panel().querySelectorAll(".sc-hit")).toHaveLength(win.years.length);
    expect(handle("a")).toHaveAttribute("aria-valuenow", "11");
    expect(handle("b")).toHaveAttribute("aria-valuenow", "11");
  });

  test("the waterfall names the biggest stocks, groups the rest and ends with the total", () => {
    render(<Host />);
    const svg = panel().querySelector("svg.wf") as SVGElement;
    expect(svg).toHaveAttribute("aria-label", "Contribution to return by stock, percentage points, as a waterfall");
    const names = hits().map((h) => h.getAttribute("aria-label"));
    expect(names).toHaveLength(6); // 4 named + "Other" + total at the jsdom fallback width
    expect(names[0]).toMatch(/^ALPHABET INC \(GOOGL\): \+1\.46 percentage points$/);
    expect(names[names.length - 2]).toMatch(/^Other stocks, 6 smaller contributors: /);
    expect(names[names.length - 1]).toBe("Total of listed stocks: −2.76 percentage points");
    expect(Array.from(svg.querySelectorAll("text.rl-t")).map((t) => t.textContent)).toEqual(["GOOGL", "NVDA", "META", "GE", "Other", "Total"]);
    expect(svg.querySelectorAll("line.conn")).toHaveLength(5);
    expect(svg.querySelectorAll("path.bar")).toHaveLength(6);
    expect(svg.querySelectorAll("path.bar.tot")).toHaveLength(1);
  });

  test("the stepper moves the whole period by a year and stops at the ends", () => {
    const onCr = vi.fn();
    render(<Host sel="2025" onCr={onCr} />);
    fireEvent.click(screen.getByRole("button", { name: "Earlier period" }));
    expect(onCr).toHaveBeenLastCalledWith({ a: "2024", b: "2024" });
    expect(screen.getByRole("heading", { name: "Return Constituents 2024" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Later period" }));
    fireEvent.click(screen.getByRole("button", { name: "Later period" }));
    expect(onCr).toHaveBeenLastCalledWith({ a: "2026 H1", b: "2026 H1" });
    expect(screen.getByRole("button", { name: "Later period" })).toBeDisabled();
  });

  test("a multi-year period sums the years; the stepper keeps its length", () => {
    const onCr = vi.fn();
    render(<Host sel="2025" cr={{ a: "2020", b: "2022" }} onCr={onCr} />);
    expect(screen.getByRole("heading", { name: "Return Constituents 2020 to 2022" })).toBeInTheDocument();
    expect(panel().querySelector(".stepper output")).toHaveTextContent("2020 to 2022");
    expect(panel().querySelector(".hmeta")).toHaveTextContent("3 years, 12 quarters");
    expect(hits()[hits().length - 1].getAttribute("aria-label")).toMatch(/^Total of listed stocks: −17\.\d\d percentage points$/);
    fireEvent.click(screen.getByRole("button", { name: "Later period" }));
    expect(onCr).toHaveBeenLastCalledWith({ a: "2021", b: "2023" });
    fireEvent.click(screen.getByRole("button", { name: "Earlier period" }));
    fireEvent.click(screen.getByRole("button", { name: "Earlier period" }));
    expect(onCr).toHaveBeenLastCalledWith({ a: "2019", b: "2021" });
  });

  test("arrow keys on a strip handle widen the period and keep the focus", () => {
    const onCr = vi.fn();
    render(<Host sel="2025" onCr={onCr} />);
    const b = handle("b");
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowRight" });
    expect(onCr).toHaveBeenLastCalledWith({ a: "2025", b: "2026 H1" });
    expect(screen.getByRole("heading", { name: "Return Constituents 2025 to 2026 H1" })).toBeInTheDocument();
    expect(document.activeElement).toBe(handle("b"));
    fireEvent.keyDown(handle("a"), { key: "ArrowLeft" });
    expect(onCr).toHaveBeenLastCalledWith({ a: "2024", b: "2026 H1" });
  });

  test("clicking a year in the strip moves the nearest edge", () => {
    const onCr = vi.fn();
    render(<Host sel="2025" cr={{ a: "2020", b: "2022" }} onCr={onCr} />);
    fireEvent.click(panel().querySelector('.sc-hit[data-s="9"]') as Element); // 2023, right of the period
    expect(onCr).toHaveBeenLastCalledWith({ a: "2020", b: "2023" });
    fireEvent.click(panel().querySelector('.sc-hit[data-s="0"]') as Element); // 2014, left of it
    expect(onCr).toHaveBeenLastCalledWith({ a: "2014", b: "2023" });
  });

  test("an unset or stale period falls back to the selected year", () => {
    render(<Host sel="2023" cr={{ a: "1999", b: "2001" }} />);
    expect(screen.getByRole("heading", { name: "Return Constituents 2023" })).toBeInTheDocument();
  });

  test("Show the numbers swaps the chart for an accessible table with a Total row", () => {
    render(<Host sel="2025" cr={{ a: "2020", b: "2022" }} />);
    const btn = screen.getByRole("button", { name: "Show the numbers" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(panel().querySelector("svg.wf")).toBeNull();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Contribution to return, 2020 to 2022, percentage points")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Ticker", "Company", "Points"]);
    const rows = within(table).getAllByRole("row").slice(1);
    const last = rows[rows.length - 1];
    expect(within(last).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Sum of listed", expect.stringMatching(/^−17\.\d\d$/)]);
    expect(within(last).getByRole("rowheader")).toHaveTextContent("Total");
    // biggest contribution first
    const pts = rows.slice(0, -1).map((r) => Number((r.lastChild?.textContent ?? "").replace("−", "-")));
    expect([...pts].sort((x, y) => y - x)).toEqual(pts);
    const back = screen.getByRole("button", { name: "Show the chart" });
    expect(back).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(back);
    expect(panel().querySelector("svg.wf")).not.toBeNull();
  });

  test("a fund with thousands of stocks prints the biggest 200 and a Show all button", () => {
    const n = 3000;
    const big: Contrib = {
      years: ["2025"],
      by_year: { "2025": { stock_id: Array.from({ length: n }, (_, i) => 5000 + i), points: Array.from({ length: n }, (_, i) => 3 - i * 0.002), pnl: Array(n).fill(0) } },
    };
    render(<Host sel="2025" contrib={big} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the numbers" }));
    const table = screen.getByRole("table");
    // 200 stocks, the line for the other 2800, and the total
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 200 + 1 + 1);
    expect(within(table).getByText("2800 smaller contributors")).toBeInTheDocument();
    expect(within(table).getByText("#5000")).toBeInTheDocument(); // not in securities: shown as #id
    fireEvent.click(screen.getByRole("button", { name: "Show all 3000" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + n + 1);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  test("a year without contributions is the empty state", () => {
    const none: Contrib = { years: [], by_year: {} };
    render(<Host sel="2025" contrib={none} />);
    expect(screen.getByRole("heading", { name: "No stock-level detail for 2025" })).toBeInTheDocument();
    expect(screen.getByText("Orca needs two consecutive filings to attribute a period.")).toBeInTheDocument();
    expect(panel().querySelector("svg.wf")).toBeNull();
    expect(panel().querySelector(".headline")).toHaveTextContent("");
    // the strip and stepper still work
    expect(screen.getByRole("button", { name: "Earlier period" })).toBeEnabled();
  });

  test("a fund with no years still renders its panel", () => {
    render(
      <TooltipProvider>
        <DrivePanel series={series} win={{ years: [], offset: 0, total: 0 }} contrib={contrib} stocks={stocks} sel={null} cr={null} onCr={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("heading", { name: "Return Constituents" })).toBeInTheDocument();
    expect(screen.getByText("Orca needs two consecutive filings to attribute a period.")).toBeInTheDocument();
  });

  test("hovering a bar shows the tooltip by the cursor and a band; leaving hides it", () => {
    render(<Host sel="2025" cr={{ a: "2020", b: "2022" }} />);
    const h = hits();
    fireEvent.pointerMove(h[0], { clientX: 120, clientY: 90 });
    expect(tip()).not.toHaveAttribute("hidden");
    expect(tip()).toHaveTextContent(/\+\d+\.\d\d points/);
    expect(tip()).toHaveTextContent(/in 2020 to 2022$/);
    expect(panel().querySelector(".hovband")).toHaveClass("on");
    fireEvent.pointerMove(h[h.length - 1], { clientX: 400, clientY: 90 });
    expect(tip()).toHaveTextContent("Total of listed stocks");
    expect(tip()).toHaveTextContent("The sum of every contribution in 2020 to 2022");
    fireEvent.pointerLeave(h[h.length - 1]);
    expect(tip()).toHaveAttribute("hidden");
    expect(panel().querySelector(".hovband")).not.toHaveClass("on");
  });

  test("arrow keys move the focus between bars", () => {
    render(<Host />);
    const h = hits();
    act(() => h[0].focus());
    fireEvent.keyDown(h[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(h[1]);
    fireEvent.keyDown(h[1], { key: "End" });
    expect(document.activeElement).toBe(h[h.length - 1]);
    fireEvent.keyDown(h[h.length - 1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(h[h.length - 1]);
    fireEvent.keyDown(h[h.length - 1], { key: "Home" });
    expect(document.activeElement).toBe(h[0]);
  });

  test("a period chosen elsewhere fades the chart in; one made in the panel does not", () => {
    const { rerender } = render(
      <TooltipProvider>
        <DrivePanel series={series} win={win} contrib={contrib} stocks={stocks} sel="2025" cr={null} onCr={() => {}} />
      </TooltipProvider>,
    );
    const host = panel().querySelector(".chart") as HTMLElement;
    expect(host).not.toHaveClass("swap");
    rerender(
      <TooltipProvider>
        <DrivePanel series={series} win={win} contrib={contrib} stocks={stocks} sel="2022" cr={{ a: "2022", b: "2022" }} onCr={() => {}} />
      </TooltipProvider>,
    );
    expect(host).toHaveClass("swap");
  });

  test("the chart stays put while the period changes inside the panel", () => {
    render(<Host />);
    const host = panel().querySelector(".chart") as HTMLElement;
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Earlier period" }));
    });
    expect(host).not.toHaveClass("swap");
    expect(host.querySelector("svg")?.getAttribute("class")).toBe("viz wf c3"); // no grow-in class in jsdom
  });
});
