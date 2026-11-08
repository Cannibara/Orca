// Loading for the Positions panel: the weekly price files an earlier period needs, and the table's rows
// once they are in. The newest quarter needs no weekly file at all.
//
// Every weekly file goes through one queue per panel (src/fund/prefetch.ts). A period that needs files asks
// for them as DEMAND; once the page is idle after landing, the files of every position of the fund are
// planned as BACKGROUND work, so that stepping back through the quarters finds them already loaded.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NotFoundError, loadWeekly, type Stock } from "../data/api";
import type { PositionRow, Weekly } from "../data/types";
import { buildRows, neededStocks, prefetchOrder, type PosRow, type Timeline } from "./positions";
import { createPriorityQueue, startPrefetch, type PriorityQueue } from "./prefetch";

/** Weekly series by stock id; a settled value of null = the stock has no file (or it could not be loaded). */
export type WeeklyStore = PriorityQueue<number, Weekly>;

/** How long the "Loading prices… 120 of 340" count waits between updates. */
const PROGRESS_MS = 120;

export function createWeeklyStore(): WeeklyStore {
  return createPriorityQueue<number, Weekly>({
    // only background loads ask the browser for low priority; a URL already loading keeps its request
    load: (id, priority) => (priority === "background" ? loadWeekly(id, { priority: "low" }) : loadWeekly(id)),
    isMissing: (err) => err instanceof NotFoundError,
  });
}

/** The panel's queue, for the rows that open into a price chart. */
export const WeeklyStoreContext = createContext<WeeklyStore | null>(null);

/**
 * The panel's weekly queue. Once the browser is idle after the panel has landed, it plans the weekly file
 * of every position of the fund in the background (held now first, then the rest by latest trade), unless
 * the visitor saves data or is on a 2G connection; it pauses while the tab is hidden. Unmounting (or a new
 * fund, which re-keys the panel) drops everything that has not started.
 */
export function useWeeklyStore(positions: PositionRow[], tl: Timeline, prices: Map<number, number>): WeeklyStore {
  const [store] = useState(createWeeklyStore);
  useEffect(() => startPrefetch(store, () => prefetchOrder(positions, tl, prices)), [store, positions, tl, prices]);
  useEffect(() => () => store.cancel(), [store]);
  return store;
}

const countSettled = (store: WeeklyStore, ids: readonly number[]): number => {
  let n = 0;
  for (const id of ids) if (store.get(id)) n++;
  return n;
};

/**
 * Tells React when some of `ids` have settled: at once for the last of them, otherwise at most every
 * PROGRESS_MS, so a long wait updates its count a few times a second instead of once per file.
 */
function subscribeToIds(store: WeeklyStore, ids: readonly number[], onChange: () => void): () => void {
  const left = new Set(ids.filter((id) => !store.get(id)));
  if (left.size === 0) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = store.subscribe((key) => {
    if (!left.delete(key)) return;
    if (left.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      onChange();
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        onChange();
      }, PROGRESS_MS);
    }
  });
  return () => {
    off();
    clearTimeout(timer);
  };
}

export type WeeklyPrices = {
  /** Series of the ids settled so far; null = the stock has no file or it could not be loaded. */
  weekly: ReadonlyMap<number, Weekly | null>;
  /** Some of the ids are still to come. */
  pending: boolean;
  /** Ids whose file could not be loaded (a missing file is not a failure). */
  failed: number;
  /** How many of the ids are in. */
  progress: { done: number; total: number };
};

/**
 * Weekly series of the given ids from the store. Those not in it yet are asked for as demand (ahead of
 * all background work; one that is already loading in the background is just waited for) and dropped again
 * if the ids change before they start. A stock without a file is null; any other failure is null as well
 * and counted in `failed`, so the panel can say its prices fell back to trade prices.
 */
export function useWeeklyPrices(store: WeeklyStore, ids: number[]): WeeklyPrices {
  const subscribe = useCallback((onChange: () => void) => subscribeToIds(store, ids, onChange), [store, ids]);
  const done = useSyncExternalStore(
    subscribe,
    () => countSettled(store, ids),
    () => 0,
  );

  useEffect(() => {
    const missing = ids.filter((id) => !store.get(id));
    if (missing.length === 0) return;
    const claim = store.demand(missing);
    return () => claim.release();
  }, [store, ids]);

  const weekly = useMemo(() => {
    const m = new Map<number, Weekly | null>();
    for (const id of ids) {
      const r = store.get(id);
      if (r) m.set(id, r.value);
    }
    return m;
  }, [store, ids, done]); // `done` says the store has more of the ids
  const failed = useMemo(
    () => ids.reduce((n, id) => n + (store.get(id)?.failed ? 1 : 0), 0),
    [store, ids, done],
  );
  return { weekly, pending: done < ids.length, failed, progress: { done, total: ids.length } };
}

export type PositionData = {
  /** Rows of the last period that finished loading; null before the first one. */
  rows: PosRow[] | null;
  /** The period asked for is still loading its prices: `rows` are the previous period's. */
  pending: boolean;
  failed: number;
  /** Weekly files in, of those the period needs. */
  progress: { done: number; total: number };
};

type Inputs = {
  positions: PositionRow[];
  tl: Timeline;
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  qs: number;
  qe: number;
  store: WeeklyStore;
};

/** The table's rows for the period qs..qe; the previous rows stay while the next period's prices load. */
export function usePositionData({ positions, tl, prices, stocks, qs, qe, store }: Inputs): PositionData {
  const needed = useMemo(() => neededStocks(positions, qs, qe, tl), [positions, qs, qe, tl]);
  const { weekly, pending, failed, progress } = useWeeklyPrices(store, needed);
  const rows = useMemo(
    () => (pending ? null : buildRows(positions, qs, qe, { tl, prices, weekly }, stocks)),
    [pending, positions, qs, qe, tl, prices, weekly, stocks],
  );
  const last = useRef<PosRow[] | null>(null);
  if (rows) last.current = rows;
  return { rows: rows ?? last.current, pending, failed, progress };
}

/**
 * One stock's weekly series for its price chart: undefined while loading, null when the stock has none
 * (or it could not be loaded). Opening a row asks for it as demand: it overtakes the background plan.
 */
export function useWeekly(stockId: number): Weekly | null | undefined {
  const shared = useContext(WeeklyStoreContext);
  const [own] = useState(createWeeklyStore); // a chart outside the panel has a queue of its own
  const store = shared ?? own;
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe((key) => key === stockId && onChange()),
    [store, stockId],
  );
  const got = useSyncExternalStore(
    subscribe,
    () => store.get(stockId),
    () => undefined,
  );
  useEffect(() => {
    if (store.get(stockId)) return;
    const claim = store.demand([stockId]);
    return () => claim.release();
  }, [store, stockId]);
  return got ? got.value : undefined;
}
