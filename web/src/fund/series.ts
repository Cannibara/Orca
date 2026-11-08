// The fund page's view of summary.json: years and quarters in the shapes the panels
// need, the 15-year/Max window, and the span figures behind the KPI tiles and the
// annualised-return bracket. The formulas are the artifact's (app.js spanKpi,
// yearDetail), now fed by the live data model: quarters come from summary.quarters,
// and whether a year is a part year is decided by counting its quarters, never by
// its label.

import type { Metrics, Summary } from "../data/types";

/** One year of summary.years. Money in dollars. */
export type YearPoint = {
  /** As published: "2019", or "2026 H1" for a part year. */
  label: string;
  /** Fewer than four quarters with a return (the first and the current year of a fund). */
  part: boolean;
  /** The calendar year. */
  year: number;
  /** Compounded quarterly returns, in percent; null when the year has none. A part year stays a raw compounded return. */
  ret: number | null;
  start: number;
  end: number;
  gains: number;
  inflows: number;
  /** Quarters with a return in this year. */
  qCount: number;
};

/** One quarter with a return. `ret` is a fraction (0.05 = 5%). */
export type QPoint = { q: number; ret: number };

export type Series = {
  years: YearPoint[];
  quarters: QPoint[];
  metrics: Metrics;
  /** The latest filed quarter. */
  periodQ: number;
  /** The first quarter of the fund's current tracking segment. */
  trackedSinceQ: number;
};

/** Calendar year of quarter index q (0 = Q1 2013). */
export const yearOfQ = (q: number): number => 2013 + Math.floor(q / 4);

export function buildSeries(summary: Summary): Series {
  const quarters: QPoint[] = [];
  summary.quarters.q.forEach((q, i) => {
    const ret = summary.quarters.ret[i];
    if (ret != null) quarters.push({ q, ret });
  });
  quarters.sort((a, b) => a.q - b.q);
  const y = summary.years;
  const years: YearPoint[] = y.label.map((label, i) => {
    const year = parseInt(label, 10);
    const qCount = quarters.filter((p) => yearOfQ(p.q) === year).length;
    const ret = y.ret[i];
    return {
      label,
      part: qCount < 4,
      year,
      ret: ret == null ? null : ret * 100,
      start: y.start[i],
      end: y.end[i],
      gains: y.gains[i],
      inflows: y.inflows[i],
      qCount,
    };
  });
  return { years, quarters, metrics: summary.metrics, periodQ: summary.period_q, trackedSinceQ: summary.tracked_since_q };
}

/** How many years the Returns and AUM charts show: the last 15, or all of them. */
export type Range = "15" | "max";

export type Win = {
  years: YearPoint[];
  /** Index of the first windowed year in series.years. */
  offset: number;
  /** Years in the whole series. */
  total: number;
};

export function windowYears(series: Series, range: Range): Win {
  const n = series.years.length;
  const k = range === "max" ? n : Math.min(15, n);
  const offset = n - k;
  return { years: series.years.slice(offset), offset, total: n };
}

/** The windowed years that have a return: the bars of the Returns chart. */
export function returnYears(win: Pick<Win, "years">): YearPoint[] {
  return win.years.filter((y) => y.ret != null);
}

/** Label of the latest full year, or of the last year when none is full ("" for no years). */
export function lastFullLabel(years: YearPoint[]): string {
  for (let i = years.length - 1; i >= 0; i--) if (!years[i].part) return years[i].label;
  return years.length ? years[years.length - 1].label : "";
}

/** The year selected when the page opens: the latest full year. */
export function defaultYearLabel(summary: Summary): string {
  return lastFullLabel(buildSeries(summary).years);
}

export type SpanKpi = {
  /** Annualised return in percent; null under four quarters. */
  ann: number | null;
  /** Volatility in percent (stdev of the quarters x 2); null under four quarters. */
  vol: number | null;
  /** Worst fall from a peak, in percent (<= 0). */
  mdd: number;
  /** Share of quarters with a gain, 0..1; null without quarters. */
  qpos: number | null;
  /** Full years with a gain / full years in the span. */
  up: number;
  nFull: number;
  /** Growth of $1 over the span. */
  growth: number;
  /** Chained index (starts at 1) and its drawdown from the running peak. */
  idx: number[];
  dd: number[];
  /** Quarters in the span. */
  n: number;
  quarterly: true;
};

/** The four KPI tiles and the bracket pill for the years yearFrom..yearTo, from the quarterly returns inside them. */
export function spanKpi(series: Series, yearFrom: number, yearTo: number): SpanKpi {
  const r = series.quarters.filter((p) => yearOfQ(p.q) >= yearFrom && yearOfQ(p.q) <= yearTo).map((p) => p.ret);
  const n = r.length;
  const yrs = n / 4;
  let g = 1;
  let peak = 1;
  let worst = 0;
  let pos = 0;
  let sum = 0;
  let sq = 0;
  const idx = [1];
  const dd = [0];
  for (const x of r) {
    g *= 1 + x;
    idx.push(idx[idx.length - 1] * (1 + x));
    peak = Math.max(peak, idx[idx.length - 1]);
    const d = idx[idx.length - 1] / peak - 1;
    dd.push(d);
    if (d < worst) worst = d;
    if (x > 0) pos++;
    sum += x;
    sq += x * x;
  }
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : null;
  let nFull = 0;
  let up = 0;
  for (const y of series.years) {
    if (y.year < yearFrom || y.year > yearTo || y.part || y.ret == null) continue;
    nFull++;
    if (y.ret > 0) up++;
  }
  const ok = n >= 4;
  return {
    ann: ok ? (Math.pow(Math.max(g, 0), 1 / yrs) - 1) * 100 : null,
    vol: ok && sd != null ? sd * 2 * 100 : null,
    mdd: worst * 100,
    qpos: n ? pos / n : null,
    up,
    nFull,
    growth: g,
    idx,
    dd,
    n,
    quarterly: true,
  };
}

/** Annualised return of a span in percent; 0 when it has under four quarters (the bracket pill's figure). */
export function cagrOf(series: Series, yearFrom: number, yearTo: number): number {
  return spanKpi(series, yearFrom, yearTo).ann ?? 0;
}

/** Length of a span in years, counted in quarters: three quarters are 0.75. */
export function spanYears(series: Series, yearFrom: number, yearTo: number): number {
  return spanKpi(series, yearFrom, yearTo).n / 4;
}

/** "2019" for one year, "2015 to 2019" for a run. */
export function spanName(a: string, b: string): string {
  return a === b ? a : a + " to " + b;
}

export type YearDetail = {
  /** The year's quarters with a return, in order. */
  qs: QPoint[];
  /** Worst fall from a peak inside the year, in percent (<= 0). */
  mdd: number;
  /** Stdev of the quarters x 2, in percent; null under four quarters. */
  vol: number | null;
};

/** One year from its quarterly returns (the tooltip of a Returns bar). */
export function yearDetail(series: Series, year: number): YearDetail {
  const qs = series.quarters.filter((p) => yearOfQ(p.q) === year);
  const n = qs.length;
  let idx = 1;
  let peak = 1;
  let worst = 0;
  let sum = 0;
  let sq = 0;
  for (const p of qs) {
    idx *= 1 + p.ret;
    peak = Math.max(peak, idx);
    worst = Math.min(worst, idx / peak - 1);
    sum += p.ret;
    sq += p.ret * p.ret;
  }
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : null;
  return { qs, mdd: worst * 100, vol: n >= 4 && sd != null ? sd * 2 * 100 : null };
}
