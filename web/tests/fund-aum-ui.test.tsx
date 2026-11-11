import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "../src/charts/Tooltip";
import type { Metrics } from "../src/data/types";
import { AumPanel } from "../src/fund/AumPanel";
import type { Series, Win, YearPoint } from "../src/fund/series";

const B = 1e9;

function yp(label: string, start: number, inflows: number, gains: number, over: Partial<YearPoint> = {}): YearPoint {
  return { label, part: false, year: parseInt(label, 10), ret: 0, start, end: start + inflows + gains, gains, inflows, qCount: 4, ...over };
}

// The demo fund's shape: a first year from nothing, losses and outflows in places, a part year at the end.
const years: YearPoint[] = [
  yp("2014", 0, 1.879 * B, -0.384 * B, { part: true, qCount: 3 }),
  yp("2015", 1.495 * B, 0.404 * B, -0.198 * B),
  yp("2016", 1.701 * B, 0.624 * B, 0.193 * B),
  yp("2017", 2.518 * B, 0.424 * B, -0.214 * B),
  yp("2018", 2.728 * B, -0.214 * B, 0.533 * B),
  yp("2025", 10.264 * B, 1.099 * B, -0.471 * B),
  yp("2026 H1", 10.891 * B, 2.343 * B, -2.093 * B, { part: true, qCount: 2 }),
];
const series: Series = { years, quarters: [], metrics: {} as Metrics, periodQ: 53, trackedSinceQ: 4 };
const win = (ys: YearPoint[] = years, offset = 0): Win => ({ years: ys, offset, total: ys.length + offset });

function mount(w: Win = win()) {
  const ui = (ww: Win) => (
    <TooltipProvider>
      <AumPanel series={series} win={ww} />
    </TooltipProvider>
  );
  const r = render(ui(w));
  return { ...r, again: (ww: Win) => r.rerender(ui(ww)) };
}

const tipEl = () => document.getElementById("tip") as HTMLElement;
const svgEl = () => document.querySelector("svg.viz") as SVGSVGElement;
const hits = () => Array.from(document.querySelectorAll<SVGRectElement>("svg.viz .hit"));

type Getter = { configurable: true; get: (this: HTMLElement) => number };
function stubProto(name: "clientWidth", get: Getter["get"]) {
  const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
  const holder = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ? HTMLElement.prototype : Element.prototype;
  Object.defineProperty(holder, name, { configurable: true, get });
  return () => {
    if (orig) Object.defineProperty(holder, name, orig);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-motion");
});

describe("AumPanel: head, stats, legend", () => {
  test("names the panel, with no explanation under the title", () => {
    mount();
    const section = screen.getByRole("region", { name: "Assets under management" });
    expect(section).toHaveAttribute("id", "flowPanel");
    expect(within(section).getByRole("heading", { level: 3, name: "Assets under management" })).toBeInTheDocument();
    expect(section).not.toHaveTextContent("Each bar is last year's book");
    expect(section).not.toHaveTextContent(/billions/i);
  });

  test("three stats: the end book, then net flows and gains over the span of the window", () => {
    const { container } = mount();
    const stats = Array.from(container.querySelectorAll(".stats .stat")).map((s) => s.textContent);
    expect(stats).toEqual([
      "Book at the end of 2026 H1$11.1B",
      "Net inflows, 2014 to 2026 H1+$6.56B", // 1.879+.404+.624+.424-.214+1.099+2.343
      "Losses, 2014 to 2026 H1−$2.63B", // -.384-.198+.193-.214+.533-.471-2.093
    ]);
    expect(container.querySelector(".stats")).toHaveAttribute("aria-live", "polite");
  });

  test("the words follow the signs: outflows, gains, and a single year is not a span", () => {
    const { container } = mount(win([yp("2022", 4 * B, -0.5 * B, 0.3 * B)]));
    const stats = Array.from(container.querySelectorAll(".stats .stat")).map((s) => s.textContent);
    expect(stats).toEqual(["Book at the end of 2022$3.80B", "Net outflows, 2022−$500M", "Gains, 2022+$300M"]);
  });

  test("the stats follow the window passed in", () => {
    const { container } = mount(win(years.slice(2, 4), 2));
    const stats = Array.from(container.querySelectorAll(".stats .stat span")).map((s) => s.textContent);
    expect(stats).toEqual(["Book at the end of 2017", "Net inflows, 2016 to 2017", "Losses, 2016 to 2017"]);
  });

  test("the legend lists inflows, gains, losses and outflows", () => {
    const { container } = mount();
    const items = Array.from(container.querySelectorAll(".legend .lg")).map((l) => l.textContent);
    expect(items).toEqual(["Net inflows", "Gains", "Losses", "Net outflows"]);
    expect(container.querySelector(".legend i.flow")).toBeInTheDocument();
    expect(container.querySelector(".legend i.rml")).toBeInTheDocument();
    expect(container.querySelector(".legend i.out")).toBeInTheDocument();
  });

  test("a window without years says so and draws no chart", () => {
    mount(win([], 0));
    expect(screen.getByText(/No year-end book values/)).toBeInTheDocument();
    expect(svgEl()).toBeNull();
    expect(screen.queryByRole("button", { name: /Show the numbers/ })).toBeNull();
  });
});

