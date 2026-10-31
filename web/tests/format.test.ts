import { money, pct, pp, px, qLabel, sgn, signClass } from "../src/lib/format";

test("money", () => {
  expect(money(1_234_000_000)).toBe("$1.23B");
  expect(money(15_200_000_000)).toBe("$15.2B");
  expect(money(-340_000_000, true)).toBe("−$340M");
  expect(money(4_500_000)).toBe("$4.5M");
  expect(money(null)).toBe("—");
});

test("money below $1M (R3)", () => {
  expect(money(1110)).toBe("$1,110");
  expect(money(340_000)).toBe("$340K");
  expect(money(9_999)).toBe("$9,999");
  expect(money(10_000)).toBe("$10K");
  expect(money(0)).toBe("$0");
  expect(money(-1110)).toBe("−$1,110");
  expect(money(1110, true)).toBe("+$1,110");
  expect(money(-340_000, true)).toBe("−$340K");
});

test("money thresholds", () => {
  expect(money(10_000_000_000)).toBe("$10.0B");
  expect(money(1_000_000_000)).toBe("$1.00B");
  expect(money(10_000_000)).toBe("$10M");
  expect(money(1_000_000)).toBe("$1.0M");
  expect(money(-4_500_000)).toBe("−$4.5M");
  expect(money(4_500_000, true)).toBe("+$4.5M");
});

test("pct and pp", () => {
  expect(pct(0.1234)).toBe("+12.3%");
  expect(pct(-0.05, 0)).toBe("−5%");
  expect(pct(0.2, 1, false)).toBe("20.0%");
  expect(pp(-2.04)).toBe("−2.0 pts");
});

test("pct and pp extra cases", () => {
  expect(pct(0)).toBe("0.0%");
  expect(pct(-0.2, 1, false)).toBe("−20.0%");
  expect(pp(3.06)).toBe("+3.1 pts");
});

test("px", () => {
  expect(px(12.345)).toBe("$12.35");
  expect(px(187.6)).toBe("$188");
  expect(px(null)).toBe("—");
});

test("qLabel", () => expect(qLabel(53)).toBe("Q2 2026"));

test("qLabel at year edges", () => {
  expect(qLabel(0)).toBe("Q1 2013");
  expect(qLabel(3)).toBe("Q4 2013");
  expect(qLabel(4)).toBe("Q1 2014");
});

test("null input gives a dash for every formatter", () => {
  expect(money(null, true)).toBe("—");
  expect(pct(null)).toBe("—");
  expect(pct(null, 0, false)).toBe("—");
  expect(pp(null)).toBe("—");
  expect(px(null)).toBe("—");
});

test("a number that is not finite also gives a dash", () => {
  expect(money(NaN)).toBe("—");
  expect(pct(Infinity)).toBe("—");
  expect(pp(NaN)).toBe("—");
  expect(px(NaN)).toBe("—");
  expect(signClass(NaN)).toBe("");
});

test("sgn and signClass", () => {
  expect(sgn(1)).toBe("+");
  expect(sgn(-1)).toBe("−");
  expect(sgn(0)).toBe("");
  expect(signClass(2)).toBe("up");
  expect(signClass(-2)).toBe("down");
  expect(signClass(0)).toBe("");
  expect(signClass(null)).toBe("");
});
