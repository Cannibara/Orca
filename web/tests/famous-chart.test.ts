import {
  aumLabel,
  captionText,
  domainAt,
  initials,
  leadLine,
  periodPhrase,
  rawDomain,
  retLabel,
  rowLabel,
  shadeFor,
  sourceLine,
  standfirst,
  tickStep,
  ticksFor,
  vsLabel,
  windowDomains,
} from "../src/home/famousChart";

describe("labels", () => {
  it("aumLabel prints billions to one decimal", () => {
    expect(aumLabel(304.2e9)).toBe("$304.2B");
    expect(aumLabel(0.3e9)).toBe("$0.3B");
    expect(aumLabel(0.05e9)).toBe("$0.1B");
    expect(aumLabel(null)).toBe("—");
    expect(aumLabel(undefined)).toBe("—");
  });

  it("retLabel and vsLabel use the site's signs", () => {
    expect(retLabel(0.302)).toBe("+30.2%");
    expect(retLabel(-0.226)).toBe("−22.6%");
    expect(retLabel(null)).toBe("—");
    expect(vsLabel(0.12, 0.1)).toBe("+2.0 pts");
    expect(vsLabel(-0.05, 0.1)).toBe("−15.0 pts");
  });

  it("aumLabel says '<$0.1B' below $0.05B, not '$0.0B'", () => {
    expect(aumLabel(0.049e9)).toBe("<$0.1B");
    expect(aumLabel(12e6)).toBe("<$0.1B");
    expect(aumLabel(0)).toBe("<$0.1B");
  });

  it("initials takes the first letters of the first two words", () => {
    expect(initials("Battery Ventures")).toBe("BV");
    expect(initials("Carl Icahn & Co")).toBe("CI");
    expect(initials("Duquesne")).toBe("D");
    expect(initials("Greylock 15")).toBe("G");
    expect(initials("")).toBe("");
  });

  it("initials keeps a leading acronym whole, up to 3 letters", () => {
    expect(initials("IVP XVI")).toBe("IVP");
    expect(initials("TCV VIII")).toBe("TCV");
    expect(initials("NEA")).toBe("NEA");
    expect(initials("AQR Capital")).toBe("AQR");
    expect(initials("CDPQ")).toBe("CDP");
    expect(initials("OMERS")).toBe("O"); // five capitals: a name, not an acronym to print whole
    expect(initials("AIMCo")).toBe("A");
  });
});

describe("shadeFor", () => {
  it("is the ramp end at 30% and beyond, and the 0.15 mix at zero", () => {
    expect(shadeFor(0.3, false)).toBe("#0b4a72");
    expect(shadeFor(0.9, false)).toBe("#0b4a72");
    expect(shadeFor(0, false)).toBe("#79b1d1");
    expect(shadeFor(-0.3, false)).toBe("#8a3208");
  });
  it("uses the loss ramp for a loss and flips in dark mode", () => {
    expect(shadeFor(-0.3, true)).toBe("#f7a882");
    expect(shadeFor(0.3, true)).toBe("#8ccbee");
    expect(shadeFor(-0.05, false)).not.toBe(shadeFor(0.05, false));
  });
  it("hits the middle stop at f = 0.5 mix point (t = 0.5)", () => {
    // t = 0.15 + 0.85 f = 0.5 at f = 0.35/0.85; check via the exact mid colour instead
    const f = 0.35 / 0.85;
    expect(shadeFor(f * 0.3, false)).toBe("#267caa");
  });
});

describe("rawDomain (7.3)", () => {
  it("raises hi to a 20-point minimum span", () => {
    expect(rawDomain([0.06], 0.12, 864, 50)).toEqual({ lo: 0, hi: 20 });
  });
  it("keeps zero and the S&P line in view and drops the S&P term when null", () => {
    expect(rawDomain([0.3, 0.1], null, 864, 50)).toEqual({ lo: 0, hi: 30 });
    expect(rawDomain([0.05, 0.1], 0.25, 864, 50)).toEqual({ lo: 0, hi: 25 });
  });
  it("pushes the low end out for the label room when there are losses", () => {
    const d = rawDomain([-0.1, -0.3], 0.12, 864, 50);
    expect(d.hi).toBe(12);
    expect(d.lo).toBeCloseTo(-30 - (50 * 42) / 814, 6);
  });
  it("keeps the full label room on a phone's narrow plot (the spec's formula, no 200px floor)", () => {
    // phone: inner plot 138px, ROOM 48. lo -22.6, hi = the S&P's +13.5 (36.1 pts wide, over the 20 minimum),
    // then room 48 * 36.1 / (138 - 48) = 19.2533…, so lo = -41.8533…
    // (a 200px floor would give 48 * 36.1 / 200 = 8.664 and lo -31.264: half the room a loss label needs)
    const d = rawDomain([-0.226, 0.1], 0.135, 138, 48);
    expect(d.hi).toBeCloseTo(13.5, 6);
    expect(d.lo).toBeCloseTo(-22.6 - (48 * 36.1) / 90, 6);
  });
  it("uses at least 80px as the plot width denominator, so a tiny or unmeasured width cannot blow up", () => {
    const d = rawDomain([-0.1], 0.0, 100, 50);
    // lo -10, hi raised to +10 (20 pts wide), then room 50 * 20 / max(80, 100 - 50) = 12.5
    expect(d.lo).toBeCloseTo(-22.5, 6);
    expect(d.hi).toBe(10);
  });
});

