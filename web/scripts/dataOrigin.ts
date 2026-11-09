// Where the app loads its data from, as far as the build needs to know: the ORIGIN of
// VITE_DATA_URL when it is an absolute http(s) address. Shared by vite.config.ts (the preconnect
// hint in index.html) and scripts/prerender.mjs (the connect-src of dist/_headers), so the two can
// never disagree. Node runs this file as it is (types are stripped), as it does src/lib/format.ts.
//
// The value comes from a build variable that anyone with access to the repository settings can
// change, and it ends up inside a response header, so it is checked strictly and only the parsed,
// canonical origin is ever returned: a bad value stops the build with a message, never reaches a
// header.

/** What the app uses when VITE_DATA_URL is not set: the demo data, served by the site itself. */
export const DEFAULT_DATA_URL = "/demo-data";

// scheme://host[:port], nothing else: letters, digits, dots and hyphens in the host (a name, an
// IPv4 address, or an IPv6 address in brackets), as the URL parser prints it.
const ORIGIN = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d{1,5})?$/;
// Anything in a value that has no business in an address, or that a header, a CSP list or a shell
// would treat as structure: white space, control characters, ; , quotes, angle brackets, \ and `.
const FORBIDDEN = /[\s\u0000-\u001f\u007f;,"'<>\\`]/;

const HELP = "Set it to the data site's address, like https://data.orcaetf.com, or to a path on the site, like /demo-data.";

function bad(value: string, why: string): never {
  const shown = JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}...` : value);
  throw new Error(`VITE_DATA_URL ${shown} is not usable: ${why}. ${HELP}`);
}

/**
 * The origin ("https://data.orcaetf.com") the app fetches its data from, or null when it fetches
 * from the site's own origin (the default, or a path such as "/data"). Throws an Error saying what
 * is wrong when the value is neither a path on the site nor an absolute http(s) URL.
 */
export function dataOrigin(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (FORBIDDEN.test(value)) {
    bad(value, "it has a space, line break or one of ; , \" ' < > \\ ` in it");
  }
  // A path on the site: one slash at the start ("//host/x" would be another site).
  if (value.startsWith("/")) {
    if (value.startsWith("//")) bad(value, "a value starting with // names another site");
    return null;
  }
  if (!/^https?:\/\//i.test(value)) bad(value, "it is neither an http(s) address nor a path starting with /");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad(value, "it is not a valid address");
  }
  if (url.username !== "" || url.password !== "") bad(value, "it must not carry a user name or password");
  if (!ORIGIN.test(url.origin)) bad(value, "its host name has characters other than letters, digits, dots and hyphens");
  return url.origin;
}
