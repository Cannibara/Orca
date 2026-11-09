import { AUTO_FILL_MAX, CHUNK, INITIAL_ROWS, MORE_STEP, moreLabel } from "../src/fund/loading";

// The behaviour of the hook is tested through the two tables (fund-positions-ui, fund-whatif-ui).

describe("the loading numbers", () => {
  test("a first page of a few screens, an automatic fill of a few hundred rows, small chunks and clicks", () => {
    expect(INITIAL_ROWS).toBeGreaterThanOrEqual(30);
    expect(INITIAL_ROWS).toBeLessThanOrEqual(100);
    expect(AUTO_FILL_MAX).toBeGreaterThan(INITIAL_ROWS);
    expect(AUTO_FILL_MAX).toBeLessThanOrEqual(400);
    expect(CHUNK).toBeGreaterThan(0);
    expect(CHUNK).toBeLessThanOrEqual(INITIAL_ROWS);
    expect(MORE_STEP).toBeGreaterThanOrEqual(CHUNK);
  });

  test("the automatic fill lands exactly on the cap: no half chunk, so a full table is never one row over", () => {
    expect((AUTO_FILL_MAX - INITIAL_ROWS) % CHUNK).toBe(0);
  });
});

describe("the 'Show more' label", () => {
  test("says how many it adds and how many are left", () => {
    expect(moreLabel(2600)).toBe(`Show ${MORE_STEP} more · 2,600 left`);
    expect(moreLabel(MORE_STEP + 1)).toBe(`Show ${MORE_STEP} more · ${MORE_STEP + 1} left`);
  });

  test("just the number when that is all there is", () => {
    expect(moreLabel(MORE_STEP)).toBe(`Show ${MORE_STEP} more`);
    expect(moreLabel(40)).toBe("Show 40 more");
    expect(moreLabel(1)).toBe("Show 1 more");
  });
});
