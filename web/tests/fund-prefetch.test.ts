import { createPriorityQueue, networkIsConstrained, startPrefetch, whenIdle, type PageLike, type Priority } from "../src/fund/prefetch";
import { prefetchOrder, type Timeline } from "../src/fund/positions";
import type { PositionRow, Trade } from "../src/data/types";
import { clearDataCache, loadWeekly } from "../src/data/api";

/** A loader the test controls: every call is recorded and stays in flight until it is settled by hand. */
function loader() {
  const calls: { key: number; priority: Priority }[] = [];
  const open = new Map<number, { ok: (v: string) => void; no: (e: unknown) => void }>();
  let inFlight = { demand: 0, background: 0 };
  const peak = { demand: 0, background: 0 };
  const load = (key: number, priority: Priority) => {
    calls.push({ key, priority });
    inFlight[priority]++;
    peak[priority] = Math.max(peak[priority], inFlight[priority]);
    return new Promise<string>((ok, no) => {
      open.set(key, {
        ok: (v) => {
          inFlight[priority]--;
          ok(v);
        },
        no: (e) => {
          inFlight[priority]--;
          no(e);
        },
      });
    });
  };
  /** Settles the call in flight for `key` and lets the queue react. */
  const finish = async (key: number, value = "v" + key) => {
    open.get(key)!.ok(value);
    open.delete(key);
    await Promise.resolve();
    await Promise.resolve();
  };
  const fail = async (key: number, err: unknown) => {
    open.get(key)!.no(err);
    open.delete(key);
    await Promise.resolve();
    await Promise.resolve();
  };
  const started = (priority?: Priority) => calls.filter((c) => !priority || c.priority === priority).map((c) => c.key);
  return { load, calls, open, peak, finish, fail, started, inFlight: () => ({ ...inFlight }) };
}

const keys = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
class Missing extends Error {}