describe("AumPanel: the chart", () => {
  test("one focusable image column per year, labelled like the artifact", () => {
    mount();
    expect(svgEl()).toHaveAttribute("role", "group");
    expect(svgEl()).toHaveAttribute("aria-label", "Assets under management at each year end.");
    const hs = hits();
    expect(hs).toHaveLength(7);
    hs.forEach((h) => {
      expect(h).toHaveAttribute("role", "img");
      expect(h).toHaveAttribute("tabindex", "0");
    });
    expect(hs[0]).toHaveAttribute("aria-label", "2014: book $0 to $1.50B; net inflows +$1.88B; gains −$384M, part year");
    expect(hs[5]).toHaveAttribute("aria-label", "2025: book $10.3B to $10.9B; net inflows +$1.10B; gains −$471M");
    expect(hs[6]).toHaveAttribute("aria-label", "2026 H1: book $10.9B to $11.1B; net inflows +$2.34B; gains −$2.09B, part year");
  });

  test("draws the bar variants, the zero line, the axis in dollars and labels on top", () => {
    const { container } = mount();
    expect(container.querySelector(".bar.corp")).toBeInTheDocument();
    expect(container.querySelector(".bar.fin")).toBeInTheDocument();
    expect(container.querySelector(".bar.gain")).toBeInTheDocument();
    expect(container.querySelector(".bar.rm-loss")).toBeInTheDocument();
    expect(container.querySelector(".bar.rm-out")).toBeInTheDocument(); // 2018: net outflow
    expect(container.querySelector("line.zero")).toBeInTheDocument();
    const ticks = Array.from(container.querySelectorAll("text.tick")).map((t) => t.textContent);
    expect(ticks[0]).toBe("$0");
    expect(ticks.every((t) => /^\$\d+(\.\d+)?B$|^\$0$/.test(t ?? ""))).toBe(true);
    const labels = Array.from(container.querySelectorAll("text.blab")).map((t) => t.textContent);
    expect(labels).toContain("$11.1B");
    expect(labels).toContain("$1.5B");
    expect(container.querySelectorAll("text.blab[aria-hidden='true']").length).toBe(labels.length);
  });

  test("the first bar is one block: the carried-over colour and nothing else", () => {
    const { container } = mount();
    const paths = Array.from(container.querySelectorAll<SVGPathElement>(".bar")).filter((p) => p.style.getPropertyValue("--i") === "0");
    expect(paths.map((p) => p.getAttribute("class"))).toEqual(["bar corp"]);
  });

  test("the hatch pattern is defined once per chart and the inflow segments use it", () => {
    const { container } = mount();
    const pattern = container.querySelector("pattern") as SVGPatternElement;
    expect(pattern.id).toMatch(/^aum-hatch-[A-Za-z0-9_-]+$/);
    const fin = container.querySelector<SVGPathElement>(".bar.fin");
    expect(fin?.style.fill).toBe(`url(#${pattern.id})`);
  });

  test("the grow-in custom properties are set: --i on every bar and label, --y0 and --step on the svg", () => {
    const { container } = mount();
    expect(svgEl().style.getPropertyValue("--y0")).toMatch(/^\d+(\.\d+)?px$/);
    expect(svgEl().style.getPropertyValue("--step")).toMatch(/^\d+(\.\d+)?ms$/);
    container.querySelectorAll<SVGElement>(".bar, .blab").forEach((el) => expect(el.style.getPropertyValue("--i")).toMatch(/^\d+$/));
  });

  test("clicking a column selects nothing: the chart is static", () => {
    mount();
    const before = svgEl().innerHTML;
    fireEvent.click(hits()[3]);
    fireEvent.keyDown(hits()[3], { key: "Enter" });
    expect(svgEl().innerHTML).toBe(before);
    expect(document.querySelector(".selband, .selpill")).toBeNull();
    expect(document.querySelector("text.blab.sel, text.clab.sel")).toBeNull();
  });

  test("responsive: the axis and horizontal labels from 520 px, rotated labels on a phone", () => {
    const restore = stubProto("clientWidth", () => 400);
    try {
      mount(win(Array.from({ length: 15 }, (_, i) => yp(String(2012 + i), (i + 1) * B, 0.3 * B, 0.1 * B))));
      expect(svgEl()).toHaveAttribute("width", "400");
      expect(svgEl()).toHaveAttribute("height", "300");
      expect(document.querySelector("text.tick")).toBeNull();
      const lab = document.querySelector("text.blab") as SVGTextElement;
      expect(lab.getAttribute("transform")).toMatch(/^rotate\(-90 /);
    } finally {
      restore();
    }
  });

  test("never narrower than 280 px", () => {
    const restore = stubProto("clientWidth", () => 120);
    try {
      mount();
      expect(svgEl()).toHaveAttribute("width", "280");
    } finally {
      restore();
    }
  });

  test("wide: full labels with the dollar sign and the axis", () => {
    const restore = stubProto("clientWidth", () => 1100);
    try {
      mount();
      expect(svgEl()).toHaveAttribute("height", "360");
      expect(document.querySelectorAll("text.tick").length).toBeGreaterThan(2);
      expect(Array.from(document.querySelectorAll("text.blab")).every((t) => (t.textContent ?? "").startsWith("$"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("AumPanel: tooltip", () => {
  test("shows the year's book, flows and gains, pinned to the top-left of the chart, and hides on leave", () => {
    const orig = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList?.contains("chart") ? ({ left: 100, top: 200, right: 700, bottom: 560, width: 600, height: 360, x: 100, y: 200, toJSON() {} } as DOMRect) : orig.call(this);
    });
    try {
      mount();
      expect(tipEl()).not.toBeVisible();
      fireEvent.pointerMove(hits()[6], { clientX: 500, clientY: 300 });
      const tip = tipEl();
      expect(tip).toBeVisible();
      expect(tip).toHaveTextContent("2026 H1");
      expect(tip).toHaveTextContent("Part year");
      const rows = Array.from(tip.querySelectorAll(".v")).map((r) => r.textContent);
      expect(rows).toEqual(["Book at start$10.9B", "Net inflows+$2.34B", "Losses−$2.09B", "Book at end$11.1B"]);
      expect(tip.querySelector(".v.sum")).toHaveTextContent("Book at end");
      // pinned: 70px in and 10px down from the chart's corner, wherever the pointer is
      expect(tip.style.left).toBe("170px");
      expect(tip.style.top).toBe("210px");
      expect(document.querySelector(".hovband")).toHaveClass("on");
      fireEvent.pointerMove(hits()[2], { clientX: 120, clientY: 500 });
      expect(tip).toHaveTextContent("2016");
      expect(tip).not.toHaveTextContent("Part year");
      expect(tip.querySelectorAll(".v")[1]).toHaveTextContent("Net inflows+$624M");
      expect(tip.querySelectorAll(".v")[2]).toHaveTextContent("Gains+$193M");
      expect(tip.style.left).toBe("170px");
      fireEvent.pointerLeave(svgEl());
      expect(tipEl()).not.toBeVisible();
      expect(document.querySelector(".hovband")).not.toHaveClass("on");
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("rows are coloured by sign: gain colour for inflows and gains, loss colour for outflows and losses", () => {
    mount();
    fireEvent.pointerMove(hits()[4]); // 2018: net outflow, gain
    const dots = Array.from(tipEl().querySelectorAll<HTMLElement>(".v i")).map((i) => i.style.background);
    expect(dots).toEqual(["var(--loss)", "var(--gain)"]);
    expect(tipEl().querySelectorAll(".v")[1]).toHaveTextContent("Net outflows−$214M");
    expect(tipEl().querySelectorAll(".v")[2]).toHaveTextContent("Gains+$533M");
  });

  test("keyboard focus shows the same tooltip, blur hides it", () => {
    mount();
    act(() => hits()[1].focus());
    expect(tipEl()).toBeVisible();
    expect(tipEl()).toHaveTextContent("2015");
    act(() => hits()[1].blur());
    expect(tipEl()).not.toBeVisible();
  });

  test("arrow keys, Home and End move focus between columns", () => {
    mount();
    const hs = hits();
    act(() => hs[0].focus());
    fireEvent.keyDown(hs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(hs[1]);
    fireEvent.keyDown(hs[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(hs[2]);
    fireEvent.keyDown(hs[2], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(hs[1]);
    fireEvent.keyDown(hs[1], { key: "End" });
    expect(document.activeElement).toBe(hs[6]);
    fireEvent.keyDown(hs[6], { key: "ArrowRight" }); // the last stays
    expect(document.activeElement).toBe(hs[6]);
    fireEvent.keyDown(hs[6], { key: "Home" });
    expect(document.activeElement).toBe(hs[0]);
    fireEvent.keyDown(hs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(hs[0]);
    expect(tipEl()).toHaveTextContent("2014");
  });

  test("Escape hides the tooltip", () => {
    mount();
    fireEvent.pointerMove(hits()[0]);
    expect(tipEl()).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tipEl()).not.toBeVisible();
  });
});

describe("AumPanel: show the numbers", () => {
  test("swaps the chart for an accessible table and back; stats and legend stay", () => {
    const { container } = mount();
    const btn = screen.getByRole("button", { name: "Show the numbers" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(svgEl()).toBeNull();
    const back = screen.getByRole("button", { name: "Show the chart" });
    expect(back).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(within(table).getByText("Book value, net inflows and gains by year")).toBeInTheDocument();
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Year", "Book at start", "Net inflows", "Gains", "Net change", "Book at end"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    // the year is the row header, the part-year ones are tagged
    const first = within(rows[0]).getByRole("rowheader");
    expect(first).toHaveTextContent("2014 Part year");
    expect(Array.from(rows[0].querySelectorAll("td")).map((c) => c.textContent)).toEqual(["$0", "+$1.88B", "−$384M", "+$1.50B", "$1.50B"]);
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent(/^2015$/);
    expect(Array.from(rows[6].querySelectorAll("td")).map((c) => c.textContent)).toEqual(["$10.9B", "+$2.34B", "−$2.09B", "+$250M", "$11.1B"]);
    expect(container.querySelector(".stats")).toBeInTheDocument();
    expect(container.querySelector(".legend")).toBeInTheDocument();
    fireEvent.click(back);
    expect(svgEl()).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Show the numbers" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("AumPanel: grow-in", () => {
  type IO = { cb: IntersectionObserverCallback; el: Element | null };
  function stubIO() {
    const all: IO[] = [];
    class Stub {
      private rec: IO;
      constructor(cb: IntersectionObserverCallback) {
        this.rec = { cb, el: null };
        all.push(this.rec);
      }
      observe(el: Element) {
        this.rec.el = el;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Stub);
    const seen = () => act(() => all.forEach((r) => r.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
    return seen;
  }

  test("bars start hidden, grow once when the chart is first seen, and a new window does not replay it", () => {
    const seen = stubIO();
    const { again } = mount();
    expect(svgEl().getAttribute("class")).toBe("viz c2 pre");
    seen();
    expect(svgEl().getAttribute("class")).toBe("viz c2 run");
    // a changed window while it runs settles the animation instead of restarting it
    again(win(years.slice(1), 1));
    expect(svgEl().getAttribute("class")).toBe("viz c2");
  });

  test("toggling to the numbers and back does not replay it", () => {
    vi.useFakeTimers();
    try {
      const seen = stubIO();
      mount();
      seen();
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(svgEl().getAttribute("class")).toBe("viz c2");
      fireEvent.click(screen.getByRole("button", { name: "Show the numbers" }));
      fireEvent.click(screen.getByRole("button", { name: "Show the chart" }));
      expect(svgEl().getAttribute("class")).toBe("viz c2");
    } finally {
      vi.useRealTimers();
    }
  });

  test("reduced motion: no animation classes at all", () => {
    stubIO();
    document.documentElement.setAttribute("data-motion", "reduce");
    mount();
    expect(svgEl().getAttribute("class")).toBe("viz c2");
  });

  test("without IntersectionObserver the chart is simply there", () => {
    mount();
    expect(svgEl().getAttribute("class")).toBe("viz c2");
  });
});
