// The preconnect hint to the data site: `vite build` (vite.config.ts) adds
// <link rel="preconnect" href="<origin>" crossorigin> to dist/index.html when VITE_DATA_URL is an
// absolute http(s) URL, and the fund pages that scripts/prerender.mjs copies from it carry it too.
// The same builds show that the demo data is dropped from a build with real data elsewhere.
// Real builds into temporary directories, as `npm run build` runs them; no network.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const PRERENDER = join(ROOT, "scripts", "prerender.mjs");
const DEMO_FUNDS = join(ROOT, "public", "demo-data", "funds.json");
const demoIds: number[] = JSON.parse(readFileSync(DEMO_FUNDS, "utf8")).id;

type Result = { code: number; stdout: string; stderr: string };

function node(args: string[], env: Record<string, string>): Promise<Result> {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("PRERENDER_") && !k.startsWith("VITE_") && k !== "SITE_URL" && k !== "HSTS_MAX_AGE",
    ),
  );
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...clean, ...env }, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const build = (out: string, env: Record<string, string>) =>
  node([VITE, "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], env);

const preconnects = (html: string) => html.match(/<link rel="preconnect"[^>]*>/g) ?? [];

let tmp: string;
const dirs = { plain: "", remote: "", bad: "" };
const results: Record<keyof typeof dirs, Result | undefined> = { plain: undefined, remote: undefined, bad: undefined };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "orca-preconnect-"));
  for (const k of Object.keys(dirs) as (keyof typeof dirs)[]) dirs[k] = join(tmp, k);
  const [plain, remote, bad] = await Promise.all([
    build(dirs.plain, {}),
    build(dirs.remote, { VITE_DATA_URL: "https://data.orcaetf.com/" }),
    build(dirs.bad, { VITE_DATA_URL: "https://data.orcaetf.com; script-src *" }),
  ]);
  Object.assign(results, { plain, remote, bad });
  // The fund pages are made from the remote build's index.html.
  const pages = await node([PRERENDER], { PRERENDER_DIST: dirs.remote, PRERENDER_FUNDS: DEMO_FUNDS, VITE_DATA_URL: "https://data.orcaetf.com/" });
  expect(pages.code, pages.stderr).toBe(0);
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("preconnect to the data site", () => {
  it("adds one anonymous preconnect to the data origin when VITE_DATA_URL is an absolute URL", () => {
    expect(results.remote?.code, results.remote?.stderr).toBe(0);
    const html = readFileSync(join(dirs.remote, "index.html"), "utf8");
    expect(preconnects(html)).toEqual(['<link rel="preconnect" href="https://data.orcaetf.com" crossorigin>']);
    // in the head, ahead of the scripts and styles that start the work
    expect(html.indexOf("rel=\"preconnect\"")).toBeLessThan(html.indexOf("<script"));
    expect(html.indexOf("</head>")).toBeGreaterThan(html.indexOf("rel=\"preconnect\""));
  });

  it("adds nothing for the same-origin default", () => {
    expect(results.plain?.code, results.plain?.stderr).toBe(0);
    expect(preconnects(readFileSync(join(dirs.plain, "index.html"), "utf8"))).toEqual([]);
  });

  it("the pre-rendered fund pages carry the hint too", () => {
    for (const id of demoIds) {
      const html = readFileSync(join(dirs.remote, "fund", String(id), "index.html"), "utf8");
      expect(preconnects(html)).toEqual(['<link rel="preconnect" href="https://data.orcaetf.com" crossorigin>']);
    }
  });

  it("the demo data is copied by Vite into a plain build, and removed from one with an absolute data URL", () => {
    expect(existsSync(join(dirs.plain, "demo-data", "funds.json"))).toBe(true);
    expect(existsSync(join(dirs.remote, "demo-data"))).toBe(false);
    expect(existsSync(join(dirs.remote, "_headers"))).toBe(true);
  });

  it("a malformed VITE_DATA_URL stops the build with the reason and writes no page", () => {
    expect(results.bad?.code).not.toBe(0);
    expect(`${results.bad?.stderr}${results.bad?.stdout}`).toMatch(/VITE_DATA_URL ".*" is not usable/);
    expect(existsSync(join(dirs.bad, "index.html"))).toBe(false);
  });
});
