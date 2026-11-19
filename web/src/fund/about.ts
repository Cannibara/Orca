// The About panel's text, pure: what SEC EDGAR says about the filer (summary.json `about`), printed the way the
// site prints names. SEC records come in capitals and two-letter state codes.

import type { About, FormerName } from "../data/types";
import { fmtDate, money, qOfYear } from "../lib/format";

// ---- names --------------------------------------------------------------------------------

// Stay in capitals: legal forms, countries, exchanges, Roman numerals.
const KEEP = new Set([
  "LLC", "LP", "LLP", "LLLP", "PLC", "NA", "USA", "US", "UK", "NYSE", "ETF", "REIT", "SPDR", "S&P", "AG", "SA", "NV", "BV", "SE", "AB", "ASA",
  "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "CEO", "CFO", "COO", "CIO", "CCO", "GP",
]);
// Vowel-less words that are abbreviations to title-case ("ST" → "St"); other vowel-less words are acronyms ("BH", "KKR").
const ABBR = new Set(["MR", "MRS", "MS", "DR", "ST", "JR", "SR", "FL", "FLR", "FT", "MT", "BLVD", "PL", "PKWY", "HWY", "CTR", "STS", "RD", "CT", "SQ", "PH"]);
// Small words written in lower case inside a name ("Bank of New York").
const MINOR = new Set(["OF", "AND", "THE", "FOR", "IN", "ON", "AT", "BY", "A", "AN", "TO"]);

function caseWord(word: string, first: boolean): string {
  const bare = word.replace(/^[("']+|[),.;:]+$/g, "");
  if (bare === "" || !/[A-Z]/.test(bare)) return word;
  if (KEEP.has(bare)) return word;
  if (/^(?:[A-Z]\.){2,}$/.test(bare + (word.endsWith(".") && !bare.endsWith(".") ? "." : ""))) return word; // U.S., L.P.
  if (/^[A-Z]+$/.test(bare) && !/[AEIOUY]/.test(bare) && bare.length > 1 && !ABBR.has(bare)) return word;
  if (!first && MINOR.has(bare)) return word.toLowerCase();
  return word.toLowerCase().replace(/(^|[-'/.(&])([a-z])/g, (_, b: string, c: string) => b + c.toUpperCase());
}

/**
 * Text from SEC records in capitals, title-cased: "MARC D. HAMBURG" → "Marc D. Hamburg", "BH FINANCE LLC" →
 * "BH Finance LLC". Legal forms, Roman numerals, initialisms and vowel-less acronyms keep their capitals. Text
 * that already has lower-case letters is left as it is.
 */
export function titleCase(s: string): string {
  if (s === "" || /[a-z]/.test(s)) return s;
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => caseWord(w, i === 0))
    .join(" ");
}

const tc = (s: string | null): string | null => (s == null || s.trim() === "" ? null : titleCase(s.trim()));

// ---- places -------------------------------------------------------------------------------

const PLACES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", VI: "US Virgin Islands", GU: "Guam", AS: "American Samoa", MP: "Northern Mariana Islands",
  // EDGAR's codes for Canada's provinces and the countries 13F filers most often give
  A0: "Alberta", A1: "British Columbia", A2: "Manitoba", A3: "New Brunswick", A4: "Newfoundland and Labrador", A5: "Nova Scotia",
  A6: "Ontario", A7: "Prince Edward Island", A8: "Quebec", A9: "Saskatchewan", B0: "Yukon",
  X0: "United Kingdom", E9: "Cayman Islands", D0: "Bermuda", K3: "Hong Kong", L2: "Ireland",
};

/** An SEC state or country code in full ("NE" → "Nebraska"); an unknown code as it is. */
export function placeName(code: string | null): string | null {
  if (code == null || code.trim() === "") return null;
  const c = code.trim().toUpperCase();
  return PLACES[c] ?? code.trim();
}

// ---- the panel's text ---------------------------------------------------------------------

/** "A", "A and B", "A, B and C". */
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);

/** Last day of quarter q, ISO. */
const qEnd = (q: number): string => new Date(Date.UTC(2013 + Math.floor(q / 4), qOfYear(q) * 3 + 3, 0)).toISOString().slice(0, 10);

export type Filing = { name: string; period_q: number; book: number; n_holdings: number };

/** The panel's opening paragraph, built from the facts; a clause whose fact is missing is left out. */
export function describeFiler(a: About, s: Filing): string {
  const name = tc(a.name) ?? titleCase(s.name);
  const place = [tc(a.city), placeName(a.state)].filter((x): x is string => x !== null);
  const out = [`${name} is an institutional investment manager${place.length ? " based in " + place.join(", ") : ""}.`];
  const sic = tc(a.sic);
  const tickers = a.tickers.filter((t) => t.trim() !== "");
  const exchanges = [...new Set(a.exchanges.filter((e) => e.trim() !== ""))];
  const trade = tickers.length ? `${exchanges.length ? " on the " + list(exchanges) : ""} as ${list(tickers)}` : null;
  if (sic && trade) out.push(`The SEC classes it under ${sic}, and its shares trade${trade}.`);
  else if (sic) out.push(`The SEC classes it under ${sic}.`);
  else if (trade) out.push(`Its shares trade${trade}.`);
  out.push(
    `Its latest 13F, for the quarter to ${fmtDate(qEnd(s.period_q))}, reports ${money(s.book)} across ${s.n_holdings} ${s.n_holdings === 1 ? "holding" : "holdings"}.`,
  );
  return out.join(" ");
}

const year = (iso: string | null): string | null => (iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null);

/** "NBH Inc (1998–1999)": the name and the years it was used. */
export function formerName(f: FormerName): string {
  const name = titleCase(f.name);
  const a = year(f.from);
  const b = year(f.to);
  const when = a && b ? (a === b ? a : `${a}–${b}`) : a ? `from ${a}` : b ? `until ${b}` : null;
  return when ? `${name} (${when})` : name;
}

export type AboutRow = { key: "hq" | "signed" | "inc" | "former"; label: string; value: string };

/** The panel's plain label / value rows, each only when its fact is known (managers and the CIK link are drawn apart). */
export function aboutRows(a: About): AboutRow[] {
  const rows: AboutRow[] = [];
  const place = [tc(a.city), placeName(a.state)].filter((x): x is string => x !== null).join(", ");
  const street = tc(a.street);
  if (place || street) rows.push({ key: "hq", label: "Headquarters", value: place && street ? `${place} (${street})` : place || (street as string) });
  const who = [tc(a.signer), tc(a.signer_title)].filter((x): x is string => x !== null).join(", ");
  if (who) rows.push({ key: "signed", label: "13F signed by", value: who + (a.signed ? ` (${fmtDate(a.signed)})` : "") });
  const inc = placeName(a.incorporated);
  if (inc) rows.push({ key: "inc", label: "Incorporated in", value: inc });
  const former = a.former_names.filter((f) => f.name && f.name.trim() !== "");
  if (former.length) rows.push({ key: "former", label: former.length === 1 ? "Former name" : "Former names", value: former.map(formerName).join("; ") });
  return rows;
}

/** EDGAR's list of the filer's 13F-HR filings. */
export const edgarUrl = (cik: number): string => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=13F-HR`;
