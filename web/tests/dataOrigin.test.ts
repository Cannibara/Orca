// scripts/dataOrigin.ts: the one place VITE_DATA_URL is turned into an origin for the build (the
// preconnect hint in index.html and the connect-src of dist/_headers).
import { describe, expect, it } from "vitest";
import { DEFAULT_DATA_URL, dataOrigin } from "../scripts/dataOrigin";

describe("dataOrigin: same-origin values give null", () => {
  it.each([
    [undefined],
    [""],
    [DEFAULT_DATA_URL],
    ["/demo-data/"],
    ["/data"],
    ["/a/b/c.d-e_f"],
  ])("%j", (value) => {
    expect(dataOrigin(value)).toBeNull();
  });
});

describe("dataOrigin: absolute http(s) URLs give their canonical origin", () => {
  it.each([
    ["https://data.orcaetf.com", "https://data.orcaetf.com"],
    ["https://data.orcaetf.com/", "https://data.orcaetf.com"],
    ["https://data.orcaetf.com//", "https://data.orcaetf.com"],
    ["HTTPS://Data.OrcaETF.com/Site", "https://data.orcaetf.com"],
    ["https://pub-0123abcd.r2.dev/site/", "https://pub-0123abcd.r2.dev"],
    ["https://data.orcaetf.com:443/x", "https://data.orcaetf.com"],
    ["https://data.orcaetf.com:8443", "https://data.orcaetf.com:8443"],
    ["http://127.0.0.1:8788", "http://127.0.0.1:8788"],
    ["http://localhost:5173/demo", "http://localhost:5173"],
    ["http://[::1]:9000/x", "http://[::1]:9000"],
    ["https://bücher.example/", "https://xn--bcher-kva.example"],
  ])("%s -> %s", (value, origin) => {
    expect(dataOrigin(value)).toBe(origin);
  });
});

describe("dataOrigin: anything else throws, naming the variable, the value and what to set", () => {
  it.each([
    "https://data.orcaetf.com; script-src *",
    "https://data.orcaetf.com\n",
    " https://data.orcaetf.com",
    "https://data.orcaetf.com\r\nX-Evil: 1",
    "https://data.orcaetf.com https://evil.example",
    "https://data.orcaetf.com,https://evil.example",
    "https://a;b.example",
    "https://data.orcaetf.com/'x'",
    'https://data.orcaetf.com/"x"',
    "https://data.orcaetf.com/<x>",
    "https://data.orcaetf.com\\evil.example",
    "https://data.orcaetf.com/`x`",
    "https://data.orcaetf.com/\u0000",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://data.orcaetf.com",
    "wss://data.orcaetf.com",
    "//evil.example",
    "//",
    "data.orcaetf.com",
    "demo-data",
    "./demo-data",
    "https://user@data.orcaetf.com",
    "https://user:pw@data.orcaetf.com",
    "https://a_b.example",
    "https://",
    "http://",
  ])("%j", (value) => {
    expect(() => dataOrigin(value)).toThrow(/^VITE_DATA_URL ".*" is not usable: .*https:\/\/data\.orcaetf\.com/s);
  });

  it("shows the value escaped and cut short, so a line break cannot forge a log line", () => {
    let message = "";
    try {
      dataOrigin(`https://data.orcaetf.com\n::error::forged ${"x".repeat(300)}`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("\n");
    expect(message).toContain("\\n::error::forged");
    expect(message.length).toBeLessThan(400);
  });
});
