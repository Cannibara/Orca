import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { TooltipProvider } from "../src/charts/Tooltip";
import type { Summary } from "../src/data/types";
import { FundHeader } from "../src/fund/FundHeader";
import { slots } from "../src/fund/geometry";
import { KpiStrip } from "../src/fund/KpiStrip";
import { ReturnsPanel } from "../src/fund/ReturnsPanel";
import { buildSeries, windowYears, type Range } from "../src/fund/series";
import type { Span } from "../src/fund/span";

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/clientY.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", { value: PointerEventShim, configurable: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-motion");
});

const here = dirname(fileURLToPath(import.meta.url));
const demo: Summary = JSON.parse(readFileSync(resolve(here, "../public/demo-data/fund/9100002/summary.json"), "utf8"));
const copy = (mutate: (s: Summary) => void): Summary => {
  const s = structuredClone(demo);
  mutate(s);
  return s;
};

// ---------------------------------------------------------------------- FundHeader

describe("FundHeader", () => {
  test("the h1 is the fund's name and nothing else", () => {
    render(<FundHeader summary={demo} positionsEver={18} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Halyard Point Partners$/);
  });

  test("line under it: reported book, holdings now and ever, and the filing pill", () => {
    const { container } = render(<FundHeader summary={demo} positionsEver={18} />);
    const meta = container.querySelector(".meta") as HTMLElement;
    expect(meta).toHaveTextContent("$11.1B reported book");
    expect(meta).toHaveTextContent("9 holdings now, 18 positions ever");
    expect(within(meta).getByText("Updated 31 Jul 2026 · Q2 filing")).toBeInTheDocument();
    expect(container.querySelector(".pill .dot.live")).not.toBeNull();
  });

  test("the quarter in the pill is the quarter of the year of the latest filing", () => {
    render(<FundHeader summary={copy((s) => ((s.period_q = 52), (s.filed = "2026-05-12")))} positionsEver={18} />);
    expect(screen.getByText("Updated 12 May 2026 · Q1 filing")).toBeInTheDocument();
  });

  test("singular forms", () => {
    const { container } = render(<FundHeader summary={copy((s) => (s.n_holdings = 1))} positionsEver={1} />);
    expect(container.querySelector(".meta")).toHaveTextContent("1 holding now, 1 position ever");
  });

  test.each([
    [0.75, "75% of book priced"],
    [0.57, "57% of book priced"], // 0.57 * 100 is 56.99999999999999
    [0.799, "79% of book priced"], // never rounds up to a "80%" warning
  ])("coverage warning below 80%% (priced_pct %s)", (priced, text) => {
    render(<FundHeader summary={copy((s) => (s.priced_pct = priced))} positionsEver={18} />);
    const badge = screen.getByText(text);
    expect(badge).toHaveClass("badge");
    expect(badge).toHaveAttribute("title", expect.stringContaining("no price"));
  });

  test("no warning at 80% and above", () => {
    render(<FundHeader summary={copy((s) => (s.priced_pct = 0.8))} positionsEver={18} />);
    expect(screen.queryByText(/of book priced/)).toBeNull();
  });

  test("an inactive fund says its figures stop at its last filing", () => {
    const { rerender } = render(<FundHeader summary={copy((s) => (s.inactive = true))} positionsEver={18} />);
    expect(
      screen.getByText("This fund filed nothing in the latest two quarters, so these figures stop at its last filing."),
    ).toBeInTheDocument();
    rerender(<FundHeader summary={demo} positionsEver={18} />);
    expect(screen.queryByText(/filed nothing/)).toBeNull();
  });

  test("Overview and Positions tabs: no others; Positions scrolls to its panel, Overview to the top", async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const scrollIntoView = vi.fn();
    const panel = document.createElement("section");
    panel.id = "posPanel";
    panel.scrollIntoView = scrollIntoView;
    document.body.appendChild(panel);
    const user = userEvent.setup();
    render(<FundHeader summary={demo} positionsEver={18} />);
    const list = screen.getByRole("tablist", { name: "Fund sections" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("data-view"))).toEqual(["overview", "positions"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveTextContent("Positions18");

    await user.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));

    await user.click(tabs[0]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    panel.remove();
  });

  test("arrow keys move between the tabs and open them", async () => {
    vi.stubGlobal("scrollTo", vi.fn());
    const user = userEvent.setup();
    render(<FundHeader summary={demo} positionsEver={18} />);
    const [overview, positions] = screen.getAllByRole("tab");
    act(() => overview.focus());
    await user.keyboard("{ArrowRight}");
    expect(positions).toHaveFocus();
    expect(positions).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(overview).toHaveFocus();
    expect(overview).toHaveAttribute("aria-selected", "true");
  });
});

