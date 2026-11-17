// Number strings of the Home lists, in the fund page's style: money in whole millions with a small "m"
// ("$2,968m") and billions to one decimal ("$14.2B"); percentages are whole numbers (lib/format's
// pct(x, 0)); a missing figure is "—" as everywhere else on the site.
import { DASH, MINUS } from "../lib/format";

const missing = (x: number | null | undefined): x is null | undefined => x == null || !Number.isFinite(x);

/**
 * Dollars for a table cell: 14.2e9 → "$14.2B", 2.968e9 → "$3.0B", 340.4e6 → "$340m", 2,968m stays "$2,968m"
 * below a billion, then "$850K" and "$420". `signed` puts a "+" on gains; a figure that prints as $0 has no sign.
 */
export function fBook(usd: number | null | undefined, signed = false): string {
  if (missing(usd)) return DASH;
  const a = Math.abs(usd);
  const m = Math.round(a / 1e6);
  let text: string;
  if (m >= 1000) text = "$" + (a / 1e9).toFixed(1) + "B"; // a rounded 1,000m reads as $1.0B, never "$1,000m"
  else if (m >= 1) text = "$" + m.toLocaleString("en-US") + "m";
  else if (Math.round(a / 1e3) >= 1) text = "$" + Math.round(a / 1e3) + "K";
  else text = "$" + Math.round(a);
  if (text === "$0") return text;
  return (usd < 0 ? MINUS : signed ? "+" : "") + text;
}

/** A share price: whole dollars with thousands separators from $100, cents below ("$1,079", "$80.00"). */
export function fPrice(price: number | null | undefined): string {
  if (missing(price)) return DASH;
  return "$" + (price >= 100 ? Math.round(price).toLocaleString("en-US") : price.toFixed(2));
}

/** A portfolio weight (a fraction) in whole percent; "<1%" for a holding under half a percent. */
export function fWeight(w: number | null | undefined): string {
  if (missing(w)) return DASH;
  return w > 0 && w < 0.005 ? "<1%" : Math.round(w * 100) + "%";
}

/** A change in a holding's weight, in percent of the fund's AUM with one decimal: 20.46 → "+20.5%", −9.3 → "−9.3%". A value that prints as 0.0 has no sign. */
export function fAum(pts: number | null | undefined): string {
  if (missing(pts)) return DASH;
  const digits = Math.abs(pts).toFixed(1);
  return (Number(digits) === 0 ? "" : pts < 0 ? MINUS : "+") + digits + "%";
}

/** A count read at a glance: 950 → "950", 4,200 → "4.2k", 22,800 → "23k", 1,250,000 → "1.3M". */
export function fViews(n: number | null | undefined): string {
  if (missing(n)) return DASH;
  if (n >= 999_500) return (n / 1e6).toFixed(1) + "M";
  if (n >= 9_950) return Math.round(n / 1e3) + "k";
  if (n >= 1_000) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
