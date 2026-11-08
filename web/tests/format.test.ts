import { count, fmtDate, money, pct, pp, printsZero, px, qLabel, ratio, sgn, shareCount, signClass, tidyName } from "../src/lib/format";

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

test("money rounds first, then moves up a unit at each boundary", () => {
  // $K -> $M
  expect(money(999_499)).toBe("$999K");
  expect(money(999_500)).toBe("$1.0M");
  expect(money(999_999)).toBe("$1.0M");
  // 1 dp $M -> whole $M
  expect(money(9_949_999)).toBe("$9.9M");
  expect(money(9_950_000)).toBe("$10M");
  expect(money(9_999_999)).toBe("$10M");
  // $M -> $B
  expect(money(999_499_999)).toBe("$999M");
  expect(money(999_500_000)).toBe("$1.00B");
  expect(money(999_999_999)).toBe("$1.00B");
  // 2 dp $B -> 1 dp $B
  expect(money(9_994_999_999)).toBe("$9.99B");
  expect(money(9_995_000_000)).toBe("$10.0B");
  expect(money(9_999_999_999)).toBe("$10.0B");
  // dollars -> $K
  expect(money(9_999.4)).toBe("$9,999");
  expect(money(9_999.6)).toBe("$10K");
  // sign is unaffected by the move up
  expect(money(-999_999)).toBe("−$1.0M");
  expect(money(-9_999_999, true)).toBe("−$10M");
  expect(money(999_999_999, true)).toBe("+$1.00B");
});