// ---------------------------------------------------------------------- KpiStrip

const series = buildSeries(demo);
const win15 = windowYears(series, "15");

const tiles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".kpi")).map((k) => ({
    label: k.querySelector(".kpi-l")?.textContent,
    value: k.querySelector(".kpi-v")?.textContent,
    note: k.querySelector(".kpi-n")?.textContent,
  }));

describe("KpiStrip", () => {
  test("the whole window: the figures of the artifact", () => {
    const { container } = render(<KpiStrip series={series} win={win15} br={null} />);
    expect(tiles(container)).toEqual([
      { label: "Annualised return", value: "+0.6%", note: "Growth of $1: $1.07" },
      { label: "Years positive", value: "6 of 11", note: "55% of quarters positive" },
      { label: "Max drawdown", value: "−29.7%", note: "Peak to trough, quarterly" },
      { label: "Volatility", value: "16.1%", note: "Annualised" },
    ]);
    expect(container.querySelector(".kpi-cap")).toHaveTextContent("Tiles follow the Annual returns bracket: 2014 to 2026 H1.");
    expect(container.querySelector(".kpi-cap b")).toHaveTextContent("2014 to 2026 H1");
    expect(screen.getByRole("region", { name: "Key figures" })).toBeInTheDocument();
  });

  test("the whole window equals the figures the pipeline published", () => {
    const { container } = render(<KpiStrip series={series} win={win15} br={null} />);
    const m = demo.metrics;
    const t = tiles(container);
    expect(t[0].value).toBe((m.ann_return! >= 0 ? "+" : "−") + (Math.abs(m.ann_return!) * 100).toFixed(1) + "%");
    expect(t[1].note).toBe(Math.round(m.quarters_pos_pct! * 100) + "% of quarters positive");
    expect(t[2].value).toBe("−" + (Math.abs(m.max_dd!) * 100).toFixed(1) + "%");
    expect(t[3].value).toBe((m.vol! * 100).toFixed(1) + "%");
  });

  test("a bracket narrows the figures to its years", () => {
    const { container } = render(<KpiStrip series={series} win={win15} br={{ a: "2016", b: "2023" }} />);
    expect(tiles(container)).toEqual([
      { label: "Annualised return", value: "+6.2%", note: "Growth of $1: $1.62" },
      { label: "Years positive", value: "5 of 8", note: "63% of quarters positive" },
      { label: "Max drawdown", value: "−23.3%", note: "Peak to trough, quarterly" },
      { label: "Volatility", value: "16.7%", note: "Annualised" },
    ]);
    expect(container.querySelector(".kpi-cap b")).toHaveTextContent("2016 to 2023");
  });

  test("a bracket that no longer fits the window falls back to the whole window", () => {
    const { container } = render(<KpiStrip series={series} win={win15} br={{ a: "1999", b: "2023" }} />);
    expect(container.querySelector(".kpi-cap b")).toHaveTextContent("2014 to 2026 H1");
  });

  test("each tile has a picture of its span", () => {
    const { container } = render(<KpiStrip series={series} win={win15} br={{ a: "2016", b: "2023" }} />);
    const sparks = Array.from(container.querySelectorAll(".kpi-s svg"));
    expect(sparks).toHaveLength(4);
    expect(sparks[0].querySelector("path.spk-line")).not.toBeNull();
    expect(sparks[0].querySelector("circle.spk-dot")).not.toBeNull();
    // 5 gains and 3 losses among the 8 full years
    expect(sparks[1].querySelectorAll("rect.spk-gain")).toHaveLength(5);
    expect(sparks[1].querySelectorAll("rect.spk-loss")).toHaveLength(3);
    expect(sparks[2].querySelector("path.spk-area-loss")).not.toBeNull();
    // one bar per year in the span, the biggest dark
    expect(sparks[3].querySelectorAll("rect.spk-neutral")).toHaveLength(8);
    expect(sparks[3].querySelectorAll("rect.spk-neutral.hi")).toHaveLength(1);
    sparks.forEach((s) => expect(s).toHaveAttribute("aria-hidden", "true"));
  });

  test("under four quarters there is no annualised return and no volatility", () => {
    const part = copy((s) => {
      const k = s.years.label.length - 1;
      for (const key of Object.keys(s.years) as (keyof typeof s.years)[]) s.years[key] = [s.years[key][k]] as never;
      const keep = s.quarters.q.map((q) => q >= 52);
      for (const key of Object.keys(s.quarters) as (keyof typeof s.quarters)[]) {
        s.quarters[key] = (s.quarters[key] as unknown[]).filter((_, i) => keep[i]) as never;
      }
    });
    const ser = buildSeries(part);
    const { container } = render(<KpiStrip series={ser} win={windowYears(ser, "15")} br={null} />);
    const t = tiles(container);
    expect(t[0].value).toBe("–");
    expect(t[3].value).toBe("–");
    expect(t[1].value).toBe("0 of 0");
    expect(t[2].value).toMatch(/%$/);
  });

  test("no year with a return: every tile is a dash", () => {
    const { container } = render(<KpiStrip series={series} win={{ years: [], offset: 0, total: 0 }} br={null} />);
    expect(tiles(container).map((t) => t.value)).toEqual(["–", "–", "–", "–"]);
  });
});

