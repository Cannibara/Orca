import {
  NotFoundError,
  clearDataCache,
  isFundFileMissing,
  isListedFund,
  loadContrib,
  loadExits,
  loadFunds,
  loadHome,
  loadLatestPrices,
  loadPositions,
  loadSecurities,
  loadSummary,
  loadWeekly,
  priceDates,
  priceMap,
  stockMap,
  toRows,
  yearsSince2013,
} from "../src/data/api";
import type { CallRow, LatestPrices, RowsFile, Securities, TopList } from "../src/data/types";

type Reply = { status: number; body?: unknown };

/** Stub fetch: call n gets replies[n], the last reply repeats. Returns the mock so tests can inspect calls. */
function mockFetch(...replies: Reply[]) {
  let n = 0;
  const fn = vi.fn(async (_url: string) => {
    const r = replies[Math.min(n++, replies.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  clearDataCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("toRows", () => expect(toRows({ a: [1, 2], b: ["x", "y"] })).toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]));

test("toRows of no columns or empty columns is empty", () => {
  expect(toRows({})).toEqual([]);
  expect(toRows({ a: [], b: [] })).toEqual([]);
});

test("loader caches and maps 404", async () => {
  const fetchMock = mockFetch({ status: 200, body: { v: 1, id: [7], name: ["A"], book: [1], n: [2] } });
  const first = await loadFunds();
  const second = await loadFunds();
  expect(first.id).toEqual([7]);
  expect(second).toBe(first);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  mockFetch({ status: 404 });
  await expect(loadSummary(123)).rejects.toBeInstanceOf(NotFoundError);
  await expect(loadSummary(123)).rejects.toThrow(/fund\/123\/summary\.json/);
});

test("a rejected request is not cached: a retry refetches", async () => {
  const fetchMock = mockFetch({ status: 500 }, { status: 200, body: { v: 1, id: [], name: [], book: [], n: [] } });
  await expect(loadFunds()).rejects.toThrow();
  await expect(loadFunds()).resolves.toMatchObject({ v: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  // a 404 is not cached either
  mockFetch({ status: 404 }, { status: 200, body: { start: "2020-01-03", close: [1] } });
  await expect(loadWeekly(5)).rejects.toBeInstanceOf(NotFoundError);
  await expect(loadWeekly(5)).resolves.toEqual({ start: "2020-01-03", close: [1] });
});

test("a network failure is not cached either", async () => {
  const fn = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ asof: "2026-10-30", stock_id: [], price: [], date: [] }),
  });
  vi.stubGlobal("fetch", fn);
  await expect(loadLatestPrices()).rejects.toThrow("offline");
  await expect(loadLatestPrices()).resolves.toMatchObject({ asof: "2026-10-30" });
  expect(fn).toHaveBeenCalledTimes(2);
});

test("other HTTP errors are a plain Error naming the status and URL", async () => {
  mockFetch({ status: 503 });
  const err = await loadFunds().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(NotFoundError);
  expect((err as Error).message).toContain("503");
  expect((err as Error).message).toContain("/demo-data/funds.json");
});

test("every loader requests its contract path under the default base URL", async () => {
  const fetchMock = mockFetch({ status: 200, body: {} });
  await loadFunds();
  await loadSecurities();
  await loadLatestPrices();
  await loadSummary(9100001);
  await loadPositions(9100001);
  await loadContrib(9100001);
  await loadExits(9100001);
  await loadWeekly(17);
  await loadHome("top_3y");
  await loadHome("calls_q");
  expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
    "/demo-data/funds.json",
    "/demo-data/securities.json",
    "/demo-data/latest_prices.json",
    "/demo-data/fund/9100001/summary.json",
    "/demo-data/fund/9100001/positions.json",
    "/demo-data/fund/9100001/contrib.json",
    "/demo-data/fund/9100001/exits.json",
    "/demo-data/stock/17/weekly.json",
    "/demo-data/home/top_3y.json",
    "/demo-data/home/calls_q.json",
  ]);
});

test("VITE_DATA_URL sets the base URL, trailing slash ignored", async () => {
  vi.stubEnv("VITE_DATA_URL", "https://data.example.test/orca/");
  const fetchMock = mockFetch({ status: 200, body: {} });
  await loadFunds();
  expect(fetchMock.mock.calls[0][0]).toBe("https://data.example.test/orca/funds.json");
});

