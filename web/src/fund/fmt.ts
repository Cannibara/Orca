// Number and date strings of the fund page. Ported one to one from the approved
// artifact (app.js), so the page prints exactly what the artifact printed. Money is in
// dollars here (the artifact drew billions) and goes through lib/format's money().

import { MINUS, money, qLabel } from "../lib/format";

export { MINUS };

/** Printed sign: a real minus for negatives, "+" otherwise (zero included; callers drop it where it is not wanted). */
export function sgn(v: number): string {
  return v < 0 ? MINUS : "+";
}

/** One decimal with a sign; a value that prints as 0.0 has none. */
export function f1(v: number): string {
  const s = Math.abs(v).toFixed(1);
  return s === "0.0" ? "0.0" : sgn(v) + s;
}

/** A percentage given in percent: -16.71 → "−16.7%". */
export function fPct(v: number): string {
  return f1(v) + "%";
}

/** Whole number with a sign, for crowded bar labels: 12.4 → "+12". */
export function fShort(v: number): string {
  const s = Math.abs(Math.round(v));
  return s === 0 ? "0" : sgn(v) + s;
}

/** Percentage points, `d` decimals (default 1): 2.04 → "+2.0"; a value that prints as zero has no sign. */
export function fPP(v: number, d = 1): string {
  const s = Math.abs(v).toFixed(d);
  return Number(s) === 0 ? (0).toFixed(d) : sgn(v) + s;
}

export function axisPct(v: number): string {
  return v === 0 ? "0%" : sgn(v) + Math.abs(v) + "%";
}

export function axisPP(v: number): string {
  return v === 0 ? "0" : sgn(v) + Math.abs(v);
}

/** "2019" → "’19"; "2026 H1" → "’26 H1". */
export function shortYear(c: string): string {
  return c.replace(/^\d\d(\d\d)(.*)$/, "’$1$2");
}

/** Quarter index counted from Q1 2013: 53 → "Q2 ’26". */
export function qShort(q: number): string {
  return "Q" + ((q % 4) + 1) + " ’" + String(2013 + Math.floor(q / 4)).slice(2);
}

/** "Q2 2026". */
export const qLabelFull: (q: number) => string = qLabel;

/** Dollars at the precision of the artifact's fM: $2.97B, $340.0M, $85K. "–" when missing. */
export function fM(v: number | null, signed = false): string {
  if (v == null) return "–";
  const a = Math.abs(v);
  const t =
    a >= 1e9
      ? "$" + (a / 1e9).toFixed(2) + "B"
      : a >= 1e6
        ? "$" + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + "M"
        : a >= 1e3
          ? "$" + Math.round(a / 1e3) + "K"
          : "$" + Math.round(a);
  return (v < 0 ? MINUS : signed && a >= 0.5 ? "+" : "") + t;
}

/** Whole millions with thousands separators: 2968000000 → "$2,968m". */
export function fMm(v: number | null, signed = false): string {
  if (v == null) return "–";
  const m = Math.round(v / 1e6);
  if (m === 0) return "$0m";
  return (m < 0 ? MINUS : signed ? "+" : "") + "$" + Math.abs(m).toLocaleString("en-US") + "m";
}

/** A figure already in percent, signed, one decimal (a weight change in points): 1.26 → "+1.3%". */
export function fPc1(v: number | null): string {
  return v == null ? "–" : (v < 0 ? MINUS : "+") + Math.abs(v).toFixed(1) + "%";
}

/** A fraction as a whole signed percentage (a position's return, IRR): 0.234 → "+23%". */
export function fP0(v: number | null): string {
  if (v == null) return "–";
  return (v < 0 ? MINUS : "+") + Math.abs(v * 100).toFixed(0) + "%";
}

/** Share price in whole dollars: 1234.5 → "$1,235". */
export function fPx(v: number | null): string {
  return v == null ? "–" : "$" + Math.round(v).toLocaleString("en-US");
}

/** A weight in percent: "<1%" under half a percent, else whole percent. */
export function fW0(w: number): string {
  return w > 0 && w < 0.5 ? "<1%" : Math.round(w) + "%";
}

/** Years with one decimal, no trailing ".0": 2.5 → "2.5", 3 → "3". */
export function fYrs(t: number): string {
  return (Math.round(t * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO date as "30 Oct 2026". */
export function fmtLong(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

/** Axis tick in dollars: 0 → "$0", 5e8 → "$500M", 2e9 → "$2B", 2.5e9 → "$2.5B". */
export function axisMoney(v: number): string {
  if (v === 0) return "$0";
  const a = Math.abs(v);
  const n = (x: number) => +x.toFixed(2); // trims the float noise of tick multiples
  const s = a >= 1e9 ? n(a / 1e9) + "B" : a >= 1e6 ? n(a / 1e6) + "M" : a >= 1e3 ? n(a / 1e3) + "K" : String(n(a));
  return (v < 0 ? MINUS : "") + "$" + s;
}

/** Dollars as lib/format prints them: 11141121260 → "$11.1B", 3.4e8 → "$340M". */
export function fMoney(v: number): string {
  return money(v);
}

/** Signed dollars: 1.23e9 → "+$1.23B", -3.4e8 → "−$340M"; no sign on a figure that prints as $0. */
export function fMoneySigned(v: number): string {
  return money(v, true);
}
