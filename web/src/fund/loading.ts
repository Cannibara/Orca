// How a long table loads: the rows the Positions table and the What-if table draw at first paint, how many
// more they add by themselves once the page is idle, and how many a click adds. One module, so both
// tables behave the same and the numbers live in one place.
//
// The rule: a visitor lands, sees what they normally look for (the biggest holdings, a few screens of
// them), and gets the details later. Nothing is added after first paint unless it is cheap, and whatever is
// left is one click away. A table with no more rows than AUTO_FILL_MAX fills in completely by itself and
// never shows a button.
//
// WHERE THE NUMBERS COME FROM. Chromium, production build, a synthetic fund of 3,000 positions (1,600 sales)
// served with 8 ms latency; "4x" is CDP CPU throttling, a mid-range phone. Both tables of the page grow
// at once. The table is a plain <table>: React's work for a chunk is small and time-sliced (see below), but
// the browser's layout, paint and layerize of the page after each commit grow with the number of rows in
// the table, so what one added chunk costs depends on how many rows are already there. A "task" below is
// the longest single main-thread task a chunk causes (the rendering task after its commit).
//
//   INITIAL_ROWS  first paint (navigation start to the table painted), median of 7, positions + sales table
//                  rows in first paint    10     30     50     100    150
//                  1x                    350    389    386    437    544   ms
//                  4x                   1202   1273   1391   1781   2080   ms
//                50 is the knee: 3+ screens of the table (15 rows are visible at its 620px height), 160 ms (1x) and
//                690 ms (4x) faster than the old 150, and only 120 ms (4x) slower than 30. The top 50 holdings are
//                about half the book of a large fund (Zipf-shaped funds of 1,000-3,000 positions: 42-69%); every
//                fund of 50 positions or fewer, which is nearly all of them (the demo funds hold 7-18), is complete.
//   AUTO_FILL_MAX, CHUNK  task per added chunk, median / worst of 3 runs, by rows already in the table
//                  rows in table      51-100     101-200    201-300    301-400
//                  1x, chunk 25       32 / 47    34 / 51    33 / 59    47 / 95   ms
//                  1x, chunk 50       36 / 47    38 / 49    40 / 54    47 / 67   ms
//                  1x, chunk 100        -        53 / 60    71 / 79    71 / 94   ms
//                  4x, chunk 25       85 / 141  101 / 140  124 / 179  134 / 252  ms
//                  4x, chunk 50      122 / 128  137 / 211  140 / 220  230 / 255  ms
//                  4x, chunk 100        -       210 / 229  248 / 314  218 / 234  ms
//                On a desktop every chunk of 25 stays at the 50 ms long-task line up to about 200-300 rows and
//                breaks it beyond; bigger chunks break it sooner. The rendering floor of this page is 35-50 ms
//                at 4x with almost no rows, so no cap meets 50 ms there: 200 rows keep a phone's worst task
//                near 140 ms (chunk 25), 300 rows near 180. Small chunks win at every size: the task a chunk causes
//                grows with the chunk (25 to 100 rows doubles it at 1x and nearly triples it at 4x).
//   MORE_STEP     one click, rows appended at once, to a table of 200 (React renders it as a transition, so the
//                  click itself returns at once and input stays live; what remains is the browser's layout)
//                  rows added                100       250       500
//                  1x, longest task       40-57 ms  115-122 ms     -
//                  4x, longest task      181-386 ms 405-454 ms     -
//                100 keeps a click inside the 50 ms line on a desktop; 250 doubles it.
//   Time-sliced rendering also replaces the old "halve the chunk when it is slow" rule: with a transition the
//   chunk's own commit is a few ms (2-10 ms at 4x), so there is nothing left for halving to save.
//
// The weekly price files are another matter and are not capped by these numbers: stepping back to an earlier
// quarter needs the price of EVERY position of the fund, because every weight is a share of the whole book,
// whether or not its row is on screen. See usePositionData.

import { startTransition, useCallback, useEffect, useState } from "react";
import { whenIdle } from "./prefetch";

/** Rows in the first paint. */
export const INITIAL_ROWS = 50;
/** Rows the table has after the automatic fill (the first paint included); the rest wait for a click. */
export const AUTO_FILL_MAX = 200;
/** Rows added by each idle step of the automatic fill. */
export const CHUNK = 25;
/** Rows a click on "Show more" adds, at once. */
export const MORE_STEP = 100;

/** How many tables are still adding rows by themselves: the price prefetch waits for this to reach zero (see usePositionData). */
let fills = 0;
export const rowsAreFilling = (): boolean => fills > 0;

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

  const filling = Math.max(0, target - limit);
  useEffect(() => {
    if (!filling) return;
    fills++;
    return () => void fills--;
  }, [filling > 0]); // only the start and the end of a fill matter

  useEffect(() => {
    if (limit >= target) return;
    return whenIdle(
      () =>
        // a transition: React draws the chunk in slices that give way to input, and commits it in one go
        startTransition(() =>
          setGrown((g) => ({ key: restartKey, n: Math.min(target, (g.key === restartKey ? g.n : INITIAL_ROWS) + CHUNK) })),
        ),
      { timeout: 1000, fallback: 16 },
    );
  }, [limit, target, restartKey]);

  const more = useCallback(
    () => startTransition(() => setGrown((g) => ({ key: restartKey, n: (g.key === restartKey ? g.n : INITIAL_ROWS) + MORE_STEP }))),
    [restartKey],
  );
  return { limit, filling, left: total - Math.max(limit, target), more };
}

/** The "Show more" button's words: "Show 250 more · 1,420 left"; just "Show 120 more" when that is all there is. */
export function moreLabel(left: number): string {
  const step = Math.min(MORE_STEP, left);
  const n = (v: number) => v.toLocaleString("en-US");
  return step === left ? `Show ${n(step)} more` : `Show ${n(step)} more · ${n(left)} left`;
}
