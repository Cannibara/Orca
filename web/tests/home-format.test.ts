import { fAum, fBook, fPrice, fWeight } from "../src/pages/homeFmt";

describe("fBook", () => {
  it("prints billions to one decimal and millions whole with a small m", () => {
    expect(fBook(14.23e9)).toBe("$14.2B");
    expect(fBook(114.46e9)).toBe("$114.5B");
    expect(fBook(1.04e9)).toBe("$1.0B");
    expect(fBook(2968.4e6)).toBe("$3.0B");
    expect(fBook(340.4e6)).toBe("$340m");
    expect(fBook(1.2e6)).toBe("$1m");
  });

  it("moves up a unit when rounding reaches the next one", () => {
    expect(fBook(999.6e6)).toBe("$1.0B"); // never "$1,000m"
    expect(fBook(999.4e6)).toBe("$999m");
    expect(fBook(999.9e3)).toBe("$1m"); // never "$1000K"
  });

  it("falls back to thousands and dollars for small amounts", () => {
    expect(fBook(425e3)).toBe("$425K");
    expect(fBook(420)).toBe("$420");
  });

  it("puts a true minus on losses and a plus on gains only when asked", () => {
    expect(fBook(-45e6)).toBe("−$45m");
    expect(fBook(-45e6, true)).toBe("−$45m");
    expect(fBook(23.9e9, true)).toBe("+$23.9B");
    expect(fBook(23.9e9)).toBe("$23.9B");
  });

  it("gives a figure that prints as $0 no sign, and a dash for a missing one", () => {
    expect(fBook(0.3, true)).toBe("$0");
    expect(fBook(-0.3, true)).toBe("$0");
    expect(fBook(null)).toBe("—");
    expect(fBook(undefined)).toBe("—");
    expect(fBook(NaN)).toBe("—");
  });
});

describe("fPrice", () => {
  it("shows cents under $100 and whole dollars with separators above", () => {
    expect(fPrice(80)).toBe("$80.00");
    expect(fPrice(99.994)).toBe("$99.99");
    expect(fPrice(100)).toBe("$100");
    expect(fPrice(1079.4)).toBe("$1,079");
    expect(fPrice(null)).toBe("—");
  });
});

describe("fWeight", () => {
  it("is a whole percent, with <1% for a sliver and 0% for nothing", () => {
    expect(fWeight(0.205)).toBe("21%");
    expect(fWeight(0.0924)).toBe("9%");
    expect(fWeight(0.003)).toBe("<1%");
    expect(fWeight(0)).toBe("0%");
    expect(fWeight(null)).toBe("—");
  });
});

describe("fAum", () => {
  it("is the weight change in percent of AUM: one decimal, a plus for a buy and a true minus for a sale", () => {
    expect(fAum(20.46)).toBe("+20.5%");
    expect(fAum(9.24)).toBe("+9.2%");
    expect(fAum(6)).toBe("+6.0%");
    expect(fAum(-9.3)).toBe("−9.3%");
    expect(fAum(-9.6)).toBe("−9.6%");
  });

  it("gives a change that prints as 0.0 no sign, and a dash for a missing one", () => {
    expect(fAum(0)).toBe("0.0%");
    expect(fAum(0.04)).toBe("0.0%");
    expect(fAum(-0.04)).toBe("0.0%");
    expect(fAum(null)).toBe("—");
  });
});
