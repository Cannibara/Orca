// Display formatters. Every one returns "—" for a missing value (null, or a
// number that is not finite) so a table cell or tile never shows "NaN".
export const MINUS = "−"; // U+2212
const DASH = "—";

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
  return (signed ? sgn(usd) : usd < 0 ? MINUS : "") + s;
}

/** A fraction as a percentage: 0.1234 → "+12.3%". `signed: false` drops the plus sign. */
export function pct(x: number | null, digits = 1, signed = true): string {
  if (missing(x)) return DASH;
  const s = Math.abs(x * 100).toFixed(digits) + "%";
  return (signed ? sgn(x) : x < 0 ? MINUS : "") + s;
}

/** Percentage points: -2.04 → "−2.0 pts". */
export function pp(points: number | null): string {
  if (missing(points)) return DASH;
  return sgn(points) + Math.abs(points).toFixed(1) + " pts";
}

/** Share price: whole dollars from $100, cents below. */
export function px(price: number | null): string {
  if (missing(price)) return DASH;
  return "$" + (price >= 100 ? price.toFixed(0) : price.toFixed(2));
}

/** Quarter index counted from Q1 2013: 53 → "Q2 2026". */
export function qLabel(q: number): string {
  return "Q" + ((q % 4) + 1) + " " + (2013 + Math.floor(q / 4));
}

/** CSS class for a signed figure; "" for zero or missing. */
export function signClass(x: number | null): "up" | "down" | "" {
  if (missing(x)) return "";
  return x > 0 ? "up" : x < 0 ? "down" : "";
}
