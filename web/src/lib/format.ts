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

/** Quarter index counted from Q1 2013: 53 → "Q2 2026". */
export function qLabel(q: number): string {
  return "Q" + ((q % 4) + 1) + " " + (2013 + Math.floor(q / 4));
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
