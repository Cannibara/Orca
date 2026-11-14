// Pre-renders one page per fund so a search engine (or a reader without JavaScript) finds the
// fund's name, a description and its 13F book without running the app: dist/fund/{id}/index.html
// is dist/index.html with the <title>, the meta description and their Open Graph twins replaced and
// a <noscript> line added. The app mounts over it as usual. No 404.html is written: Cloudflare Pages
// then serves index.html for every other path.
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
// It also adds the link-preview image: og:image must be an absolute URL, so the tags for
// og-image.png (copied from public/) go into dist/index.html and every fund page, with og:url on
// the fund pages only (for the same reason as the canonical link). This is the one change made to
// dist/index.html, and it is skipped when dist has no og-image.png. Without SITE_URL none of those
// exist, and the demo build used by CI and the e2e tests is unchanged.
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
//   SITE_URL         the website's own address, https://www.orcaetf.com (https, no path, no
//                    trailing slash); unset means no canonical links, sitemap.xml or robots.txt
//   HSTS_MAX_AGE     seconds of the Strict-Transport-Security header (default 15552000, six
//                    months; 0 makes browsers forget it: the way to undo it)
// Any problem (no funds.json, a malformed one, a missing index.html) stops the build.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { money } from "../src/lib/format.ts";
import { dataOrigin } from "./dataOrigin.ts";
import { siteUrl } from "./siteUrl.ts";

const DEFAULT_MAX = 15000;
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

function parseHstsMaxAge(value) {
  if (value === undefined || value === "") return DEFAULT_HSTS_MAX_AGE;
  if (!/^\d{1,10}$/.test(value) || Number(value) > MAX_HSTS_MAX_AGE) {
    const shown = JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
    fail(`HSTS_MAX_AGE must be a whole number of seconds from 0 to ${MAX_HSTS_MAX_AGE}, not ${shown}`);
  }
  return Number(value);
}

const fundPath = (id) => `/fund/${id}/`;

const TITLE = /<title>[\s\S]*?<\/title>/;
const DESCRIPTION = /<meta\s+name=["']description["'][^>]*>/i;
const OG_TITLE = /<meta\s+property=["']og:title["'][^>]*>/i;
const OG_DESCRIPTION = /<meta\s+property=["']og:description["'][^>]*>/i;
const BODY_OPEN = /<body[^>]*>/i;
const HEAD_CLOSE = /\n([ \t]*)<\/head>/i;
// The link-preview card (docs/brand/og-image.png, copied to public/ and so to dist/).
const OG_IMAGE = { file: "og-image.png", width: 1200, height: 630, alt: "The Orca logo and the line: Estimated fund returns from SEC 13F filings" };

/**
 * The shell's page for one fund. Replacers are functions so a "$&" in a name is copied as typed.
 * `site` is the website's address, or null: the canonical link names this very page (the one with
 * the trailing slash, which is where Pages serves dist/fund/{id}/index.html).
 */
function renderFund(template, fund, site) {
  const name = escapeHtml(fund.name);
  const canonical = site === null ? "" : `\n    <link rel="canonical" href="${escapeHtml(`${site}${fundPath(fund.id)}`)}" />`;
  const description = `Estimated returns, P&amp;L and trades for ${name} from 13F filings.`;
  const noscript = `<noscript><p>${name}: 13F book ${money(fund.book)}. Turn on JavaScript to see estimated returns, P&amp;L and trades from 13F filings.</p></noscript>`;
  return template
    .replace(TITLE, () => `<title>${name} · Orca</title>`)
    .replace(DESCRIPTION, () => `<meta name="description" content="${description}" />${canonical}`)
    .replace(OG_TITLE, () => `<meta property="og:title" content="${name} · Orca" />`)
    .replace(OG_DESCRIPTION, () => `<meta property="og:description" content="${description}" />`)
    .replace(BODY_OPEN, (body) => `${body}\n    ${noscript}`);
}

/**
 * `html` with the link-preview image tags added at the end of <head>: og:image is absolute, as Open
 * Graph requires, so they exist only with a site address. `url` is the page's own address for
 * og:url, or null for dist/index.html, which is every other route and so has no one address.
 */
function withPreviewImage(html, site, url) {
  const tags = [
    ...(url === null ? [] : [`<meta property="og:url" content="${escapeHtml(url)}" />`]),
    `<meta property="og:image" content="${escapeHtml(`${site}/${OG_IMAGE.file}`)}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE.alt)}" />`,
  ];
  return html.replace(HEAD_CLOSE, (_, indent) => `\n${tags.map((t) => `${indent}  ${t}`).join("\n")}\n${indent}</head>`);
}

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
function renderSitemap(site, funds) {
  const urls = [`${site}/`, ...funds.map((f) => `${site}${fundPath(f.id)}`)];
  if (urls.length > MAX_SITEMAP_URLS) {
    fail(`sitemap.xml would list ${urls.length} URLs and one file may list ${MAX_SITEMAP_URLS}: lower PRERENDER_MAX`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`).join("\n")}
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
  for (const [what, re] of [["<title>", TITLE], ["meta description", DESCRIPTION], ["<body>", BODY_OPEN]]) {
    if (!re.test(template)) fail(`${indexFile} has no ${what} to replace`);
  }

  // Largest book first (a fund without a number sorts last); equal books by id so the choice is stable.
  const bookOf = (f) => (Number.isFinite(f.book) ? f.book : -Infinity);
  const chosen = [...funds].sort((a, b) => bookOf(b) - bookOf(a) || a.id - b.id).slice(0, max);
  // Made before anything is written, so a sitemap over the limit stops the build early.
  const sitemap = site === null ? null : renderSitemap(site, chosen);
  // A preview tag that names a missing image is worse than none.
  const preview = site !== null && HEAD_CLOSE.test(template) && (await stat(path.join(dist, OG_IMAGE.file)).then((s) => s.isFile(), () => false));

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
  if (preview) {
    await writeFile(indexFile, withPreviewImage(template, site, null));
    console.log(`prerender: added og:image ${site}/${OG_IMAGE.file} to index.html and the fund pages`);
  }

  for (let i = 0; i < chosen.length; i += WRITE_BATCH) {
    await Promise.all(
      chosen.slice(i, i + WRITE_BATCH).map(async (fund) => {
        const dir = path.join(dist, "fund", String(fund.id));
        await mkdir(dir, { recursive: true });
        const html = renderFund(template, fund, site);
        await writeFile(path.join(dir, "index.html"), preview ? withPreviewImage(html, site, `${site}${fundPath(fund.id)}`) : html);
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