// 50 returns, best first, from +30% down to -25%, like the 5y Most searched list.
const RETS = Array.from({ length: 50 }, (_, i) => 0.3 - (i * 0.55) / 49);

describe("windowDomains / domainAt", () => {
  const track = windowDomains(RETS, 15, 0.12, 864, 50);

  it("has one window per start row", () => {
    expect(track.raw).toHaveLength(36);
    expect(track.smooth).toHaveLength(36);
    expect(windowDomains([0.1, 0.2], 15, null, 800, 50).raw).toHaveLength(1);
  });
  it("starts at zero with no loss in view and ends below zero", () => {
    expect(track.raw[0].lo).toBe(0);
    expect(track.smooth[0].lo).toBe(0);
    expect(track.raw[35].lo).toBeLessThan(0);
    expect(track.smooth[35].lo).toBeLessThan(0);
  });
  it("smooth is never narrower than raw", () => {
    track.raw.forEach((r, k) => {
      expect(track.smooth[k].lo).toBeLessThanOrEqual(r.lo + 1e-9);
      expect(track.smooth[k].hi).toBeGreaterThanOrEqual(r.hi - 1e-9);
    });
  });
  it("is continuous in p", () => {
    for (let p = 0; p < 34.99; p += 0.01) {
      const a = domainAt(track, p);
      const b = domainAt(track, p + 0.01);
      expect(Math.abs(a.lo - b.lo)).toBeLessThan(0.6);
      expect(Math.abs(a.hi - b.hi)).toBeLessThan(0.6);
    }
  });
  it("always covers the rows that stay in view, and clamps p", () => {
    for (let p = 0; p <= 35; p += 0.05) {
      const d = domainAt(track, p);
      const k = Math.min(35, Math.floor(p));
      for (const r of RETS.slice(k + 1, k + 15)) {
        expect(r * 100).toBeGreaterThanOrEqual(d.lo - 1e-9);
        expect(r * 100).toBeLessThanOrEqual(d.hi + 1e-9);
      }
      expect(d.lo).toBeLessThanOrEqual(0);
      expect(d.hi).toBeGreaterThanOrEqual(12);
    }
    expect(domainAt(track, -3)).toEqual(domainAt(track, 0));
    expect(domainAt(track, 99)).toEqual(domainAt(track, 35));
  });
  it("is exactly the smooth domain (or wider) at a whole row", () => {
    expect(domainAt(track, 0).lo).toBeCloseTo(track.smooth[0].lo, 9);
    expect(domainAt(track, 10).hi).toBeGreaterThanOrEqual(track.raw[10].hi - 1e-9);
  });
});

describe("ticksFor (6)", () => {
  // the plot's inner width: desktop at 1280 (1184 − 266 columns − 56 inset), a 400px phone (352 − 164 − 58)
  const DESK = 864;
  const PH = 130;
  it("desktop: step by span, margin keeps the end ticks off the edge", () => {
    expect(ticksFor({ lo: 0, hi: 30 }, false, DESK)).toEqual([0, 10, 20]);
    expect(ticksFor({ lo: 0, hi: 20 }, false, DESK)).toEqual([0, 5, 10, 15]);
    expect(ticksFor({ lo: -66, hi: 128 }, false, DESK)).toEqual(expect.arrayContaining([-60, 0, 120]));
    expect(ticksFor({ lo: -25, hi: 12.5 }, false, DESK)).toEqual([-20, -10, 0, 10]);
  });
  it("phone: few labels", () => {
    expect(ticksFor({ lo: 0, hi: 30 }, true, PH)).toEqual([0, 20]);
    expect(ticksFor({ lo: 0, hi: 22 }, true, PH)).toEqual([0, 10, 20]);
  });
  it("raises the step until labels sit at least 48px apart", () => {
    expect(ticksFor({ lo: -62, hi: 14 }, true, PH)).toEqual([-40, 0]); // 20 would be 34px apart
    // a 50-pt phone span keeps step 20 (52px apart), so a number still sits beside 0%
    expect(ticksFor({ lo: -30, hi: 20 }, true, PH)).toEqual([-20, 0]);
    expect(ticksFor({ lo: -62, hi: 14 }, false, DESK)).toEqual([-60, -40, -20, 0]); // desktop keeps 20
    expect(tickStep(76, true, PH)).toBe(40);
    expect(tickStep(30, false, DESK)).toBe(10);
  });
  it("a wide range (1y Venture capital) never overlaps, on a phone or a narrow desktop plot", () => {
    const dom = { lo: -21, hi: 302 };
    for (const [phone, w] of [
      [true, PH],
      [false, PH],
      [true, 500],
      [false, 500],
    ] as const) {
      const t = ticksFor(dom, phone, w);
      expect(t).toContain(0);
      expect(t.length).toBeGreaterThan(1);
      const px = t.map((v) => ((v - dom.lo) / (dom.hi - dom.lo)) * w);
      px.slice(1).forEach((x, i) => expect(x - px[i]).toBeGreaterThanOrEqual(48));
    }
    expect(ticksFor(dom, true, PH)).toEqual([0, 200]);
    expect(ticksFor(dom, false, 500)).toEqual([0, 40, 80, 120, 160, 200, 240, 280]);
  });
  it("is ascending, always includes 0, and has no negative zero", () => {
    const t = ticksFor({ lo: -40, hi: 3 }, false, DESK);
    expect(t).toContain(0);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(t.some((x) => Object.is(x, -0))).toBe(false);
  });
});

