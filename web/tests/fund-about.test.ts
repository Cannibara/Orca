import type { About } from "../src/data/types";
import { aboutRows, describeFiler, edgarUrl, formerName, placeName, titleCase } from "../src/fund/about";

const BERKSHIRE: About = {
  name: "BERKSHIRE HATHAWAY INC",
  street: "3555 FARNAM STREET",
  city: "OMAHA",
  state: "NE",
  signer: "MARC D. HAMBURG",
  signer_title: "SENIOR VICE PRESIDENT",
  signed: "2026-11-16",
  other_managers: [
    "WARREN E. BUFFETT",
    "GEICO CORP",
    "GENERAL RE CORP",
    "NATIONAL INDEMNITY CO",
    "BERKSHIRE HATHAWAY LIFE INSURANCE CO OF NEBRASKA",
    "BH FINANCE LLC",
  ],
  incorporated: "DE",
  former_names: [{ name: "NBH INC", from: "1998-08-10", to: "1999-01-04" }],
  sic: "FIRE, MARINE & CASUALTY INSURANCE",
  tickers: ["BRK-A", "BRK-B"],
  exchanges: ["NYSE", "NYSE"],
};
const FILING = { name: "Berkshire Hathaway Inc", period_q: 54, book: 304.2e9, n_holdings: 30 };

const none: About = {
  name: null,
  street: null,
  city: null,
  state: null,
  signer: null,
  signer_title: null,
  signed: null,
  other_managers: [],
  incorporated: null,
  former_names: [],
  sic: null,
  tickers: [],
  exchanges: [],
};

describe("titleCase: SEC capitals, read like a name", () => {
  test.each([
    ["BERKSHIRE HATHAWAY INC", "Berkshire Hathaway Inc"],
    ["MARC D. HAMBURG", "Marc D. Hamburg"],
    ["SENIOR VICE PRESIDENT", "Senior Vice President"],
    ["3555 FARNAM STREET", "3555 Farnam Street"],
    ["FIRE, MARINE & CASUALTY INSURANCE", "Fire, Marine & Casualty Insurance"],
    ["BERKSHIRE HATHAWAY LIFE INSURANCE CO OF NEBRASKA", "Berkshire Hathaway Life Insurance Co of Nebraska"],
    ["BH FINANCE LLC", "BH Finance LLC"],
    ["U.S. INVESTMENT CORP", "U.S. Investment Corp"],
    ["KKR & CO. L.P.", "KKR & Co. L.P."],
    ["ONE MARKET PLAZA, STE 1200 BLVD", "One Market Plaza, Ste 1200 Blvd"],
    ["O'NEIL-SMITH CAPITAL II", "O'Neil-Smith Capital II"],
    ["THE BANK OF NEW YORK MELLON CORP", "The Bank of New York Mellon Corp"],
  ])("%s → %s", (raw, want) => expect(titleCase(raw)).toBe(want));

  test("text with lower-case letters is left as it is", () => {
    expect(titleCase("Kelpwood Capital LP")).toBe("Kelpwood Capital LP");
    expect(titleCase("")).toBe("");
  });
});

describe("placeName: SEC state codes in full", () => {
  test("US states, DC and Puerto Rico", () => {
    expect(placeName("NE")).toBe("Nebraska");
    expect(placeName("DE")).toBe("Delaware");
    expect(placeName("NY")).toBe("New York");
    expect(placeName("DC")).toBe("District of Columbia");
    expect(placeName("PR")).toBe("Puerto Rico");
    expect(placeName("ne")).toBe("Nebraska");
  });
  test("a few non-US codes that 13F filers use; anything else as it is", () => {
    expect(placeName("X0")).toBe("United Kingdom");
    expect(placeName("E9")).toBe("Cayman Islands");
    expect(placeName("A6")).toBe("Ontario");
    expect(placeName("Q9")).toBe("Q9");
    expect(placeName(null)).toBeNull();
  });
});

describe("describeFiler: one paragraph from the facts, a clause left out for each that is missing", () => {
  test("everything known", () => {
    expect(describeFiler(BERKSHIRE, FILING)).toBe(
      "Berkshire Hathaway Inc is an institutional investment manager based in Omaha, Nebraska. " +
        "The SEC classes it under Fire, Marine & Casualty Insurance, and its shares trade on the NYSE as BRK-A and BRK-B. " +
        "Its latest 13F, for the quarter to 30 Sep 2026, reports $304.2B across 30 holdings.",
    );
  });

  test("no place, no industry, no listing", () => {
    expect(describeFiler({ ...none, name: "ACME CAPITAL MANAGEMENT LLC" }, { ...FILING, n_holdings: 1 })).toBe(
      "Acme Capital Management LLC is an institutional investment manager. Its latest 13F, for the quarter to 30 Sep 2026, reports $304.2B across 1 holding.",
    );
  });

  test("a city without a state; an industry without shares; shares without an exchange", () => {
    expect(describeFiler({ ...none, city: "GREENWICH" }, FILING)).toMatch(/^Berkshire Hathaway Inc is an institutional investment manager based in Greenwich\. /);
    expect(describeFiler({ ...none, sic: "INVESTMENT ADVICE" }, FILING)).toContain(" The SEC classes it under Investment Advice. Its latest");
    expect(describeFiler({ ...none, tickers: ["XYZ"] }, FILING)).toContain(" Its shares trade as XYZ. Its latest");
    expect(describeFiler({ ...none, tickers: ["A", "B", "C"], exchanges: ["NYSE", "Nasdaq"] }, FILING)).toContain(
      " Its shares trade on the NYSE and Nasdaq as A, B and C.",
    );
  });
});

describe("aboutRows: label and value, each only when known", () => {
  test("everything known", () => {
    const rows = aboutRows(BERKSHIRE);
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Headquarters", "Omaha, Nebraska (3555 Farnam Street)"],
      ["13F signed by", "Marc D. Hamburg, Senior Vice President (16 Nov 2026)"],
      ["Incorporated in", "Delaware"],
      ["Former name", "NBH Inc (1998–1999)"],
    ]);
  });

  test("nothing known: no rows", () => {
    expect(aboutRows(none)).toEqual([]);
  });

  test("a street alone; a signer without a title or date; two former names", () => {
    const rows = aboutRows({
      ...none,
      street: "1 MAIN ST",
      signer: "JANE DOE",
      former_names: [
        { name: "OLD ONE LLC", from: "2001-02-03", to: "2001-09-30" },
        { name: "OLDER TWO LP", from: null, to: "2000-12-31" },
      ],
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Headquarters", "1 Main St"],
      ["13F signed by", "Jane Doe"],
      ["Former names", "Old One LLC (2001); Older Two LP (until 2000)"],
    ]);
  });

  test("former names: the years they were used", () => {
    expect(formerName({ name: "A INC", from: "1998-01-01", to: "1999-01-01" })).toBe("A Inc (1998–1999)");
    expect(formerName({ name: "A INC", from: "1998-01-01", to: null })).toBe("A Inc (from 1998)");
    expect(formerName({ name: "A INC", from: null, to: null })).toBe("A Inc");
  });

  test("the EDGAR link lists the CIK's 13F-HR filings", () => {
    expect(edgarUrl(1067983)).toBe("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1067983&type=13F-HR");
  });
});