test("loadHome is typed per file", async () => {
  mockFetch({ status: 200, body: { latest_q: 53, period: "3y", eligible: [], giants: [] } });
  const top = await loadHome("top_3y");
  expectTypeOf(top).toEqualTypeOf<TopList>();
  expect(top.period).toBe("3y");
  mockFetch({ status: 200, body: { latest_q: 53, rows: [] } });
  const calls = await loadHome("calls_q");
  expectTypeOf(calls).toEqualTypeOf<RowsFile<CallRow>>();
  expect(calls.latest_q).toBe(53);
});

const lp = (price: (number | null)[], date: (string | null)[]): LatestPrices => ({
  asof: "2026-10-30",
  stock_id: [1, 2, 3],
  price,
  date,
});

test("isListedFund is decided by funds.json, whatever the fund's own files answer (R29)", async () => {
  mockFetch({ status: 200, body: { v: 1, id: [7, 9], name: ["A", "B"], book: [1, 2], n: [1, 1] } });
  expect(await isListedFund(9)).toBe(true);
  expect(await isListedFund(8)).toBe(false);
  expect(await isListedFund(10)).toBe(false);
});

test("isListedFund rejects when funds.json cannot be read, so a broken index is not 'unknown fund'", async () => {
  mockFetch({ status: 404 });
  await expect(isListedFund(7)).rejects.toBeInstanceOf(NotFoundError);
});

test("isFundFileMissing: only the 404 of one of this fund's own files", () => {
  expect(isFundFileMissing(new NotFoundError("/demo-data/fund/7/summary.json"), 7)).toBe(true);
  expect(isFundFileMissing(new NotFoundError("/demo-data/fund/7/positions.json"), 7)).toBe(true);
  expect(isFundFileMissing(new NotFoundError("/demo-data/fund/70/summary.json"), 7)).toBe(false); // another fund
  expect(isFundFileMissing(new NotFoundError("/demo-data/securities.json"), 7)).toBe(false); // a shared file
  expect(isFundFileMissing(new Error("HTTP 500 for /demo-data/fund/7/summary.json"), 7)).toBe(false);
});

test("priceMap holds every non-null price, stale ones included, and skips null (R5)", () => {
  const m = priceMap(lp([10.5, null, 3], ["2026-10-30", null, "2019-08-15"]));
  expect(m).toEqual(new Map([[1, 10.5], [3, 3]]));
  expect(m.has(2)).toBe(false);
});

test("priceDates holds the date of each stock that has one", () => {
  const d = priceDates(lp([10.5, null, 3], ["2026-10-30", null, "2019-08-15"]));
  expect(d).toEqual(new Map([[1, "2026-10-30"], [3, "2019-08-15"]]));
});

test("yearsSince2013", () => {
  expect(yearsSince2013("2013-01-01")).toBe(0);
  expect(yearsSince2013("2014-01-01")).toBeCloseTo(365 / 365.25, 12);
  expect(yearsSince2013("2017-01-01")).toBeCloseTo(1461 / 365.25, 12); // 2016 is a leap year
  expect(yearsSince2013("2026-10-30")).toBeCloseTo((Date.UTC(2026, 9, 30) - Date.UTC(2013, 0, 1)) / (365.25 * 86_400_000), 12);
  expect(yearsSince2013("2012-07-01")).toBeLessThan(0);
});

describe("stockMap", () => {
  it("maps each stock id to its ticker and name", () => {
    const sec: Securities = {
      stock_id: [7, 3],
      ticker: ["AAA", "BBB"],
      name: ["Alpha Corp", "Beta Inc"],
      sector: ["Tech", "Energy"],
    };
    const m = stockMap(sec);
    expect(m.size).toBe(2);
    expect(m.get(7)).toEqual({ ticker: "AAA", name: "Alpha Corp" });
    expect(m.get(3)).toEqual({ ticker: "BBB", name: "Beta Inc" });
    expect(m.get(99)).toBeUndefined();
  });

  it("is empty for no securities", () => {
    expect(stockMap({ stock_id: [], ticker: [], name: [], sector: [] }).size).toBe(0);
  });
});
