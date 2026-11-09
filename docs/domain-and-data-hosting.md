# Domain and data hosting: the owner's runbook

Plain-English notes on where Orca lives, which settings it needs and where each one is kept. Most
settings are in GitHub (Settings > Secrets and variables > Actions, or Settings > Environments >
`production`); the rest are in the Cloudflare dashboard and are **not** in this repository, so they
are listed here.

## The addresses

| Address | What it is |
| --- | --- |
| https://www.orcaetf.com | The website. The main address. |
| https://orcaetf.com | Only forwards (redirects) to www. |
| https://orca-88p.pages.dev | The old address. Keeps working, nothing to do. |
| https://data.orcaetf.com | The data files (JSON) the website reads. A custom domain on the public R2 bucket, cached by Cloudflare. |

The website is a Cloudflare Pages project called `orca`. The data bucket is the public R2 bucket named
in `R2_SITE_BUCKET`. The private bucket (`R2_LAKE_BUCKET`) is never public.

## Settings in GitHub

| Name | Kind | Where | What it is |
| --- | --- | --- | --- |
| `VITE_DATA_URL` | variable | repository or `production` | Where the website reads its data: `https://data.orcaetf.com`. The security headers and the early connection hint are built from it. |
| `SITE_ORIGINS` | variable (optional) | repository | Websites allowed to read the data bucket (Site CORS), separated by spaces. Empty means the built-in list: www, the bare domain, the pages.dev address and localhost. Never put the data address here. |
| `R2_SITE_BUCKET` | variable | repository | Name of the public data bucket. |
| `CF_ZONE_ID` | variable | `production` | Zone ID of orcaetf.com (Cloudflare dashboard > orcaetf.com > Overview, right-hand side). |
| `CF_PURGE_TOKEN` | secret | `production` | Cloudflare API token that can only clear the cache: create it under My Profile > API Tokens > Create Token > Custom, permission Zone > Cache Purge > Purge, zone orcaetf.com. |
| `CLOUDFLARE_API_TOKEN` | secret | `production` | Token used to deploy the website (permission Account > Cloudflare Pages > Edit). |
| `CLOUDFLARE_ACCOUNT_ID` | secret | `production` | The Cloudflare account ID (32 characters). |

Also there, from earlier setup: `R2_LAKE_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_ENDPOINT` and the data-provider keys the pipeline uses; `CF_PAGES_PROJECT` (optional, default
`orca`). Paste values without spaces or line breaks.

## What each workflow does (GitHub > Actions)

- **Web**: on every change to `web/`, runs the tests and a test build. On the main branch it also builds
  the real site (reading `VITE_DATA_URL` and the list of funds from the data address) and deploys it to
  Pages. Run it by hand (Run workflow, branch main) to redeploy.
- **Site CORS**: run by hand. Tells the data bucket which websites may read it. Run it when a website
  address is added or changed, then run **Purge cache**.
- **Purge cache**: run by hand. Clears Cloudflare's cache for orcaetf.com. It fails, with a clear message,
  if `CF_PURGE_TOKEN` or `CF_ZONE_ID` is missing or wrong, so it is also the way to test the token.
- **Pipeline**: monthly on the 16th, or by hand. Reads the new filings, uploads the changed data files
  (manifest last), then clears the Cloudflare cache (the "Clear the Cloudflare cache" step) and saves the
  private lake. Without `CF_PURGE_TOKEN` and `CF_ZONE_ID` that step only prints a notice and the data
  site may show old files for up to 30 days. If the step fails, the lake is still saved; fix the token
  and run **Purge cache** by hand.

## How to redeploy

Actions > Web > Run workflow (branch main). Do this after a data refresh adds funds, because the funds
with their own pre-rendered pages are chosen when the site is built. Redeploying is safe at any time. To
undo a bad deploy quickly: Cloudflare dashboard > Workers & Pages > orca > Deployments > pick an earlier
one > Rollback.

