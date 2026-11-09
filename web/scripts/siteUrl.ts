// The website's own address (the build variable SITE_URL), for the canonical links, sitemap.xml and
// robots.txt that scripts/prerender.mjs writes. Same care as scripts/dataOrigin.ts: the value comes
// from a repository variable and ends up in files search engines read, so only a plain
// https://host[:port] address passes, and only the parsed origin is returned.
import { FORBIDDEN, ORIGIN } from "./dataOrigin.ts";

const HELP = "Set it to the website's address, like https://www.orcaetf.com (https, no path, no trailing slash), or leave it out.";

function bad(value: string, why: string): never {
  const shown = JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}...` : value);
  throw new Error(`SITE_URL ${shown} is not usable: ${why}. ${HELP}`);
}

/**
 * The website's origin ("https://www.orcaetf.com"), or null when SITE_URL is not set. Throws an Error
 * saying what is wrong with anything but an https origin written exactly as the URL parser prints it
 * (lower case host, no path, no trailing slash, no default port).
 */
export function siteUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (FORBIDDEN.test(value)) {
    bad(value, "it has a space, line break or one of ; , \" ' < > \\ ` in it");
  }
  if (!/^https:\/\//i.test(value)) bad(value, "it must start with https://");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad(value, "it is not a valid address");
  }
  if (url.username !== "" || url.password !== "") bad(value, "it must not carry a user name or password");
  if (!ORIGIN.test(url.origin)) bad(value, "its host name has characters other than letters, digits, dots and hyphens");
  if (url.origin !== value) bad(value, "it must be just the address: lower case, no path, no trailing /, no :443");
  return url.origin;
}
