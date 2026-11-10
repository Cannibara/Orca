import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pipeline/contract.md is the source of truth for the published files. This keeps web/src/data/types.ts and
// the demo data in step with the JSON-shape lines of its "Files" section. It reads only those lines (the
// backticked shapes), never the prose.
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = readFileSync(join(HERE, "../../pipeline/contract.md"), "utf8");
const TYPES = readFileSync(join(HERE, "../src/data/types.ts"), "utf8");
const DEMO = join(HERE, "../public/demo-data");

const FILES: Record<string, string> = {};
const filesSection = CONTRACT.split(/^## Files$/m)[1]?.split(/^## /m)[0] ?? "";
for (const line of filesSection.split("\n")) {
  const m = /^- `([^`]+)`: `(\{.*)$/.exec(line);
  if (m) FILES[m[1]] = m[2];
}

/** The balanced {...} at the start of s. */
function shape(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    if (s[i] === "}" && --depth === 0) return s.slice(0, i + 1);
  }
  throw new Error(`unbalanced shape: ${s}`);
}

const NAME = /^[a-z][a-z0-9_]*$/;

/** Quoted lower-case identifiers at any depth ("YYYY-MM-DD" and other placeholder strings do not match). */
function allKeys(s: string): Set<string> {
  return new Set([...shape(s).matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((k) => NAME.test(k)));
}

/** Quoted identifiers directly inside the outermost braces. */
function topKeys(s: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  const sh = shape(s);
  for (let i = 0; i < sh.length; i++) {
    const c = sh[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      const end = sh.indexOf('"', i + 1);
      const word = sh.slice(i + 1, end);
      if (depth === 1 && NAME.test(word)) out.add(word);
      i = end;
    }
  }
  return out;
}

/** Field names of the named `export type X = { ... };` blocks in types.ts. */
function typeFields(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    // multi-line blocks list one field per line; a one-line `{ a: x; b: y }` is also accepted
    const m = new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\};`).exec(TYPES);
    if (!m) throw new Error(`type ${name} not found in types.ts`);
    for (const f of m[1].matchAll(/(?:^|[{;\n])\s*(\w+)\??:/g)) out.add(f[1]);
  }
  return out;
}

const sorted = (s: Set<string>) => [...s].sort();

// contract path -> the types.ts types that describe that file (the file's type and its nested blocks)
const MAP: Record<string, string[]> = {
  "funds.json": ["FundsIndex"],
  "securities.json": ["Securities"],
  "latest_prices.json": ["LatestPrices"],
  "fund/{id}/summary.json": ["Summary", "Metrics", "YearLabelRet", "YearsBlock", "QuartersBlock", "Holdings"],
  "fund/{id}/positions.json": ["Positions"],
  "fund/{id}/contrib.json": ["Contrib", "ContribYear"],
  "fund/{id}/exits.json": ["Exits", "ExitsRows", "ExitsSummary"],
  "stock/{stock_id}/weekly.json": ["Weekly"],
};

describe("the contract's Files section", () => {
  it("documents every file this test checks", () => {
    for (const path of Object.keys(MAP)) expect(FILES[path], path).toBeTruthy();
  });
});

describe("types.ts follows contract.md", () => {
  for (const [path, types] of Object.entries(MAP)) {
    it(`${path}: the documented field names and the type's field names are the same`, () => {
      expect(sorted(typeFields(types))).toEqual(sorted(allKeys(FILES[path])));
    });
  }
});

describe("the demo data has the documented top-level keys", () => {
  const read = (p: string) => JSON.parse(readFileSync(join(DEMO, p), "utf8")) as Record<string, unknown>;
  const cases: [string, string][] = [
    ["funds.json", "funds.json"],
    ["securities.json", "securities.json"],
    ["latest_prices.json", "latest_prices.json"],
    ["fund/{id}/summary.json", "fund/9100001/summary.json"],
    ["fund/{id}/positions.json", "fund/9100001/positions.json"],
    ["fund/{id}/contrib.json", "fund/9100001/contrib.json"],
    ["fund/{id}/exits.json", "fund/9100001/exits.json"],
    ["stock/{stock_id}/weekly.json", "stock/1/weekly.json"],
  ];
  for (const [path, file] of cases) {
    it(file, () => {
      expect(existsSync(join(DEMO, file)), file).toBe(true);
      expect(Object.keys(read(file)).sort()).toEqual(sorted(topKeys(FILES[path])));
    });
  }
});
