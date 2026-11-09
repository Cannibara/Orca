import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { dataOrigin } from "./scripts/dataOrigin";

/**
 * When the app loads its data from another origin (VITE_DATA_URL is an absolute http(s) URL, read
 * from the process environment like scripts/prerender.mjs does), start the connection to it while
 * the page's scripts download: <link rel="preconnect" crossorigin> in the head of index.html. The
 * pre-rendered fund pages are copies of that index.html, so they get it too. Nothing is added for
 * the same-origin default. A malformed value stops the build (see scripts/dataOrigin.ts); it is
 * checked when the page is transformed, so tools that only load this file (Vitest) never see it.
 */
export function preconnectToData(): Plugin {
  return {
    name: "orca:preconnect-to-data",
    apply: "build",
    transformIndexHtml() {
      const origin = dataOrigin(process.env.VITE_DATA_URL);
      if (origin === null) return undefined;
      return [{ tag: "link", attrs: { rel: "preconnect", href: origin, crossorigin: true }, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  plugins: [react(), preconnectToData()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
});