// ---------------------------------------------------------------------- ReturnsPanel

type HostProps = {
  summary?: Summary;
  initialBr?: Span | null;
  onSelect?: (label: string) => void;
  onBr?: (span: Span) => void;
  onRange?: (r: Range) => void;
};

/** The panel with its page state, the way Fund.tsx holds it. */
function Host({ summary = demo, initialBr = null, onSelect, onBr, onRange }: HostProps) {
  const ser = buildSeries(summary);
  const [range, setRange] = useState<Range>("15");
  const [sel, setSel] = useState<string | null>("2025");
  const [br, setBr] = useState<Span | null>(initialBr);
  const win = windowYears(ser, range);
  return (
    <TooltipProvider>
      <KpiStrip series={ser} win={win} br={br} />
      <ReturnsPanel
        series={ser}
        win={win}
        range={range}
        onRange={(r) => {
          setRange(r);
          onRange?.(r);
        }}
        sel={sel}
        onSelect={(l) => {
          setSel(l);
          onSelect?.(l);
        }}
        br={br}
        onBr={(s) => {
          setBr(s);
          onBr?.(s);
        }}
      />
    </TooltipProvider>
  );
}

const hits = () => Array.from(document.querySelectorAll<SVGRectElement>("#retPanel rect.hit"));
const handle = (d: "a" | "b") => document.querySelector(`#retPanel polygon.brk-h[data-d="${d}"]`) as SVGPolygonElement;
const pillText = () => document.querySelector("#retPanel .brk-t")?.textContent;
const tipEl = () => document.getElementById("tip") as HTMLElement;
const focus = (el: HTMLElement | SVGElement) => act(() => el.focus());
const blur = (el: HTMLElement | SVGElement) => act(() => el.blur());
// the width jsdom gives useWidth (nothing can be measured): 600
const G = slots(600, 13, 46);

