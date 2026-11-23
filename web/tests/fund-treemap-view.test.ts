import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TooltipApi } from "../src/charts/Tooltip";
import type { Measure, RGB } from "../src/fund/treemap";
import { DUR, LABEL_FROM, LABEL_FULL, LABEL_OUT, createTreemapView, type TileDatum, type TreemapView } from "../src/fund/treemapView";

// The tree map's drawing on a clock the test turns by hand: when each box moves, what colour it has, and when
// its words show. (jsdom has no layout, so sizes are the numbers given; the page-level checks are in
// fund-holdings-ui.test.tsx and e2e/smoke.spec.ts.)

const SVGNS = "http://www.w3.org/2000/svg";
const measure: Measure = (_f, s) => s.length * 7;
const tip: TooltipApi = { show: () => {}, hide: () => {} };
const GREEN: RGB = [0, 135, 95];
const RED: RGB = [214, 15, 37];
const INK: RGB = [27, 25, 22];

let clock = 0;
let queue: FrameRequestCallback[] = [];
let view: TreemapView;
let svg: SVGSVGElement;
let layer: SVGGElement;

/** Turns the clock by `ms`, running the frame the view asked for (if any). */
const step = (ms: number) => {
  clock += ms;
  const q = queue;
  queue = [];
  q.forEach((cb) => cb(clock));
};

const tile = (key: string, rect: { x: number; y: number; w: number; h: number }, over: Partial<TileDatum> = {}): TileDatum => ({
  key,
  rect,
  other: false,
  fill: GREEN,
  hollow: false,
  ink: INK,
  soft: false,
  label: { other: false, ticker: key, name: "Alphabet Inc", weight: 0.25, value: 4.55e9, count: 0, ret: null },
  aria: key,
  tip: () => ({ title: key, rows: [] }),
  ...over,
});

const g = (key: string) => Array.from(layer.querySelectorAll<SVGGElement>("g.tile")).find((n) => n.getAttribute("aria-label") === key)!;
const num = (el: Element | null, a: string) => Number(el!.getAttribute(a));
const width = (key: string) => num(g(key).querySelector("rect.tr"), "width");
const fill = (key: string) => g(key).querySelector<SVGRectElement>("rect.tr")!.style.fill;
const lab = (key: string, k: "tk" | "w" | "n" | "v") => g(key).querySelector<SVGTextElement>(`text.l-${k}`)!;
const opacity = (key: string, k: "tk" | "w" | "n" | "v") => num(lab(key, k), "opacity");

