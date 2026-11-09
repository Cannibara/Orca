// How a long table loads: the rows the Positions table and the What-if table draw at first paint, how many
// more they add by themselves once the page is idle, and how many a click adds. One module, so both
// tables behave the same and the numbers live in one place.
//
// The rule: a visitor lands, sees what they normally look for (the biggest holdings, as many as a few
// screens), and gets the details later. Nothing is added after first paint unless it is cheap, and
// whatever is left is one click away. A fund with fewer rows than AUTO_FILL_MAX behaves as if every row
// fills in by itself.
//
// WHERE THE NUMBERS COME FROM (Chromium, production build, synthetic funds of 3,000 positions served with
// 8 ms latency; 4x is CDP CPU throttling, a mid-range phone; the table is a plain <table> with 13 or 14
// columns and fixed 38px rows, and the browser's layout and paint of the whole table grow with the number of
// rows in it, so what one added chunk costs depends on how many rows are already there):
//
//   TABLE_MEASUREMENTS_PLACEHOLDER

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { whenIdle } from "./prefetch";

/** Rows in the first paint. */
export const INITIAL_ROWS = 50;
/** Rows the table adds by itself after landing, in total (including the first paint); the rest wait for a click. */
export const AUTO_FILL_MAX = 400;
/** Rows added by each idle step of the automatic fill. */
export const CHUNK = 50;
/** Rows a click on "Show more" adds, at once. */
export const MORE_STEP = 250;

/** A chunk that takes longer than this to commit halves the next one (a slow device); one under FAST_MS lets it grow back. */
const SLOW_MS = 40;
const FAST_MS = 15;
const MIN_CHUNK = 10;

export type RowBudget = {
  /** How many of the sorted rows to draw now. */
  limit: number;
  /** Rows still to arrive by themselves (zero once the automatic fill is done). */
  filling: number;
  /** Rows not drawn and not coming by themselves: they wait for "Show more". */
  left: number;
  /** Draw the next MORE_STEP rows at once. */
  more(): void;
};

/**
 * How many rows to draw: INITIAL_ROWS at first paint, then CHUNK more each time the browser is idle until
 * AUTO_FILL_MAX (or all of them) are in, then MORE_STEP more per call of `more`. A new `restartKey` (a new
 * sort order or new data) starts again from the first rows, so the top of the list is always drawn first and
 * what a click added is forgotten with the order it belonged to.
 */
export function useRowBudget(total: number, restartKey: unknown): RowBudget {
  const [grown, setGrown] = useState<{ key: unknown; n: number }>({ key: restartKey, n: INITIAL_ROWS });
  // a new key falls back to the first rows during the render itself: no frame draws the old count over the new order
  const n = grown.key === restartKey ? grown.n : INITIAL_ROWS;
  const limit = Math.min(total, n);
  const target = Math.min(total, AUTO_FILL_MAX);

  // How big the next idle chunk is: CHUNK, less on a device that drew the last one slowly.
  const pace = useRef({ size: CHUNK, from: 0, rows: 0 });
  useEffect(() => {
    if (limit >= target) return;
    return whenIdle(
      () => {
        pace.current.from = performance.now();
        pace.current.rows = pace.current.size;
        setGrown((g) => ({ key: restartKey, n: Math.min(target, (g.key === restartKey ? g.n : INITIAL_ROWS) + pace.current.size) }));
      },
      { timeout: 1000, fallback: 16 },
    );
  }, [limit, target, restartKey]);
  useLayoutEffect(() => {
    const p = pace.current;
    if (p.from === 0) return;
    const ms = performance.now() - p.from; // React's render and commit of the chunk
    p.from = 0;
    p.size = ms > SLOW_MS ? Math.max(MIN_CHUNK, Math.floor(p.rows / 2)) : ms < FAST_MS ? Math.min(CHUNK, p.rows * 2) : p.rows;
  }, [limit]);

  const more = useCallback(
    () => setGrown((g) => ({ key: restartKey, n: (g.key === restartKey ? g.n : INITIAL_ROWS) + MORE_STEP })),
    [restartKey],
  );
  return { limit, filling: Math.max(0, target - limit), left: total - Math.max(limit, target), more };
}

/** The "Show more" button's words: "Show 250 more · 1,420 left"; just "Show 120 more" when that is all there is. */
export function moreLabel(left: number): string {
  const step = Math.min(MORE_STEP, left);
  const n = (v: number) => v.toLocaleString("en-US");
  return step === left ? `Show ${n(step)} more` : `Show ${n(step)} more · ${n(left)} left`;
}
