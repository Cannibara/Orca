// scripts/prerender.mjs runs as a child process, the way `npm run build` runs it, against a
// temporary dist directory. Funds come from files on disk or from a throw-away server on
// 127.0.0.1: no real endpoint is ever called.
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { money } from "../src/lib/format";

// (not `new URL(..., import.meta.url)`: Vite rewrites that into an asset URL)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "prerender.mjs");
const DEMO_FUNDS = join(ROOT, "public", "demo-data", "funds.json");

type FundsIndex = { v: number; id: number[]; name: string[]; book: number[]; n: number[] };
const demo: FundsIndex = JSON.parse(readFileSync(DEMO_FUNDS, "utf8"));

// The page `vite build` writes, reduced to what the script touches.
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Orca turns 13F filings into estimated results for the big funds, stock by stock." />
    <title>Orca</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const tmpDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-prerender-"));
  tmpDirs.push(dir);
  return dir;
}

/** A dist directory holding only index.html. */
function makeDist(): string {
  const dist = join(tmp(), "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), TEMPLATE);
  return dist;
}

function writeFunds(index: Partial<FundsIndex> | unknown): string {
  const file = join(tmp(), "funds.json");
  writeFileSync(file, JSON.stringify(index));
  return file;
}

type Result = { code: number; stdout: string; stderr: string };

/** Run the script with only the variables given (the outer shell's PRERENDER_* / VITE_* are dropped). */
function run(dist: string, env: Record<string, string>): Promise<Result> {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("PRERENDER_") && !k.startsWith("VITE_")),
  );
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { cwd: ROOT, env: { ...clean, PRERENDER_DIST: dist, ...env }, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const page = (dist: string, id: number) => join(dist, "fund", String(id), "index.html");
const read = (file: string) => readFileSync(file, "utf8");
const tag = (html: string, re: RegExp) => re.exec(html)?.[1];
const title = (html: string) => tag(html, /<title>([\s\S]*?)<\/title>/);
const description = (html: string) => tag(html, /<meta name="description" content="([^"]*)"/);
const noscript = (html: string) => tag(html, /<noscript>([\s\S]*?)<\/noscript>/);
const pageDirs = (dist: string) => (existsSync(join(dist, "fund")) ? readdirSync(join(dist, "fund")) : []);

