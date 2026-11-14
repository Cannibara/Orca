// Smoke tests against `vite preview` of the demo-data build (see playwright.config.ts): the home
// page, a fund page, that fund's first position page, the methodology and a not-found page, at
// desktop and phone width, light and dark (the two projects). Each page must show its heading, log
// no console or page errors, and not scroll sideways. The fund page also gets its sections and one
// click on a year bar checked in a real layout.
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
  { name: "position page", path: `/fund/${fundId}/stock/${stockId}` },
  { name: "not found", path: "/no-such-page" },
];
const widths = [1280, 400];

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
    test("fund page: every section is there, and clicking a year bar picks that year for Return constituents", async ({ page }) => {
      const errors = await open(page, `/fund/${fundId}`);
      await expect(page.locator("h1")).toHaveText(fundName);
      for (const name of ["Annual returns", "Assets under management", "Positions", "What if they'd kept it"]) {
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: /^Return constituents / })).toBeVisible();
      await expect(page.locator("#retPanel rect.hit").first()).toBeAttached();

      // a bar in the middle: the first and last carry the bracket's handles
      const hits = page.locator("#retPanel rect.hit");
      const aria = await hits.nth(Math.floor((await hits.count()) / 2)).getAttribute("aria-label");
      const label = (aria as string).split(":")[0];
      await page.getByRole("button", { name: new RegExp(`^${label}: `) }).click();
      await expect(page.getByRole("heading", { name: `Return constituents ${label}`, exact: true })).toBeVisible();
      await expect(page.locator("#retPanel rect.hit[aria-pressed='true']")).toHaveCount(1);
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
