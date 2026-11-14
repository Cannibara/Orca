# Plan: SEO and logo

Last verified: 2026-11-14
Status: started 2026-11-13. 2026-11-14: keyword titles and descriptions, real text in the pre-built fund pages (heading, summary, ten largest positions, links to neighbouring funds, for the 500 largest funds) and the site name "OrcaETF.com" in share tags and JSON-LD are built (`web/scripts/prerender.mjs`, PRERENDER_RICH). Logo round 5 (variations of f5) is in `docs/superpowers/logo-drafts/round5/`; the owner has not chosen. Earlier: Done: step 1 draft copy applied (owner can change it), steps 3 and 4 (share tags and JSON-LD in `prerender.mjs`, tests), step 7 for those. Logo drafts A–E are in `docs/superpowers/logo-drafts/` (open `preview.png`); the owner has not picked one. Steps 2 (icon files, `og-default.png`), 5, 6 and 8 are open. The share image is linked only once `web/public/og-default.png` exists.

## Goal
`orcaetf.com` and fund pages are easy to find and show a proper title, description and logo in search and when shared.

## Today (checked in code)
- `web/index.html`: title "Orca", one generic description, an inline SVG favicon (data URI). No OG/Twitter tags, no manifest, no PNG icons, no structured data.
- `web/scripts/prerender.mjs` (updated 2026-11-14): fund pages get `<title>{name} 13F holdings and returns · Orca</title>`, a description with the latest quarter, book and top holdings, a canonical link, and real text in the root element (15,000 pages; the 500 largest also get the holdings table); sitemap/robots exist when `SITE_URL` is set. The home page and other routes get nothing of their own.
- `web/public/` holds only `demo-data`: no logo files.

## Steps (one session each unless noted)
1. **Copy, owner decision.** Home title (e.g. "Orca: 13F fund returns, stock by stock") and a ≤155-character description; fund template (name, estimated return, book size); a one-line tagline. I draft, the owner picks.
2. **Logo and icons.** Turn the existing whale mark into `web/public/`: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` (180), 192/512 PNGs, `site.webmanifest`, a 1200×630 `og-default.png`, and a wordmark SVG for the header. A new brand design is the owner's call; this only formalises the current mark.
3. **Head tags.** In `index.html` and `prerender.mjs`: `og:title/description/image/url/type`, `twitter:card=summary_large_image`, `theme-color` (exists), canonical for the home page, `rel=icon` and manifest links. CSP: images are same-origin, so no change expected.
4. **Per-fund extras.** `og:description` with the fund's name and latest book; JSON-LD `WebSite` (home) and `Dataset` or `WebPage` (fund) with no CUSIPs; keep the numbers in the noscript block as text so crawlers see real content.
5. **Crawl hygiene.** Confirm `sitemap.xml` lists the fund pages and the home, `robots.txt` points to it, pages.dev stays `noindex`, www is canonical, and bare `orcaetf.com` 301s to www. Add `lastmod` from the manifest build date.
6. **Page budget decision (ROADMAP S5).** Pages Free allows 20,000 files; 15,000 are fund pages. Stock or sector pages later need the paid plan (100,000 files) or SPA-only. Decide now so later features do not break the deploy.
7. **Tests.** Extend the prerender tests: every fund page has one title, one description, one canonical, OG tags, valid JSON-LD, no CUSIP. Add a Playwright check of the home `<head>`.
8. **Owner actions after deploy:** add and verify the domain in Google Search Console and Bing Webmaster Tools, submit the sitemap, and check the share preview in a link debugger. Indexing takes days to weeks.

## Files touched
`web/index.html`, `web/scripts/prerender.mjs`, `web/public/*` (new icons), `web/tests/` (prerender tests), `docs/PRODUCT.md`, `docs/WORKLOG.md`.

## Risks
- The Search Console steps cannot be done by an agent.
- Fund names alone are weak keywords; a "best-performing 13F funds" landing content block on the home page would help more than tags, and is a copy decision.
- A copy or logo change is cheap now and costly after links spread.
