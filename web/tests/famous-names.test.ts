import { fundShortName } from "../src/lib/format";
import { MANAGER_LINE, PHONE_SHORT, SHORT_NAME, managerLine, phoneNameOf, shortNameOf } from "../src/lib/famousNames";

describe("fundShortName (spec 3.3 rules 1-5)", () => {
  it("title-cases an all-caps name and strips legal endings and generic tails", () => {
    expect(fundShortName("GREENLIGHT CAPITAL INC")).toBe("Greenlight Capital");
    expect(fundShortName("AQR CAPITAL MANAGEMENT LLC")).toBe("AQR Capital");
    expect(fundShortName("TCI FUND MANAGEMENT LTD")).toBe("TCI");
    expect(fundShortName("Whale Rock Capital Management LLC")).toBe("Whale Rock Capital");
    expect(fundShortName("Bridgewater Associates, LP")).toBe("Bridgewater");
    expect(fundShortName("Owl Creek Asset Management, L.P.")).toBe("Owl Creek");
    expect(fundShortName("Pershing Square Capital Management, L.P.")).toBe("Pershing Square Capital");
  });

  it("drops state and country tags, roman numerals I-III and trailing 'ET AL'", () => {
    expect(fundShortName("BAUPOST GROUP LLC/MA")).toBe("Baupost");
    expect(fundShortName("FAIRFAX FINANCIAL HOLDINGS LTD/ CAN")).toBe("Fairfax Financial");
    expect(fundShortName("SOUTHEASTERN ASSET MANAGEMENT INC/TN/")).toBe("Southeastern");
    expect(fundShortName("VAN DEN BERG MANAGEMENT I, INC")).toBe("Van Den Berg");
    expect(fundShortName("GAMCO INVESTORS, INC. ET AL")).toBe("Gamco Investors");
    expect(fundShortName("NOVO HOLDINGS A/S")).toBe("Novo");
    expect(fundShortName("Greenwoods Asset Management Hong Kong Ltd.")).toBe("Greenwoods");
    expect(fundShortName("HARRIS ASSOCIATES L P")).toBe("Harris");
    expect(fundShortName("Aware Super Pty Ltd as trustee of Aware Super")).toBe("Aware Super");
    expect(fundShortName("FJARDE AP-FONDEN /FOURTH SWEDISH NATIONAL PENSION FUND")).toBe("Fjarde AP-Fonden");
    expect(fundShortName("GREYLOCK XIII GP LLC")).toBe("Greylock XIII");
    expect(fundShortName("Dragoneer Investment Group, LLC")).toBe("Dragoneer");
    expect(fundShortName("PUBLIC INVESTMENT FUND")).toBe("Public Investment Fund");
    expect(fundShortName("TRIAN FUND MANAGEMENT, L.P.")).toBe("Trian");
    expect(fundShortName("CVS HEALTH Corp")).toBe("CVS Health");
    expect(fundShortName("STRS OHIO")).toBe("STRS Ohio");
  });

  it("keeps brand words, an ampersand and an inner 'Co.'", () => {
    expect(fundShortName("Merck & Co., Inc.")).toBe("Merck & Co.");
    expect(fundShortName("ANGELO GORDON & CO., L.P.")).toBe("Angelo Gordon & Co.");
    expect(fundShortName("Miller Value Partners, LLC")).toBe("Miller Value Partners");
    expect(fundShortName("Casdin Capital, LLC")).toBe("Casdin Capital");
  });

  it("leaves a mixed-case name's casing alone, and never strips to nothing", () => {
    expect(fundShortName("SkyBridge Capital II, LLC")).toBe("SkyBridge Capital");
    expect(fundShortName("ICONIQ Capital, LLC")).toBe("ICONIQ Capital");
    expect(fundShortName("Management Inc")).not.toBe("");
    expect(fundShortName("LLC")).toBe("LLC");
    expect(fundShortName("")).toBe("");
  });

  it("keeps small acronyms, lowercases joining words, and does not treat ordinary words as acronyms", () => {
    expect(fundShortName("NEA MANAGEMENT COMPANY, LLC")).toBe("NEA");
    expect(fundShortName("RA CAPITAL MANAGEMENT, L.P.")).toBe("RA Capital");
    expect(fundShortName("DELTA AIR LINES, INC.")).toBe("Delta Air Lines");
    expect(fundShortName("BANK OF AMERICA CORP")).toBe("Bank of America");
  });
});

