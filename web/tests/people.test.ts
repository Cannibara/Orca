import { describe, expect, it } from "vitest";
import { creditOf, photoOf, photoSlug, slugify } from "../src/lib/people";

describe("people photos", () => {
  it("names the file after the person: lower case, hyphens, no accents", () => {
    expect(slugify("Warren Buffett")).toBe("warren-buffett");
    expect(slugify("François Rochon")).toBe("francois-rochon");
    expect(slugify("  Mary  Meeker. ")).toBe("mary-meeker");
  });

  it("falls back to the slug of the text shown under the fund", () => {
    expect(photoSlug("Nobody Atall")).toBe("nobody-atall");
  });

  it("has no photo for a missing or unknown manager", () => {
    expect(photoOf(null)).toBeUndefined();
    expect(photoOf("")).toBeUndefined();
    expect(photoOf("Nobody Atall")).toBeUndefined();
    expect(creditOf("Nobody Atall")).toBeUndefined();
  });
});
