import { defineConfig } from "@playwright/test";

// A port of our own, so a dev server on Vite's default 5173/4173 is never mistaken for this one.
const PORT = 4783;

export default defineConfig({
  testDir: "e2e", // Vitest's tests/*.test.ts files are not Playwright's
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // In CI the HTML report is written to playwright-report/ for the workflow to upload when a test fails.
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // A machine whose browser is installed elsewhere (not through `playwright install`) names it here.
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
  },
  // The viewport is set per describe block in e2e/smoke.spec.ts (1280 and 400 wide); the projects
  // run every test in each colour scheme.
  projects: [
    { name: "light", use: { colorScheme: "light" } },
    { name: "dark", use: { colorScheme: "dark" } },
  ],
  webServer: {
    // Always the demo-data build (public/demo-data, fetched from the same origin), whatever the
    // caller's environment says, then the production bundle served by `vite preview`.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { VITE_DATA_URL: "/demo-data", PRERENDER_FUNDS: "", PRERENDER_MAX: "", PRERENDER_DIST: "dist", SITE_URL: "", HSTS_MAX_AGE: "" },
    url: `http://127.0.0.1:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
