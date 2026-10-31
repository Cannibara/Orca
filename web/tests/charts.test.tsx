import { act, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { ColumnChart } from "../src/charts/ColumnChart";
import { DivergingBars } from "../src/charts/DivergingBars";
import { PriceChart } from "../src/charts/PriceChart";
import { StepChart } from "../src/charts/StepChart";
import { TooltipProvider } from "../src/charts/Tooltip";
import type { Trade } from "../src/data/types";

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/clientY.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventShim extends MouseEvent {}
    Object.defineProperty(window, "PointerEvent", { value: PointerEventShim, configurable: true });
  }
});

afterEach(() => vi.unstubAllGlobals());

/** Replace ResizeObserver with a stub whose size the test sets. */
function stubResizeObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  class Stub {
    constructor(cb: ResizeObserverCallback) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Stub);
  return (width: number) =>
    act(() => callbacks.forEach((cb) => cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)));
}

const tipEl = () => document.getElementById("tip") as HTMLElement;
const withTip = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);
const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

// Fixed fallback width used when the wrapper has no measurable size (jsdom).
const W = 640;

// ---------------------------------------------------------------- ColumnChart

const cats = ["2021", "2022", "2023"];
const ret = { name: "Return", color: "var(--s1)", values: [10, -5, 20] };
const spy = { name: "SPY", color: "var(--s2)", values: [8, 2, 12] };
const pctFmt = (v: number) => `${v}%`;
const base = { cats, yFmt: pctFmt, tipFmt: pctFmt, label: "Annual returns" };

