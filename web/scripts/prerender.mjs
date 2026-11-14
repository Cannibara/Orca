// Pre-renders one page per fund so a search engine (or a reader without JavaScript) finds the
// fund's name, a description and its 13F book without running the app: dist/fund/{id}/index.html
// is dist/index.html with the <title> and meta description replaced and a <noscript> line added.
// The app mounts over it as usual. dist/index.html itself is left alone, and no 404.html is
// written: Cloudflare Pages then serves index.html for every other path.
//
// It also writes dist/_headers, which Cloudflare Pages applies to every response: the security
// headers (a Content-Security-Policy that names the data site's origin, so it is made here, from
// VITE_DATA_URL, and is not a static file in public/; and HSTS), the long cache for the
// content-hashed files under /assets/, and "noindex" for the pages.dev addresses (the website
// lives at its own domain; the old address must not compete with it in search results). A
// VITE_DATA_URL that is malformed stops the build (scripts/dataOrigin.ts).
//
// When VITE_DATA_URL is an absolute URL the real data lives elsewhere, so the fictional demo files
// that Vite copies from public/demo-data are removed from dist: they must not ship to production.
//
// When SITE_URL (the website's own address) is set it also writes the search-engine files:
// <link rel="canonical"> in every pre-rendered fund page (and only there: the other routes are one
// shared index.html, which cannot know its own address), dist/sitemap.xml and dist/robots.txt.
// Without it none of those exist, and the demo build used by CI and the e2e tests is unchanged.
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
//   PRERENDER_RICH   how many of those pages (largest book first) also get their latest holdings and
//                    estimated return written into the HTML, read from the data site's per-fund
//                    summary.json (default 500; 0 turns it off). The rest get the fund's name and book.
//                    A file that cannot be read only costs that fund its extra text, never the build.
//                    The files are read from VITE_DATA_URL even when PRERENDER_FUNDS names the funds file.
//   SITE_URL         the website's own address, https://www.orcaetf.com (https, no path, no
//                    trailing slash); unset means no canonical links, sitemap.xml or robots.txt
//   HSTS_MAX_AGE     seconds of the Strict-Transport-Security header (default 15552000, six
//                    months; 0 makes browsers forget it: the way to undo it)
// Any problem (no funds.json, a malformed one, a missing index.html) stops the build.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { count, fmtDate, fundTitle, money, pct, qLabel, tidyName } from "../src/lib/format.ts";
import { dataOrigin } from "./dataOrigin.ts";
import { siteUrl } from "./siteUrl.ts";

const DEFAULT_MAX = 15000;
const DEFAULT_RICH = 500;
const RICH_CONCURRENCY = 16;
const RICH_TIMEOUT_MS = 20_000;
const TOP_POSITIONS = 10; // rows of the holdings table in a rich page
const RELATED_FUNDS = 8; // links to the funds next in size, so the pages link to each other
const WRITE_BATCH = 200;
const FETCH_TIMEOUT_MS = 60_000;

const fail = (message) => {
  throw new Error(message);
};

// Cloudflare Pages reads at most 2,000 characters per line of _headers.
const MAX_HEADER_LINE = 2000;
// Six months. No includeSubDomains (the other hosts of the domain are not this site's to decide)
// and no preload (a preload-list entry cannot be taken back).
const DEFAULT_HSTS_MAX_AGE = 15_552_000;
const MAX_HSTS_MAX_AGE = 63_072_000; // two years
// The sitemap protocol allows 50,000 URLs and 50 MB (uncompressed) per file.
const MAX_SITEMAP_URLS = 50_000;
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

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

function parseRich(value) {
  if (value === undefined || value === "") return DEFAULT_RICH;
  if (!/^\d+$/.test(value)) fail(`PRERENDER_RICH must be a whole number, not "${value}"`);
  return Number(value);
}

function parseHstsMaxAge(value) {
  if (value === undefined || value === "") return DEFAULT_HSTS_MAX_AGE;
  if (!/^\d{1,10}$/.test(value) || Number(value) > MAX_HSTS_MAX_AGE) {
    const shown = JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
    fail(`HSTS_MAX_AGE must be a whole number of seconds from 0 to ${MAX_HSTS_MAX_AGE}, not ${shown}`);
  }
  return Number(value);
}

