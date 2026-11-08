import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState, type ReactElement } from "react";
import { TooltipProvider, tipHandlers, useTooltip, type TipContent, type TipOptions } from "../src/charts/Tooltip";
import { shortYear } from "../src/fund/fmt";
import { reducedMotion, useGrowOnce, useWidth } from "../src/fund/hooks";
import { PeriodStrip } from "../src/fund/PeriodStrip";
import { Seg } from "../src/fund/Seg";

// jsdom has no PointerEvent, so fireEvent.pointer* would drop clientX/clientY.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventShim extends MouseEvent {}
    Object.defineProperty(window, "PointerEvent", { value: PointerEventShim, configurable: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-motion");
});

type Getter = { configurable: true; get: (this: HTMLElement) => number };
/** Replace an HTMLElement size getter (jsdom has no layout) and return a restore function. */
function stubProto(name: "offsetLeft" | "offsetWidth" | "offsetHeight" | "clientWidth", get: Getter["get"]) {
  const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
  const holder = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ? HTMLElement.prototype : Element.prototype;
  Object.defineProperty(holder, name, { configurable: true, get });
  return () => {
    if (orig) Object.defineProperty(holder, name, orig);
  };
}

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

// ---------------------------------------------------------------------- Seg

describe("Seg", () => {
  const options = [
    { id: "15", label: "15 years" },
    { id: "max", label: "Max" },
  ];
  function Host({ onChange }: { onChange: (id: string) => void }) {
    const [v, setV] = useState("15");
    return (
      <Seg
        label="Years shown"
        options={options}
        value={v}
        onChange={(id) => {
          setV(id);
          onChange(id);
        }}
      />
    );
  }

  test("a group of toggle buttons: the value is pressed, a click on another reports it once", () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Years shown" });
    const [a, b] = within(group).getAllByRole("button");
    expect(a).toHaveTextContent("15 years");
    expect(a).toHaveAttribute("aria-pressed", "true");
    expect(b).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(a); // already pressed: nothing
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("max");
    expect(a).toHaveAttribute("aria-pressed", "false");
    expect(b).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("the thumb sits under the pressed button and follows it", () => {
    const restoreLeft = stubProto("offsetLeft", function () {
      return this.textContent === "Max" ? 90 : 2;
    });
    const restoreWidth = stubProto("offsetWidth", function () {
      return this.textContent === "Max" ? 50 : 80;
    });
    try {
      const { container } = render(<Host onChange={() => {}} />);
      const thumb = container.querySelector(".seg .thumb") as HTMLElement;
      expect(thumb).toHaveAttribute("aria-hidden", "true");
      expect(thumb.style.getPropertyValue("--x")).toBe("0px");
      expect(thumb.style.getPropertyValue("--w")).toBe("80px");
      fireEvent.click(screen.getByRole("button", { name: "Max" }));
      expect(thumb.style.getPropertyValue("--x")).toBe("88px");
      expect(thumb.style.getPropertyValue("--w")).toBe("50px");
    } finally {
      restoreLeft();
      restoreWidth();
    }
  });

  test("the thumb only starts to tween after its first placement", async () => {
    const { container } = render(<Host onChange={() => {}} />);
    const seg = container.querySelector(".seg") as HTMLElement;
    await waitFor(() => expect(seg).toHaveClass("ready"));
  });

  test("renders icons and honours disabled options", () => {
    render(
      <Seg
        label="View"
        value="a"
        onChange={() => {}}
        options={[
          { id: "a", label: "Chart", icon: <svg data-testid="ic" /> },
          { id: "b", label: "Table", disabled: true },
        ]}
      />,
    );
    expect(screen.getByTestId("ic")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toBeDisabled();
  });
});

// -------------------------------------------------------------- PeriodStrip

describe("PeriodStrip", () => {
  const years = ["2014", "2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026 H1"];
  const W = 560; // the fallback width: jsdom cannot measure
  const band = (W - 20) / years.length;
  const xAt = (i: number) => 10 + band * i + band / 2;

  function mount(a = 10, b = 12, over: Partial<Parameters<typeof PeriodStrip>[0]> = {}) {
    const onChange = vi.fn();
    const utils = render(
      <TooltipProvider>
        <PeriodStrip variant="years" names={years} a={a} b={b} onChange={onChange} ariaLabel="Period for what drove the return" {...over} />
      </TooltipProvider>,
    );
    const svg = utils.container.querySelector("svg") as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: 56, width: W, height: 56, x: 0, y: 0, toJSON() {} });
    const handle = (d: "a" | "b") => utils.container.querySelector(`rect.scr-h[data-d="${d}"]`) as SVGRectElement;
    return { ...utils, svg, onChange, handle };
  }

  test("years: a labelled group with a slider on each edge and a hit title per year", () => {
    const { svg, handle, container } = mount();
    expect(svg).toHaveAttribute("role", "group");
    expect(svg).toHaveAttribute("aria-label", "Period for what drove the return");
    expect(container.querySelectorAll("rect.sc-hit")).toHaveLength(13);
    expect(container.querySelector("rect.sc-hit title")!.textContent).toBe("Extend the period to 2014");
    const a = handle("a");
    const b = handle("b");
    expect(a).toHaveAttribute("role", "slider");
    expect(a).toHaveAttribute("aria-label", "Start of the period");
    expect(a).toHaveAttribute("aria-valuenow", "10");
    expect(a).toHaveAttribute("aria-valuemin", "0");
    expect(a).toHaveAttribute("aria-valuemax", "12");
    expect(a).toHaveAttribute("aria-valuetext", "2024");
    expect(a).toHaveAttribute("tabindex", "0");
    expect(b).toHaveAttribute("aria-label", "End of the period");
    expect(b).toHaveAttribute("aria-valuetext", "2026 H1");
    // ticks inside the period are marked
    expect(container.querySelectorAll("line.scr-tick")).toHaveLength(13);
    expect(container.querySelectorAll("line.scr-tick.in")).toHaveLength(3);
    // 13 full labels do not fit at 560 px ("2026 H1" is wide), the short form does
    expect(Array.from(container.querySelectorAll("text.clab")).map((t) => t.textContent)).toEqual(years.map(shortYear));
  });

  test("a period outside the slots is clamped", () => {
    const { handle } = mount(-3, 99);
    expect(handle("a")).toHaveAttribute("aria-valuenow", "0");
    expect(handle("b")).toHaveAttribute("aria-valuenow", "12");
  });

  test("clicking a slot moves the nearest edge (the start on a tie) and ignores an edge slot", () => {
    const { container, onChange } = mount();
    const hit = (i: number) => container.querySelectorAll("rect.sc-hit")[i];
    fireEvent.click(hit(3)); // left of the period: extends the start
    expect(onChange).toHaveBeenLastCalledWith(3, 12);
    fireEvent.click(hit(11)); // inside, one from each edge: tie -> start
    expect(onChange).toHaveBeenLastCalledWith(11, 12);
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.click(hit(12)); // already the end
    fireEvent.click(hit(10)); // already the start
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("arrow keys step a handle; shift moves both; the ends hold", () => {
    const { handle, onChange } = mount();
    fireEvent.keyDown(handle("a"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(9, 12);
    fireEvent.keyDown(handle("b"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(10, 11);
    fireEvent.keyDown(handle("a"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(11, 12);
    fireEvent.keyDown(handle("b"), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(9, 11);
    const count = onChange.mock.calls.length;
    fireEvent.keyDown(handle("b"), { key: "ArrowRight" }); // b is at the last slot
    fireEvent.keyDown(handle("a"), { key: "Home" }); // not a step key
    fireEvent.keyDown(handle("b"), { key: "ArrowRight", shiftKey: true }); // the box is at the last slot
    expect(onChange).toHaveBeenCalledTimes(count);
  });

  test("a handle stops at the other one", () => {
    const { handle, onChange } = mount(5, 5);
    fireEvent.keyDown(handle("a"), { key: "ArrowRight" });
    fireEvent.keyDown(handle("b"), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("dragging the start handle resizes, never past the end", () => {
    const { handle, svg, onChange } = mount();
    fireEvent.pointerDown(handle("a"), { clientX: xAt(10), pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: xAt(6), pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(6, 12);
    fireEvent.pointerMove(svg, { clientX: xAt(12) + 5, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(12, 12);
    fireEvent.pointerUp(svg, { clientX: xAt(12), pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerMove(svg, { clientX: xAt(2), pointerId: 1 }); // no drag any more
    expect(onChange).not.toHaveBeenCalled();
  });

  test("dragging the end handle resizes, never before the start", () => {
    const { handle, svg, onChange } = mount();
    fireEvent.pointerDown(handle("b"), { clientX: xAt(12), pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: xAt(7), pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(10, 10);
    fireEvent.pointerMove(svg, { clientX: xAt(11), pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(10, 11);
  });

  test("dragging the box moves it by whole slots and keeps it inside", () => {
    const { container, svg, onChange } = mount();
    const win = container.querySelector("rect.scr-win") as SVGRectElement;
    fireEvent.pointerDown(win, { clientX: xAt(11), pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: xAt(9), pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(8, 10);
    fireEvent.pointerMove(svg, { clientX: xAt(0), pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(0, 2);
    const calls = onChange.mock.calls.length;
    fireEvent.pointerMove(svg, { clientX: xAt(12), pointerId: 1 }); // one slot right of where it started: already at the last slot
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  test("a press on the box that never moves is a click on that slot", () => {
    const { container, svg, onChange } = mount();
    const win = container.querySelector("rect.scr-win") as SVGRectElement;
    fireEvent.pointerDown(win, { clientX: xAt(11), pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: xAt(11), pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(11, 12);
    onChange.mockClear();
    // moved first: the release is not a click
    fireEvent.pointerDown(win, { clientX: xAt(11), pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: xAt(10), pointerId: 1 });
    onChange.mockClear();
    fireEvent.pointerUp(svg, { clientX: xAt(10), pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a cancelled drag ends without a click", () => {
    const { container, svg, onChange } = mount();
    const win = container.querySelector("rect.scr-win") as SVGRectElement;
    fireEvent.pointerDown(win, { clientX: xAt(11), pointerId: 1 });
    fireEvent.pointerCancel(svg, { clientX: xAt(11), pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: xAt(3), pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("pressing a handle hides the shared tooltip", () => {
    function Show() {
      const tip = useTooltip();
      return <button onClick={() => tip.show({ title: "x", rows: [] }, 10, 10)}>show</button>;
    }
    const { container } = render(
      <TooltipProvider>
        <Show />
        <PeriodStrip variant="years" names={years} a={10} b={12} onChange={() => {}} ariaLabel="x" />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByText("show"));
    expect(tipEl().hidden).toBe(false);
    fireEvent.pointerDown(container.querySelector('rect.scr-h[data-d="a"]')!, { clientX: xAt(10), pointerId: 1 });
    expect(tipEl().hidden).toBe(true);
  });

  test("quarters: ticks, labels only where given, and the nearest-edge titles", () => {
    const names = Array.from({ length: 10 }, (_, i) => `Q${(i % 4) + 1} ’${14 + Math.floor(i / 4)}`);
    const tickLabels = names.map((_, i) => (i % 4 === 0 ? `’${14 + i / 4}` : ""));
    const onChange = vi.fn();
    const { container } = render(
      <PeriodStrip variant="quarters" names={names} tickLabels={tickLabels} a={2} b={5} onChange={onChange} ariaLabel="Custom period" />,
    );
    expect(container.querySelector("rect.sc-hit title")!.textContent).toBe("Move the nearest edge to Q1 ’14");
    expect(Array.from(container.querySelectorAll("text.tick")).map((t) => t.textContent)).toEqual(["’14", "’15", "’16"]);
    expect(container.querySelectorAll("text.clab")).toHaveLength(0);
    const ticks = Array.from(container.querySelectorAll("line.scr-tick"));
    expect(ticks[0].getAttribute("y1")).toBe("8"); // a year's first quarter has the taller tick
    expect(ticks[1].getAttribute("y1")).toBe("11");
    expect(container.querySelectorAll("line.scr-tick.in")).toHaveLength(4);
    fireEvent.click(container.querySelectorAll("rect.sc-hit")[8]);
    expect(onChange).toHaveBeenCalledWith(2, 8);
  });

  test("an empty strip renders nothing", () => {
    const { container } = render(<PeriodStrip variant="years" names={[]} a={0} b={0} onChange={() => {}} ariaLabel="x" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  test("the strip is as wide as its measured box", () => {
    const resize = stubResizeObserver();
    const { container } = render(<PeriodStrip variant="years" names={years} a={0} b={1} onChange={() => {}} ariaLabel="x" />);
    resize(420.7);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("420");
    expect(svg.getAttribute("viewBox")).toBe("0 0 420 56");
  });
});

// ------------------------------------------------------------------ Tooltip

describe("Tooltip", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true, writable: true });
    restores.push(stubProto("offsetWidth", function () { return this.id === "tip" ? 100 : 0; }));
    restores.push(stubProto("offsetHeight", function () { return this.id === "tip" ? 40 : 0; }));
  });
  afterEach(() => restores.splice(0).forEach((r) => r()));

  const content: TipContent = { title: "2014", rows: [{ value: "1" }] };
  function Probe({ x, y, opts, c = content }: { x: number; y: number; opts?: TipOptions; c?: TipContent }) {
    const tip = useTooltip();
    return (
      <>
        <button onClick={() => tip.show(c, x, y, opts)}>show</button>
        <button onClick={() => tip.hide()}>hide</button>
      </>
    );
  }
  const shown = (ui: ReactElement) => {
    render(<TooltipProvider>{ui}</TooltipProvider>);
    fireEvent.click(screen.getByText("show"));
    return tipEl();
  };
  const at = (el: HTMLElement) => [el.style.left, el.style.top];

  test("hidden until something is shown; a tooltip role; Escape and hide() hide it", () => {
    render(
      <TooltipProvider>
        <Probe x={1} y={1} />
      </TooltipProvider>,
    );
    expect(tipEl()).toHaveAttribute("role", "tooltip");
    expect(tipEl()).toHaveClass("tip");
    expect(tipEl().hidden).toBe(true);
    fireEvent.click(screen.getByText("show"));
    expect(tipEl().hidden).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tipEl().hidden).toBe(true);
    fireEvent.click(screen.getByText("show"));
    fireEvent.click(screen.getByText("hide"));
    expect(tipEl().hidden).toBe(true);
  });

  test("title with the Part year tag, rows with swatch / label / value, big and sum rows, a note", () => {
    const c: TipContent = {
      title: "2014",
      part: true,
      rows: [
        { label: "Max drawdown", value: "−22.3%" },
        { color: "var(--gain)", label: "Q2", value: "+1.8%" },
        { color: "var(--loss)", value: "−1.20 points", big: true },
        { label: "Book at end", value: "$1.5B", sum: true },
      ],
      note: "A note under the rows",
    };
    const el = shown(<Probe x={200} y={300} c={c} />);
    const title = el.querySelector(".t")!;
    expect(title.textContent).toBe("2014Part year");
    expect(title.querySelector(".tag.hollow")!.textContent).toBe("Part year");
    const rows = Array.from(el.querySelectorAll(".v"));
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toBe("Max drawdown−22.3%");
    expect(rows[0].querySelector("i")).toBeNull();
    expect(rows[0].querySelector(".vl")!.textContent).toBe("Max drawdown");
    expect(rows[0].querySelector(".vv")!.textContent).toBe("−22.3%");
    expect((rows[1].querySelector("i") as HTMLElement).style.background).toBe("var(--gain)");
    expect(Array.from(rows[1].children).map((n) => n.tagName + "." + n.className)).toEqual(["I.", "SPAN.vl", "SPAN.vv"]);
    expect(rows[2]).toHaveClass("v", "big");
    expect(rows[2].querySelector(".vl")).toBeNull();
    expect(rows[3]).toHaveClass("v", "sum");
    expect(el.querySelector(".x")!.textContent).toBe("A note under the rows");
  });

  test("no tag, note or label unless given", () => {
    const el = shown(<Probe x={200} y={300} />);
    expect(el.querySelector(".tag")).toBeNull();
    expect(el.querySelector(".x")).toBeNull();
    expect(el.querySelector(".vl")).toBeNull();
  });

  test("place above (the default): right of the point and above it; flips at the right and top edges", () => {
    expect(at(shown(<Probe x={200} y={300} />))).toEqual(["214px", "248px"]);
  });
  test("place above flips left near the right edge", () => {
    expect(at(shown(<Probe x={990} y={300} />))).toEqual(["876px", "248px"]);
  });
  test("place above drops below the point near the top", () => {
    expect(at(shown(<Probe x={200} y={20} opts={{ place: "above" }} />))).toEqual(["214px", "36px"]);
  });

  test("place cursor: 14px right and below, flipping near the edges", () => {
    expect(at(shown(<Probe x={200} y={300} opts={{ place: "cursor" }} />))).toEqual(["214px", "314px"]);
  });
  test("place cursor flips left at the right edge", () => {
    expect(at(shown(<Probe x={990} y={300} opts={{ place: "cursor" }} />))).toEqual(["876px", "314px"]);
  });
  test("place cursor flips above at the bottom edge", () => {
    expect(at(shown(<Probe x={200} y={690} opts={{ place: "cursor" }} />))).toEqual(["214px", "636px"]);
  });

  test("place pin: top-left of the element, 70px in and 10px down, kept on screen", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const rect = (left: number, top: number) => () => ({ left, top, right: left + 300, bottom: top + 100, width: 300, height: 100, x: left, y: top, toJSON() {} });
    host.getBoundingClientRect = rect(100, 50);
    expect(at(shown(<Probe x={0} y={0} opts={{ place: { pin: host } }} />))).toEqual(["170px", "60px"]);
    host.remove();
  });
  test("place pin clamps to the viewport", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({ left: 900, top: -40, right: 1200, bottom: 60, width: 300, height: 100, x: 900, y: -40, toJSON() {} });
    expect(at(shown(<Probe x={0} y={0} opts={{ place: { pin: host } }} />))).toEqual(["892px", "8px"]);
  });

  test("tipHandlers pass the placement on for pointer events; focus anchors above the target", () => {
    function Hit({ opts }: { opts?: TipOptions }) {
      const api = useTooltip();
      return <div data-testid="hit" {...tipHandlers(api, () => content, opts)} />;
    }
    const { rerender } = render(
      <TooltipProvider>
        <Hit opts={{ place: "cursor" }} />
      </TooltipProvider>,
    );
    const hit = screen.getByTestId("hit");
    fireEvent.pointerMove(hit, { clientX: 300, clientY: 200 });
    expect(at(tipEl())).toEqual(["314px", "214px"]);
    fireEvent.pointerLeave(hit);
    expect(tipEl().hidden).toBe(true);
    rerender(
      <TooltipProvider>
        <Hit />
      </TooltipProvider>,
    );
    fireEvent.pointerEnter(screen.getByTestId("hit"), { clientX: 300, clientY: 200 });
    expect(at(tipEl())).toEqual(["314px", "148px"]);
    screen.getByTestId("hit").getBoundingClientRect = () => ({ left: 100, top: 80, right: 150, bottom: 100, width: 50, height: 20, x: 100, y: 80, toJSON() {} });
    fireEvent.focus(screen.getByTestId("hit"));
    expect(at(tipEl())).toEqual(["139px", "28px"]);
    fireEvent.blur(screen.getByTestId("hit"));
    expect(tipEl().hidden).toBe(true);
  });

  test("without a provider the API is a harmless no-op", () => {
    function Lone() {
      const tip = useTooltip();
      tip.show(content, 1, 1);
      tip.hide();
      return <i>ok</i>;
    }
    expect(() => render(<Lone />)).not.toThrow();
  });
});

// -------------------------------------------------------------------- hooks

describe("reducedMotion", () => {
  test("off by default", () => {
    expect(reducedMotion()).toBe(false);
  });
  test("on when the user prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("prefers-reduced-motion: reduce") }));
    expect(reducedMotion()).toBe(true);
  });
  test("on when the page says data-motion=reduce", () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    expect(reducedMotion()).toBe(true);
  });
});

describe("useWidth", () => {
  function Probe({ min, fallback }: { min?: number; fallback?: number }) {
    const ref = useRef<HTMLDivElement>(null);
    const w = useWidth(ref, min, fallback);
    return (
      <div ref={ref} data-testid="w">
        {w}
      </div>
    );
  }

  test("falls back when the box cannot be measured", () => {
    render(<Probe />);
    expect(screen.getByTestId("w")).toHaveTextContent("600");
  });
  test("a custom fallback", () => {
    render(<Probe fallback={520} />);
    expect(screen.getByTestId("w")).toHaveTextContent("520");
  });
  test("measures the box before paint, then follows the ResizeObserver, floored and never below min", () => {
    const restore = stubProto("clientWidth", () => 450.6);
    const resize = stubResizeObserver();
    try {
      render(<Probe />);
      expect(screen.getByTestId("w")).toHaveTextContent("450");
      resize(800.4);
      expect(screen.getByTestId("w")).toHaveTextContent("800");
      resize(120);
      expect(screen.getByTestId("w")).toHaveTextContent("280");
      resize(0);
      expect(screen.getByTestId("w")).toHaveTextContent("600");
    } finally {
      restore();
    }
  });
});

describe("useGrowOnce", () => {
  class IOStub {
    static all: IOStub[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(
      private cb: IntersectionObserverCallback,
      public opts?: IntersectionObserverInit,
    ) {
      IOStub.all.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    fire(isIntersecting: boolean) {
      act(() => this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
  }
  const live = () => IOStub.all.filter((o) => !o.disconnected);
  beforeEach(() => {
    IOStub.all = [];
  });

  const host = () => ({ current: document.createElement("div") });

  test("without IntersectionObserver there is no animation", () => {
    const ref = host();
    const { result } = renderHook(() => useGrowOnce(ref));
    expect(result.current.cls).toBe("");
    act(() => result.current.replay());
    expect(result.current.cls).toBe("");
    act(() => result.current.settle());
    expect(result.current.cls).toBe("");
  });

  test("with reduced motion there is no animation and no observer", () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    document.documentElement.setAttribute("data-motion", "reduce");
    const ref = host();
    const { result } = renderHook(() => useGrowOnce(ref));
    expect(result.current.cls).toBe("");
    expect(IOStub.all).toHaveLength(0);
  });

  test("hidden at first, grows when 25% visible, settles after the run, never restarts on re-render", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", IOStub);
    const ref = host();
    const { result, rerender } = renderHook(() => useGrowOnce(ref, { durMs: 500 }));
    expect(result.current.cls).toBe(" pre");
    expect(live()).toHaveLength(1);
    expect(live()[0].opts?.threshold).toBe(0.25);
    expect(live()[0].observed).toEqual([ref.current]);

    live()[0].fire(false); // seen but under 25%
    expect(result.current.cls).toBe(" pre");
    const io = live()[0];
    io.fire(true);
    expect(result.current.cls).toBe(" run");
    expect(io.disconnected).toBe(true);

    act(() => void vi.advanceTimersByTime(499));
    expect(result.current.cls).toBe(" run");
    act(() => void vi.advanceTimersByTime(2));
    expect(result.current.cls).toBe("");

    rerender();
    rerender();
    expect(result.current.cls).toBe("");
    expect(IOStub.all).toHaveLength(1);
  });

  test("settle ends a run early; during the wait it changes nothing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", IOStub);
    const ref = host();
    const { result } = renderHook(() => useGrowOnce(ref));
    act(() => result.current.settle());
    expect(result.current.cls).toBe(" pre");
    live()[0].fire(true);
    expect(result.current.cls).toBe(" run");
    act(() => result.current.settle());
    expect(result.current.cls).toBe("");
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.cls).toBe("");
  });

  test("replay hides the bars again and waits for the next sighting", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", IOStub);
    const ref = host();
    const { result } = renderHook(() => useGrowOnce(ref));
    live()[0].fire(true);
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current.cls).toBe("");
    act(() => result.current.replay());
    expect(result.current.cls).toBe(" pre");
    expect(live()).toHaveLength(1);
    live()[0].fire(true);
    expect(result.current.cls).toBe(" run");
    // a replay during a run starts over
    act(() => result.current.replay());
    expect(result.current.cls).toBe(" pre");
  });

  test("a host that is not there settles at once", () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    const none = { current: null };
    const { result } = renderHook(() => useGrowOnce(none));
    expect(result.current.cls).toBe("");
  });

  test("unmounting disconnects the observer", () => {
    vi.stubGlobal("IntersectionObserver", IOStub);
    const ref = host();
    const { unmount } = renderHook(() => useGrowOnce(ref));
    expect(live()).toHaveLength(1);
    unmount();
    expect(live()).toHaveLength(0);
  });
});
