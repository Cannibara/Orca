// Display formatters. Every one returns "—" for a missing value (null, or a
// number that is not finite) so a table cell or tile never shows "NaN".
export const MINUS = "−"; // U+2212
export const DASH = "—";

const missing = (x: number | null): x is null => x == null || !Number.isFinite(x);

export function sgn(x: number): "+" | "−" | "" {
  return x > 0 ? "+" : x < 0 ? MINUS : "";
}

/** Dollar amount in whole dollars: $1.23B, $340M, $4.5M, $340K, $1,110. */
export function money(usd: number | null, signed = false): string {
  if (missing(usd)) return DASH;
  const a = Math.abs(usd);
  // Round to each tier's precision first and take the first tier whose rounded
  // value is still below its ceiling, so a value that rounds up to the next
  // unit moves up with it ("$1.0M", never "$1000K"; "$10M", never "$10.0M").
  const dollars = Math.round(a);
  const k = Math.round(a / 1e3);
  const m1 = Math.round(a / 1e5) / 10;
  const m = Math.round(a / 1e6);
  const b2 = Math.round(a / 1e7) / 100;
  let s: string;
  if (dollars < 1e4) s = "$" + dollars.toLocaleString("en-US");
  else if (k < 1e3) s = "$" + k + "K";
  else if (m1 < 10) s = "$" + m1.toFixed(1) + "M";
  else if (m < 1e3) s = "$" + m + "M";
  else if (b2 < 10) s = "$" + b2.toFixed(2) + "B";
  else s = "$" + (a / 1e9).toFixed(1) + "B";
  // The sign follows the printed figure: a value that rounds to $0 has none.
  return (dollars === 0 ? "" : signed ? sgn(usd) : usd < 0 ? MINUS : "") + s;
}

/** A fraction as a percentage: 0.1234 → "+12.3%". `signed: false` drops the plus sign. */
export function pct(x: number | null, digits = 1, signed = true): string {
  if (missing(x)) return DASH;
  const digitsText = Math.abs(x * 100).toFixed(digits);
  // The sign follows the printed figure: a value that rounds to 0.0% has none.
  const sign = Number(digitsText) === 0 ? "" : signed ? sgn(x) : x < 0 ? MINUS : "";
  return sign + digitsText + "%";
}

/** Percentage points: -2.04 → "−2.0 pts". */
export function pp(points: number | null): string {
  if (missing(points)) return DASH;
  const digitsText = Math.abs(points).toFixed(1);
  return (Number(digitsText) === 0 ? "" : sgn(points)) + digitsText + " pts";
}

/** Share price: whole dollars from $100, cents below. */
export function px(price: number | null): string {
  if (missing(price)) return DASH;
  return "$" + (price >= 100 ? price.toFixed(0) : price.toFixed(2));
}

/** A share count rounded to whole shares, with thousands separators: 1234567.4 → "1,234,567". */
export function shareCount(n: number | null): string {
  if (missing(n)) return DASH;
  const whole = Math.round(n);
  return (whole < 0 ? MINUS : "") + Math.abs(whole).toLocaleString("en-US");
}

/** The home page's title (also in index.html, which cannot import this: keep the two equal). */
export const HOME_TITLE = "Orca: Hedge fund holdings";

/** A fund page's title: the pre-rendered file and the app use this one text, so the tab does not change when the app loads. */
export const fundTitle = (name: string): string => `${name} 13F holdings and returns · Orca`;

/** Quarter of the year, 0–3, of quarter index q. Pre-2013 quarters are negative and JS `%` keeps the sign. */
export const qOfYear = (q: number): number => ((q % 4) + 4) % 4;