describe("the two-priority queue", () => {
  test("background work runs 3 at a time, in the order it was planned, with low priority", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(10));
    expect(l.started()).toEqual([1, 2, 3]);
    expect(l.calls.every((c) => c.priority === "background")).toBe(true);
    await l.finish(2);
    expect(l.started()).toEqual([1, 2, 3, 4]);
    await l.finish(1);
    await l.finish(3);
    expect(l.started()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(q.get(2)).toEqual({ value: "v2", failed: false });
    expect(q.get(5)).toBeUndefined();
  });

  test("never more than 8 demand loads and 3 background loads in flight, however much is queued", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(40, 1000));
    expect(l.inFlight()).toEqual({ demand: 0, background: 3 });
    q.demand(keys(30));
    expect(l.inFlight()).toEqual({ demand: 8, background: 3 });
    for (let i = 0; i < 200; i++) {
      const next = [...l.open.keys()][0];
      if (next === undefined) break;
      await l.finish(next);
    }
    expect(l.peak).toEqual({ demand: 8, background: 3 });
    expect(l.started("demand")).toHaveLength(30);
    expect(l.started("background")).toHaveLength(40);
  });

  test("demand starts at once, ahead of the whole background plan, even while the background slots are full", () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(50, 100));
    expect(l.started()).toEqual([100, 101, 102]);
    q.demand([7, 8]);
    expect(l.started("demand")).toEqual([7, 8]);
    expect(l.started("background")).toEqual([100, 101, 102]);
  });

  test("a demand line is served first: no background key starts while demand is waiting for a slot", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load, demandLimit: 2, backgroundLimit: 1 });
    q.demand([1, 2, 3, 4]);
    q.background([50, 51]);
    expect(l.started()).toEqual([1, 2]); // 3 and 4 wait for a demand slot: 50 does not start meanwhile
    await l.finish(1);
    expect(l.started()).toEqual([1, 2, 3]);
    await l.finish(2);
    expect(l.started()).toEqual([1, 2, 3, 4, 50]); // the demand line is empty now: the background plan begins, one at a time
    await l.finish(50);
    expect(l.started()).toEqual([1, 2, 3, 4, 50, 51]);
  });

  test("with demand already running (nothing waiting), background work still gets its own three slots", () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.demand(keys(5));
    q.background(keys(9, 100));
    expect(l.inFlight()).toEqual({ demand: 5, background: 3 });
  });

  test("a demand for a key waiting in the background moves it ahead of the plan and loads it as demand", () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(10));
    expect(l.started()).toEqual([1, 2, 3]);
    q.demand([9]);
    expect(l.calls.at(-1)).toEqual({ key: 9, priority: "demand" });
    expect(l.started().filter((k) => k === 9)).toHaveLength(1);
  });

  test("a demand for a key already loading in the background waits for that load (one request) and frees its slot", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(10));
    expect(l.started()).toEqual([1, 2, 3]);
    const seen: number[] = [];
    q.subscribe((k) => seen.push(k));
    q.demand([2]);
    // promoted: it counts as demand now, so the background line moves on at once
    expect(l.started()).toEqual([1, 2, 3, 4]);
    expect(q.stats()).toMatchObject({ runningDemand: 1, runningBackground: 3 });
    expect(l.started().filter((k) => k === 2)).toHaveLength(1);
    await l.finish(2, "from the first request");
    expect(q.get(2)).toEqual({ value: "from the first request", failed: false });
    expect(seen).toEqual([2]);
    expect(q.stats().runningDemand).toBe(0);
  });

  test("a settled key is never loaded again, whoever asks", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.demand([1]);
    await l.finish(1);
    q.demand([1]);
    q.background([1]);
    expect(l.started()).toEqual([1]);
  });

  test("releasing a demand drops the keys that have not started; a planned key goes back to the background", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load, demandLimit: 2, backgroundLimit: 1 });
    q.background([10, 11, 12]);
    const d = q.demand([1, 2, 3, 4, 12]); // 3, 4, 12 are waiting
    expect(l.started()).toEqual([10, 1, 2]);
    d.release();
    await l.finish(1);
    await l.finish(2);
    expect(l.started("demand")).toEqual([1, 2]); // 3 and 4 never started
    await l.finish(10);
    expect(l.started("background")).toEqual([10, 11]);
    await l.finish(11);
    expect(l.started("background")).toEqual([10, 11, 12]); // 12 is back in the plan
    d.release(); // twice is fine
  });

  test("pause holds back new background starts only; resume carries on", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.pause();
    q.background(keys(5));
    expect(l.started()).toEqual([]);
    q.demand([99]);
    expect(l.started()).toEqual([99]);
    q.resume();
    expect(l.started()).toEqual([99, 1, 2, 3]);
    q.pause();
    await l.finish(1);
    expect(l.started()).toEqual([99, 1, 2, 3]); // the freed slot stays empty while paused
    q.resume();
    expect(l.started()).toEqual([99, 1, 2, 3, 4]);
  });

  test("cancel forgets everything that has not started, and what is running starts nothing more", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.background(keys(20));
    q.demand(keys(12, 100));
    const before = l.calls.length;
    expect(before).toBe(11); // 3 background + 8 demand
    q.cancel();
    expect(q.stats()).toMatchObject({ queuedDemand: 0, queuedBackground: 0 });
    for (const k of [...l.open.keys()]) await l.finish(k);
    expect(l.calls).toHaveLength(before);
    // the queue is still usable afterwards, and what arrived meanwhile is kept
    expect(q.get(1)).toEqual({ value: "v1", failed: false });
    q.background([500]);
    expect(l.started()).toContain(500);
  });

  test("dropBackground keeps the demand that is waiting", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load, demandLimit: 1 });
    q.background(keys(10));
    q.demand([7, 8]);
    q.dropBackground();
    await l.finish(7);
    expect(l.started("demand")).toEqual([7, 8]);
    for (const k of [...l.open.keys()]) await l.finish(k);
    expect(l.started("background")).toEqual([1, 2, 3]);
  });

  test("a missing file is a result (null), kept and never retried", async () => {
    vi.useFakeTimers();
    try {
      const l = loader();
      const q = createPriorityQueue<number, string>({ load: l.load, isMissing: (e) => e instanceof Missing, retryDelay: 10 });
      q.background([1]);
      await l.fail(1, new Missing());
      expect(q.get(1)).toEqual({ value: null, failed: false });
      vi.advanceTimersByTime(60_000);
      q.demand([1]);
      expect(l.started()).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("another failure in the background is retried once, later, without a word; then it is given up quietly", async () => {
    vi.useFakeTimers();
    try {
      const l = loader();
      const q = createPriorityQueue<number, string>({ load: l.load, retryDelay: 1000 });
      const seen: number[] = [];
      q.subscribe((k) => seen.push(k));
      q.background([1, 2]);
      await l.fail(1, new Error("HTTP 500"));
      expect(q.get(1)).toBeUndefined();
      expect(l.started()).toEqual([1, 2]);
      vi.advanceTimersByTime(999);
      expect(l.started()).toEqual([1, 2]);
      vi.advanceTimersByTime(1);
      expect(l.started()).toEqual([1, 2, 1]); // the one retry, still background
      expect(l.calls.at(-1)?.priority).toBe("background");
      await l.fail(1, new Error("HTTP 500 again"));
      vi.advanceTimersByTime(60_000);
      expect(l.started()).toEqual([1, 2, 1]);
      expect(q.get(1)).toBeUndefined(); // no failure result, nothing said
      expect(seen).toEqual([]);
      // a later demand may try afresh
      q.demand([1]);
      expect(l.started()).toEqual([1, 2, 1, 1]);
      expect(l.calls.at(-1)?.priority).toBe("demand");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a retry that works settles normally", async () => {
    vi.useFakeTimers();
    try {
      const l = loader();
      const q = createPriorityQueue<number, string>({ load: l.load, retryDelay: 50 });
      q.background([1]);
      await l.fail(1, new Error("offline"));
      vi.advanceTimersByTime(50);
      await l.finish(1, "second time");
      expect(q.get(1)).toEqual({ value: "second time", failed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failure someone is waiting for is a result they can see: null, failed", async () => {
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    q.demand([1]);
    await l.fail(1, new Error("HTTP 500"));
    expect(q.get(1)).toEqual({ value: null, failed: true });
    // a background load that someone starts to wait for counts the same
    q.background([2]);
    q.demand([2]);
    await l.fail(2, new Error("HTTP 500"));
    expect(q.get(2)).toEqual({ value: null, failed: true });
  });

  test("cancel stops a retry that is waiting; a demand during the wait loads at once", async () => {
    vi.useFakeTimers();
    try {
      const l = loader();
      const q = createPriorityQueue<number, string>({ load: l.load, retryDelay: 1000 });
      q.background([1, 2]);
      await l.fail(1, new Error("x"));
      await l.fail(2, new Error("x"));
      q.demand([2]);
      expect(l.started()).toEqual([1, 2, 2]);
      q.cancel();
      vi.advanceTimersByTime(10_000);
      expect(l.started()).toEqual([1, 2, 2]); // key 1's retry never happens
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("when to run background work", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("whenIdle uses requestIdleCallback with a timeout, and can be cancelled", () => {
    const ric = vi.fn(() => 7);
    const cic = vi.fn();
    vi.stubGlobal("requestIdleCallback", ric);
    vi.stubGlobal("cancelIdleCallback", cic);
    const fn = vi.fn();
    const cancel = whenIdle(fn, { timeout: 900 });
    expect(ric).toHaveBeenCalledWith(fn, { timeout: 900 });
    cancel();
    expect(cic).toHaveBeenCalledWith(7);
  });

  test("without requestIdleCallback it falls back to a timer", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("requestIdleCallback", undefined);
      const fn = vi.fn();
      const cancel = whenIdle(fn, { fallback: 30 });
      vi.advanceTimersByTime(29);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      const fn2 = vi.fn();
      whenIdle(fn2, { fallback: 30 })();
      vi.advanceTimersByTime(100);
      expect(fn2).not.toHaveBeenCalled();
      void cancel;
    } finally {
      vi.useRealTimers();
    }
  });

  test("Save-Data and 2G connections are constrained; 3G, 4G and browsers without the API are not", () => {
    expect(networkIsConstrained({ connection: { saveData: true } })).toBe(true);
    expect(networkIsConstrained({ connection: { effectiveType: "2g" } })).toBe(true);
    expect(networkIsConstrained({ connection: { effectiveType: "slow-2g" } })).toBe(true);
    expect(networkIsConstrained({ connection: { effectiveType: "3g", saveData: false } })).toBe(false);
    expect(networkIsConstrained({ connection: { effectiveType: "4g" } })).toBe(false);
    expect(networkIsConstrained({})).toBe(false);
    expect(networkIsConstrained(undefined)).toBe(false);
  });

  /** A page that can be hidden and shown. */
  function page(hidden = false) {
    const fns = new Set<() => void>();
    const p: PageLike & { hidden: boolean; show(): void; hide(): void; listeners(): number } = {
      hidden,
      addEventListener: (_t, fn) => void fns.add(fn),
      removeEventListener: (_t, fn) => void fns.delete(fn),
      show() {
        p.hidden = false;
        fns.forEach((f) => f());
      },
      hide() {
        p.hidden = true;
        fns.forEach((f) => f());
      },
      listeners: () => fns.size,
    };
    return p;
  }

  test("startPrefetch plans the keys only when the browser is idle", () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => ((idle = cb), 1));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    const planned = vi.fn(() => keys(5));
    startPrefetch(q, planned, page());
    expect(planned).not.toHaveBeenCalled(); // not even worked out before idle
    expect(l.calls).toHaveLength(0);
    idle!();
    expect(l.started()).toEqual([1, 2, 3]);
  });

  test("on Save-Data or 2G nothing is planned at all", () => {
    for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
      vi.stubGlobal("navigator", { connection });
      const ric = vi.fn();
      vi.stubGlobal("requestIdleCallback", ric);
      const l = loader();
      const q = createPriorityQueue<number, string>({ load: l.load });
      startPrefetch(q, keys(5), page())();
      expect(ric).not.toHaveBeenCalled();
      expect(l.calls).toHaveLength(0);
    }
  });

  test("a hidden tab holds the plan back and starts it when the tab is visible", async () => {
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => (cb(), 1));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    const pg = page(true);
    const stop = startPrefetch(q, keys(8), pg);
    expect(l.calls).toHaveLength(0);
    pg.show();
    expect(l.started()).toEqual([1, 2, 3]);
    pg.hide();
    await l.finish(1);
    await l.finish(2);
    await l.finish(3);
    expect(l.started()).toEqual([1, 2, 3]); // paused again
    pg.show();
    expect(l.started()).toEqual([1, 2, 3, 4, 5, 6]);
    stop();
    expect(pg.listeners()).toBe(0);
    expect(q.stats().queuedBackground).toBe(0);
  });

  test("stopping before idle cancels the idle callback; stopping later drops what has not started", async () => {
    const cic = vi.fn();
    vi.stubGlobal("requestIdleCallback", () => 3);
    vi.stubGlobal("cancelIdleCallback", cic);
    const l = loader();
    const q = createPriorityQueue<number, string>({ load: l.load });
    startPrefetch(q, keys(5), page())();
    expect(cic).toHaveBeenCalledWith(3);

    vi.stubGlobal("requestIdleCallback", (cb: () => void) => (cb(), 1));
    const stop = startPrefetch(q, keys(10, 100), page());
    expect(l.started()).toEqual([100, 101, 102]);
    stop();
    await l.finish(100);
    await l.finish(101);
    await l.finish(102);
    expect(l.started()).toEqual([100, 101, 102]);
  });
});

describe("the prefetch order", () => {
  const tl: Timeline = { qmin: 4, latest: 53, asof: "2026-10-30" };
  const tr = (q: number, delta: number, after: number): Trade => ({ q, delta, px: 10, low: null, high: null, sharesAfter: after });
  const pos = (id: number, trades: Trade[], over: Partial<PositionRow> = {}): PositionRow => ({
    stock_id: id,
    from_q: trades[0].q,
    to_q: null,
    avg_cost: 10,
    avg_exit: null,
    invested: 100,
    realised: 0,
    dividends: 0,
    shares_now: trades[trades.length - 1].sharesAfter,
    cost_now: 10,
    last_q: trades[trades.length - 1].q,
    last_type: "new",
    last_pct: null,
    last_usd: 0,
    trades,
    ...over,
  });

  test("held at the newest quarter first (largest first), then the rest by latest trade, most recent first", () => {
    const rows = [
      pos(1, [tr(10, 5, 5), tr(20, -5, 0)]), // sold out in Q20
      pos(2, [tr(8, 100, 100)], { shares_now: 100 }), // held, 100 sh
      pos(3, [tr(30, 5, 5), tr(40, -5, 0)]), // sold out in Q40
      pos(4, [tr(9, 100, 100)], { shares_now: 100 }), // held, dearer
      pos(5, [tr(35, 5, 5), tr(40, -5, 0)], { invested: 900 }), // sold out in Q40 as well, invested more: before 3
      pos(6, [tr(12, 10, 10)], { shares_now: 10 }), // held, unpriced: valued at cost_now
    ];
    const prices = new Map([
      [2, 1],
      [4, 3],
    ]);
    expect(prefetchOrder(rows, tl, prices)).toEqual([4, 2, 6, 5, 3, 1]);
  });

  test("a stock the fund sold out before the newest quarter is not 'held' however its row reads", () => {
    const rows = [pos(1, [tr(10, 5, 5), tr(52, -5, 0)], { shares_now: 5 }), pos(2, [tr(53, 5, 5)], { shares_now: 5 })];
    expect(prefetchOrder(rows, tl, new Map())).toEqual([2, 1]);
  });
});

describe("the fetch helper's low-priority option", () => {
  const stub = () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ start: "2020-01-03", close: [1] }) }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  beforeEach(() => clearDataCache());
  afterEach(() => vi.unstubAllGlobals());

  test("only a background load asks for low priority; an ordinary load is the plain call it always was", async () => {
    const fn = stub();
    await loadWeekly(1, { priority: "low" });
    await loadWeekly(2);
    expect(fn.mock.calls).toEqual([
      ["/demo-data/stock/1/weekly.json", { priority: "low" }],
      ["/demo-data/stock/2/weekly.json"],
    ]);
  });

  test("one request per URL: a load that is needed now awaits the low-priority request already under way", async () => {
    const fn = stub();
    const background = loadWeekly(3, { priority: "low" });
    const now = loadWeekly(3);
    expect(now).toBe(background);
    await now;
    await loadWeekly(3, { priority: "low" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