describe("copy", () => {
  it("periodPhrase", () => {
    expect(periodPhrase("1y")).toBe("over the last year");
    expect(periodPhrase("3y")).toBe("over the last 3 years");
    expect(periodPhrase("5y")).toBe("over the last 5 years");
    expect(periodPhrase("10y")).toBe("over the last 10 years");
    expect(periodPhrase("15y")).toBe("over the last 15 years");
    expect(periodPhrase("max")).toBe("since each fund's first filing");
  });

  it("standfirst, chart and table", () => {
    expect(standfirst("5y", 0.1352, "chart")).toBe(
      "Estimated return a year over the last 5 years, best first. The dotted line is the S&P 500 (+13.5%).",
    );
    expect(standfirst("max", null, "chart")).toBe("Estimated return a year since each fund's first filing, best first.");
    expect(standfirst("3y", 0.1, "table")).toBe(
      "Estimated figures over the last 3 years. Select a heading to sort; Fund steps through A–Z, Z–A and most popular.",
    );
  });

  it("leadLine", () => {
    const rows = (rets: number[]) => rets.map((ret, i) => ({ name: i === 0 ? "Duquesne" : "F" + i, ret }));
    const fifty = rows([0.303, ...Array.from({ length: 35 }, () => 0.2), ...Array.from({ length: 14 }, () => -0.1)]);
    expect(leadLine(fifty, 0.12)).toBe("Duquesne leads with +30.3% a year. 36 of the 50 beat the S&P 500; 14 lost money.");
    expect(leadLine(rows([0.3, 0.2, 0.05]), 0.1)).toBe("Duquesne leads with +30.0% a year. 2 of the 3 beat the S&P 500; none lost money.");
    expect(leadLine(fifty, null)).toBe("Duquesne leads with +30.3% a year. 14 of the 50 lost money.");
    expect(leadLine(rows([0.3, 0.2]), null)).toBe("Duquesne leads with +30.0% a year. None of the 2 lost money.");
    expect(leadLine([], 0.1)).toBe("");
  });

  it("sourceLine", () => {
    const base = "Source: SEC 13F filings; Orca estimates.";
    expect(sourceLine({ ann_return: 0.135, from_q: 35, to_q: 55 })).toBe(base + " S&P 500: SPY total return, Q4 2021 to Q4 2026.");
    expect(sourceLine({ ann_return: 0.135, from_q: 34, to_q: 54 })).toBe(base + " S&P 500: SPY total return, Q3 2021 to Q3 2026.");
    expect(sourceLine({ ann_return: null, from_q: 34, to_q: 54 })).toBe(base);
    expect(sourceLine(null)).toBe(base);
    expect(sourceLine(undefined)).toBe(base);
  });

  it("captionText", () => {
    expect(captionText(1, 15, 50, true)).toBe("Showing 1–15 of 50 · scale fits the funds in view");
    expect(captionText(1, 12, 12, false)).toBe("Showing all 12 funds");
    expect(captionText(1, 1, 1, false)).toBe("Showing 1 fund");
  });

  it("rowLabel", () => {
    const o = { i: 3, n: 50, name: "Bridgewater", manager: "Ray Dalio", book: 22.1e9, ret: 0.12, spx: 0.135 };
    expect(rowLabel(o)).toBe("3 of 50. Bridgewater, Ray Dalio, AUM $22.1B: gain of 12.0% a year (estimate), behind the S&P 500");
    expect(rowLabel({ ...o, ret: -0.05 })).toBe("3 of 50. Bridgewater, Ray Dalio, AUM $22.1B: loss of 5.0% a year (estimate), behind the S&P 500");
    expect(rowLabel({ ...o, ret: 0.2 })).toContain(", ahead of the S&P 500");
    expect(rowLabel({ ...o, spx: null })).toBe("3 of 50. Bridgewater, Ray Dalio, AUM $22.1B: gain of 12.0% a year (estimate)");
    expect(rowLabel({ ...o, manager: null, spx: null })).toBe("3 of 50. Bridgewater, AUM $22.1B: gain of 12.0% a year (estimate)");
    expect(rowLabel({ ...o, i: 1 })).toBe(
      "1 of 50. Bridgewater, Ray Dalio, AUM $22.1B: gain of 12.0% a year (estimate), behind the S&P 500, best in this list",
    );
  });
});