/** The funds around position `i` of the list (largest book first), `RELATED_FUNDS` of them, not the fund itself. */
function relatedTo(list, i) {
  const from = Math.max(0, Math.min(i - RELATED_FUNDS / 2, list.length - RELATED_FUNDS - 1));
  return list.slice(from, from + RELATED_FUNDS + 1).filter((_, k) => from + k !== i).slice(0, RELATED_FUNDS);
}

const fundPath = (id) => `/fund/${id}/`;

const TITLE = /<title>[\s\S]*?<\/title>/;
const DESCRIPTION = /<meta\s+name=["']description["'][^>]*>/i;
const BODY_OPEN = /<body[^>]*>/i;

// The names the site goes by, for search engines (a browser always shows a domain in lower case; text we write can use these capitals).
const SITE_NAMES = ["OrcaETF.com", "OrcaETF"];

const ROOT_EMPTY = /<div id="root"><\/div>/;

/**
 * One JSON file of the data site (or of dist, for local data), or null when it cannot be read or is
 * not JSON: the extra text of a page is optional, so a missing file must never stop the build.
 */
async function readData(dist, rel) {
  const base = (process.env.VITE_DATA_URL ?? "/demo-data").replace(/\/+$/, "");
  try {
    if (/^https?:\/\//i.test(base)) {
      const res = await fetch(`${base}/${rel}`, { signal: AbortSignal.timeout(RICH_TIMEOUT_MS) });
      return res.ok ? JSON.parse(await res.text()) : null;
    }
    return JSON.parse(await readFile(path.join(dist, base, rel), "utf8"));
  } catch {
    return null;
  }
}

/**
 * What a rich page says about a fund, from its summary.json: the latest 13F quarter, the book, the
 * number of positions, the estimated annual return and the largest positions at the latest prices
 * (shares x latest close; a stock without a price is left out). null for anything malformed.
 */
function richFrom(summary, stocks, prices) {
  try {
    const h = summary.holdings_now;
    if (!Number.isInteger(summary.period_q) || !Array.isArray(h.stock_id) || !Array.isArray(h.shares)) return null;
    const rows = [];
    h.stock_id.forEach((id, i) => {
      const price = prices.get(id);
      const shares = h.shares[i];
      if (Number.isFinite(price) && Number.isFinite(shares) && shares > 0) rows.push({ id, shares, value: price * shares });
    });
    const total = rows.reduce((sum, r) => sum + r.value, 0);
    const top = total > 0
      ? rows.sort((a, b) => b.value - a.value || a.id - b.id).slice(0, TOP_POSITIONS).map((r) => {
          const stock = stocks.get(r.id);
          const label = stock?.ticker || tidyName(stock?.name ?? "");
          return { label: label === "" ? `#${r.id}` : label, name: tidyName(stock?.name ?? ""), weight: r.value / total };
        })
      : [];
    const m = summary.metrics ?? {};
    return {
      periodQ: summary.period_q,
      filed: typeof summary.filed === "string" ? summary.filed : null,
      book: Number.isFinite(summary.book) ? summary.book : null,
      n: Number.isInteger(summary.n_holdings) ? summary.n_holdings : null,
      ann: Number.isFinite(m.ann_return) ? m.ann_return : null,
      first: Number.isInteger(m.first_year) ? m.first_year : null,
      last: Number.isInteger(m.last_year) ? m.last_year : null,
      top,
    };
  } catch {
    return null;
  }
}

/** The rich text of the first `funds` (already in the order to serve), keyed by fund id; empty when securities or prices cannot be read. */
async function loadRich(dist, funds) {
  if (funds.length === 0) return new Map();
  const [securities, latest] = await Promise.all([readData(dist, "securities.json"), readData(dist, "latest_prices.json")]);
  if (!securities || !latest || !Array.isArray(securities.stock_id) || !Array.isArray(latest.stock_id)) {
    console.log("prerender: securities.json or latest_prices.json could not be read: fund pages get no holdings text");
    return new Map();
  }
  const stocks = new Map(securities.stock_id.map((id, i) => [id, { ticker: securities.ticker?.[i] ?? "", name: securities.name?.[i] ?? "" }]));
  const prices = new Map(latest.stock_id.map((id, i) => [id, latest.price?.[i]]));
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < funds.length) {
      const fund = funds[next++];
      const summary = await readData(dist, `fund/${fund.id}/summary.json`);
      const rich = summary === null ? null : richFrom(summary, stocks, prices);
      if (rich !== null) out.set(fund.id, rich);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RICH_CONCURRENCY, funds.length) }, worker));
  return out;
}