## How to roll back the data address

1. Set `VITE_DATA_URL` back to the previous address (for example the old `r2.dev` address).
2. Run Web by hand (Actions > Web > Run workflow, main). The site and its security rules follow the
   variable by themselves.
3. The old address must still serve the files and allow the website (Site CORS covers the bucket).

## Cloudflare settings that are not in the repository

Write down any change you make to these here.

1. **Pages project `orca` > Custom domains**: `www.orcaetf.com` (primary). Keep `orca-88p.pages.dev`.
2. **Bare domain forwards to www**: orcaetf.com needs a proxied DNS record (it already has one when it is also a
   custom domain of the Pages project; otherwise add a placeholder A record to 192.0.2.1) and a Redirect Rule (Rules > Redirect Rules): if host equals `orcaetf.com`,
   redirect to `https://www.orcaetf.com` keeping the path and query, status 301.
3. **R2 > the public bucket > Settings > Custom domains**: `data.orcaetf.com`. The public `r2.dev`
   address can be switched off once everything uses the custom domain (it has no cache).
4. **Cache rule for `data.orcaetf.com`** (Caching > Cache Rules): host equals `data.orcaetf.com`;
   eligible for cache; Edge TTL 1 month (ignore the origin's setting); Browser TTL 2 hours (override).
   The Pipeline clears the month after each upload, which is why it is safe.
5. **DNS > Settings > DNSSEC**: on. If the domain is registered elsewhere, add the DS record Cloudflare
   shows at the registrar.
6. **SSL/TLS > Overview**: encryption mode **Full (strict)**. **SSL/TLS > Edge Certificates**: **Always Use
   HTTPS** on.
7. **E-mail records (DNS)**, if the domain sends no mail: a TXT record on `orcaetf.com` with
   `v=spf1 -all`, and a TXT record on `_dmarc` with `v=DMARC1; p=reject; adkim=s; aspf=s`. If you use
   e-mail on the domain, set SPF and DMARC for that provider instead.
8. **Pages project `orca` > Metrics > Web Analytics**: leave it off (no automatic script). The security rules only allow the
   site's own scripts, so Cloudflare's injected analytics script would be blocked (and show an error in
   the browser console).

9. **Response header rule for the data site (optional, not needed today)**: R2 answers with `Vary: Origin`, and
   Cloudflare keeps a separate cached copy per site address (checked 9 Nov 2026 with `curl -H 'Origin: ...'`
   for the www, bare and pages.dev addresses: each got its own `Access-Control-Allow-Origin` and a cache HIT).
   If a browser console ever shows CORS errors while the data file opens fine, add Rules > Transform Rules >
   Modify Response Header: if host equals `data.orcaetf.com`, **Set static** `Access-Control-Allow-Origin` = `*`
   (the data is public anyway).

## Order for the move (first time)

1. Data custom domain and cache rule (3, 4 above). 2. Run **Site CORS**, then create `CF_PURGE_TOKEN` and
`CF_ZONE_ID` and run **Purge cache** (it must end green). 3. Set `VITE_DATA_URL` to
`https://data.orcaetf.com` and run **Web**. 4. Open the site and check that funds load. 5. Add the www
custom domain, then the bare redirect (1, 2). 6. DNSSEC, HTTPS and e-mail records (5 to 7).

## If something looks wrong

- Funds do not load, the browser console talks about "Content Security Policy": `VITE_DATA_URL` differs
  from the address the site was built with. Run Web again.
- Funds do not load, the console talks about CORS: run **Site CORS**, then **Purge cache** (Cloudflare
  keeps copies without the CORS headers until the cache is cleared).
- Old numbers after a monthly run: run **Purge cache**; the browser may keep a file up to 1 hour.
- The build fails with `VITE_DATA_URL ... is not usable`: the variable has a space, a line break or is not
  an address like `https://data.orcaetf.com`. Fix it and run Web again.
