// A small loading queue with two priorities, and the policy around background prefetching. Pure:
// it never touches React or the page (the browser bits are passed in or looked up lazily), so it is
// tested with fake timers and deferred promises.
//
// Two kinds of load share it:
//   DEMAND      something on screen needs the file now (the user stepped to an earlier quarter, chose
//               Year/Custom, or opened a row). Up to `demandLimit` run at once.
//   BACKGROUND  the file is only wanted so a later step is instant. Up to `backgroundLimit` run at once,
//               in the order they were handed in, and only while the queue is not paused.
// Demand always starts first, and no new background load starts while demand is waiting for a slot. A
// demand for a key that is waiting in the background moves it to the front of the demand line; for a key
// already loading in the background it just waits for that load and the load is counted as demand from
// then on (so it no longer holds one of the few background slots).
// Each key is loaded at most once: a settled key (a value, "no file" or a failure) stays settled.

export type Priority = "demand" | "background";

/** How a key ended: a value; `value: null` with `failed: false` = there is no such file; `failed: true` = it could not be loaded. */
export type Settled<V> = { readonly value: V | null; readonly failed: boolean };

export type QueueOptions<K, V> = {
  /** Starts one load; `priority` says which kind of request it is (a background one asks the browser for low fetch priority). */
  load: (key: K, priority: Priority) => Promise<V>;
  /** Whether an error means "there is no such file": that is a result (null), never retried. */
  isMissing?: (err: unknown) => boolean;
  /** Loads in flight at once for demand (default 8) and for background work (default 3). */
  demandLimit?: number;
  backgroundLimit?: number;
  /** How long a failed background load waits before its one retry, in ms (default 5000). */
  retryDelay?: number;
};

/** A claim on some keys; release it when they are no longer needed so loads that have not started can be dropped. */
export type Demand = { release(): void };

export type QueueStats = {
  runningDemand: number;
  runningBackground: number;
  queuedDemand: number;
  queuedBackground: number;
  settled: number;
};

export type PriorityQueue<K, V> = {
  /** Ask for keys now. Keys already settled are skipped; the rest load ahead of all background work. */
  demand(keys: readonly K[]): Demand;
  /** Add keys to the background plan, after the ones already in it. */
  background(keys: readonly K[]): void;
  /** The result of a key, once it has one. */
  get(key: K): Settled<V> | undefined;
  /** Called with the key each time one settles. */
  subscribe(fn: (key: K) => void): () => void;
  /** Hold back / allow new background starts (loads already running finish either way). */
  pause(): void;
  resume(): void;
  /** Drop the background plan: loads that have not started are forgotten, running ones finish. */
  dropBackground(): void;
  /** Drop everything that has not started and every claim. Results are kept; the queue stays usable. */
  cancel(): void;
  stats(): QueueStats;
};