test("money never prints a figure outside its unit's format", () => {
  const forms = [
    /^\$(0|[1-9]\d{0,2}|[1-9],\d{3})$/, // $0 .. $9,999
    /^\$[1-9]\d{1,2}K$/, // $10K .. $999K
    /^\$[1-9]\.\dM$/, // $1.0M .. $9.9M
    /^\$[1-9]\d{1,2}M$/, // $10M .. $999M
    /^\$[1-9]\.\d\dB$/, // $1.00B .. $9.99B
    /^\$[1-9]\d+\.\dB$/, // $10.0B and up
  ];
  const bad: string[] = [];
  for (let v = 0.5; v < 5e12; v *= 1.0001) {
    const s = money(v);
    if (!forms.some((f) => f.test(s))) bad.push(`${v} -> ${s}`);
  }
  for (const edge of [9_999.5, 999_500, 9_950_000, 999_500_000, 9_995_000_000]) {
    for (const d of [-1, -0.5, -0.01, 0, 0.01, 1]) {
      const s = money(edge + d);
      if (!forms.some((f) => f.test(s))) bad.push(`${edge + d} -> ${s}`);
    }
  }
  expect(bad.slice(0, 5)).toEqual([]);
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

test("fmtDate", () => {
  expect(fmtDate("2026-08-13")).toBe("13 Aug 2026");
  expect(fmtDate("2026-01-05")).toBe("5 Jan 2026");
  expect(fmtDate("2013-12-31")).toBe("31 Dec 2013");
});

test("fmtDate leaves text that is not an ISO date as it is, and dashes a missing one", () => {
  expect(fmtDate("2026-13-01")).toBe("2026-13-01");
  expect(fmtDate("soon")).toBe("soon");
  expect(fmtDate(null)).toBe("—");
});

test("ratio", () => {
  expect(ratio(1.234)).toBe("1.23");
  expect(ratio(0)).toBe("0.00");
  expect(ratio(-0.5)).toBe("−0.50");
  expect(ratio(12)).toBe("12.00");
});

test("ratio gives a dash for a missing or non-finite value", () => {
  expect(ratio(null)).toBe("—");
  expect(ratio(NaN)).toBe("—");
  expect(ratio(-Infinity)).toBe("—");
});

test("shareCount rounds to whole shares with thousands separators", () => {
  expect(shareCount(0)).toBe("0");
  expect(shareCount(999)).toBe("999");
  expect(shareCount(1234567.4)).toBe("1,234,567");
  expect(shareCount(1234567.5)).toBe("1,234,568");
  expect(shareCount(341060531)).toBe("341,060,531");
  expect(shareCount(0.4)).toBe("0");
});

test("shareCount gives a dash for a missing or non-finite value", () => {
  expect(shareCount(null)).toBe("—");
  expect(shareCount(NaN)).toBe("—");
  expect(shareCount(Infinity)).toBe("—");
});

test("a figure that rounds to zero is printed without a sign (money)", () => {
  expect(money(-0.4)).toBe("$0");
  expect(money(-0.4, true)).toBe("$0");
  expect(money(0.4, true)).toBe("$0");
  expect(money(-0.5, true)).toBe("−$1"); // rounds to one: signed
  expect(money(0.5, true)).toBe("+$1");
  expect(money(-0.6)).toBe("−$1");
});

test("a figure that rounds to zero is printed without a sign (pct)", () => {
  expect(pct(-0.0001)).toBe("0.0%");
  expect(pct(0.0001)).toBe("0.0%");
  expect(pct(-0.0001, 1, false)).toBe("0.0%");
  expect(pct(-0.004, 0)).toBe("0%"); // −0.4% at whole percents
  expect(pct(-0.0049, 0, false)).toBe("0%");
  expect(pct(-0.005, 0)).toBe("−1%");
  expect(pct(-0.0006)).toBe("−0.1%");
  expect(pct(0.0006)).toBe("+0.1%");
});

test("a figure that rounds to zero is printed without a sign (pp)", () => {
  expect(pp(-0.04)).toBe("0.0 pts");
  expect(pp(0.04)).toBe("0.0 pts");
  expect(pp(-0.06)).toBe("−0.1 pts");
  expect(pp(0.06)).toBe("+0.1 pts");
});

test("a figure that rounds to zero is printed without a sign (ratio)", () => {
  expect(ratio(-0.004)).toBe("0.00");
  expect(ratio(-0.006)).toBe("−0.01");
});

test("printsZero recognises a printed zero in every format", () => {
  for (const zero of ["$0", "0.0%", "0%", "0.0 pts", "0.00", "0", "+$0", "−0.0%", "0.00×"]) {
    expect(printsZero(zero), zero).toBe(true);
  }
  for (const other of ["$1", "$0.5M", "0.1%", "10%", "−0.1 pts", "0.01", "—", "New", "$10K", "100"]) {
    expect(printsZero(other), other).toBe(false);
  }
});

test("count: thousands separators, and the noun in the right number", () => {
  expect(count(0)).toBe("0");
  expect(count(16000)).toBe("16,000");
  expect(count(0, "position")).toBe("0 positions");
  expect(count(1, "position")).toBe("1 position");
  expect(count(2, "position")).toBe("2 positions");
  expect(count(16000, "position")).toBe("16,000 positions");
  expect(count(1234567, "holding")).toBe("1,234,567 holdings");
  expect(count(null)).toBe("—");
  expect(count(NaN, "position")).toBe("—");
});

describe("tidyName", () => {
  test("title-cases a capitalised SEC name and drops the legal suffix", () => {
    expect(tidyName("ALPHABET INC")).toBe("Alphabet");
    expect(tidyName("GENERAL ELECTRIC CO")).toBe("General Electric");
    expect(tidyName("COSTCO WHSL CORP NEW")).toBe("Costco Whsl");
    expect(tidyName("JPMORGAN CHASE & CO")).toBe("Jpmorgan Chase");
    expect(tidyName("AMAZON COM INC")).toBe("Amazon");
    expect(tidyName("FREEPORT-MCMORAN INC")).toBe("Freeport-Mcmoran");
  });
  test("keeps acronyms and mixed-case names, and never returns an empty name", () => {
    expect(tidyName("SPDR S&P 500 ETF TR")).toBe("SPDR S&P 500 ETF");
    expect(tidyName("Apple Inc")).toBe("Apple Inc");
    expect(tidyName("INC")).toBe("Inc");
    expect(tidyName("")).toBe("");
  });
});