describe("ReturnsPanel", () => {
  test("header: title, subtitle with the full years, years seg, numbers button", () => {
    render(<Host />);
    const panel = screen.getByRole("region", { name: "Annual returns" });
    expect(within(panel).getByText("Estimated, full years 2015 to 2025. Part years are shown but not counted.")).toBeInTheDocument();
    const seg = within(panel).getByRole("group", { name: "Years shown" });
    expect(within(seg).getByRole("button", { name: "15 years" })).toHaveAttribute("aria-pressed", "true");
    expect(within(seg).getByRole("button", { name: "Max" })).toHaveAttribute("aria-pressed", "false");
    expect(within(panel).getByRole("button", { name: "Show the numbers" })).toBeInTheDocument();
  });

  test("one button per year with its return, direction and part-year note; the selected one is pressed", () => {
    render(<Host />);
    const hs = hits();
    expect(hs).toHaveLength(13);
    expect(hs.map((h) => h.getAttribute("aria-label"))).toEqual([
      "2014: −20.9%, loss, part year",
      "2015: −9.5%, loss",
      "2016: +11.0%, gain",
      "2017: −7.2%, loss",
      "2018: +22.5%, gain",
      "2019: +30.2%, gain",
      "2020: +11.5%, gain",
      "2021: −7.2%, loss",
      "2022: −16.4%, loss",
      "2023: +13.9%, gain",
      "2024: +14.5%, gain",
      "2025: −2.9%, loss",
      "2026 H1: −16.7%, loss, part year",
    ]);
    expect(hs.filter((h) => h.getAttribute("aria-pressed") === "true").map((h) => h.getAttribute("aria-label"))).toEqual(["2025: −2.9%, loss"]);
    hs.forEach((h) => expect(h).toHaveAttribute("role", "button"));
  });

  test("draws one gain or loss bar per year, % labels, and the selected year's band and pill", () => {
    render(<Host />);
    const svg = document.querySelector("#retPanel svg.viz.c1") as SVGSVGElement;
    expect(svg).toHaveAttribute("role", "group");
    expect(svg.querySelectorAll("path.bar.gain")).toHaveLength(6);
    expect(svg.querySelectorAll("path.bar.loss")).toHaveLength(7);
    const labels = Array.from(svg.querySelectorAll("text.blab")).map((t) => t.textContent);
    // the jsdom chart is 600 px wide: 13 bars fit whole-percent labels, not one decimal
    expect(labels).toContain("+30");
    expect(labels).toContain("−17");
    expect(svg.querySelector("text.blab.sel")?.textContent).toBe("−3");
    expect(svg.querySelectorAll("rect.selband")).toHaveLength(1);
    expect(svg.querySelector("rect.selpill")).not.toBeNull();
    expect(svg.querySelector("text.clab.sel")?.textContent).toBe("’25");
    // y axis from 520 px wide: percent ticks
    expect(Array.from(svg.querySelectorAll("text.tick")).map((t) => t.textContent)).toContain("+40%");
    // each bar carries its place in the grow-in
    expect((svg.querySelector("path.bar") as SVGElement).style.getPropertyValue("--i")).toBe("0");
    expect(svg.style.getPropertyValue("--step")).toMatch(/ms$/);
  });

  test("the bracket shows the annualised return of its span and follows the tiles", () => {
    render(<Host />);
    expect(pillText()).toBe("+0.6% a year");
    expect(handle("a")).toHaveAttribute("aria-label", "Start of the annualised return span");
    expect(handle("a")).toHaveAttribute("aria-valuetext", "2014");
    expect(handle("b")).toHaveAttribute("aria-label", "End of the annualised return span");
    expect(handle("b")).toHaveAttribute("aria-valuetext", "2026 H1");
    expect(handle("b")).toHaveAttribute("aria-valuenow", "12");
    expect(handle("b")).toHaveAttribute("role", "slider");
  });

  test("arrow keys on a handle move that end; shift moves both; the tiles follow", async () => {
    const onBr = vi.fn();
    const user = userEvent.setup();
    render(<Host onBr={onBr} />);
    focus(handle("b"));
    await user.keyboard("{ArrowLeft}");
    expect(onBr).toHaveBeenLastCalledWith({ a: "2014", b: "2025" });
    expect(handle("b")).toHaveAttribute("aria-valuetext", "2025");
    expect(handle("b")).toHaveFocus();
    expect(document.querySelector(".kpi-cap b")).toHaveTextContent("2014 to 2025");
    await user.keyboard("{ArrowRight}");
    expect(onBr).toHaveBeenLastCalledWith({ a: "2014", b: "2026 H1" });

    focus(handle("a"));
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(onBr).toHaveBeenLastCalledWith({ a: "2016", b: "2026 H1" });
    expect(pillText()).toBe("+3.9% a year");
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(onBr).toHaveBeenLastCalledWith({ a: "2015", b: "2025" });
    // the ends keep one bar between them
    for (let i = 0; i < 12; i++) await user.keyboard("{ArrowRight}");
    expect(handle("a")).toHaveAttribute("aria-valuenow", "10");
  });

  test("dragging an end, and the pill, moves the bracket by bars", () => {
    const onBr = vi.fn();
    render(<Host onBr={onBr} />);
    const svg = document.querySelector("#retPanel svg.viz.c1") as SVGSVGElement;
    const at = (i: number) => G.ml + G.band * i + G.band / 2;

    fireEvent.pointerDown(handle("b"), { clientX: at(12), clientY: 20, pointerId: 7 });
    expect(svg).toHaveClass("drag");
    fireEvent.pointerMove(svg, { clientX: at(9), clientY: 20, pointerId: 7 });
    expect(onBr).toHaveBeenLastCalledWith({ a: "2014", b: "2023" });
    expect(pillText()).toBe("+1.5% a year");
    fireEvent.pointerMove(svg, { clientX: at(9) + 3, clientY: 20, pointerId: 7 }); // same bar: no new call
    expect(onBr).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(svg, { clientX: at(0), clientY: 20, pointerId: 7 }); // cannot cross the other end
    expect(onBr).toHaveBeenLastCalledWith({ a: "2014", b: "2015" });
    fireEvent.pointerUp(svg, { pointerId: 7 });
    expect(svg).not.toHaveClass("drag");
    fireEvent.pointerMove(svg, { clientX: at(5), clientY: 20, pointerId: 7 }); // no longer dragging
    expect(onBr).toHaveBeenCalledTimes(2);

    // a different pointer is ignored
    fireEvent.pointerDown(handle("a"), { clientX: at(0), clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: at(1), clientY: 20, pointerId: 2 });
    expect(onBr).toHaveBeenCalledTimes(2);
    fireEvent.pointerCancel(svg, { pointerId: 1 });

    // move the whole bracket by dragging the pill
    const pill = document.querySelector("#retPanel rect.brk-pill") as SVGRectElement;
    fireEvent.pointerDown(pill, { clientX: at(1), clientY: 16, pointerId: 3 });
    fireEvent.pointerMove(svg, { clientX: at(3), clientY: 16, pointerId: 3 });
    expect(onBr).toHaveBeenLastCalledWith({ a: "2016", b: "2017" });
    fireEvent.pointerUp(svg, { pointerId: 3 });
  });

  test("a drag hides the tooltip and does not show it again until the pointer is over a bar", () => {
    render(<Host />);
    const svg = document.querySelector("#retPanel svg.viz.c1") as SVGSVGElement;
    fireEvent.pointerEnter(hits()[3], { clientX: 100, clientY: 100 });
    expect(tipEl()).toBeVisible();
    fireEvent.pointerDown(handle("b"), { clientX: 500, clientY: 20, pointerId: 4 });
    expect(tipEl()).not.toBeVisible();
    fireEvent.pointerMove(hits()[3], { clientX: 100, clientY: 100, pointerId: 4 });
    expect(tipEl()).not.toBeVisible();
    fireEvent.pointerUp(svg, { pointerId: 4 });
  });

  test("hovering a bar shows the year's drawdown, volatility and quarters by the cursor", () => {
    render(<Host />);
    fireEvent.pointerEnter(hits()[3], { clientX: 100, clientY: 120 });
    const tip = tipEl();
    expect(tip).toBeVisible();
    expect(tip.querySelector(".t")).toHaveTextContent("2017");
    expect(tip.querySelector(".tag")).toBeNull();
    const rows = Array.from(tip.querySelectorAll(".v")).map((r) => r.textContent);
    expect(rows).toEqual(["Max drawdown−10.0%", "Volatility15.1%", "Q1−9.6%", "Q2+6.3%", "Q3−6.3%", "Q4+3.1%"]);
    const swatches = Array.from(tip.querySelectorAll<HTMLElement>(".v i")).map((i) => i.style.background);
    expect(swatches).toEqual(["var(--loss)", "var(--gain)", "var(--loss)", "var(--gain)"]);
    // 14 px right of and below the pointer
    expect(tip.style.left).toBe("114px");
    expect(tip.style.top).toBe("134px");
    // the hover band follows
    expect(document.querySelector("#retPanel rect.hovband")).toHaveClass("on");
    expect(document.querySelector("#retPanel rect.hovband")).toHaveAttribute("x", String(G.ml + G.band * 3));

    fireEvent.pointerMove(hits()[3], { clientX: 130, clientY: 140 });
    expect(tip.style.left).toBe("144px");
    fireEvent.pointerLeave(hits()[3]);
    expect(tip).not.toBeVisible();
    expect(document.querySelector("#retPanel rect.hovband")).not.toHaveClass("on");
  });

  test("a part year's tooltip carries the Part year tag and only the quarters it has", () => {
    render(<Host />);
    fireEvent.pointerEnter(hits()[12], { clientX: 300, clientY: 120 });
    const tip = tipEl();
    expect(tip.querySelector(".t")).toHaveTextContent("2026 H1");
    expect(tip.querySelector(".t .tag")).toHaveTextContent("Part year");
    expect(Array.from(tip.querySelectorAll(".v")).map((r) => r.textContent)).toEqual([
      "Max drawdown−16.7%",
      "Volatility–",
      "Q1−6.3%",
      "Q2−11.1%",
    ]);
  });

  test("clicking a bar selects the year, and the tooltip stays by the cursor after the redraw", async () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    const h = hits()[5];
    fireEvent.pointerEnter(h, { clientX: 250, clientY: 150 });
    fireEvent.click(h, { detail: 1, clientX: 250, clientY: 150 });
    expect(onSelect).toHaveBeenCalledWith("2019");
    expect(hits()[5]).toHaveAttribute("aria-pressed", "true");
    expect(hits()[11]).toHaveAttribute("aria-pressed", "false");
    expect(tipEl()).toBeVisible();
    expect(tipEl().style.left).toBe("264px");
    expect(tipEl().style.top).toBe("164px");
    expect(document.querySelector("#retPanel text.clab.sel")?.textContent).toBe("’19");
  });

  test("keyboard: arrows, Home and End move between bars, Enter and Space select; focus puts the tooltip on the bar", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Host onSelect={onSelect} />);
    focus(hits()[2]);
    await user.keyboard("{ArrowRight}");
    expect(hits()[3]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(hits()[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(hits()[12]).toHaveFocus();
    await user.keyboard("{ArrowRight}"); // nothing further
    expect(hits()[12]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(hits()[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("2014");
    await user.keyboard("{ArrowRight} ");
    expect(onSelect).toHaveBeenLastCalledWith("2015");
    expect(hits()[1]).toHaveFocus(); // the focus stays on the bar after the redraw
    expect(tipEl()).toBeVisible();
    expect(tipEl().querySelector(".t")).toHaveTextContent("2015");
    blur(hits()[1]);
    expect(tipEl()).not.toBeVisible();
  });

  test("Show the numbers swaps the chart for an accessible table and back", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const panel = screen.getByRole("region", { name: "Annual returns" });
    const btn = within(panel).getByRole("button", { name: "Show the numbers" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await user.click(btn);
    expect(document.querySelector("#retPanel svg.viz")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Show the chart" })).toHaveAttribute("aria-pressed", "true");
    const table = within(panel).getByRole("table", { name: "Estimated annual return by year" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Year",
      "Return",
      "Direction",
      "In annual figures",
      "Book at year end",
    ]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(14);
    const cells = (r: HTMLElement) => within(r).getAllByRole("cell").map((c) => c.textContent);
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent("2014 Part year");
    expect(cells(rows[1])).toEqual(["−20.9%", "Loss", "Not counted", "$1.50B"]);
    expect(within(rows[3]).getByRole("rowheader")).toHaveTextContent(/^2016$/);
    expect(cells(rows[3])).toEqual(["+11.0%", "Gain", "Counted", "$2.52B"]);
    expect(cells(rows[13])).toEqual(["−16.7%", "Loss", "Not counted", "$11.1B"]);
    // the selected year's row is marked
    expect(rows[12]).toHaveAttribute("aria-current", "true");
    expect(rows[12]).toHaveClass("is-sel");
    expect(rows[11]).not.toHaveAttribute("aria-current");

    await user.click(within(panel).getByRole("button", { name: "Show the chart" }));
    expect(within(panel).queryByRole("table")).toBeNull();
    expect(document.querySelector("#retPanel svg.viz")).not.toBeNull();
  });

  test("the years seg reports a change of range", async () => {
    const onRange = vi.fn();
    const user = userEvent.setup();
    render(<Host onRange={onRange} />);
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(onRange).toHaveBeenCalledWith("max");
    expect(screen.getByRole("button", { name: "Max" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "15 years" }));
    expect(onRange).toHaveBeenLastCalledWith("15");
  });

  test("a long history: the 15-year window draws 15 bars and Max all of them", async () => {
    const long = copy((s) => {
      // 20 years: prepend seven copies of the 2015.. years, relabelled 2008..2014 on top of the existing labels
      const labels = Array.from({ length: 20 }, (_, i) => String(2006 + i)).concat("2026 H1");
      const n = labels.length;
      const rep = <T,>(v: T[]): T[] => Array.from({ length: n }, (_, i) => v[Math.min(v.length - 1, Math.max(0, i - (n - v.length)))]);
      for (const key of Object.keys(s.years) as (keyof typeof s.years)[]) {
        s.years[key] = (key === "label" ? labels : rep(s.years[key] as unknown[])) as never;
      }
    });
    const user = userEvent.setup();
    render(<Host summary={long} />);
    expect(hits()).toHaveLength(15);
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(hits()).toHaveLength(21);
  });

  test("a bracket given as labels that are not drawn falls back to the whole window", () => {
    render(<Host initialBr={{ a: "1990", b: "2023" }} />);
    expect(handle("a")).toHaveAttribute("aria-valuetext", "2014");
    expect(handle("b")).toHaveAttribute("aria-valuetext", "2026 H1");
  });

  test("years without a return are not drawn", () => {
    const gap = copy((s) => {
      s.years.ret[3] = null; // 2017
    });
    render(<Host summary={gap} />);
    const labels = hits().map((h) => h.getAttribute("aria-label")?.split(":")[0]);
    expect(labels).not.toContain("2017");
    expect(labels).toHaveLength(12);
  });

  test("a fund with no year that has a return shows an empty state and no numbers button", () => {
    const none = copy((s) => {
      s.years.ret = s.years.ret.map(() => null);
    });
    render(<Host summary={none} />);
    expect(screen.getByText("No annual returns yet")).toBeInTheDocument();
    expect(document.querySelector("#retPanel svg.viz")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the numbers" })).toBeNull();
    expect(screen.getByText("Estimated. Part years are shown but not counted.")).toBeInTheDocument();
  });

  test("a single year draws no bracket", () => {
    const one = copy((s) => {
      s.years.ret = s.years.ret.map((r, i) => (i === 5 ? r : null));
    });
    render(<Host summary={one} />);
    expect(hits()).toHaveLength(1);
    expect(document.querySelector("#retPanel .brk-t")).toBeNull();
  });

  test("a narrow chart words the pill short", () => {
    const wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    try {
      render(<Host />);
      expect(pillText()).toBe("+0.6% a yr");
      expect(document.querySelector("#retPanel svg.viz")).toHaveAttribute("width", "400");
    } finally {
      if (wide) Object.defineProperty(HTMLElement.prototype, "clientWidth", wide);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });
});

// ---------------------------------------------------------------------- grow-in

describe("ReturnsPanel grow-in", () => {
  class IOStub {
    static all: IOStub[] = [];
    disconnected = false;
    constructor(private cb: IntersectionObserverCallback) {
      IOStub.all.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    fire() {
      act(() => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
  }
  const svgClass = () => document.querySelector("#retPanel svg.viz")?.getAttribute("class");
  const live = () => IOStub.all.filter((o) => !o.disconnected);
  beforeEach(() => {
    IOStub.all = [];
  });

  test("hidden until seen, grows once, and no interaction replays it", async () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    const user = userEvent.setup();
    render(<Host />);
    expect(svgClass()).toBe("viz c1 pre");
    live()[0].fire();
    expect(svgClass()).toBe("viz c1 run");
    // a click selects and ends the run: the bars are final and stay so
    await user.click(hits()[4]);
    expect(svgClass()).toBe("viz c1");
    await user.click(hits()[6]);
    focus(handle("b"));
    await user.keyboard("{ArrowLeft}");
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(svgClass()).toBe("viz c1");
    expect(live()).toHaveLength(0);
  });

  test("changing the range ends a run in progress", async () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    const user = userEvent.setup();
    render(<Host />);
    live()[0].fire();
    expect(svgClass()).toBe("viz c1 run");
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(svgClass()).toBe("viz c1");
  });

  test("a drag keeps the grow-in going; the bracket group fades in with the late class", () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    render(<Host />);
    expect(document.querySelector("#retPanel g.late.brkg")).not.toBeNull();
    live()[0].fire();
    const svg = document.querySelector("#retPanel svg.viz.c1") as SVGSVGElement;
    fireEvent.pointerDown(handle("b"), { clientX: 500, clientY: 20, pointerId: 1 });
    expect(svg).toHaveClass("run");
    fireEvent.pointerUp(svg, { pointerId: 1 });
  });

  test("without motion the chart is simply there", () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    document.documentElement.setAttribute("data-motion", "reduce");
    render(<Host />);
    expect(svgClass()).toBe("viz c1");
  });
});
