import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useRef } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { TooltipProvider } from "../src/charts/Tooltip";
import { clearDataCache } from "../src/data/api";
import type { TopList, TopRow } from "../src/data/types";
import { aumLabel, retLabel, vsLabel } from "../src/home/famousChart";
import { useEasedScroll } from "../src/home/useEasedScroll";
import { phoneNameOf, shortNameOf } from "../src/lib/famousNames";
import Home from "../src/pages/Home";

// The Famous funds chart on production-shaped data: tests/fixtures/famous-top5y.json is production's
// home/top_5y.json (famous rows and top-level fields) with an S&P 500 figure added by hand. Every other
// file comes from the demo data, as in home.test.tsx.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "../public/demo-data");
const read = <T,>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const demo = <T,>(path: string): T => read<T>(join(DEMO, path));
const FIXTURE = read<TopList>(join(HERE, "fixtures/famous-top5y.json"));

function stubData(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/^\/demo-data\//, "");
      const body = path in overrides ? overrides[path] : demo<unknown>(path);
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

function FundStub() {
  const { id } = useParams();
  return <p>Fund page {id}</p>;
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/fund/:id" element={<FundStub />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** Home on the fixture's 5 years (the page opens on 3 years, which stays the demo's). */
async function openFixture(file: TopList = FIXTURE) {
  stubData({ "home/top_5y.json": file });
  const user = userEvent.setup();
  renderHome();
  await screen.findByRole("heading", { level: 3, name: "Most searched" });
  await user.click(screen.getByRole("button", { name: "5 years" }));
  await screen.findByRole("region", { name: /^Funds 1 to 15 of \d+, scrollable$/ });
  return user;
}

const popular = (a: TopRow, b: TopRow) =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
  (b.fame ?? 0) - (a.fame ?? 0) ||
  b.book - a.book ||
  a.fund_id - b.fund_id;
const bestFirst = (a: TopRow, b: TopRow) => b.ann_return - a.ann_return || a.fund_id - b.fund_id;

/** Most searched as the site picks it: one row per fund with a search place, the 50 most popular. */
function mostSearched(rows: TopRow[]): TopRow[] {
  const seen = new Set<number>();
  return rows
    .filter((r) => r.search != null)
    .sort(popular)
    .filter((r) => !seen.has(r.fund_id) && !!seen.add(r.fund_id))
    .slice(0, 50);
}

const famous = FIXTURE.famous ?? [];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WINDOW = /^Funds \d+ to \d+ of \d+, scrollable$/;
const box = () => screen.getByRole("region", { name: WINDOW });
const chartRows = () => within(box()).getAllByRole("link");
const caption = () => document.querySelector(".fc-cap")!.textContent;

beforeEach(() => clearDataCache());
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

describe("Famous funds chart", () => {
  it("opens on the chart: Most searched's 50 funds, best return first, each a link to its fund", async () => {
    const user = await openFixture();
    const want = mostSearched(famous).sort(bestFirst);
    expect(want).toHaveLength(50);
    const rows = chartRows();
    expect(rows).toHaveLength(50);
    rows.forEach((row, i) =>
      expect(row.getAttribute("aria-label")).toMatch(
        new RegExp(`^${i + 1} of 50\\. ${esc(shortNameOf(want[i].fund_id, want[i].name))}[,:]`),
      ),
    );
    expect(rows[0]).toHaveAttribute("aria-label", expect.stringMatching(/best in this list$/));
    // the leader's figure sits in the pill, the others are plain labels
    expect(rows[0].querySelector(".lab")).toHaveClass("lead");
    expect(rows[1].querySelector(".lab")).not.toHaveClass("lead");
    expect(rows[0].querySelector(".lab")).toHaveTextContent(retLabel(want[0].ann_return));
    expect(screen.getByRole("heading", { level: 3, name: "Most searched" })).toBeInTheDocument();
    expect(screen.getByText("50 funds")).toBeInTheDocument();
    expect(caption()).toBe("Showing 1–15 of 50 · scale fits the funds in view");
    await user.click(rows[0]);
    expect(await screen.findByText(`Fund page ${want[0].fund_id}`)).toBeInTheDocument();
  });

  it("puts the zero line at the plot's left edge while no loss is in view, and the S&P 500 line at its figure", async () => {
    await openFixture();
    const zero = document.querySelector<HTMLElement>(".fc .zl")!;
    expect(zero.style.left).toBe("0%");
    // the first window has no loss: every bar is a gain that starts on the zero line
    const bars = chartRows()
      .slice(0, 15)
      .map((r) => r.querySelector<HTMLElement>(".bar")!);
    expect(bars.every((b) => b.classList.contains("gain") && b.style.left === "0%")).toBe(true);
    expect(document.querySelector(".fc .spx")).toHaveTextContent("S&P 500 +13.5%");
    const spl = document.querySelector<HTMLElement>(".fc .spl")!;
    expect(parseFloat(spl.style.left)).toBeGreaterThan(0);
    expect(screen.getByText(/^Estimated return a year over the last 5 years, best first\. The dotted line is the S&P 500 \(\+13\.5%\)\.$/)).toBeInTheDocument();
    expect(screen.getByText("Source: SEC 13F filings; Orca estimates. S&P 500: SPY total return, Q3 2021 to Q3 2026.")).toBeInTheDocument();
    const want = mostSearched(famous).sort(bestFirst);
    const beat = want.filter((r) => r.ann_return > 0.135).length;
    const lost = want.filter((r) => r.ann_return < 0).length;
    expect(
      screen.getByText(
        `${shortNameOf(want[0].fund_id, want[0].name)} leads with ${retLabel(want[0].ann_return)} a year. ${beat} of the 50 beat the S&P 500; ${lost} lost money.`,
      ),
    ).toBeInTheDocument();
  });

  it("draws a loss to the left of the zero line, with its label on the left of the bar", async () => {
    await openFixture();
    const last = chartRows()[49];
    const bar = last.querySelector<HTMLElement>(".bar")!;
    const lab = last.querySelector<HTMLElement>(".lab")!;
    expect(bar).toHaveClass("loss");
    expect(lab.style.left).toBe("auto");
    // the label's right edge is 6px left of the bar's left end
    expect(lab.style.right).toBe(`calc(${100 - parseFloat(bar.style.left)}% + 6px)`);
    expect(lab.textContent).toMatch(/^−\d+\.\d%$/);
  });

  it("scrolling the window moves the caption, the region's name and the scale", async () => {
    await openFixture();
    const zero = document.querySelector<HTMLElement>(".fc .zl")!;
    act(() => {
      box().scrollTop = 35 * 46;
      fireEvent.scroll(box());
    });
    expect(caption()).toBe("Showing 36–50 of 50 · scale fits the funds in view");
    expect(box()).toHaveAccessibleName("Funds 36 to 50 of 50, scrollable");
    // the losses are in view, so zero has moved in from the left edge
    expect(parseFloat(zero.style.left)).toBeGreaterThan(20);
  });

  it("tells a screen reader where the window is once it settles, not at every row it passes", async () => {
    await openFixture();
    const said = () => document.querySelector(".fc-said")!;
    expect(said()).toHaveAttribute("aria-live", "polite");
    expect(document.querySelector(".fc-cap")).toHaveAttribute("aria-hidden", "true");
    expect(said()).toHaveTextContent("Showing 1–15 of 50 · scale fits the funds in view");
    vi.useFakeTimers();
    try {
      const heard: string[] = [];
      const mo = new MutationObserver(() => heard.push(said().textContent ?? ""));
      mo.observe(said(), { childList: true, characterData: true, subtree: true });
      // a glide through the list: a new row every 100ms
      for (const row of [3, 8, 14, 20, 27, 35]) {
        act(() => {
          box().scrollTop = row * 46;
          fireEvent.scroll(box());
        });
        act(() => vi.advanceTimersByTime(100));
      }
      expect(caption()).toBe("Showing 36–50 of 50 · scale fits the funds in view"); // the visible caption follows
      expect(said()).toHaveTextContent("Showing 1–15 of 50 · scale fits the funds in view");
      act(() => vi.advanceTimersByTime(300));
      await Promise.resolve(); // the observer's callback
      expect(said()).toHaveTextContent("Showing 36–50 of 50 · scale fits the funds in view");
      expect(heard).toEqual(["Showing 36–50 of 50 · scale fits the funds in view"]);
      mo.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the window with the keys: a row, a page, the ends (straight there with reduced motion)", async () => {
    document.documentElement.dataset.motion = "reduce";
    const user = await openFixture();
    const el = box();
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 50 * 46 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 15 * 46 });
    el.focus();
    await user.keyboard("{ArrowDown}");
    expect(caption()).toBe("Showing 2–16 of 50 · scale fits the funds in view");
    await user.keyboard("{PageDown}");
    expect(caption()).toBe("Showing 16–30 of 50 · scale fits the funds in view");
    await user.keyboard("{End}");
    expect(caption()).toBe("Showing 36–50 of 50 · scale fits the funds in view");
    await user.keyboard("{ArrowUp}");
    expect(caption()).toBe("Showing 35–49 of 50 · scale fits the funds in view");
    await user.keyboard("{Home}");
    expect(caption()).toBe("Showing 1–15 of 50 · scale fits the funds in view");
  });

  it("has no S&P 500 line, label or sentence when the file has no S&P figure", async () => {
    const { spx: _, ...noSpx } = FIXTURE;
    await openFixture(noSpx as TopList);
    expect(document.querySelector(".fc .spl")).toBeNull();
    expect(document.querySelector(".fc .spx")).toBeNull();
    expect(screen.getByText("Estimated return a year over the last 5 years, best first.")).toBeInTheDocument();
    expect(screen.getByText("Source: SEC 13F filings; Orca estimates.")).toBeInTheDocument();
    expect(screen.queryByText(/beat the S&P 500/)).toBeNull();
  });

  it("has no 'vs S&P 500' row in the tooltip when the file has no S&P figure", async () => {
    const { spx: _, ...noSpx } = FIXTURE;
    const user = await openFixture(noSpx as TopList);
    await user.hover(chartRows()[2]);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Return a year");
    expect(tip).not.toHaveTextContent("vs S&P 500");
    expect(chartRows()[0].getAttribute("aria-label")).not.toMatch(/S&P/);
  });

  it("the list switch shows every fund of a style list, best first", async () => {
    const user = await openFixture();
    const lists = within(screen.getByRole("group", { name: "List" })).getAllByRole("button");
    expect(lists[0]).toHaveTextContent("Most searched");
    expect(lists[0]).toHaveAttribute("aria-pressed", "true");
    await user.click(within(screen.getByRole("group", { name: "List" })).getByRole("button", { name: "Fundamental long/short" }));
    const want = famous.filter((r) => r.group === "Fundamental long/short").sort(bestFirst);
    expect(want).toHaveLength(40);
    expect(screen.getByRole("heading", { level: 3, name: "Fundamental long/short" })).toBeInTheDocument();
    expect(screen.getByText("40 funds")).toBeInTheDocument();
    expect(box()).toHaveAccessibleName("Funds 1 to 15 of 40, scrollable");
    expect(caption()).toBe("Showing 1–15 of 40 · scale fits the funds in view");
    const rows = chartRows();
    expect(rows).toHaveLength(40);
    expect(rows[0].getAttribute("aria-label")).toMatch(new RegExp(`^1 of 40\\. ${esc(shortNameOf(want[0].fund_id, want[0].name))}`));
    expect(rows[39].getAttribute("aria-label")).toMatch(new RegExp(`^40 of 40\\. ${esc(shortNameOf(want[39].fund_id, want[39].name))}`));
  });

  it("a short list has no scroll window", async () => {
    const user = await openFixture();
    await user.click(within(screen.getByRole("group", { name: "List" })).getByRole("button", { name: "Macro" }));
    expect(screen.queryByRole("region", { name: WINDOW })).toBeNull();
    expect(document.querySelectorAll(".fc a.fc-row")).toHaveLength(3);
    expect(caption()).toBe("Showing all 3 funds");
  });

  it("falls back to Most searched when the chosen list is missing for a new period", async () => {
    const user = await openFixture();
    const list = () => screen.getByRole("group", { name: "List" });
    await user.click(within(list()).getByRole("button", { name: "Macro" }));
    expect(screen.getByRole("heading", { level: 3, name: "Macro" })).toBeInTheDocument();
    // the demo's 1-year file has no Macro list
    expect((demo<TopList>("home/top_1y.json").famous ?? []).some((r) => r.group === "Macro")).toBe(false);
    await user.click(screen.getByRole("button", { name: "1 year" }));
    await screen.findByRole("heading", { level: 3, name: "Most searched" });
    expect(within(list()).getByRole("button", { name: "Most searched" })).toHaveAttribute("aria-pressed", "true");
    expect(within(list()).queryByRole("button", { name: "Macro" })).toBeNull();
  });

  it("Chart | Table switches to today's table for the same list, and back", async () => {
    const user = await openFixture();
    const view = () => screen.getByRole("group", { name: "View" });
    expect(within(view()).getByRole("button", { name: "Chart" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(view()).getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table", { name: "Most searched" });
    expect(screen.queryByRole("region", { name: WINDOW })).toBeNull();
    // the table keeps the popularity order and the funds' full names
    const names = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getByRole("link").textContent);
    expect(names).toEqual(mostSearched(famous).slice(0, 10).map((r) => r.name));
    expect(screen.getByText("Showing 1–10 of 50 funds")).toBeInTheDocument();
    expect(screen.getByText(/^Estimated figures over the last 5 years\. Select a heading to sort/)).toBeInTheDocument();
    // the lead line and the source stay in both views
    expect(screen.getByText(/leads with .* a year\./)).toBeInTheDocument();
    expect(screen.getByText(/^Source: SEC 13F filings/)).toBeInTheDocument();
    await user.click(within(view()).getByRole("button", { name: "Chart" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(chartRows()).toHaveLength(50);
  });

  it("shows the initials of the fund on a grey disc when there is no photo and no manager", async () => {
    await openFixture();
    const eagle = famous.find((r) => r.name.startsWith("First Eagle"))!;
    expect(eagle.manager).toBeNull();
    const row = chartRows().find((r) => r.getAttribute("href") === `/fund/${eagle.fund_id}`)!;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".init")).toHaveTextContent("FE");
    // a manager with a photo gets it
    const buffett = chartRows().find((r) => /Warren Buffett/.test(r.getAttribute("aria-label") ?? ""))!;
    expect(buffett.querySelector("img.fc-face")).not.toBeNull();
  });

  it("shows the legal name, the return, the gap to the S&P 500 and the AUM in the tooltip", async () => {
    const user = await openFixture();
    const want = mostSearched(famous).sort(bestFirst);
    await user.hover(chartRows()[2]);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(want[2].name);
    expect(tip).toHaveTextContent(`Return a year${retLabel(want[2].ann_return)}`);
    expect(tip).toHaveTextContent(`vs S&P 500${vsLabel(want[2].ann_return, 0.135)}`);
    expect(tip).toHaveTextContent(`AUM${aumLabel(want[2].book)}`);
    await user.unhover(chartRows()[2]);
    expect(screen.getByRole("tooltip", { hidden: true })).not.toBeVisible();
  });

  it("on a phone: each row's spoken label holds the shorter name it shows, and the axis says 'Est.'", async () => {
    // jsdom lays nothing out: give every element a phone's width so the chart measures one
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    try {
      stubData({ "home/top_5y.json": FIXTURE });
      const user = userEvent.setup();
      renderHome();
      await screen.findByRole("heading", { level: 3, name: "Most searched" });
      await user.click(screen.getByRole("button", { name: "5 years" }));
      await screen.findByRole("region", { name: "Funds 1 to 10 of 50, scrollable" });
      expect(document.querySelector(".fc")).toHaveClass("phone");
      expect(document.querySelector(".fc-axl")).toHaveTextContent("Est. return a year");
      const want = mostSearched(famous).sort(bestFirst);
      let shorter = 0;
      chartRows().forEach((row, i) => {
        const short = shortNameOf(want[i].fund_id, want[i].name);
        const shown = phoneNameOf(short);
        if (shown !== short) shorter++;
        expect(row.querySelector(".nm")).toHaveTextContent(shown);
        expect(row.getAttribute("aria-label")).toMatch(new RegExp(`^${i + 1} of 50\\. ${esc(shown)}[,:]`));
      });
      expect(shorter).toBeGreaterThan(0); // Duquesne Family Office, shown as Duquesne
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it("the chart works on the demo's short lists, without a scroll window", async () => {
    stubData();
    renderHome();
    await screen.findByRole("heading", { level: 3, name: "Most searched" });
    const t3 = demo<TopList>("home/top_3y.json");
    const n = new Set((t3.famous ?? []).filter((r) => r.search != null).map((r) => r.fund_id)).size;
    expect(screen.queryByRole("region", { name: WINDOW })).toBeNull();
    expect(document.querySelectorAll(".fc a.fc-row")).toHaveLength(n);
    expect(caption()).toBe(`Showing all ${n} funds`);
  });
});

// ---- the eased scroll on its own: a hand-driven animation clock ----

function Box({ onPos }: { onPos: (p: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const es = useEasedScroll(ref, 46, onPos);
  return (
    <div>
      <div data-testid="box" ref={ref} />
      <button type="button" onClick={() => es.glide(46 * 5)}>
        five rows
      </button>
    </div>
  );
}

describe("useEasedScroll", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  let now = 0;
  /** Runs one 60fps frame. */
  const frame = () =>
    act(() => {
      now += 1000 / 60;
      const run = [...frames.values()];
      frames.clear();
      run.forEach((cb) => cb(now));
    });
  beforeEach(() => {
    frames.clear();
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(next, cb);
      return next++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  function setup() {
    const onPos = vi.fn();
    render(<Box onPos={onPos} />);
    const el = screen.getByTestId("box");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 50 * 46 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 15 * 46 });
    return { el, onPos };
  }
  const wheel = (el: HTMLElement, init: WheelEventInit) => {
    const e = new WheelEvent("wheel", { cancelable: true, bubbles: true, ...init });
    el.dispatchEvent(e);
    return e;
  };

  it("a wheel notch starts slow, speeds up, then settles on the target without overshooting", async () => {
    const { el, onPos } = setup();
    expect(wheel(el, { deltaY: 100 }).defaultPrevented).toBe(true);
    const tops: number[] = [];
    for (let i = 0; i < 90 && (frames.size > 0 || i === 0); i++) {
      await frame();
      tops.push(el.scrollTop);
    }
    expect(tops.at(-1)).toBe(100);
    expect(Math.max(...tops)).toBeLessThanOrEqual(100); // no overshoot
    tops.slice(1).forEach((t, i) => expect(t).toBeGreaterThanOrEqual(tops[i])); // never back
    const steps = tops.map((t, i) => t - (tops[i - 1] ?? 0));
    const peak = steps.indexOf(Math.max(...steps));
    expect(peak).toBeGreaterThan(2); // a slow start: the fastest frame comes later
    expect(steps[0]).toBeLessThan(steps[peak] / 2);
    const settled = tops.findIndex((t) => t > 99.5);
    expect(settled / 60).toBeGreaterThan(0.4); // about half a second to most of the way
    expect(settled / 60).toBeLessThan(1);
    expect(onPos).toHaveBeenLastCalledWith(100 / 46);
  });

  it("lets the page scroll at the ends, ignores pinch zoom, and counts lines and pages", async () => {
    const { el } = setup();
    expect(wheel(el, { deltaY: -100 }).defaultPrevented).toBe(false); // at the top already
    expect(wheel(el, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    expect(wheel(el, { deltaY: 3, deltaMode: 1 }).defaultPrevented).toBe(true); // 3 lines = 48px
    for (let i = 0; i < 120 && frames.size > 0; i++) await frame();
    expect(el.scrollTop).toBe(48);
    el.scrollTop = 35 * 46; // the bottom
    fireEvent.scroll(el);
    expect(wheel(el, { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(wheel(el, { deltaY: -1, deltaMode: 2 }).defaultPrevented).toBe(true); // a page up
    for (let i = 0; i < 120 && frames.size > 0; i++) await frame();
    expect(el.scrollTop).toBe(35 * 46 - 15 * 46);
  });

  it("leaves a wheel it cannot hold back to the browser, and a sideways swipe too", async () => {
    const { el } = setup();
    // not cancelable (the browser is already scrolling): no glide on top of the browser's own scroll
    expect(wheel(el, { deltaY: 100, cancelable: false }).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    // mostly sideways: a trackpad swipe, not a scroll of the list
    expect(wheel(el, { deltaX: 120, deltaY: 30 }).defaultPrevented).toBe(false);
    expect(frames.size).toBe(0);
    expect(el.scrollTop).toBe(0);
    // mostly down still glides
    expect(wheel(el, { deltaX: 10, deltaY: 100 }).defaultPrevented).toBe(true);
    expect(frames.size).toBe(1);
  });

  it("follows a scroll it did not cause (a scrollbar drag) and stops gliding", async () => {
    const { el, onPos } = setup();
    wheel(el, { deltaY: 300 });
    await frame();
    await frame();
    el.scrollTop = 600; // the user drags the scrollbar
    fireEvent.scroll(el);
    expect(onPos).toHaveBeenLastCalledWith(600 / 46);
    for (let i = 0; i < 5; i++) await frame();
    expect(el.scrollTop).toBe(600);
  });

  it("jumps straight to the target with reduced motion", async () => {
    document.documentElement.dataset.motion = "reduce";
    const { el, onPos } = setup();
    await userEvent.setup().click(screen.getByRole("button", { name: "five rows" }));
    expect(el.scrollTop).toBe(230);
    expect(onPos).toHaveBeenLastCalledWith(5);
    expect(frames.size).toBe(0);
  });
});
