// Smoke tests against `vite preview` of the demo-data build (see playwright.config.ts): the home
// page, a fund page (each of its three tabs), that fund's first position page and a not-found page, at
// desktop and phone width, light and dark (the two projects). Each page must show its heading, log
// no console or page errors, and not scroll sideways. The fund page also gets its tabs, its tree map
// and one click on a year bar checked in a real layout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fundTitle, HOME_TITLE } from "../src/lib/format";

const DEMO = join(import.meta.dirname, "..", "public", "demo-data");
const readJson = (file: string) => JSON.parse(readFileSync(join(DEMO, file), "utf8"));

const funds: { id: number[]; name: string[] } = readJson("funds.json");
const fundId: number = funds.id[0];
const fundName: string = funds.name[0];
const stockId: number = readJson(`fund/${fundId}/positions.json`).stock_id[0];

const routes = [
  { name: "home", path: "/" },
  { name: "fund page", path: `/fund/${fundId}` },
  { name: "fund page, Analysis tab", path: `/fund/${fundId}#analysis` },
  { name: "fund page, About tab", path: `/fund/${fundId}#about` },
  { name: "position page", path: `/fund/${fundId}/stock/${stockId}` },
  { name: "not found", path: "/no-such-page" },
];
const widths = [1280, 400];
/** The period button's name at a width: a phone shows the short ones (1y … Max). */
const periodName = (width: number, long: string) =>
  width < 560 ? ({ "1 year": "1y", "3 years": "3y", "5 years": "5y", "10 years": "10y", "15 years": "15y", "Since start": "Max" } as Record<string, string>)[long] : long;

// The fonts are the site's own files (src/fonts.css), so nothing asks Google for them any more. This
// stub is a leftover safety net: should a font request to Google ever come back, it is answered here
// (the run needs no network) and the "fonts are the site's own" test below fails on it.
test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

/** Open a page, wait until it has loaded its data, and return the errors logged while it did. */
async function open(page: Page, path: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`uncaught: ${err.message}`));
  await page.goto(path);
  await expect(page.locator("h1")).toBeVisible();
  await page.waitForLoadState("networkidle");
  return errors;
}