type Entry = {
  state: "queued" | "running" | "waiting";
  /** The kind of request it runs as; a background load that someone starts to wait for becomes demand. */
  kind: Priority;
  /** Demand claims on it. */
  claims: number;
  /** In the background plan: a failed load is retried once. */
  plan: boolean;
  tries: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** A first-in first-out line that forgets what it has handed out. */
class Line<K> {
  private items: K[] = [];
  private head = 0;
  push(k: K): void {
    this.items.push(k);
  }
  peek(): K | undefined {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }
  shift(): K | undefined {
    if (this.head >= this.items.length) return undefined;
    const k = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return k;
  }
  clear(): void {
    this.items = [];
    this.head = 0;
  }
  get length(): number {
    return this.items.length - this.head;
  }
}

export function createPriorityQueue<K, V>(opts: QueueOptions<K, V>): PriorityQueue<K, V> {
  const demandLimit = opts.demandLimit ?? 8;
  const backgroundLimit = opts.backgroundLimit ?? 3;
  const retryDelay = opts.retryDelay ?? 5000;
  const isMissing = opts.isMissing ?? (() => false);

  const results = new Map<K, Settled<V>>();
  const entries = new Map<K, Entry>(); // everything not settled yet
  const demandLine = new Line<K>();
  const backgroundLine = new Line<K>();
  const running = { demand: 0, background: 0 };
  const listeners = new Set<(key: K) => void>();
  let paused = false;
  let generation = 0; // bumped by cancel(): older claims no longer count

  const settle = (key: K, r: Settled<V>) => {
    entries.delete(key);
    results.set(key, r);
    pump(); // before telling anyone: a listener that throws must not leave the queue stuck
    for (const fn of [...listeners]) fn(key);
  };

  const start = (key: K, e: Entry, kind: Priority) => {
    e.state = "running";
    e.kind = kind;
    running[kind]++;
    let p: Promise<V>;
    try {
      p = Promise.resolve(opts.load(key, kind));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (value) => {
        running[e.kind]--;
        settle(key, { value, failed: false });
      },
      (err: unknown) => {
        running[e.kind]--;
        if (isMissing(err)) settle(key, { value: null, failed: false });
        else if (e.claims > 0) settle(key, { value: null, failed: true }); // someone is waiting: say so
        else if (e.plan && e.tries === 0) retryLater(key, e);
        else entries.delete(key); // gave up quietly; a later demand tries afresh
        pump();
      },
    );
  };

  /** One more try, later, in the background (or as demand if someone has asked for it meanwhile). */
  const retryLater = (key: K, e: Entry) => {
    e.tries++;
    e.state = "waiting";
    e.timer = setTimeout(() => {
      e.timer = undefined;
      e.state = "queued";
      (e.claims > 0 ? demandLine : backgroundLine).push(key);
      pump();
    }, retryDelay);
  };

  const nextQueued = (line: Line<K>, wantClaims: boolean): K | undefined => {
    for (let k = line.shift(); k !== undefined; k = line.shift()) {
      const e = entries.get(k);
      // a stale place in the line (started, dropped, or moved to the other line) is skipped
      if (e && e.state === "queued" && (e.claims > 0) === wantClaims) return k;
    }
    return undefined;
  };

  /** Demand is waiting for a slot: background work must not take the connection from it meanwhile. */
  const demandWaits = (): boolean => {
    for (let k = demandLine.peek(); k !== undefined; k = demandLine.peek()) {
      const e = entries.get(k);
      if (e && e.state === "queued" && e.claims > 0) return true;
      demandLine.shift(); // a stale place
    }
    return false;
  };

  function pump(): void {
    while (running.demand < demandLimit) {
      const k = nextQueued(demandLine, true);
      if (k === undefined) break;
      start(k, entries.get(k)!, "demand");
    }
    while (!paused && running.background < backgroundLimit && !demandWaits()) {
      const k = nextQueued(backgroundLine, false);
      if (k === undefined) break;
      start(k, entries.get(k)!, "background");
    }
  }

  const demand = (keys: readonly K[]): Demand => {
    const claimed: K[] = [];
    for (const key of keys) {
      if (results.has(key)) continue;
      let e = entries.get(key);
      if (!e) {
        e = { state: "queued", kind: "demand", claims: 0, plan: false, tries: 0 };
        entries.set(key, e);
        demandLine.push(key);
      } else if (e.state === "waiting") {
        clearTimeout(e.timer);
        e.timer = undefined;
        e.state = "queued";
        demandLine.push(key);
      } else if (e.state === "queued" && e.claims === 0) {
        demandLine.push(key); // moves out of the background line (its place there is skipped)
      } else if (e.state === "running" && e.kind === "background") {
        // already loading: wait for that load, counted as demand from now on
        running.background--;
        running.demand++;
        e.kind = "demand";
      }
      e.claims++;
      claimed.push(key);
    }
    pump();
    const mine = generation;
    let released = false;
    return {
      release() {
        if (released || mine !== generation) return;
        released = true;
        for (const key of claimed) {
          const e = entries.get(key);
          if (!e || e.claims === 0) continue;
          e.claims--;
          if (e.claims > 0 || e.state !== "queued") continue;
          // nobody waits for it any more and it has not started: back to the plan, or forgotten
          if (e.plan) backgroundLine.push(key);
          else entries.delete(key);
        }
        pump();
      },
    };
  };

  const background = (keys: readonly K[]): void => {
    for (const key of keys) {
      if (results.has(key)) continue;
      const e = entries.get(key);
      if (e) {
        e.plan = true;
        continue;
      }
      entries.set(key, { state: "queued", kind: "background", claims: 0, plan: true, tries: 0 });
      backgroundLine.push(key);
    }
    pump();
  };

  const dropBackground = (): void => {
    backgroundLine.clear();
    for (const [key, e] of entries) {
      e.plan = false;
      if (e.claims > 0) {
        // still wanted on screen: it keeps its place in the demand line (already there)
        continue;
      }
      if (e.state === "waiting") clearTimeout(e.timer);
      if (e.state !== "running") entries.delete(key);
    }
  };

  const cancel = (): void => {
    generation++;
    demandLine.clear();
    for (const [key, e] of entries) {
      e.claims = 0;
      e.plan = false;
      if (e.state === "waiting") clearTimeout(e.timer);
      if (e.state !== "running") entries.delete(key);
    }
    backgroundLine.clear();
  };

  return {
    demand,
    background,
    get: (key) => results.get(key),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      pump();
    },
    dropBackground,
    cancel,
    stats: () => ({
      runningDemand: running.demand,
      runningBackground: running.background,
      queuedDemand: demandLine.length,
      queuedBackground: backgroundLine.length,
      settled: results.size,
    }),
  };
}