/** A sentence for the meta description: at most about 300 characters, cut at a word. */
function clip(text, max = 300) {
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** The text a crawler reads before any script runs: heading, summary, largest positions, links. The app replaces it when it mounts. All values are escaped. */
function renderStatic(fund, rich, related) {
  const name = escapeHtml(fund.name);
  const book = money(fund.book);
  const intro = rich === null
    ? `${name} has a 13F book of ${book}.`
    : `${name} filed its latest 13F for ${qLabel(rich.periodQ)}${rich.filed === null ? "" : ` on ${escapeHtml(fmtDate(rich.filed))}`}.` +
      `${rich.n === null ? "" : ` It held ${count(rich.n, "position")}`}` +
      `${rich.n === null ? " Its" : " with a"} 13F book of ${money(rich.book ?? fund.book)}.` +
      `${rich.ann === null || rich.first === null || rich.last === null ? "" : ` Orca estimates its return at ${pct(rich.ann)} a year from ${rich.first} to ${rich.last}.`}`;
  const table = rich === null || rich.top.length === 0 ? "" : `
      <table>
        <caption>Largest positions at the latest prices (Orca estimate)</caption>
        <thead><tr><th scope="col">Stock</th><th scope="col">Weight</th></tr></thead>
        <tbody>${rich.top.map((r) => `<tr><td>${escapeHtml(r.label)}${r.name === "" || r.name === r.label ? "" : ` ${escapeHtml(r.name)}`}</td><td>${pct(r.weight, 1, false)}</td></tr>`).join("")}</tbody>
      </table>`;
  const links = related.length === 0 ? "" : `
      <h2>Other large hedge funds</h2>
      <ul>${related.map((f) => `<li><a href="${fundPath(f.id)}">${escapeHtml(f.name)}</a></li>`).join("")}</ul>`;
  return `<main>
      <h1>${name}: 13F holdings and estimated returns</h1>
      <p>${intro}</p>${table}
      <p><a href="/">Orca: hedge fund holdings and returns from 13F filings</a></p>${links}
    </main>`;
}

/**
 * The shell's page for one fund. Replacers are functions so a "$&" in a name is copied as typed.
 * `site` is the website's address, or null: the canonical link names this very page (the one with
 * the trailing slash, which is where Pages serves dist/fund/{id}/index.html). `rich` is the fund's
 * extra text (or null) and `related` the funds linked at the bottom.
 */
function renderFund(template, fund, site, image, rich = null, related = []) {
  const name = escapeHtml(fund.name);
  const page = site === null ? null : `${site}${fundPath(fund.id)}`;
  const canonical = page === null ? "" : `\n    <link rel="canonical" href="${escapeHtml(page)}" />`;
  const top = rich === null ? [] : rich.top.slice(0, 3).map((r) => r.label);
  const plain = `${fund.name} 13F holdings, estimated returns and stock-by-stock P&L. 13F book ${money(fund.book)}.`;
  const detail = rich === null || rich.n === null ? plain
    : clip(`${fund.name} 13F holdings for ${qLabel(rich.periodQ)}: ${count(rich.n, "position")}, ${money(rich.book ?? fund.book)} book.` +
        `${top.length === 0 ? "" : ` Top: ${top.join(", ")}.`} Orca estimates its returns and stock-by-stock P&L.`);
  const description = escapeHtml(detail);
  const title = escapeHtml(fundTitle(fund.name));
  const noscript = `<noscript><p>Turn on JavaScript to see ${name}'s charts, full holdings and each stock's estimated profit and loss from 13F filings.</p></noscript>`;
  const share = shareTags(title, description, page, image);
  const ld = page === null ? "" : `\n    ${jsonLd({ "@context": "https://schema.org", "@type": "WebPage", name: fund.name, description: detail, url: page, isPartOf: { "@type": "WebSite", name: "Orca", alternateName: SITE_NAMES, url: site } })}`;
  return template
    .replace(TITLE, () => `<title>${title}</title>`)
    .replace(DESCRIPTION, () => `<meta name="description" content="${description}" />${canonical}${share}${ld}`)
    .replace(BODY_OPEN, (body) => `${body}\n    ${noscript}`)
    .replace(ROOT_EMPTY, () => `<div id="root">\n    ${renderStatic(fund, rich, related)}\n    </div>`);
}

/** Open Graph and Twitter tags. `page` is null for the shared shell (it is every route, so no fixed og:url); `image` is an absolute URL or null. */
function shareTags(title, description, page, image) {
  const tags = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "OrcaETF.com"],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ...(page === null ? [] : [["property", "og:url", escapeHtml(page)]]),
    ...(image === null ? [] : [["property", "og:image", image]]),
    ["name", "twitter:card", image === null ? "summary" : "summary_large_image"],
  ];
  return tags.map(([k, n, v]) => `\n    <meta ${k}="${n}" content="${v}" />`).join("");
}

