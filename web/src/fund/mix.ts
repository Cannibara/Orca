// Pure model of "Sector mix over time" (spec §5.3): the fund's book by sector, industry or sub-industry each
// quarter (skill.json `mix`), the big switches between sectors, and the 100% stacked areas.

import type { SkillMix } from "../data/types";
import { pathParts } from "./skill";

export type Level = 1 | 2 | 3;
export const LEVEL_NAMES: Record<Level, string> = { 1: "Sector", 2: "Industry", 3: "Sub-industry" };

export const NOT_CLASSIFIED = "(Not classified)";

/** One band of the chart: a label at the level and its share of the book in each quarter. */
export type Band = {
  /** The path at the level ("Technology > Semiconductors"). */
  key: string;
  /** What the band is called ("Semiconductors", "Technology ETFs", "Not classified"). */
  name: string;
  /** "Technology › Semiconductors", for the tooltip. */
  trail: string;
  /** Its sector ("Not classified" for the neutral row). */
  sector: string;
  shares: number[];
  /** Its average share, which orders the bands. */
  avg: number;
  /** 1 for the sector's biggest part, lighter (down to 0.38) for its smaller ones. */
  shade: number;
};

export type MixSeries = { q: number[]; bands: Band[] };

const strip = (s: string) => s.replace(/^\((.*)\)$/, "$1");

/** A path part as readers see it: groupings in parentheses read as "Technology ETFs", "Smaller Technology holdings". */
function partName(parts: string[], i: number): string {
  const p = parts[i];
  if (p === NOT_CLASSIFIED) return "Not classified";
  if (!p.startsWith("(")) return p;
  const what = strip(p);
  return what === "ETFs" ? `${parts[0]} ETFs` : what === "Smaller holdings" ? `Smaller ${parts[0]} holdings` : `${parts[0]}: ${what}`;
}

/**
 * The mix summed to `level` (paths split on " > "): sectors by their average share, largest first, with the
 * neutral row last; at finer levels each sector's parts sit together, largest first.
 */
export function mixSeries(mix: SkillMix, level: Level): MixSeries {
  const n = mix.q.length;
  const byKey = new Map<string, { parts: string[]; shares: number[] }>();
  mix.label.forEach((label, i) => {
    const parts = pathParts(label);
    const key = parts.slice(0, level).join(" > ");
    let b = byKey.get(key);
    if (!b) {
      b = { parts: parts.slice(0, level), shares: new Array<number>(n).fill(0) };
      byKey.set(key, b);
    }
    const row = mix.share[i];
    for (let j = 0; j < n; j++) b.shares[j] += row[j] ?? 0;
  });
  const avg = (s: number[]) => (n ? s.reduce((a, v) => a + v, 0) / n : 0);
  const sectorAvg = new Map<string, number>();
  for (const b of byKey.values()) sectorAvg.set(b.parts[0], (sectorAvg.get(b.parts[0]) ?? 0) + avg(b.shares));
  const sectors = [...sectorAvg.keys()].sort((a, b) => Number(a === NOT_CLASSIFIED) - Number(b === NOT_CLASSIFIED) || sectorAvg.get(b)! - sectorAvg.get(a)! || a.localeCompare(b));
  const bands: Band[] = [];
  for (const s of sectors) {
    const kids = [...byKey.entries()].filter(([, b]) => b.parts[0] === s).sort((a, b) => avg(b[1].shares) - avg(a[1].shares) || a[0].localeCompare(b[0]));
    kids.forEach(([key, b], k) => {
      bands.push({
        key,
        name: partName(b.parts, b.parts.length - 1),
        trail: b.parts.map((_, i) => partName(b.parts, i)).filter((x, i, a) => i === 0 || x !== a[i - 1]).join(" › "),
        sector: s === NOT_CLASSIFIED ? "Not classified" : s,
        shares: b.shares,
        avg: avg(b.shares),
        shade: kids.length > 1 ? 1 - (0.62 * k) / (kids.length - 1) : 1,
      });
    });
  }
  return { q: mix.q.slice(), bands };
}