for (const width of widths) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const route of routes) {
      test(`${route.name}: shows its heading and logs no errors`, async ({ page }) => {
        const errors = await open(page, route.path);
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.getByRole("contentinfo")).toContainText("Not investment advice.");
        expect(errors).toEqual([]);
      });

      test(`${route.name}: no horizontal overflow at ${width}px`, async ({ page }) => {
        await open(page, route.path);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(innerWidth).toBe(width);
        expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      });
    }

    // jsdom cannot measure, so the unit tests draw every chart at a fixed fallback width: this is the
    // one place the panels are laid out for real, at a desktop and a phone width.
    test("fund page: Holdings first, with its tiles, tree map, Annual returns and the Positions table; the tabs open the rest", async ({ page }) => {
      const errors = await open(page, `/fund/${fundId}`);
      await expect(page.locator("h1")).toHaveText(fundName);
      await expect(page.getByRole("tab", { name: /^Holdings/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
      for (const name of ["Holdings", "Annual returns", "Positions"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      // the tree map fills its box: tiles inside it, none past its right edge
      const tiles = page.locator("svg.tm g.tile");
      await expect(tiles.first()).toBeVisible();
      const box = (await page.locator(".tm-box").boundingBox())!;
      for (const t of await tiles.all()) {
        const b = (await t.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
      }
      await expect(page.locator(".tm-cap")).toContainText("at prices of");
      await expect(page.locator("#retPanel rect.hit").first()).toBeAttached();

      // a bar in the middle: the first and last carry the bracket's handles
      const hits = page.locator("#retPanel rect.hit");
      const aria = await hits.nth(Math.floor((await hits.count()) / 2)).getAttribute("aria-label");
      const label = (aria as string).split(":")[0];
      await page.getByRole("button", { name: new RegExp(`^${label}: `) }).click();
      await expect(page.locator("#retPanel rect.hit[aria-pressed='true']")).toHaveCount(1);

      await page.getByRole("tab", { name: "About" }).click();
      await expect(page).toHaveURL(/#about$/);
      await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
      for (const name of ["Positions", "Assets under management"]) await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);

      await page.getByRole("tab", { name: "Analysis" }).click();
      await expect(page).toHaveURL(/#analysis$/);
      await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
      for (const name of ["Assets under management", "What if they'd kept it"]) {
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      }
      // the year picked on Holdings' Annual returns names Return constituents here
      await expect(page.getByRole("heading", { name: `Return constituents ${label}`, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Annual returns", exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    // jsdom has no layout, so only here can the landing be watched as a real page runs it (the first draw used to
    // be cut short by the width being measured a moment later, and the tiles began in a neutral colour).
    test("fund page: the tree map forms on landing, every tile in its final colour from its first frame", async ({ page }) => {
      type Seen = { fills: string[]; widths: number[] };
      await page.addInitScript(() => {
        const seen: Seen[] = [];
        (window as unknown as { __tm: Seen[] }).__tm = seen;
        const loop = () => {
          document.querySelectorAll<SVGGElement>("svg.tm g.tile:not(.out)").forEach((g, i) => {
            const r = g.querySelector<SVGRectElement>("rect.tr")!;
            const s = (seen[i] ??= { fills: [], widths: [] });
            if (r.style.fill && !s.fills.includes(r.style.fill)) s.fills.push(r.style.fill);
            s.widths.push(Number(r.getAttribute("width") ?? 0));
          });
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      const errors = await open(page, `/fund/${fundId}`);
      await expect(page.locator("svg.tm g.tile").first()).toBeVisible();
      await page.waitForTimeout(1500); // the grow-in takes 600 ms
      const seen = await page.evaluate(() => (window as unknown as { __tm: Seen[] }).__tm);
      expect(seen.length).toBeGreaterThan(3);
      for (const t of seen) {
        expect(t.fills).toHaveLength(1); // one colour, never tweened
        expect(t.widths[0]).toBeLessThan(t.widths[t.widths.length - 1] * 0.5); // it grew in, it was not drawn finished
      }
      expect(errors).toEqual([]);
    });

    test("fund page: the Year mode steps the tree map and the table together", async ({ page }) => {
      const errors = await open(page, `/fund/${fundId}`);
      await page.getByRole("button", { name: "Year", exact: true }).click();
      await expect(page.getByRole("group", { name: "Years end in" })).toBeVisible();
      await page.getByRole("button", { name: "Earlier year" }).click();
      await expect(page.locator("#holdPanel .asof")).toHaveText(/^12 months to /);
      await expect(page.locator(".tm-cap")).toContainText("at quarter-end prices");
      await expect(page.locator(".tm-ticks")).toContainText("+50%");
      expect(errors).toEqual([]);
    });
  });
}

// The pre-rendered page lives at dist/fund/{id}/index.html, which is the URL with the trailing slash.
test("the pre-rendered fund page has the fund's name as its title and its heading", async ({ page }) => {
  await open(page, `/fund/${fundId}/`);
  await expect(page).toHaveTitle(fundTitle(fundName));
  await expect(page.locator("h1")).toHaveText(fundName);
});

// What a crawler gets before any script runs: the file itself, not the page after the app has mounted.
test("the pre-rendered fund file holds its own text: heading, summary, largest positions and links", async ({ request }) => {
  const html = await (await request.get(`/fund/${fundId}/`)).text();
  expect(html).toContain(`<title>${fundTitle(fundName)}</title>`);
  expect(html).toMatch(/<h1>[^<]+: 13F holdings and estimated returns<\/h1>/);
  expect(html).toContain("filed its latest 13F for");
  expect(html).toContain("<caption>Largest positions at the latest prices (Orca estimate)</caption>");
  expect(html).toMatch(/<li><a href="\/fund\/\d+\/">/);
  expect(html).toMatch(/<meta name="description" content="[^"]*13F holdings/);
});

// The owner's wording (#31): "Hedge fund stock holdings and analysis based on SEC data."
test("the home page's own head names hedge fund holdings and SEC data", async ({ page }) => {
  await open(page, "/");
  await expect(page).toHaveTitle(HOME_TITLE);
  const description = await page.locator('meta[name="description"]').getAttribute("content");
  expect(description).toMatch(/hedge fund .*holdings/i);
  expect(description).toMatch(/SEC/);
});

// The pre-rendered title names the fund; moving around inside the app must not leave it behind.
test("the title follows the route when navigating inside the app", async ({ page }) => {
  await open(page, `/fund/${fundId}/`);
  await expect(page).toHaveTitle(fundTitle(fundName));
  await page.getByRole("link", { name: "Orca home" }).click();
  await expect(page.locator("h1")).toHaveText(/Fund Manager Research/);
  await expect(page).toHaveTitle(HOME_TITLE);
});

// Instrument Sans and Geist Mono are variable fonts served from the site (hashed files under
// /assets/). A page asks no other host for anything, and the faces it uses are loaded, not the
// fallbacks.
test("the fonts are the site's own: nothing is requested from another host, and both faces load", async ({ page }) => {
  const hosts = new Set<string>();
  const fonts: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.protocol !== "data:") hosts.add(url.host);
    if (req.resourceType() === "font") fonts.push(url.pathname);
  });
  await open(page, `/fund/${fundId}`);
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, "")),
  );
  expect([...hosts]).toEqual([new URL(page.url()).host]);
  expect(loaded).toContain("Instrument Sans");
  expect(loaded).toContain("Geist Mono");
  expect(fonts.length).toBeGreaterThan(0);
  for (const file of fonts) expect(file).toMatch(/^\/assets\/(instrument-sans|geist-mono)-latin(-ext)?-wght-normal-[\w-]+\.woff2$/);
  // the preload in the page head is for the file the stylesheet uses: one request, not two
  expect(fonts.filter((f) => f.includes("instrument-sans-latin-wght"))).toHaveLength(1);
});

test("the page follows the colour scheme", async ({ page, colorScheme }) => {
  await open(page, "/");
  const [r, g, b] = await page.evaluate(() => {
    const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? [];
    return rgb.slice(0, 3).map(Number);
  });
  const lightness = (r + g + b) / (3 * 255);
  expect(colorScheme === "dark" ? lightness < 0.25 : lightness > 0.75).toBe(true);
});

// The home page's Famous funds chart, laid out for real (jsdom cannot measure). The demo's lists are short, so
// the chart shows them whole; a 50-row fixture stands in for a production list and gives it a scroll window.
const FAMOUS_5Y = readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "famous-top5y.json"), "utf8");

for (const width of widths) {
  test.describe(`Famous funds chart at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("demo data: rows are drawn, there is no scroll box, and the page does not scroll sideways", async ({ page }) => {
      const errors = await open(page, "/");
      const rows = page.locator("section.famous .fc-row");
      await expect(rows.first()).toBeVisible();
      expect(await rows.count()).toBeGreaterThan(1);
      await expect(page.locator("section.famous .fc.scrolls")).toHaveCount(0);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      expect(errors).toEqual([]);
    });

    test("a long list scrolls in its own window: zero line at the left edge, the caption follows, no sideways scroll", async ({ page }) => {
      await page.route("**/home/top_5y.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: FAMOUS_5Y }));
      const errors = await open(page, "/");
      await page.getByRole("button", { name: periodName(width, "5 years"), exact: true }).click();
      const win = page.locator("section.famous .fc.scrolls .fc-win");
      await expect(win).toBeVisible();
      const rows = page.locator("section.famous .fc-row");
      await expect(rows).toHaveCount(50); // retries until the list has rendered
      const cap = page.locator("section.famous .fc-cap");
      await expect(cap).toHaveText(/^Showing 1–\d+ of 50 /);

      // the best funds all gained: the scale starts at zero, so the zero line sits on the plot's left edge
      const { zl, plot } = await page.evaluate(() => ({
        zl: document.querySelector(".fc-grid .zl")!.getBoundingClientRect().left,
        plot: document.querySelector(".fc-grid .plot .in")!.getBoundingClientRect().left,
      }));
      expect(Math.abs(zl - plot)).toBeLessThanOrEqual(2);

      await win.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(cap).toHaveText(/^Showing \d+–50 of 50 /);
      await expect(cap).not.toHaveText(/^Showing 1–/);

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      expect(errors).toEqual([]);
    });

    test("the list switch: every list reachable on straight rows and columns, the toolbar level", async ({ page }) => {
      await page.route("**/home/top_5y.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: FAMOUS_5Y }));
      const errors = await open(page, "/");
      await page.getByRole("button", { name: periodName(width, "5 years"), exact: true }).click();
      await expect(page.getByRole("region", { name: /^Funds 1 to \d+ of 50, scrollable$/ })).toBeVisible();
      const rect = (name: string) =>
        page.getByRole("group", { name, exact: true }).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        });
      // the owner saw Chart | Table sit higher than the period: the two share a top and a height
      const per = await rect("Period");
      const view = await rect("View");
      expect(Math.abs(per.top - view.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(per.height - view.height)).toBeLessThanOrEqual(0.5);
      const noSideways = async () => {
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      };

      if (width >= 560) {
        // every list in view on one grid: three list rows, five columns of names beside Most searched's tall cell
        const lists = page.getByRole("group", { name: "List" });
        const cells = await lists.evaluate((el) =>
          [...el.querySelectorAll<HTMLElement>(".ix-c:not(.feat) .nm")].map((n) => {
            const r = n.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top), clipped: n.scrollWidth > n.clientWidth + 1 };
          }),
        );
        expect(cells).toHaveLength(15);
        expect(new Set(cells.map((c) => c.top)).size).toBe(3);
        expect(new Set(cells.map((c) => c.left)).size).toBe(5);
        expect(cells.filter((c) => c.clipped)).toEqual([]); // every name whole
        expect(per.top).toBeGreaterThanOrEqual(await lists.evaluate((el) => el.getBoundingClientRect().bottom));
        await lists.getByRole("button", { name: "Sovereign & pension funds", exact: true }).click();
        await expect(page.getByRole("heading", { level: 3, name: "Sovereign & pension funds" })).toBeVisible();
        await expect(lists.getByRole("button", { name: "Sovereign & pension funds", exact: true })).toHaveAttribute("aria-pressed", "true");
        await noSideways();
        expect(errors).toEqual([]);
        return;
      }

      // a phone: one field over the device's select; the choice survives another tab and back
      const pick = page.getByRole("combobox", { name: "List" });
      await expect(page.locator("section.famous .fam-pick")).toContainText("Most searched");
      await pick.selectOption("Sovereign & pension funds");
      await expect(page.getByRole("heading", { level: 3, name: "Sovereign & pension funds" })).toBeVisible();
      await expect(page.locator("section.famous .fam-pick .pk-v")).toHaveText("Sovereign & pension funds");
      await page.getByRole("tab", { name: "Top funds" }).click();
      await page.getByRole("tab", { name: "Famous funds" }).click();
      await expect(page.getByRole("combobox", { name: "List" })).toHaveValue("Sovereign & pension funds");
      // a period without that list (the demo's 1 year) falls back to Most searched
      await page.getByRole("button", { name: "1y", exact: true }).click();
      await expect(page.getByRole("heading", { level: 3, name: "Most searched" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "List" })).toHaveValue("Most searched");
      await noSideways();
      expect(errors).toEqual([]);
    });
  });
}

// Ticks fading out of a wide scale are parked past the plot's ends; just under the page's 1232px max width
// they once widened the page. Fundamental long/short (40 funds, more than a window) has its returns scaled up
// to a wide spread, so the axis slides a long way as the window scrolls.
test.describe("Famous funds chart at 1240px, a wide scale", () => {
  test.use({ viewport: { width: 1240, height: 900 } });

  test("parked ticks never make the page scroll sideways", async ({ page }) => {
    const wide = JSON.parse(FAMOUS_5Y) as { famous: { group: string; ann_return: number }[] };
    for (const r of wide.famous) if (r.group === "Fundamental long/short") r.ann_return *= 4;
    await page.route("**/home/top_5y.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wide) }));
    const errors = await open(page, "/");
    await page.getByRole("button", { name: "5 years", exact: true }).click();
    await page.getByRole("group", { name: "List" }).getByRole("button", { name: "Fundamental long/short", exact: true }).click();
    const win = page.locator("section.famous .fc.scrolls .fc-win");
    await expect(win).toBeVisible();
    for (const k of [0, 1, 2, 3, 4]) {
      // two frames: the scroll is reported, then the scale is painted
      const over = await win.evaluate(async (el, k) => {
        el.scrollTop = ((el.scrollHeight - el.clientHeight) * k) / 4;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      }, k);
      expect(over).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
  });
});