describe("SHORT_NAME (3.3.6 hand cases, by fund_id)", () => {
  it("holds every known case", () => {
    expect(SHORT_NAME).toMatchObject({
      921669: "Carl Icahn",
      1607841: "Sequoia Capital",
      1470766: "HongShan",
      1740858: "DST Global",
      1166559: "Gates Foundation",
      1305473: "Insight Partners",
      1548594: "Battery Ventures",
      1017918: "Baron Capital",
      850529: "Fisher Investments",
      898382: "Leon Cooperman",
      1656456: "Appaloosa",
      1035674: "Paulson & Co.",
      1263508: "Baker Bros.",
      1510387: "Gotham",
      1647251: "TCI",
    });
  });

  it("shortNameOf prefers the hand case, else the rule", () => {
    expect(shortNameOf(921669, "ICAHN CARL C")).toBe("Carl Icahn");
    expect(shortNameOf(1, "GREENLIGHT CAPITAL INC")).toBe("Greenlight Capital");
  });
});

describe("PHONE_SHORT (3.3.7)", () => {
  it("shortens the three long names on a phone only", () => {
    expect(PHONE_SHORT).toEqual({
      "Duquesne Family Office": "Duquesne",
      "Pershing Square Capital": "Pershing Square",
      "Renaissance Technologies": "Renaissance",
    });
    expect(phoneNameOf("Duquesne Family Office")).toBe("Duquesne");
    expect(phoneNameOf("Pershing Square Capital")).toBe("Pershing Square");
    expect(phoneNameOf("Renaissance Technologies")).toBe("Renaissance");
    expect(phoneNameOf("Bridgewater")).toBe("Bridgewater");
  });
});

describe("managerLine (3.4, Appendix B)", () => {
  it("maps the 160 non-plain values as the appendix says", () => {
    expect(Object.keys(MANAGER_LINE)).toHaveLength(160);
    expect(managerLine("8VC (Joe Lonsdale)", "8VC")).toBe("Joe Lonsdale");
    expect(managerLine("Sequoia Fund", "Sequoia Fund")).toBe("Bill Ruane");
    expect(managerLine("Paul Black / Mike Trigg", "Wolverine")).toBe("Paul Black & Mike Trigg");
    expect(managerLine("John S. Clark II", "Clark")).toBe("John S. Clark");
    expect(managerLine("Google", "Alphabet")).toBeNull();
    expect(managerLine("CalPERS, largest US public pension", "CalPERS")).toBeNull();
    expect(MANAGER_LINE["Founders Fund (VI)"]).toBeNull();
  });

  it("shows a plain person's name as is, including accents, hyphens and CamelCase", () => {
    expect(managerLine("Ray Dalio", "Bridgewater")).toBe("Ray Dalio");
    expect(managerLine("Ed Mulé", "Ed Mule")).toBe("Ed Mulé");
    expect(managerLine("Joe DiMenna", "Zimmer Partners")).toBe("Joe DiMenna");
    expect(managerLine("Sean Stannard-Stockton", "Ensemble")).toBe("Sean Stannard-Stockton");
    expect(managerLine("C.T. Fitzpatrick", "Vulcan")).toBe("C.T. Fitzpatrick");
  });

  it("gives no line for a manager equal to the short name, a missing one, or an unknown non-plain value", () => {
    expect(managerLine("Carl Icahn", "Carl Icahn")).toBeNull();
    expect(managerLine(null, "X")).toBeNull();
    expect(managerLine(undefined, "X")).toBeNull();
    expect(managerLine("", "X")).toBeNull();
    expect(managerLine("Some new fund (IV)", "X")).toBeNull();
    expect(managerLine("Alaska's oil fund", "X")).toBeNull();
    expect(managerLine("Acme / Foo", "X")).toBeNull();
  });
});