// ---- when to run background work ----------------------------------------------------------

/**
 * Runs `fn` once the browser is idle: requestIdleCallback with a timeout so it cannot wait forever on a
 * busy page, else (Safari) a short setTimeout. Returns a function that cancels it.
 */
export function whenIdle(fn: () => void, opts: { timeout?: number; fallback?: number } = {}): () => void {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof g.requestIdleCallback === "function") {
    const h = g.requestIdleCallback(fn, { timeout: opts.timeout ?? 1500 });
    return () => g.cancelIdleCallback?.(h);
  }
  const h = setTimeout(fn, opts.fallback ?? 1);
  return () => clearTimeout(h);
}

/** Save-Data on, or a 2G-class connection: leave the network to what the user asks for. */
export function networkIsConstrained(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const c = (nav as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)?.connection;
  if (!c) return false;
  return c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g";
}

/** What `startPrefetch` needs of the page. */
export type PageLike = {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
};

/**
 * Plans `keys` (or what the function returns, worked out only when the browser is idle) in the background
 * once the browser is idle and the tab is visible, pausing while it is hidden. Does nothing on a constrained network. Returns a function that stops it (the plan is dropped,
 * loads under way finish).
 */
export function startPrefetch<K>(
  queue: Pick<PriorityQueue<K, unknown>, "background" | "dropBackground" | "pause" | "resume">,
  keys: readonly K[] | (() => readonly K[]),
  page: PageLike | undefined = typeof document === "undefined" ? undefined : document,
  opts: { timeout?: number; fallback?: number } = {},
): () => void {
  if (networkIsConstrained()) return () => {};
  const when = { timeout: 2000, fallback: 200, ...opts };
  let off = () => {};
  const cancelIdle = whenIdle(() => {
    const sync = () => (page?.hidden ? queue.pause() : queue.resume());
    page?.addEventListener("visibilitychange", sync);
    off = () => page?.removeEventListener("visibilitychange", sync);
    if (page?.hidden) queue.pause(); // plan first, start when the tab comes back
    queue.background(typeof keys === "function" ? keys() : keys); // worked out only now: first paint pays nothing for it
  }, when);
  return () => {
    cancelIdle();
    off();
    queue.dropBackground();
  };
}
