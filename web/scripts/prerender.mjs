// Pre-renders one page per fund so a search engine (or a reader without JavaScript) finds the
// fund's name, a description and its 13F book without running the app: dist/fund/{id}/index.html
// is dist/index.html with the <title> and meta description replaced and a <noscript> line added.
// The app mounts over it as usual. dist/index.html itself is left alone, and no 404.html is
// written: Cloudflare Pages then serves index.html for every other path.
//
// It also writes dist/_headers, which Cloudflare Pages applies to every response: the security
// headers (a Content-Security-Policy that names the data site's origin, so it is made here, from
// VITE_DATA_URL, and is not a static file in public/) and the long cache for the content-hashed
// files under /assets/. A VITE_DATA_URL that is malformed stops the build (scripts/dataOrigin.ts).
//
// Run by `npm run build` after `vite build`. Needs Node 22.18 or later (it imports money() from
// src/lib/format.ts, which Node runs by stripping the types). Environment, read from the process
// only (Vite's .env files are not consulted):
//   PRERENDER_DIST   the build directory (default "dist")
//   PRERENDER_FUNDS  a local funds.json to use instead of the sources below
//   VITE_DATA_URL    where the app loads its data from (default "/demo-data"): fetched as
//                    ${VITE_DATA_URL}/funds.json when it is an http(s) URL, otherwise read from
//                    dist${VITE_DATA_URL}/funds.json
//   PRERENDER_MAX    how many funds to write, largest 13F book first (default 15000): Cloudflare
//                    Pages allows 20,000 files per deployment and funds.json can list far more
//                    funds than that. The rest still work as single-page-app routes.
// Any problem (no funds.json, a malformed one, a missing index.html) stops the build.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { money } from "../src/lib/format.ts";
import { dataOrigin } from "./dataOrigin.ts";

const DEFAULT_MAX = 15000;
const WRITE_BATCH = 200;
const FETCH_TIMEOUT_MS = 60_000;

const fail = (message) => {
  throw new Error(message);
};

// Cloudflare Pages reads at most 2,000 characters per line of _headers.
const MAX_HEADER_LINE = 2000;

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fail(`${source} is not valid JSON (${err.message})`);
  }
}

async function readFunds(dist) {
  const file = process.env.PRERENDER_FUNDS;
  if (file) return readFundsFile(path.resolve(file));

  const base = (process.env.VITE_DATA_URL ?? "/demo-data").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return readFundsFile(path.join(dist, base, "funds.json"));

  const url = `${base}/funds.json`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fail(`cannot fetch ${url} (${err.cause?.message ?? err.message})`);
  }
  if (!res.ok) fail(`cannot fetch ${url}: HTTP ${res.status}`);
  return parseJson(await res.text(), url);
}

async function readFundsFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return fail(`cannot read funds from ${file} (${err.code ?? err.message})`);
  }
  return parseJson(text, file);
}

/** funds.json is column-oriented: {"v", "id": [], "name": [], "book": [], "n": []}. */
function toFunds(raw) {
  if (raw === null || typeof raw !== "object" || ![raw.id, raw.name, raw.book].every(Array.isArray)) {
    fail("funds.json must hold the columns id, name and book");
  }
  const { id, name, book } = raw;
  if (name.length !== id.length || book.length !== id.length) fail("funds.json columns differ in length");
  return id.map((fundId, i) => {
    // The id becomes a directory name: accept nothing but a plain positive integer.
    if (!Number.isSafeInteger(fundId) || fundId <= 0) fail(`funds.json: id ${JSON.stringify(fundId)} is not a positive integer`);
    if (typeof name[i] !== "string" || name[i] === "") fail(`funds.json: fund ${fundId} has no name`);
    return { id: fundId, name: name[i], book: book[i] };
  });
}

function parseMax(value) {
  if (value === undefined || value === "") return DEFAULT_MAX;
  if (!/^\d+$/.test(value)) fail(`PRERENDER_MAX must be a whole number, not "${value}"`);
  return Number(value);
}

const TITLE = /<title>[\s\S]*?<\/title>/;
const DESCRIPTION = /<meta\s+name=["']description["'][^>]*>/i;
const BODY_OPEN = /<body[^>]*>/i;

/** The shell's page for one fund. Replacers are functions so a "$&" in a name is copied as typed. */
function renderFund(template, fund) {
  const name = escapeHtml(fund.name);
  const description = `Estimated returns, P&amp;L and trades for ${name} from 13F filings.`;
  const noscript = `<noscript><p>${name}: 13F book ${money(fund.book)}. Turn on JavaScript to see estimated returns, P&amp;L and trades from 13F filings.</p></noscript>`;
  return template
    .replace(TITLE, () => `<title>${name} · Orca</title>`)
    .replace(DESCRIPTION, () => `<meta name="description" content="${description}" />`)
    .replace(BODY_OPEN, (body) => `${body}\n    ${noscript}`);
}

/**
 * The text of dist/_headers. `origin` is the data site's origin when the app loads its data from
 * another one (it is added to connect-src, the only directive that lets the page fetch from it),
 * or null when the data comes from the site itself.
 */
function renderHeaders(origin) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${origin === null ? "" : ` ${origin}`}`,
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
  const text = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Content-Security-Policy: ${csp}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
  const long = text.split("\n").find((line) => line.length > MAX_HEADER_LINE);
  if (long !== undefined) fail(`_headers has a line of ${long.length} characters; Cloudflare Pages reads at most ${MAX_HEADER_LINE}`);
  return text;
}

async function main() {
  const dist = path.resolve(process.env.PRERENDER_DIST || "dist");
  const max = parseMax(process.env.PRERENDER_MAX);
  const origin = dataOrigin(process.env.VITE_DATA_URL);
  const funds = toFunds(await readFunds(dist));

  const indexFile = path.join(dist, "index.html");
  let template;
  try {
    template = await readFile(indexFile, "utf8");
  } catch (err) {
    return fail(`cannot read ${indexFile} (${err.code ?? err.message}): run vite build first`);
  }
  for (const [what, re] of [["<title>", TITLE], ["meta description", DESCRIPTION], ["<body>", BODY_OPEN]]) {
    if (!re.test(template)) fail(`${indexFile} has no ${what} to replace`);
  }

  await writeFile(path.join(dist, "_headers"), renderHeaders(origin));
  console.log(`prerender: wrote _headers (data origin: ${origin ?? "the site itself"})`);

  // Largest book first (a fund without a number sorts last); equal books by id so the choice is stable.
  const bookOf = (f) => (Number.isFinite(f.book) ? f.book : -Infinity);
  const chosen = [...funds].sort((a, b) => bookOf(b) - bookOf(a) || a.id - b.id).slice(0, max);

  for (let i = 0; i < chosen.length; i += WRITE_BATCH) {
    await Promise.all(
      chosen.slice(i, i + WRITE_BATCH).map(async (fund) => {
        const dir = path.join(dist, "fund", String(fund.id));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "index.html"), renderFund(template, fund));
      }),
    );
  }
  const limited = chosen.length < funds.length ? ` (the largest of ${funds.length} funds by book)` : "";
  console.log(`prerender: wrote ${chosen.length} fund pages${limited}`);
}

try {
  await main();
} catch (err) {
  console.error(`prerender: ${err.message}`);
  process.exitCode = 1;
}