beforeEach(() => {
  clock = 1000;
  queue = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => (queue = []));
  svg = document.createElementNS(SVGNS, "svg") as SVGSVGElement;
  layer = document.createElementNS(SVGNS, "g") as SVGGElement;
  svg.append(layer);
  document.body.append(svg);
  view = createTreemapView(svg, layer, { hatch: "url(#h)", measure, tip });
});
afterEach(() => {
  view.destroy();
  svg.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("landing: the boxes form, the colour is final from the first frame, the words come in by the midway point", () => {
  test("a box grows from its centre to its place in DUR ms", () => {
    view.render([tile("AAA", { x: 0, y: 0, w: 300, h: 200 })], true);
    step(0);
    expect(width("AAA")).toBe(0);
    expect(g("AAA").getAttribute("transform")).toBe("translate(150,100)");
    step(250);
    expect(width("AAA")).toBeGreaterThan(300 * 0.85);
    expect(width("AAA")).toBeLessThan(300);
    step(DUR);
    expect(width("AAA")).toBe(300);
    expect(g("AAA").getAttribute("transform")).toBe("translate(0,0)");
    expect(queue).toHaveLength(0); // settled: no more frames asked for
  });

  test("its colour never changes (no fade, no tween)", () => {
    view.render([tile("AAA", { x: 0, y: 0, w: 300, h: 200 })], true);
    const seen = new Set<string>();
    seen.add(fill("AAA")); // before the first frame
    for (let i = 0; i < 50; i++) {
      step(16);
      seen.add(fill("AAA"));
      expect(g("AAA").style.opacity).toBe(""); // not faded in either: a pale red is not the red
    }
    expect([...seen]).toEqual(["rgb(0, 135, 95)"]);
  });

  test("the words: set at once, hidden until LABEL_FROM, in full at LABEL_FULL", () => {
    view.render([tile("AAA", { x: 0, y: 0, w: 300, h: 200 })], true);
    step(0);
    expect(lab("AAA", "tk").textContent).toBe("AAA");
    expect(lab("AAA", "w").textContent).toBe("25.0% · $4.55B");
    expect(lab("AAA", "n").textContent).toBe("Alphabet Inc");
    for (const k of ["tk", "w", "n"] as const) expect(opacity("AAA", k)).toBe(0);
    step(LABEL_FROM);
    for (const k of ["tk", "w", "n"] as const) expect(opacity("AAA", k)).toBeCloseTo(0, 6);
    step((LABEL_FULL - LABEL_FROM) / 2);
    expect(opacity("AAA", "tk")).toBeCloseTo(0.5, 6);
    step((LABEL_FULL - LABEL_FROM) / 2);
    for (const k of ["tk", "w", "n"] as const) expect(opacity("AAA", k)).toBe(1);
  });
});

describe("a step to another period", () => {
  const before = [tile("AAA", { x: 0, y: 0, w: 300, h: 200 }, { fill: RED })];
  const after = [tile("AAA", { x: 0, y: 0, w: 200, h: 200 }, { fill: GREEN, label: { other: false, ticker: "AAA", name: "Alphabet Inc", weight: 0.4, value: 6e9, count: 0, ret: null } })];

  beforeEach(() => {
    view.render(before, false);
    step(0);
  });

  test("the colour changes at once and the box moves", () => {
    view.render(after, true);
    expect(fill("AAA")).toBe("rgb(0, 135, 95)"); // new colour before any frame
    step(0);
    expect(width("AAA")).toBe(300);
    step(250);
    expect(width("AAA")).toBeGreaterThan(200);
    expect(width("AAA")).toBeLessThan(230); // ~89% of the way
    expect(fill("AAA")).toBe("rgb(0, 135, 95)");
    step(DUR);
    expect(width("AAA")).toBe(200);
  });

  test("a word that does not change stays in full; one that does goes out, then the new one is in by LABEL_FULL", () => {
    view.render(after, true);
    step(0);
    expect(opacity("AAA", "tk")).toBe(1);
    expect(opacity("AAA", "n")).toBe(1);
    expect(lab("AAA", "w").textContent).toBe("25.0% · $4.55B");
    step(LABEL_OUT / 2);
    expect(opacity("AAA", "w")).toBeCloseTo(0.5, 6);
    expect(opacity("AAA", "tk")).toBe(1);
    step(LABEL_OUT / 2);
    expect(lab("AAA", "w").textContent).toBe("40.0% · $6.00B"); // swapped while invisible
    expect(opacity("AAA", "w")).toBe(0);
    step(LABEL_FROM - LABEL_OUT);
    expect(opacity("AAA", "w")).toBeCloseTo(0, 6);
    step(LABEL_FULL - LABEL_FROM);
    expect(opacity("AAA", "w")).toBe(1);
  });

  test("a box that goes shrinks into its centre and is removed; its words go quickly", () => {
    view.render([], true);
    step(0);
    expect(g("AAA").classList.contains("out")).toBe(true);
    step(LABEL_OUT);
    expect(opacity("AAA", "tk")).toBe(0);
    step(DUR);
    expect(layer.querySelectorAll("g.tile")).toHaveLength(0);
  });
});

describe("big tiles' larger labels", () => {
  const size = (key: string) => parseFloat(lab(key, "tk").style.fontSize || "13");
  test("a big tile draws its ticker larger, and the size glides with the box on a step instead of jumping", () => {
    view.render([tile("AAA", { x: 0, y: 0, w: 600, h: 440 })], false);
    step(0);
    expect(size("AAA")).toBeCloseTo(13 * 2.2); // labelScale(600, 440) = 2.2
    view.render([tile("AAA", { x: 0, y: 0, w: 200, h: 140 })], true); // labelScale = 1
    step(0);
    expect(size("AAA")).toBeCloseTo(13 * 2.2); // not snapped at the start
    step(150);
    const mid = size("AAA");
    expect(mid).toBeLessThan(13 * 2.2);
    expect(mid).toBeGreaterThan(13);
    step(DUR);
    expect(lab("AAA", "tk").style.fontSize).toBe(""); // back to the stylesheet's 13px
  });
});

describe("no animation: everything is in place at once", () => {
  test("box, colour and words", () => {
    view.render([tile("AAA", { x: 10, y: 20, w: 300, h: 200 })], false);
    expect(width("AAA")).toBe(300);
    expect(g("AAA").getAttribute("transform")).toBe("translate(10,20)");
    expect(opacity("AAA", "tk")).toBe(1);
    expect(opacity("AAA", "w")).toBe(1);
    expect(queue).toHaveLength(0);
  });
});

describe("the value on a short tile", () => {
  test("sits at the right end of the ticker's row and follows the edge as the box grows", () => {
    view.render([tile("AAA", { x: 0, y: 0, w: 200, h: 30 })], true);
    step(0);
    expect(lab("AAA", "tk").textContent).toBe("AAA");
    expect(lab("AAA", "w").textContent).toBe("");
    expect(lab("AAA", "v").textContent).toBe("$4.55B");
    expect(lab("AAA", "v").getAttribute("text-anchor")).toBe("end");
    expect(num(lab("AAA", "v"), "y")).toBe(num(lab("AAA", "tk"), "y")); // the same row
    step(300);
    expect(num(lab("AAA", "v"), "x")).toBeLessThan(193);
    step(DUR);
    expect(num(lab("AAA", "v"), "x")).toBe(193); // the box's width less 7px of padding
  });
});