/** A JSON-LD block. "<" is escaped so a fund name can never close the script tag. */
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

/**
 * The text of dist/_headers. `origin` is the data site's origin when the app loads its data from
 * another one (it is added to connect-src, the only directive that lets the page fetch from it),
 * or null when the data comes from the site itself. `hsts` is the max-age of Strict-Transport-Security.
 *
 * Cloudflare Pages gives a request the headers of every rule it matches. The last two rules match
 * hosts, not paths: ":project" is a placeholder that stands for one label of the host (no dots), so
 * https://:project.pages.dev/* is the Pages address of this site (orca-88p.pages.dev) and
 * https://:version.:project.pages.dev/* its preview deployments (abc123.orca-88p.pages.dev). Neither
 * can match the custom domain.
 */
function renderHeaders(origin, hsts) {
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
  Strict-Transport-Security: max-age=${hsts}
  Content-Security-Policy: ${csp}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
https://:project.pages.dev/*
  X-Robots-Tag: noindex
https://:version.:project.pages.dev/*
  X-Robots-Tag: noindex
`;
  const long = text.split("\n").find((line) => line.length > MAX_HEADER_LINE);
  if (long !== undefined) fail(`_headers has a line of ${long.length} characters; Cloudflare Pages reads at most ${MAX_HEADER_LINE}`);
  return text;
}

/** dist/sitemap.xml: the home page and the pre-rendered fund pages (sitemaps.org protocol). */
function renderSitemap(site, funds, lastmod = null) {
  const urls = [`${site}/`, ...funds.map((f) => `${site}${fundPath(f.id)}`)];
  const stamp = lastmod === null ? "" : `<lastmod>${lastmod}</lastmod>`;
  if (urls.length > MAX_SITEMAP_URLS) {
    fail(`sitemap.xml would list ${urls.length} URLs and one file may list ${MAX_SITEMAP_URLS}: lower PRERENDER_MAX`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeHtml(url)}</loc>${stamp}</url>`).join("\n")}
</urlset>
`;
  const bytes = Buffer.byteLength(xml);
  if (bytes > MAX_SITEMAP_BYTES) fail(`sitemap.xml would be ${bytes} bytes and one file may hold ${MAX_SITEMAP_BYTES}: lower PRERENDER_MAX`);
  return { xml, count: urls.length };
}

/** dist/robots.txt: everything may be crawled, and where the sitemap is. */
const renderRobots = (site) => `User-agent: *
Allow: /