/** The colour token of a sector: "Business Services" → var(--sec-business-services); the neutral row is grey. */
export function sectorColor(sector: string): string {
  if (sector === "Not classified") return "var(--sec-none)";
  return `var(--sec-${sector.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")})`;
}

export type Rotation = { q: number; turn: number; into: string[]; out: string[]; text: string };

const TURN = 0.15; // half the sum of share changes over four quarters: 15% of the book moved
const WINDOW = 4; // the biggest turn within ±4 quarters
const APART = 6; // quarters between two switches
const KEEP = 5;
const SECOND = 0.05; // a second sector is named when it moved 5 points or more

const joinNames = (a: string[]) => a.join(" and ");

/**
 * The big switches between sectors (a series at level 1): quarter q, when half the sum of the sectors' share
 * changes over the four quarters to q is 15% or more, is the largest such turn within ±4 quarters, and is at
 * least 6 quarters from a bigger one. The 5 biggest, in time order.
 */
export function rotations(s: MixSeries): Rotation[] {
  const at = new Map(s.q.map((q, i) => [q, i]));
  const turns: { i: number; q: number; turn: number }[] = [];
  s.q.forEach((q, i) => {
    const j = at.get(q - 4);
    if (j === undefined) return;
    const turn = 0.5 * s.bands.reduce((a, b) => a + Math.abs(b.shares[i] - b.shares[j]), 0);
    turns.push({ i, q, turn });
  });
  const cands = turns.filter((t) => t.turn >= TURN && turns.every((u) => Math.abs(u.q - t.q) > WINDOW || u.turn <= t.turn));
  const kept: typeof cands = [];
  for (const c of [...cands].sort((a, b) => b.turn - a.turn || a.q - b.q)) {
    if (kept.length >= KEEP) break;
    if (kept.some((k) => Math.abs(k.q - c.q) < APART)) continue;
    kept.push(c);
  }
  return kept
    .sort((a, b) => a.q - b.q)
    .map(({ i, q, turn }) => {
      const j = at.get(q - 4)!;
      const moves = s.bands.filter((b) => b.sector !== "Not classified").map((b) => ({ name: b.name, d: b.shares[i] - b.shares[j] }));
      const up = moves.filter((m) => m.d > 0).sort((a, b) => b.d - a.d);
      const down = moves.filter((m) => m.d < 0).sort((a, b) => a.d - b.d);
      const into = up.slice(0, 1).concat(up.slice(1, 2).filter((m) => m.d >= SECOND)).map((m) => m.name);
      const out = down.slice(0, 1).concat(down.slice(1, 2).filter((m) => -m.d >= SECOND)).map((m) => m.name);
      const text = [into.length ? "Into " + joinNames(into) : "", out.length ? (into.length ? "out of " : "Out of ") + joinNames(out) : ""].filter(Boolean).join(", ");
      return { q, turn, into, out, text };
    });
}

/** One area of the chart: its path and the band's bounds (fractions of the book) in each quarter. */
export type Area = { i: number; d: string; lo: number[]; hi: number[] };

/** 100% stacked areas, bands in order from the top; x(i) and y(fraction from the top) in pixels. */
export function stackAreas(s: MixSeries, x: (i: number) => number, y: (f: number) => number): Area[] {
  const n = s.q.length;
  const acc = new Array<number>(n).fill(0);
  return s.bands.map((b, k) => {
    const lo = acc.slice();
    for (let j = 0; j < n; j++) acc[j] += b.shares[j];
    const hi = acc.slice();
    const top = hi.map((v, j) => `${x(j).toFixed(1)} ${y(v).toFixed(1)}`);
    const bot = lo.map((v, j) => `${x(j).toFixed(1)} ${y(v).toFixed(1)}`).reverse();
    return { i: k, d: "M" + top.join(" L") + " L" + bot.join(" L") + "Z", lo, hi };
  });
}
