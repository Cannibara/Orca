// scripts/siteUrl.ts: the website's own address, for the canonical links, sitemap.xml and robots.txt.
import { describe, expect, it } from "vitest";
import { siteUrl } from "../scripts/siteUrl";

describe("siteUrl: not set", () => {
  it.each([[undefined], [""]])("%j gives null", (value) => {
    expect(siteUrl(value)).toBeNull();
  });
});

describe("siteUrl: an https origin, exactly as the URL parser prints it", () => {
  it.each([
    "https://www.orcaetf.com",
    "https://orcaetf.com",
    "https://orca-88p.pages.dev",
    "https://staging.example.com:8443",
    "https://xn--bcher-kva.example",
    "https://[::1]:8443",
  ])("%s", (value) => {
    expect(siteUrl(value)).toBe(value);
  });
});

describe("siteUrl: anything else throws, naming the variable, the value and what to set", () => {
  it.each([
    "http://www.orcaetf.com",
    "https://www.orcaetf.com/",
    "https://www.orcaetf.com/app",
    "https://www.orcaetf.com?x=1",
    "https://www.orcaetf.com#top",
    "https://WWW.orcaetf.com",
    "HTTPS://www.orcaetf.com",
    "https://www.orcaetf.com:443",
    "www.orcaetf.com",
    "//www.orcaetf.com",
    "/fund",
    "ftp://www.orcaetf.com",
    "javascript:alert(1)",
    "https://www.orcaetf.com ",
    " https://www.orcaetf.com",
    "https://www.orcaetf.com\nDisallow: /",
    "https://www.orcaetf.com\r\n",
    "https://www.orcaetf.com;x",
    "https://a.example,https://b.example",
    'https://www.orcaetf.com"x',
    "https://www.orcaetf.com'x",
    "https://www.orcaetf.com<x>",
    "https://www.orcaetf.com\\x",
    "https://user@www.orcaetf.com",
    "https://user:pw@www.orcaetf.com",
    "https://a_b.example",
    "https://",
  ])("%j", (value) => {
    expect(() => siteUrl(value)).toThrow(/^SITE_URL ".*" is not usable: .*https:\/\/www\.orcaetf\.com/s);
  });

  it("shows the value escaped and cut short, so a line break cannot forge a log line", () => {
    let message = "";
    try {
      siteUrl(`https://www.orcaetf.com\n::error::forged ${"x".repeat(300)}`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("\n");
    expect(message).toContain("\\n::error::forged");
    expect(message.length).toBeLessThan(400);
  });
});