/** Quarter index counted from Q1 2013: 53 → "Q2 2026", −56 → "Q1 1999". */
export function qLabel(q: number): string {
  return "Q" + (qOfYear(q) + 1) + " " + (2013 + Math.floor(q / 4));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date as "13 Aug 2026". Text that is not an ISO date comes back unchanged. */
export function fmtDate(iso: string | null): string {
  if (iso == null) return DASH;
  const [y, m, d] = iso.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

/** A risk ratio (Sharpe, Sortino, Calmar): two decimals, a true minus sign. */
export function ratio(x: number | null): string {
  if (missing(x)) return DASH;
  const digitsText = Math.abs(x).toFixed(2);
  return (x < 0 && Number(digitsText) !== 0 ? MINUS : "") + digitsText;
}

/** A whole-number count with thousands separators; with a noun, in the right number: 1 → "1 position", 16000 → "16,000 positions". */
export function count(n: number | null, noun?: string): string {
  if (missing(n)) return DASH;
  const text = n.toLocaleString("en-US");
  return noun === undefined ? text : `${text} ${n === 1 ? noun : noun + "s"}`;
}

/** True for a printed figure that is zero ("$0", "0.0%", "0.0 pts", "0.00"): it is shown in no colour. */
export function printsZero(text: string): boolean {
  return /^[+−]?\$?0(\.0+)?( pts|%|×)?$/.test(text);
}

/** CSS class for a signed figure; "" for zero or missing. */
export function signClass(x: number | null): "up" | "down" | "" {
  if (missing(x)) return "";
  return x > 0 ? "up" : x < 0 ? "down" : "";
}

const NAME_SUFFIX = /(?:\s+(?:&\s+)?(?:INC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LLC|LP|NEW|TR|COM))+\.?$/;
// Acronyms that stay in capitals when a name is title-cased.
const NAME_KEEP = new Set(["ETF", "ETN", "SPDR", "S&P", "US", "USA", "UK", "ADR", "REIT", "AI", "II", "III", "IV", "ISHARES"]);

/**
 * A security's name as the fund page prints it. SEC filings give names in capitals with legal suffixes
 * ("ALPHABET INC", "COSTCO WHSL CORP NEW"): those become "Alphabet", "Costco Whsl". A name that already
 * has lower-case letters is left as it is.
 */
export function tidyName(name: string): string {
  if (name === "" || /[a-z]/.test(name)) return name;
  const trimmed = name.replace(NAME_SUFFIX, "").trim();
  const base = trimmed === "" ? name : trimmed;
  return base
    .split(/\s+/)
    .map((w) => (NAME_KEEP.has(w) ? (w === "ISHARES" ? "iShares" : w) : w.toLowerCase().replace(/(^|[-'/.])([a-z])/g, (_, b: string, c: string) => b + c.toUpperCase())))
    .join(" ");
}

// Endings of a legal name, taken off the end one by one (compared without dots and commas, so "L.P." is LP).
const SHORT_LEGAL = new Set(["INC", "CORP", "CORPORATION", "CO", "COMPANY", "LLC", "LP", "LLP", "LTD", "LIMITED", "PLC", "SA", "SAS", "AG", "AS", "NV", "GMBH", "PTE", "PTY", "PJSC", "COM", "GP", "I", "II", "III"]);
// Generic tails that say what a firm does, not who it is.
const SHORT_TAIL = new Set(["MANAGEMENT", "MGMT", "GROUP", "HOLDING", "HOLDINGS", "ASSOCIATES", "ADVISORS", "ADVISERS"]);
// Weaker tails: a name may be nothing but one of these plus a single word ("Public Investment Fund", "PGGM Investments"),
// so they come off only when two words remain, or right after a tail ("Asset Management", "Investment Group").
const SHORT_WEAK = new Set(["ASSET", "INVESTMENT", "INVESTMENTS", "INVESTORS", "SERVICES", "TRUST"]);
const SHORT_AFTER_MGMT = new Set(["MANAGEMENT", "MGMT"]);
const SHORT_AFTER_TAIL = new Set(["MANAGEMENT", "MGMT", "SERVICES", "GROUP", "HOLDING", "HOLDINGS"]);
// Words that make a name on their own: a tail is not stripped down to just one of these.
const SHORT_BRAND = new Set(["CAPITAL", "PARTNERS", "FAMILY", "OFFICE", "FOUNDATION"]);
// Short all-caps words that are ordinary words, not acronyms, when an ALL-CAPS name is re-cased.
const SHORT_NOT_ACRONYM = new Set(["THE", "AND", "FOR", "NEW", "ONE", "TWO", "AIR", "SEA", "SUN", "BAY", "OAK", "RED", "ALL", "OLD", "TOP", "BIG", "ART", "VAN", "DEN", "VON", "DER", "CAT", "CO", "COM"]);
const SHORT_JOIN = new Set(["OF", "AND", "THE", "FOR"]);

const shortKey = (token: string): string => token.replace(/[.,]/g, "").toUpperCase();

function shortCase(name: string): string {
  return name
    .split(" ")
    .map((w, i) => {
      if (/\d/.test(w) || w === "&" || /^[IVX]{2,7}$/.test(w)) return w; // digits, ampersand, roman numerals
      if (i > 0 && SHORT_JOIN.has(w)) return w.toLowerCase();
      return w
        .split("-")
        .map((part) => {
          // A short all-caps word is an acronym (AQR, TCI, NEA); so is a longer one with no vowel (STRS, HHLR).
          if (/^[A-Z]{1,3}$/.test(part) && !SHORT_NOT_ACRONYM.has(part)) return part;
          if (/^[B-DF-HJ-NP-TV-XZ]{4,5}$/.test(part)) return part;
          return part.toLowerCase().replace(/(^|[./]|^[a-z]')([a-z])/g, (_, b: string, c: string) => b + c.toUpperCase());
        })
        .join("-");
    })
    .join(" ");
}

/**
 * A fund's name as the home chart prints it: "AQR CAPITAL MANAGEMENT LLC" becomes "AQR Capital". Legal endings, state
 * tags and generic tails come off the end, brand words (Capital, Partners, Family Office, Foundation) stay, and it
 * never ends up empty. A name left in ALL CAPS is re-cased (short acronyms stay); a mixed-case name keeps its casing.
 */
export function fundShortName(name: string): string {
  let s = name.trim().replace(/\s+/g, " ");
  if (s === "") return name;
  s = s
    .replace(/\s+(?:in its capacity|as trustee)\b.*$/i, "") // "… Pty Ltd as trustee of …"
    .replace(/[\s,]+ET AL\.?$/i, "")
    .replace(/\s+A\/S$/i, "")
    .replace(/\s+L\s+(?:L\s+C|P)$/i, "") // "L P", "L L C"
    .replace(/\s+Hong Kong(\s+(?:Ltd|Limited)\.?)?$/i, "$1")
    .replace(/\s*\/\s*\S{4,}.*$/, "") // "FJARDE AP-FONDEN /FOURTH SWEDISH …": the translation after the slash
    .replace(/\s*\/\s*[A-Za-z]{0,3}\s*\/?$/, ""); // "/DE", "/NY/", "LTD/ CAN", "CORP/"
  let lastTail = "";
  for (;;) {
    s = s.replace(/[\s,;]+$/, "");
    const paren = s.replace(/\s*\([^()]*\)$/, "");
    if (paren !== s && paren !== "") {
      s = paren;
      continue;
    }
    const m = /^(.*\S)\s+(\S+)$/.exec(s);
    if (!m) break;
    const head = m[1].replace(/[\s,;]+$/, "");
    const key = shortKey(m[2]);
    const prev = head.split(" ").pop() ?? "";
    const oneWord = !head.includes(" ");
    if (head === "" || key === "") break;
    if (SHORT_LEGAL.has(key) && !(key === "CO" && prev === "&")) s = head;
    else if (key === "&") s = head;
    else if (SHORT_TAIL.has(key) && !(oneWord && SHORT_BRAND.has(shortKey(head)))) s = head;
    else if (SHORT_WEAK.has(key) && (!oneWord || SHORT_AFTER_TAIL.has(lastTail)) && !(oneWord && SHORT_BRAND.has(shortKey(head)))) s = head;
    else if (key === "FUND" && SHORT_AFTER_MGMT.has(lastTail)) s = head;
    else break;
    lastTail = key;
  }
  return /[a-z]/.test(s) ? s : shortCase(s);
}
