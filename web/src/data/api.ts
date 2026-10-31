// Typed loaders for the published JSON (paths exactly as in pipeline/contract.md),
// plus the small helpers every page shares: toRows, priceMap, priceDates, yearsSince2013.
import type {
  Contrib,
  Exits,
  FundsIndex,
  HomeFiles,
  HomeName,
  LatestPrices,
  Positions,
  Securities,
  Summary,
  Weekly,
} from "./types";

/** The requested file does not exist (HTTP 404): an unknown fund or stock id. */
export class NotFoundError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`Not found: ${url}`);
    this.name = "NotFoundError";
    this.url = url;
  }
}

/** Data base URL without a trailing slash. Read per call so tests can change it. */
function baseUrl(): string {
  const base: string = import.meta.env.VITE_DATA_URL ?? "/demo-data";
  return base.replace(/\/+$/, "");
}

const cache = new Map<string, Promise<unknown>>();

/** Forget every cached response (tests; a retry after a rejection needs no help, see getJson). */
export function clearDataCache(): void {
  cache.clear();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (res.status === 404) throw new NotFoundError(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** One request per URL. A rejected request leaves the cache, so a retry refetches. */
function getJson<T>(path: string): Promise<T> {
  const url = `${baseUrl()}/${path}`;
  let p = cache.get(url);
  if (!p) {
    const fresh: Promise<unknown> = fetchJson(url).catch((err: unknown) => {
      if (cache.get(url) === fresh) cache.delete(url);
      throw err;
    });
    cache.set(url, fresh);
    p = fresh;
  }
  return p as Promise<T>;
}

export const loadFunds = () => getJson<FundsIndex>("funds.json");
export const loadSecurities = () => getJson<Securities>("securities.json");
export const loadLatestPrices = () => getJson<LatestPrices>("latest_prices.json");
export const loadSummary = (id: number) => getJson<Summary>(`fund/${id}/summary.json`);
export const loadPositions = (id: number) => getJson<Positions>(`fund/${id}/positions.json`);
export const loadContrib = (id: number) => getJson<Contrib>(`fund/${id}/contrib.json`);
export const loadExits = (id: number) => getJson<Exits>(`fund/${id}/exits.json`);
export const loadWeekly = (stockId: number) => getJson<Weekly>(`stock/${stockId}/weekly.json`);
export const loadHome = <N extends HomeName>(name: N) => getJson<HomeFiles[N]>(`home/${name}.json`);

/** Column-oriented block -> one object per row (all columns have the same length). */
export function toRows<T>(cols: Record<string, unknown[]>): T[] {
  const keys = Object.keys(cols);
  if (keys.length === 0) return [];
  const n = cols[keys[0]].length;
  const rows: T[] = new Array<T>(n);
  for (let i = 0; i < n; i++) {
    const r: Record<string, unknown> = {};
    for (const k of keys) r[k] = cols[k][i];
    rows[i] = r as T;
  }
  return rows;
}

/**
 * stock_id -> latest close, for every stock that has one. A stale close (a delisted
 * stock's last price) is kept: it is the best value there is. priceDates says how old.
 */
export function priceMap(lp: LatestPrices): Map<number, number> {
  const m = new Map<number, number>();
  lp.stock_id.forEach((id, i) => {
    const p = lp.price[i];
    if (p != null) m.set(id, p);
  });
  return m;
}

/** stock_id -> ISO date of its latest close, for every stock that has one. */
export function priceDates(lp: LatestPrices): Map<number, string> {
  const m = new Map<number, string>();
  lp.stock_id.forEach((id, i) => {
    const d = lp.date[i];
    if (d != null) m.set(id, d);
  });
  return m;
}

/** Years from 2013-01-01 to an ISO date (365.25-day years): the IRR clock. */
export function yearsSince2013(isoDate: string): number {
  return (Date.parse(isoDate) - Date.UTC(2013, 0, 1)) / (365.25 * 86_400_000);
}
