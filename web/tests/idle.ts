import { act } from "@testing-library/react";

/**
 * A requestIdleCallback the test drives by hand: nothing runs "when the browser is idle" until `flush` says
 * so. With `fastClock` (the default) `performance.now` is held still too, so the tables' pacing sees every
 * chunk as fast (jsdom draws rows far slower than a browser). Call it from a beforeEach;
 * vi.unstubAllGlobals() / vi.restoreAllMocks() undo it.
 */
export function installIdle({ fastClock = true }: { fastClock?: boolean } = {}) {
  const idle = { next: 1, pending: new Map<number, () => void>() };
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    const id = idle.next++;
    idle.pending.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => idle.pending.delete(id));
  if (fastClock) vi.spyOn(performance, "now").mockReturnValue(1000);
  /** Runs the idle callbacks registered so far (those they register in turn wait for the next flush). */
  const flush = () =>
    act(async () => {
      const run = [...idle.pending.values()];
      idle.pending.clear();
      run.forEach((cb) => cb());
    });
  /** Flushes until nothing is waiting for idle any more (at most `max` rounds). */
  const flushAll = async (max = 200) => {
    for (let i = 0; i < max && idle.pending.size > 0; i++) await flush();
  };
  return { pending: idle.pending, flush, flushAll };
}
