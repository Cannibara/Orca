import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
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

const tipEl = () => document.getElementById("tip") as HTMLElement;
const withTip = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);
const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

// Fixed fallback width used when the wrapper has no measurable size (jsdom).
const W = 640;

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
      expect((b as SVGElement).style.fill).toBe("var(--range)");
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

  test("the svg is a group (its trade dots take focus) with a default or supplied label", () => {
    const a = render(<PriceChart closes={closesFull} start={START} trades={trades} />);
    expect(a.container.querySelector("svg")!.getAttribute("role")).toBe("group");
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
    expect(tipEl().querySelector(".v")!.textContent).toBe(`weekly close$${closesFull[59].toFixed(2)}`);

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
    expect(tipEl().querySelector(".v")!.textContent).toBe("no close—");
    expect(container.querySelector("circle.crosshair-dot")).toBeNull();
  });

  test("a trade dot shows its tooltip on focus and on hover", async () => {
    const user = userEvent.setup();
    const { container } = withTip(<PriceChart closes={closesFull} start={START} trades={trades} />);
    const dots = container.querySelectorAll("circle.hit-dot");

    await user.tab(); // first tab stop is the first dot
    expect(document.activeElement).toBe(dots[0]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("New · Q1 2020");
    expect(Array.from(tipEl().querySelectorAll(".v")).map((r) => r.textContent)).toEqual([
      "est. price (VWAP)$11.00",
      "quarter range$9.50 – $12.50",
      "shares+100",
    ]);

    await user.hover(dots[1]); // no range for this quarter
    expect(tipEl().querySelector(".t")!.textContent).toBe("Add · Q2 2020");
    expect(Array.from(tipEl().querySelectorAll(".v")).map((r) => r.textContent)).toEqual([
      "est. price (VWAP)$12.00",
      "shares+50",
    ]);

    await user.hover(dots[2]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("Trim · Q3 2020");
    await user.hover(dots[3]);
    expect(tipEl().querySelector(".t")!.textContent).toBe("Exit · Q4 2020");
    expect(tipEl().querySelector(".v")!.textContent).toContain("$14.00");
    expect(tipEl().textContent).toContain("shares−100");
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

  test("the svg is a group with a default or supplied label", () => {
    const a = render(<StepChart quarters={stepQuarters} shares={stepShares} />);
    expect(a.container.querySelector("svg")!.getAttribute("role")).toBe("group");
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
    expect(tipEl().querySelector(".v")!.textContent).toBe("shares held2,500,000");

    fireEvent.pointerMove(overlay, { clientX: xOf(19), clientY: 40 }); // before the first change
    expect(tipEl().querySelector(".v")!.textContent).toBe("shares held0");

    fireEvent.pointerMove(overlay, { clientX: xOf(20), clientY: 40 }); // the change quarter itself
    expect(tipEl().querySelector(".v")!.textContent).toBe("shares held1,000,000");

    fireEvent.pointerMove(overlay, { clientX: xOf(33), clientY: 40 }); // after the exit
    expect(tipEl().querySelector(".v")!.textContent).toBe("shares held0");

    fireEvent.pointerLeave(overlay);
    expect(tipEl().hidden).toBe(true);
    expect(container.querySelector("line.crosshair")).toBeNull();
  });

  test("renders with nothing to draw", () => {
    const { container } = render(<StepChart quarters={[]} shares={[]} />);
    expect(container.innerHTML).not.toContain("NaN");
  });
});