Sitemap: ${site}/sitemap.xml
`;

async function main() {
  const dist = path.resolve(process.env.PRERENDER_DIST || "dist");
  const max = parseMax(process.env.PRERENDER_MAX);
  const richMax = parseRich(process.env.PRERENDER_RICH);
  const origin = dataOrigin(process.env.VITE_DATA_URL);
  const site = siteUrl(process.env.SITE_URL);
  const hsts = parseHstsMaxAge(process.env.HSTS_MAX_AGE);
  const funds = toFunds(await readFunds(dist));

  const indexFile = path.join(dist, "index.html");
  let template;
  try {
    template = await readFile(indexFile, "utf8");
  } catch (err) {
    return fail(`cannot read ${indexFile} (${err.code ?? err.message}): run vite build first`);
  }
  for (const [what, re] of [["<title>", TITLE], ["meta description", DESCRIPTION], ["<body>", BODY_OPEN], ['<div id="root"></div>', ROOT_EMPTY]]) {
    if (!re.test(template)) fail(`${indexFile} has no ${what} to replace`);
  }

  // Largest book first (a fund without a number sorts last); equal books by id so the choice is stable.
  const bookOf = (f) => (Number.isFinite(f.book) ? f.book : -Infinity);
  const chosen = [...funds].sort((a, b) => bookOf(b) - bookOf(a) || a.id - b.id).slice(0, max);
  // Made before anything is written, so a sitemap over the limit stops the build early.
  // The date the data was last built (manifest.json "built"), when the data site says: every page's content is that old at most.
  const built = site === null ? null : (await readData(dist, "manifest.json"))?.built;
  const lastmod = typeof built === "string" && /^\d{4}-\d{2}-\d{2}/.test(built) ? built.slice(0, 10) : null;
  const sitemap = site === null ? null : renderSitemap(site, chosen, lastmod);

  // The production build reads funds.json from a file (PRERENDER_FUNDS) and still reads the rest from VITE_DATA_URL.
  const rich = await loadRich(dist, chosen.slice(0, richMax));
  console.log(`prerender: holdings text for ${rich.size} of ${Math.min(richMax, chosen.length)} fund pages asked for`);

  // The share image is optional: only linked when the file was shipped in public/.
  const hasImage = await stat(path.join(dist, "og-default.png")).then(() => true, () => false);
  const image = site !== null && hasImage ? `${site}/og-default.png` : null;
  if (site !== null) {
    // The shared shell serves every other route: share tags without a page address.
    const desc = (template.match(DESCRIPTION)?.[0].match(/content="([^"]*)"/) ?? [])[1] ?? "";
    const site_ld = jsonLd({ "@context": "https://schema.org", "@type": "WebSite", name: "Orca", alternateName: SITE_NAMES, url: `${site}/` });
    const shell = template.replace(DESCRIPTION, (d) => `${d}${shareTags("Orca", desc, null, image)}\n    ${site_ld}`);
    await writeFile(indexFile, shell);
  }

  await writeFile(path.join(dist, "_headers"), renderHeaders(origin, hsts));
  console.log(`prerender: wrote _headers (data origin: ${origin ?? "the site itself"})`);
  if (origin !== null && (await stat(path.join(dist, "demo-data")).then(() => true, () => false))) {
    // The data is elsewhere: the fictional demo files Vite copied from public/ must not ship.
    await rm(path.join(dist, "demo-data"), { recursive: true, force: true });
    console.log(`prerender: removed demo-data from ${path.basename(dist)} (the data comes from ${origin})`);
  }
  if (sitemap !== null) {
    await writeFile(path.join(dist, "sitemap.xml"), sitemap.xml);
    await writeFile(path.join(dist, "robots.txt"), renderRobots(site));
    console.log(`prerender: wrote sitemap.xml (${sitemap.count} URLs) and robots.txt for ${site}`);
  }

  for (let i = 0; i < chosen.length; i += WRITE_BATCH) {
    await Promise.all(
      chosen.slice(i, i + WRITE_BATCH).map(async (fund, j) => {
        const dir = path.join(dist, "fund", String(fund.id));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "index.html"), renderFund(template, fund, site, image, rich.get(fund.id) ?? null, relatedTo(chosen, i + j)));
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