/** Answer `path` with `status` and `body` (anything else is a 404) on 127.0.0.1; resolves to the base URL and the paths requested. */
async function serve(path: string, body: unknown, status = 200) {
  const requested: string[] = [];
  const server = createServer((req, res) => {
    requested.push(req.url ?? "");
    res.writeHead(req.url === path ? status : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requested };
}

describe("prerender: fund pages from demo data", () => {
  it("writes one page per demo fund with the name in <title>, the description and the book", async () => {
    const dist = makeDist();
    const r = await run(dist, { PRERENDER_FUNDS: DEMO_FUNDS });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);

    expect(pageDirs(dist).sort()).toEqual(demo.id.map(String).sort());
    demo.id.forEach((id, i) => {
      const html = read(page(dist, id));
      expect(title(html)).toBe(`${demo.name[i]} · Orca`);
      expect(description(html)).toBe(
        `Estimated returns, P&amp;L and trades for ${demo.name[i]} from 13F filings.`,
      );
      expect(noscript(html)).toContain(money(demo.book[i]));
      expect(noscript(html)).toContain(demo.name[i]);
    });
  });

  it("keeps the rest of the shell: one title, one description, the app script, the root element", async () => {
    const dist = makeDist();
    await run(dist, { PRERENDER_FUNDS: DEMO_FUNDS });
    const html = read(page(dist, demo.id[0]));
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    expect(html.match(/<noscript>/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc123.js"></script>');
    expect(html).toContain('<div id="root"></div>');
  });

  it("leaves dist/index.html alone and writes no 404.html (Pages' SPA fallback must stay on)", async () => {
    const dist = makeDist();
    await run(dist, { PRERENDER_FUNDS: DEMO_FUNDS });
    expect(read(join(dist, "index.html"))).toBe(TEMPLATE);
    expect(readdirSync(dist).sort()).toEqual(["fund", "index.html"]);
    expect(existsSync(join(dist, "404.html"))).toBe(false);
    expect(existsSync(join(dist, "_redirects"))).toBe(false);
  });
});

describe("prerender: escaping", () => {
  it("escapes fund names in the title, description and noscript, and copies $-sequences literally", async () => {
    const hostile = `A&B <script>alert("x")</script> 'q' $& $' $1 Fund`;
    const dist = makeDist();
    const funds = writeFunds({ v: 1, id: [7], name: [hostile], book: [2.5e9], n: [3] });
    const r = await run(dist, { PRERENDER_FUNDS: funds });
    expect(r.code).toBe(0);

    const html = read(page(dist, 7));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('"x"');
    const escaped = `A&amp;B &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;q&#39; $&amp; $&#39; $1 Fund`;
    expect(title(html)).toBe(`${escaped} · Orca`);
    expect(description(html)).toBe(`Estimated returns, P&amp;L and trades for ${escaped} from 13F filings.`);
    expect(noscript(html)).toContain(escaped);
    expect(noscript(html)).toContain("$2.50B");
  });
});

describe("prerender: how many funds", () => {
  it("PRERENDER_MAX keeps the largest funds by book", async () => {
    const dist = makeDist();
    const r = await run(dist, { PRERENDER_FUNDS: DEMO_FUNDS, PRERENDER_MAX: "3" });
    expect(r.code).toBe(0);

    const largest = demo.id
      .map((id, i) => ({ id, book: demo.book[i] }))
      .sort((a, b) => b.book - a.book)
      .slice(0, 3)
      .map((f) => String(f.id));
    expect(pageDirs(dist).sort()).toEqual(largest.sort());
  });

  it("breaks ties on book by the lower id, and puts a fund without a book last", async () => {
    const dist = makeDist();
    const funds = writeFunds({
      v: 1,
      id: [5, 3, 4, 2, 1],
      name: ["Five", "Three", "Four", "Two", "One"],
      book: [1e9, 1e9, 1e9, null, 1e9],
      n: [1, 1, 1, 1, 1],
    });
    const r = await run(dist, { PRERENDER_FUNDS: funds, PRERENDER_MAX: "4" });
    expect(r.code).toBe(0);
    expect(pageDirs(dist).sort()).toEqual(["1", "3", "4", "5"]);
  });

  it("defaults to the 15,000 largest funds",{ timeout: 60_000 }, async () => {
    const count = 15_001;
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    const funds = writeFunds({
      v: 1,
      id: ids,
      name: ids.map((id) => `Fund ${id}`),
      book: ids, // the book grows with the id, so fund 1 is the smallest
      n: ids.map(() => 1),
    });
    const dist = makeDist();
    const r = await run(dist, { PRERENDER_FUNDS: funds });
    expect(r.code).toBe(0);

    expect(pageDirs(dist)).toHaveLength(15_000);
    expect(existsSync(page(dist, 1))).toBe(false);
    expect(existsSync(page(dist, 2))).toBe(true);
    expect(existsSync(page(dist, count))).toBe(true);
  });

  it("PRERENDER_MAX=0 writes nothing and still succeeds", async () => {
    const dist = makeDist();
    const r = await run(dist, { PRERENDER_FUNDS: DEMO_FUNDS, PRERENDER_MAX: "0" });
    expect(r.code).toBe(0);
    expect(pageDirs(dist)).toEqual([]);
  });
});

describe("prerender: where the funds come from", () => {
  it("reads dist/demo-data/funds.json when no source is configured", async () => {
    const dist = makeDist();
    mkdirSync(join(dist, "demo-data"));
    copyFileSync(DEMO_FUNDS, join(dist, "demo-data", "funds.json"));
    const r = await run(dist, {});
    expect(r.code).toBe(0);
    expect(pageDirs(dist)).toHaveLength(demo.id.length);
  });

  it("reads a relative VITE_DATA_URL from inside dist", async () => {
    const dist = makeDist();
    mkdirSync(join(dist, "data"));
    copyFileSync(DEMO_FUNDS, join(dist, "data", "funds.json"));
    const r = await run(dist, { VITE_DATA_URL: "/data/" });
    expect(r.code).toBe(0);
    expect(pageDirs(dist)).toHaveLength(demo.id.length);
  });

  it("fetches ${VITE_DATA_URL}/funds.json when VITE_DATA_URL is an absolute URL", async () => {
    const { base, requested } = await serve("/site/funds.json", demo);
    const dist = makeDist();
    const r = await run(dist, { VITE_DATA_URL: `${base}/site/` });
    expect(r.code).toBe(0);
    expect(requested).toEqual(["/site/funds.json"]);
    expect(pageDirs(dist)).toHaveLength(demo.id.length);
  });

  it("PRERENDER_FUNDS wins over VITE_DATA_URL", async () => {
    const { requested, base } = await serve("/funds.json", demo);
    const dist = makeDist();
    const funds = writeFunds({ v: 1, id: [42], name: ["Only Fund"], book: [1e9], n: [1] });
    const r = await run(dist, { PRERENDER_FUNDS: funds, VITE_DATA_URL: base });
    expect(r.code).toBe(0);
    expect(requested).toEqual([]);
    expect(pageDirs(dist)).toEqual(["42"]);
  });
});

describe("prerender: fails loudly", () => {
  const badFunds = (index: unknown) => () => run(makeDist(), { PRERENDER_FUNDS: writeFunds(index) });
  const cases: [string, () => Promise<Result>, RegExp][] = [
    [
      "PRERENDER_FUNDS names a missing file",
      () => run(makeDist(), { PRERENDER_FUNDS: "/nonexistent/funds.json" }),
      /cannot read funds from \/nonexistent\/funds\.json/,
    ],
    ["there is no funds.json under dist", () => run(makeDist(), {}), /cannot read funds from .*demo-data.*funds\.json/],
    [
      "the funds file is not JSON",
      () => {
        const file = join(tmp(), "funds.json");
        writeFileSync(file, "<html>not json</html>");
        return run(makeDist(), { PRERENDER_FUNDS: file });
      },
      /not valid JSON/,
    ],
    ["a funds column is missing", badFunds({ v: 1, id: [1], name: ["A"] }), /columns id, name and book/],
    [
      "the funds columns differ in length",
      badFunds({ v: 1, id: [1, 2], name: ["A"], book: [1, 2], n: [1, 2] }),
      /differ in length/,
    ],
    ["a fund id is not a positive integer", badFunds({ v: 1, id: ["../x"], name: ["A"], book: [1], n: [1] }), /not a positive integer/],
    ["a fund name is not a string", badFunds({ v: 1, id: [1], name: [null], book: [1], n: [1] }), /fund 1 has no name/],
    [
      "PRERENDER_MAX is not a whole number",
      () => run(makeDist(), { PRERENDER_FUNDS: DEMO_FUNDS, PRERENDER_MAX: "lots" }),
      /PRERENDER_MAX must be a whole number/,
    ],
    [
      "dist has no index.html",
      () => {
        const dist = makeDist();
        rmSync(join(dist, "index.html"));
        return run(dist, { PRERENDER_FUNDS: DEMO_FUNDS });
      },
      /cannot read .*index\.html/,
    ],
    [
      "index.html has no <title> to replace",
      () => {
        const dist = makeDist();
        writeFileSync(join(dist, "index.html"), TEMPLATE.replace(/<title>.*<\/title>/, ""));
        return run(dist, { PRERENDER_FUNDS: DEMO_FUNDS });
      },
      /index\.html has no <title> to replace/,
    ],
  ];

  it.each(cases)("exits non-zero with a message when %s", async (_name, go, message) => {
    const r = await go();
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^prerender: /);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe("");
  });

  it("exits non-zero and writes no pages when the data server answers 404", async () => {
    const { base } = await serve("/funds.json", demo, 404);
    const dist = makeDist();
    const r = await run(dist, { VITE_DATA_URL: base });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("404");
    expect(pageDirs(dist)).toEqual([]);
  });
});
