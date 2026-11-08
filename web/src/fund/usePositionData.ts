// Loading for the Positions panel: the weekly price files an earlier period needs, and the
// table's rows once they are in. The newest quarter needs no weekly file at all.

import { useEffect, useMemo, useRef, useState } from "react";
import { NotFoundError, loadWeekly, type Stock } from "../data/api";
import type { PositionRow, Weekly } from "../data/types";
import { buildRows, neededStocks, type PosRow, type Timeline } from "./positions";

/** How many weekly files are in flight at once: a long period can need hundreds. */
const CONCURRENCY = 8;

type Loaded = ReadonlyMap<number, Weekly | null>;

/**
 * Weekly series of the given stocks, fetched at most CONCURRENCY at a time and kept for the life of
 * the panel (loadWeekly caches per URL too). A stock without a file is null; any other failure is
 * null as well and counted in `failed`, so the panel can say its prices fell back to trade prices.
 * A change of `ids` stops fetches that have not started.
 */
export function useWeeklyPrices(ids: number[]): { weekly: Loaded; pending: boolean; failed: number } {
  const [weekly, setWeekly] = useState<Loaded>(() => new Map());
  const [failed, setFailed] = useState(0);
  const missing = useMemo(() => ids.filter((id) => !weekly.has(id)), [ids, weekly]);

  useEffect(() => {
    if (missing.length === 0) return;
    let live = true;
    const queue = missing.slice();
    const done = new Map<number, Weekly | null>();
    let bad = 0;
    const flush = () => {
      if (done.size === 0) return;
      const add = new Map(done);
      const nBad = bad;
      done.clear();
      bad = 0;
      setWeekly((prev) => new Map([...prev, ...add]));
      if (nBad) setFailed((n) => n + nBad);
    };
    const worker = async () => {
      for (let id = queue.shift(); live && id !== undefined; id = queue.shift()) {
        try {
          done.set(id, await loadWeekly(id));
        } catch (err) {
          done.set(id, null);
          if (!(err instanceof NotFoundError)) bad++;
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).then(flush);
    return () => {
      live = false;
      flush(); // keep what already arrived
    };
  }, [missing]);

  return { weekly, pending: missing.length > 0, failed };
}

export type PositionData = {
  /** Rows of the last period that finished loading; null before the first one. */
  rows: PosRow[] | null;
  /** The period asked for is still loading its prices: `rows` are the previous period's. */
  pending: boolean;
  failed: number;
};

type Inputs = {
  positions: PositionRow[];
  tl: Timeline;
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  qs: number;
  qe: number;
};

/** The table's rows for the period qs..qe; the previous rows stay while the next period's prices load. */
export function usePositionData({ positions, tl, prices, stocks, qs, qe }: Inputs): PositionData {
  const needed = useMemo(() => neededStocks(positions, qs, qe, tl), [positions, qs, qe, tl]);
  const { weekly, pending, failed } = useWeeklyPrices(needed);
  const rows = useMemo(
    () => (pending ? null : buildRows(positions, qs, qe, { tl, prices, weekly }, stocks)),
    [pending, positions, qs, qe, tl, prices, weekly, stocks],
  );
  const last = useRef<PosRow[] | null>(null);
  if (rows) last.current = rows;
  return { rows: rows ?? last.current, pending, failed };
}

/**
 * One stock's weekly series for its price chart: undefined while loading, null when the stock has none
 * (or it could not be loaded).
 */
export function useWeekly(stockId: number): Weekly | null | undefined {
  const [got, setGot] = useState<{ id: number; w: Weekly | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadWeekly(stockId).then(
      (w) => live && setGot({ id: stockId, w }),
      () => live && setGot({ id: stockId, w: null }),
    );
    return () => {
      live = false;
    };
  }, [stockId]);
  return got && got.id === stockId ? got.w : undefined;
}