describe("ColumnChart", () => {
  test("renders one focusable hit target per category and selects on Enter", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ColumnChart {...base} series={[ret]} onSelect={onSelect} />);
    const hits = container.querySelectorAll("rect.hit");
    expect(hits).toHaveLength(3);
    hits.forEach((h) => expect(h.getAttribute("tabindex")).toBe("0"));

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(hits[1]);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  test("Space and click select too", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ColumnChart {...base} series={[ret]} onSelect={onSelect} />);
    const hits = container.querySelectorAll("rect.hit");
    await user.tab();
    await user.keyboard(" ");
    await user.click(hits[2]);
    expect(onSelect.mock.calls).toEqual([[0], [2]]);
  });

  test("hit targets are buttons only when the chart is selectable", () => {
    const a = render(<ColumnChart {...base} series={[ret]} onSelect={() => {}} selected={1} />);
    const hits = a.container.querySelectorAll("rect.hit");
    expect(hits[0].getAttribute("role")).toBe("button");
    expect(hits[1].getAttribute("aria-pressed")).toBe("true");
    expect(hits[0].getAttribute("aria-pressed")).toBe("false");
    expect(a.container.querySelectorAll("rect.selbg")).toHaveLength(1);
    expect(a.container.querySelectorAll("text.lab.sel")).toHaveLength(1);
    a.unmount();

    const b = render(<ColumnChart {...base} series={[ret]} />);
    expect(b.container.querySelector("rect.hit")!.getAttribute("role")).not.toBe("button");
    expect(b.container.querySelectorAll("rect.selbg")).toHaveLength(0);
  });

  test("the svg is an image named by the label prop", () => {
    const { container } = render(<ColumnChart {...base} series={[ret]} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Annual returns");
  });

  test("each hit target is labelled with its category and values", () => {
    const { container } = render(<ColumnChart {...base} series={[ret, spy]} />);
    expect(container.querySelectorAll("rect.hit")[1].getAttribute("aria-label")).toBe("2022: Return -5%, SPY 2%");
  });

  test("a legend appears only for two or more series, and its text is not coloured", () => {
    const one = render(<ColumnChart {...base} series={[ret]} />);
    expect(one.container.querySelector(".legend")).toBeNull();
    one.unmount();

    const two = render(<ColumnChart {...base} series={[ret, spy]} />);
    const legend = two.container.querySelector(".legend")!;
    expect(legend.textContent).toContain("Return");
    expect(legend.textContent).toContain("SPY");
    const swatches = legend.querySelectorAll("i.sw");
    expect((swatches[0] as HTMLElement).style.background).toBe("var(--s1)");
    expect((swatches[1] as HTMLElement).style.background).toBe("var(--s2)");
    expect(legend.querySelectorAll("[style*='color']")).toHaveLength(0);
  });

  test("grouped bars are at most 24 px wide and filled with the series colour", () => {
    const { container } = render(<ColumnChart {...base} series={[ret, spy]} />);
    const marks = container.querySelectorAll("path.mark");
    expect(marks).toHaveLength(6);
    marks.forEach((m) => {
      const d = m.getAttribute("d")!;
      const x0 = Number(/^M([\d.]+),/.exec(d)![1]);
      const xs = [...d.matchAll(/Q([\d.]+),/g)].map((q) => Number(q[1]));
      expect(Math.max(...xs) - x0).toBeLessThanOrEqual(24);
    });
    expect((marks[0] as SVGElement).style.fill).toBe("var(--s1)");
    expect((marks[1] as SVGElement).style.fill).toBe("var(--s2)");
  });

  test("stacked bars: one column per category, only the outer segment of each side is rounded", () => {
    const gains = { name: "Gains", color: "var(--s1)", values: [30, 20, -10] };
    const flows = { name: "Inflows", color: "var(--s2)", values: [10, -15, -5] };
    const { container } = render(<ColumnChart {...base} series={[gains, flows]} stacked />);
    const cols = container.querySelectorAll("g.cat");
    expect(cols).toHaveLength(3);
    // 2021: two positive segments; 2022: one up, one down; 2023: two negative segments.
    expect(cols[0].querySelectorAll("path.mark")).toHaveLength(2);
    expect(cols[1].querySelectorAll("path.mark")).toHaveLength(2);
    expect(cols[2].querySelectorAll("path.mark")).toHaveLength(2);
    // Radius at the data end: how far the first vertical run stops short of the curve's end.
    const radius = (el: Element) => {
      const m = /V([\d.]+)Q[\d.]+,([\d.]+) /.exec(el.getAttribute("d")!)!;
      return Math.abs(Number(m[1]) - Number(m[2]));
    };
    const [inner, outer] = Array.from(cols[0].querySelectorAll("path.mark"));
    expect(radius(inner)).toBe(0);
    expect(radius(outer)).toBe(4);
    const [up, down] = Array.from(cols[1].querySelectorAll("path.mark"));
    expect(radius(up)).toBe(4); // alone on its side of zero, so it is the outer end
    expect(radius(down)).toBe(4);
  });

  test("axis labels use yFmt and topLabel is drawn above its column", () => {
    const { container } = render(
      <ColumnChart {...base} series={[ret]} yFmt={(v) => `${v} pct`} topLabel={(i) => (i === 1 ? null : `top${i}`)} />,
    );
    const axis = Array.from(container.querySelectorAll("text.ax")).map((t) => t.textContent);
    expect(axis).toContain("0 pct");
    const tops = Array.from(container.querySelectorAll("text.val")).map((t) => t.textContent);
    expect(tops).toEqual(["top0", "top2"]);
  });

  test("on a narrow chart category and top labels thin out, keeping the last and the selected one", () => {
    const resize = stubResizeObserver();
    const years = Array.from({ length: 12 }, (_, i) => String(2015 + i));
    const one = { name: "Return", color: "var(--s1)", values: years.map((_, i) => i + 1) };
    const { container } = render(
      <ColumnChart {...base} cats={years} series={[one]} selected={1} topLabel={(i) => `$${i}.00B`} />,
    );
    const labs = () => Array.from(container.querySelectorAll("text.lab")).map((t) => t.textContent);
    const tops = () => container.querySelectorAll("text.val").length;
    expect(labs()).toHaveLength(12); // room at the default width
    expect(tops()).toBe(12);
    resize(320);
    expect(labs().length).toBeLessThan(12);
    expect(labs()).toContain("2026"); // the latest
    expect(labs()).toContain("2016"); // the selected one
    expect(tops()).toBeLessThan(12);
    // every drawn label still has its hit target
    expect(container.querySelectorAll("rect.hit")).toHaveLength(12);
  });

  test("hover shows a tooltip with a row per series; leaving hides it", async () => {
    const user = userEvent.setup();
    const { container } = withTip(
      <ColumnChart {...base} series={[ret, spy]} extraTip={(i) => [{ value: `$${i}B`, label: "end value" }]} />,
    );
    expect(tipEl().hidden).toBe(true);
    const hits = container.querySelectorAll("rect.hit");
    await user.hover(hits[1]);
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().querySelector(".t")!.textContent).toBe("2022");
    const rows = Array.from(tipEl().querySelectorAll(".r")).map((r) => r.textContent);
    expect(rows).toEqual(["-5%Return", "2%SPY", "$1Bend value"]);
    expect((tipEl().querySelector("i.lk") as HTMLElement).style.background).toBe("var(--s1)");
    await user.unhover(hits[1]);
    expect(tipEl().hidden).toBe(true);
  });

  test("keyboard focus shows the tooltip, blur and Escape hide it", async () => {
    const user = userEvent.setup();
    withTip(<ColumnChart {...base} series={[ret]} />);
    await user.tab();
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().querySelector(".t")!.textContent).toBe("2021");
    await user.keyboard("{Escape}");
    expect(tipEl().hidden).toBe(true);
    await user.tab();
    expect(tipEl().querySelector(".t")!.textContent).toBe("2022");
    await user.click(document.body); // focus leaves the chart
    expect(tipEl().hidden).toBe(true);
  });

  test("uses the fallback width without a measurable wrapper", () => {
    const { container } = render(<ColumnChart {...base} series={[ret]} />);
    const svg = container.querySelector("svg")!;
    expect(num(svg, "width")).toBe(W);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${W} 260`);
  });

  test("follows the ResizeObserver, clamped to 300, and falls back when it reports 0", () => {
    const resize = stubResizeObserver();
    const { container } = render(<ColumnChart {...base} series={[ret]} />);
    const svg = () => container.querySelector("svg")!;
    resize(480);
    expect(num(svg(), "width")).toBe(480);
    resize(120);
    expect(num(svg(), "width")).toBe(300);
    resize(0);
    expect(num(svg(), "width")).toBe(W);
  });
});

// ------------------------------------------------------------- DivergingBars

const items = [
  { label: "AAA", sub: "Alpha Corp", value: 2.5, extra: [{ label: "P&L", value: "$1.2M" }] },
  { label: "BBB", sub: "Beta Inc", value: -1 },
  { label: "CCC", sub: "Gamma Ltd", value: 0.4 },
];
const ptsFmt = (v: number) => `${v} pts`;

describe("DivergingBars", () => {
  test("puts the zero line at the horizontal centre of the plot and draws one bar per item", () => {
    const { container } = render(<DivergingBars items={items} fmt={ptsFmt} label="Contribution" />);
    const zero = container.querySelectorAll("line.base");
    expect(zero).toHaveLength(1);
    // The plot runs from the left margin (64) to width - the right margin (64).
    expect(num(zero[0], "x1")).toBeCloseTo((64 + (W - 64)) / 2, 6);
    expect(num(zero[0], "x2")).toBe(num(zero[0], "x1"));
    expect(container.querySelectorAll("path.mark")).toHaveLength(3);
    expect(container.querySelector("svg")!.getAttribute("aria-label")).toBe("Contribution");
  });

  test("the domain is symmetric: every grid line has a mirror image about the centre", () => {
    const { container } = render(<DivergingBars items={items} fmt={ptsFmt} label="c" />);
    const xs = Array.from(container.querySelectorAll("line.grid, line.base")).map((l) => num(l, "x1"));
    expect(xs.length).toBeGreaterThan(2);
    xs.forEach((x) => expect(xs.some((y) => Math.abs(x + y - W) < 1e-6)).toBe(true));
  });

  test("bars go right for gains and left for losses, in --pos / --neg", () => {
    const { container } = render(<DivergingBars items={items} fmt={ptsFmt} label="c" />);
    const marks = Array.from(container.querySelectorAll("path.mark")) as SVGElement[];
    const tipX = (d: string) => Number(/Q([\d.]+),/.exec(d)![1]);
    expect(tipX(marks[0].getAttribute("d")!)).toBeGreaterThan(W / 2);
    expect(tipX(marks[1].getAttribute("d")!)).toBeLessThan(W / 2);
    expect(marks[0].style.fill).toBe("var(--pos)");
    expect(marks[1].style.fill).toBe("var(--neg)");
  });

  test("the label sits beside the axis on the opposite side of the bar; the value sits at the tip", () => {
    const { container } = render(<DivergingBars items={items} fmt={ptsFmt} label="c" />);
    const labels = container.querySelectorAll("text.lab");
    expect(labels[0].getAttribute("text-anchor")).toBe("end");
    expect(num(labels[0], "x")).toBeLessThan(W / 2);
    expect(labels[1].getAttribute("text-anchor")).toBe("start");
    expect(num(labels[1], "x")).toBeGreaterThan(W / 2);
    const values = container.querySelectorAll("text.val");
    expect(values[0].textContent).toBe("2.5 pts");
    expect(values[0].getAttribute("text-anchor")).toBe("start");
    expect(num(values[0], "x")).toBeGreaterThan(W / 2);
    expect(values[1].getAttribute("text-anchor")).toBe("end");
    expect(num(values[1], "x")).toBeLessThan(W / 2);
  });

  test("a legend names the two colours and each row has a focusable, labelled hit target", () => {
    const { container } = render(<DivergingBars items={items} fmt={ptsFmt} label="c" />);
    expect(container.querySelectorAll(".legend i.sw")).toHaveLength(2);
    const hits = container.querySelectorAll("rect.hit");
    expect(hits).toHaveLength(3);
    hits.forEach((h) => expect(h.getAttribute("tabindex")).toBe("0"));
    expect(hits[0].getAttribute("aria-label")).toBe("AAA 2.5 pts");
  });

  test("tooltip shows the name, the value and the extra rows on hover and on focus", async () => {
    const user = userEvent.setup();
    const { container } = withTip(<DivergingBars items={items} fmt={ptsFmt} label="c" />);
    await user.hover(container.querySelectorAll("rect.hit")[0]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("AAA · Alpha Corp");
    expect(Array.from(tipEl().querySelectorAll(".r")).map((r) => r.textContent)).toEqual([
      "2.5 ptscontribution",
      "$1.2MP&L",
    ]);
    await user.unhover(container.querySelectorAll("rect.hit")[0]);
    expect(tipEl().hidden).toBe(true);
    await user.tab();
    await user.tab();
    expect(tipEl().querySelector(".t")!.textContent).toBe("BBB · Beta Inc");
  });

  test("on a narrow chart the axis labels thin out but keep 0", () => {
    const resize = stubResizeObserver();
    const wide = [{ label: "AAA", sub: "a", value: 12.3 }, { label: "BBB", sub: "b", value: -9.1 }];
    const { container } = render(<DivergingBars items={wide} fmt={(v) => `${v} pts`} label="c" />);
    const labels = () => Array.from(container.querySelectorAll("text.ax")).map((t) => t.textContent);
    const full = labels().length;
    resize(320);
    expect(labels().length).toBeLessThan(full);
    expect(labels()).toContain("0 pts");
  });
});

// ---------------------------------------------------------------- PriceChart

// A Friday. Quarter 28 is Q1 2020; week i ends start + 7 i days.
const START = "2020-01-03";
const closesFull = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 5) * 2 + i * 0.05);
const trades: Trade[] = [
  { q: 28, delta: 100, px: 11, low: 9.5, high: 12.5, sharesAfter: 100 }, // New
  { q: 29, delta: 50, px: 12, low: null, high: null, sharesAfter: 150 }, // Add, no quarter range
  { q: 30, delta: -50, px: 13.25, low: 12, high: 14.5, sharesAfter: 100 }, // Trim
  { q: 31, delta: -100, px: 14, low: 13, high: 15, sharesAfter: 0 }, // Exit
];

describe("PriceChart", () => {
  test("the weekly line is one path in --ink2 with a 2 px stroke", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const line = container.querySelector("path.price-line") as SVGPathElement;
    expect(line.style.stroke).toBe("var(--ink2)");
    expect(line.getAttribute("stroke-width")).toBe("2");
    expect(line.getAttribute("d")!.match(/M/g)).toHaveLength(1);
  });

  test("a null close breaks the line: no carry-forward, no interpolation", () => {
    const closes: (number | null)[] = closesFull.slice();
    closes[20] = null;
    closes[21] = null;
    const { container } = render(<PriceChart closes={closes} start={START} trades={trades} />);
    const d = container.querySelector("path.price-line")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(2);
    const points = d.match(/[ML][\d.]+,[\d.]+/g)!;
    expect(points).toHaveLength(closes.length - 2); // one point per priced week, none for the gap
  });

  test("buy and sell dots use --s1 and --s2 and carry their own class", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const buys = Array.from(container.querySelectorAll("circle.hit-dot.buy")) as SVGElement[];
    const sells = Array.from(container.querySelectorAll("circle.hit-dot.sell")) as SVGElement[];
    expect(buys).toHaveLength(2);
    expect(sells).toHaveLength(2);
    buys.forEach((c) => expect(c.style.fill).toBe("var(--s1)"));
    sells.forEach((c) => expect(c.style.fill).toBe("var(--s2)"));
    [...buys, ...sells].forEach((c) => {
      expect(c.getAttribute("tabindex")).toBe("0");
      expect(c.getAttribute("r")).toBe("5");
    });
    expect(buys[0].getAttribute("aria-label")).toBe("New Q1 2020 at about $11.00");
  });

  test("the quarter low-high band is drawn only for quarters that have a range", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const bands = container.querySelectorAll("rect.band");
    expect(bands).toHaveLength(3);
    bands.forEach((b) => {
      expect(num(b, "width")).toBe(8);
      expect((b as SVGElement).style.fill).toBe("var(--band)");
    });
  });

  test("dots sit on their estimated price: a higher price is higher on screen", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const dots = container.querySelectorAll("circle.hit-dot");
    expect(num(dots[3], "cy")).toBeLessThan(num(dots[0], "cy")); // 14 above 11
    expect(num(dots[3], "cx")).toBeGreaterThan(num(dots[0], "cx")); // later quarter further right
  });

  test("has a legend naming the line, both dots and the band", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const legend = container.querySelector(".legend")!;
    ["Weekly close", "Buy", "Sell", "Quarter low"].forEach((t) => expect(legend.textContent).toContain(t));
  });

  test("the svg is an image with a default or supplied label", () => {
    const a = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    expect(a.container.querySelector("svg")!.getAttribute("role")).toBe("img");
    expect(a.container.querySelector("svg")!.getAttribute("aria-label")).toMatch(/price/i);
    a.unmount();
    const b = render(<PriceChart closes={closesFull} start={START} trades={trades} label="NVDA price" />);
    expect(b.container.querySelector("svg")!.getAttribute("aria-label")).toBe("NVDA price");
  });

  test("moving over the plot shows a crosshair and the week's close; leaving removes both", () => {
    const { container } = withTip(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const overlay = container.querySelector("rect.overlay")!;
    expect(container.querySelector("line.crosshair")).toBeNull();

    // Far right of the plot: the last week, 3 Jan 2020 + 59 weeks.
    fireEvent.pointerMove(overlay, { clientX: W - 14, clientY: 100 });
    expect(container.querySelector("line.crosshair")).not.toBeNull();
    expect(container.querySelector("circle.crosshair-dot")).not.toBeNull();
    expect(tipEl().hidden).toBe(false);
    expect(tipEl().querySelector(".t")!.textContent).toBe("19 Feb 2021");
    expect(tipEl().querySelector(".r")!.textContent).toBe(`$${closesFull[59].toFixed(2)}weekly close`);

    // Far left: the first week.
    fireEvent.pointerMove(overlay, { clientX: 52, clientY: 100 });
    expect(tipEl().querySelector(".t")!.textContent).toBe("3 Jan 2020");

    fireEvent.pointerLeave(overlay);
    expect(container.querySelector("line.crosshair")).toBeNull();
    expect(tipEl().hidden).toBe(true);
  });

  test("a week without a close shows a dash, not a carried-forward value", () => {
    const closes: (number | null)[] = closesFull.slice();
    closes[0] = null;
    const { container } = withTip(<PriceChart closes={closes} start={START} trades={trades} />);
    fireEvent.pointerMove(container.querySelector("rect.overlay")!, { clientX: 52, clientY: 100 });
    expect(tipEl().querySelector(".r")!.textContent).toBe("—no close");
    expect(container.querySelector("circle.crosshair-dot")).toBeNull();
  });

  test("a trade dot shows its tooltip on focus and on hover", async () => {
    const user = userEvent.setup();
    const { container } = withTip(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const dots = container.querySelectorAll("circle.hit-dot");

    await user.tab(); // first tab stop is the first dot
    expect(document.activeElement).toBe(dots[0]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("New · Q1 2020");
    expect(Array.from(tipEl().querySelectorAll(".r")).map((r) => r.textContent)).toEqual([
      "$11.00est. price (VWAP)",
      "$9.50 – $12.50quarter range",
      "+100shares",
    ]);

    await user.hover(dots[1]); // no range for this quarter
    expect(tipEl().querySelector(".t")!.textContent).toBe("Add · Q2 2020");
    expect(Array.from(tipEl().querySelectorAll(".r")).map((r) => r.textContent)).toEqual([
      "$12.00est. price (VWAP)",
      "+50shares",
    ]);

    await user.hover(dots[2]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("Trim · Q3 2020");
    await user.hover(dots[3]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("Exit · Q4 2020");
    expect(tipEl().querySelector(".r")!.textContent).toContain("$14.00");
    expect(tipEl().textContent).toContain("−100shares");
  });

  test("shows year labels on the x axis", () => {
    const { container } = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const axis = Array.from(container.querySelectorAll("text.ax")).map((t) => t.textContent);
    expect(axis).toContain("2020");
    expect(axis).toContain("2021");
  });

  test("renders with no trades and with no priced week", () => {
    const a = render(<PriceChart closes={closesFull} start={START} trades={[]} />);
    expect(a.container.querySelectorAll("circle.hit-dot")).toHaveLength(0);
    a.unmount();
    const b = render(<PriceChart closes={[null, null]} start={START} trades={[]} />);
    expect(b.container.innerHTML).not.toContain("NaN");
  });
});

// ----------------------------------------------------------------- StepChart

// Plot geometry: left margin 52, right margin 14, fallback width 640.
const SL = 52;
const SW = W - SL - 14;
const stepQuarters = [20, 24, 30];
const stepShares = [1_000_000, 2_500_000, 0];

describe("StepChart", () => {
  test("draws one step per quarter in which the holding changed", () => {
    const { container } = render(<StepChart quarters={stepQuarters} shares={stepShares} endQ={33} />);
    const line = container.querySelector("path.step-line")!.getAttribute("d")!;
    expect(line.match(/V/g)).toHaveLength(3);
    expect(line.match(/M/g)).toHaveLength(1);
    expect(container.querySelector("path.step-line")!.getAttribute("stroke-width")).toBe("2");
    expect((container.querySelector("path.step-line") as SVGElement).style.stroke).toBe("var(--s1)");
    expect(container.querySelector("path.step-area")).not.toBeNull();
  });

  test("a single change is a single step", () => {
    const { container } = render(<StepChart quarters={[10]} shares={[500]} />);
    expect(container.querySelector("path.step-line")!.getAttribute("d")!.match(/V/g)).toHaveLength(1);
  });

  test("the svg is an image with a default or supplied label", () => {
    const a = render(<StepChart quarters={stepQuarters} shares={stepShares} />);
    expect(a.container.querySelector("svg")!.getAttribute("role")).toBe("img");
    expect(a.container.querySelector("svg")!.getAttribute("aria-label")).toBe("Shares held by quarter");
    a.unmount();
    const b = render(<StepChart quarters={stepQuarters} shares={stepShares} label="NVDA shares" />);
    expect(b.container.querySelector("svg")!.getAttribute("aria-label")).toBe("NVDA shares");
  });

  test("axis labels are compact and year labels sit on the x axis", () => {
    const { container } = render(<StepChart quarters={stepQuarters} shares={stepShares} endQ={33} />);
    const axis = Array.from(container.querySelectorAll("text.ax")).map((t) => t.textContent);
    expect(axis).toContain("0");
    expect(axis.some((t) => /^\d(\.\d+)?M$/.test(t ?? ""))).toBe(true);
    expect(axis).toContain("2019");
  });

  test("hovering a quarter shows the shares held then; the level holds until the next change", () => {
    // Domain: 2 quarters of lead-in (18) to endQ (33) = 16 quarters.
    const { container } = withTip(<StepChart quarters={stepQuarters} shares={stepShares} endQ={33} />);
    const overlay = container.querySelector("rect.overlay")!;
    const xOf = (q: number) => SL + ((q + 0.5 - 18) / 16) * SW; // centre of quarter q's slot

    fireEvent.pointerMove(overlay, { clientX: xOf(25), clientY: 40 });
    expect(container.querySelector("line.crosshair")).not.toBeNull();
    expect(tipEl().querySelector(".t")!.textContent).toBe("Q2 2019");
    expect(tipEl().querySelector(".r")!.textContent).toBe("2,500,000shares held");

    fireEvent.pointerMove(overlay, { clientX: xOf(19), clientY: 40 }); // before the first change
    expect(tipEl().querySelector(".r")!.textContent).toBe("0shares held");

    fireEvent.pointerMove(overlay, { clientX: xOf(20), clientY: 40 }); // the change quarter itself
    expect(tipEl().querySelector(".r")!.textContent).toBe("1,000,000shares held");

    fireEvent.pointerMove(overlay, { clientX: xOf(33), clientY: 40 }); // after the exit
    expect(tipEl().querySelector(".r")!.textContent).toBe("0shares held");

    fireEvent.pointerLeave(overlay);
    expect(tipEl().hidden).toBe(true);
    expect(container.querySelector("line.crosshair")).toBeNull();
  });

  test("renders with nothing to draw", () => {
    const { container } = render(<StepChart quarters={[]} shares={[]} />);
    expect(container.innerHTML).not.toContain("NaN");
  });
});
