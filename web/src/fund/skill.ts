// Pure models of the fund page's sector choice vs stock choice panels (spec
// docs/superpowers/specs/2026-11-21-sector-stock-choice-design.md §5, §7.3), from fund/{id}/skill.json and
// sectors/scores.json. Returns are fractions here; panels print them with pct / pts.
//
// A fund's trades are replayed in its stocks (the fund), in its labels' indices ("their sectors") and in the
// whole market. Sector choice = labels − market, stock choice = fund − labels, so every year
// market + sector choice + stock choice = fund.

import type { FundsIndex, SectorScores, Skill, SkillTier, TopRow } from "../data/types";
import { FAMOUS_GROUPS } from "../data/famousGroups";
import { pp, qOfYear, tidyName } from "../lib/format";

export type Tier = 1 | 2 | 3;
export const TIERS: Tier[] = [1, 2, 3];

/** What a tier is called in every string (readers see "sub-industry", never "vertical"). */
export type TierWords = {
  /** "Sector" */
  Noun: string;
  /** "sector" */
  noun: string;
  /** "sectors" */
  plural: string;
  /** "Sector choice" */
  choice: string;
  /** "Sector picker" */
  picker: string;
  /** "Their sectors" */
  their: string;
  /** "Stocks vs their sector" */
  stockView: string;
  /** "Sectors vs market" */
  betsView: string;
};

const WORDS: Record<Tier, [string, string]> = { 1: ["sector", "sectors"], 2: ["industry", "industries"], 3: ["sub-industry", "sub-industries"] };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function tierWords(t: Tier): TierWords {
  const [noun, plural] = WORDS[t];
  return {
    Noun: cap(noun),
    noun,
    plural,
    choice: cap(noun) + " choice",
    picker: cap(noun) + " picker",
    their: "Their " + plural,
    stockView: "Stocks vs their " + noun,
    betsView: cap(plural) + " vs market",
  };
}

/** A fraction a year as percentage points: 0.023 → "+2.3 pts". */
export const pts = (x: number | null): string => pp(x == null ? null : x * 100);

/** The tier's block of the file. */
export const tierOf = (skill: Skill, t: Tier): SkillTier => skill.tiers[String(t) as "1" | "2" | "3"];

/** A hierarchy path's parts ("Technology > Semiconductors" → ["Technology", "Semiconductors"]). */
export const pathParts = (path: string): string[] => path.split(" > ");

/** The last part of a label path, as readers see it. */
export const labelName = (path: string | null): string => (path == null ? "–" : pathParts(path).slice(-1)[0]);

// ---- the stacked bars ---------------------------------------------------------------------------------

/** One calendar year of the split (fractions). */
export type YearRow = {
  name: string;
  part: boolean;
  /** whole market */
  m: number;
  /** sector (tier) choice = label − market */
  alloc: number;
  /** stock choice = fund − label */
  pick: number;
  /** the fund = m + alloc + pick */
  f: number;
  /** S&P 500, for reference; null without it */
  spy: number | null;
};

/** The years with all three replays' returns, oldest first. */
export function yearRows(skill: Skill, t: Tier): YearRow[] {
  const y = skill.years;
  const lab = tierOf(skill, t).years.label;
  const out: YearRow[] = [];
  y.name.forEach((name, i) => {
    const f = y.fund[i];
    const m = y.mkt[i];
    const l = lab[i];
    if (f == null || m == null || l == null) return;
    out.push({ name, part: !/^\d{4}$/.test(name), m, alloc: l - m, pick: f - l, f, spy: y.spy[i] ?? null });
  });
  return out;
}

export type PartKey = "m" | "s" | "p";
/** A stretch of a bar in return units: from a (the zero side) to b (the outer end). */
export type StackPart = { k: PartKey; sign: 1 | -1; a: number; b: number };
export type Stack = {
  /** 1 when the year was up (the bar grows up), −1 when down. */
  dir: 1 | -1;
  /** Parts that pushed the way the year went, stacked from zero: market, sector choice, stock choice. */
  solid: StackPart[];
  /** Parts that pushed the other way, drawn beyond the solid bar as dashed boxes. */
  boxes: StackPart[];
  /** Outer end of the bar with its boxes. */
  gross: number;
};

/**
 * The AUM rule (aum.ts): the solid bar always ends at the fund's return. Parts that pushed the same way as the
 * result stack from zero in the order market, sector choice, stock choice; a part that pushed the other way is
 * taken off the outer end (stock choice first, then sector choice, then market) and drawn beyond it as a dashed
 * box. A part's sign sets its colour: blue when it added, orange when it took away.
 */
export function stackParts(o: Pick<YearRow, "m" | "alloc" | "pick" | "f">): Stack {
  const dir: 1 | -1 = o.f >= 0 ? 1 : -1;
  const comps: [PartKey, number][] = [
    ["m", o.m],
    ["s", o.alloc],
    ["p", o.pick],
  ];
  const sgn = (v: number): 1 | -1 => (v >= 0 ? 1 : -1);
  const withC = comps.filter(([, v]) => v * dir > 0).map(([k, v]) => ({ k, v: Math.abs(v), sign: sgn(v) }));
  const against = comps.filter(([, v]) => v * dir < 0).map(([k, v]) => ({ k, v: Math.abs(v), sign: sgn(v) }));
  let rem = against.reduce((a, c) => a + c.v, 0);
  for (let i = withC.length - 1; i >= 0 && rem > 0; i--) {
    const t = Math.min(withC[i].v, rem);
    withC[i].v -= t;
    rem -= t;
  }
  let t = 0;
  const solid: StackPart[] = [];
  const boxes: StackPart[] = [];
  for (const c of withC) {
    if (c.v > 1e-9) solid.push({ k: c.k, sign: c.sign, a: t * dir, b: (t + c.v) * dir });
    t += c.v;
  }
  for (const c of against) {
    boxes.push({ k: c.k, sign: c.sign, a: t * dir, b: (t + c.v) * dir });
    t += c.v;
  }
  return { dir, solid, boxes, gross: t * dir };
}

// ---- the map ------------------------------------------------------------------------------------------

export type Corner = "both" | "stock" | "sector" | "neither";

/** Which corner of the map a fund is in; inside the "too close to call" band counts as not positive. */
export function quadrant(pick: number, alloc: number, band = 0.008): Corner {
  const p = pick > band;
  const a = alloc > band;
  return p && a ? "both" : p ? "stock" : a ? "sector" : "neither";
}

export type ScoreRow = { fund_id: number; tier: number; picking: number; allocation: number; n: number; coverage: number; span_q: number };

/** The map needs 3 years of trades, 20 picks and 80% of the buying scored (ROADMAP F5). */
export const isEligible = (r: Pick<ScoreRow, "span_q" | "n" | "coverage">): boolean => r.span_q >= 12 && r.n >= 20 && r.coverage >= 0.8;

/** fund_id → its row at tier t (rows without both scores are left out). */
export function scoreRows(s: SectorScores, t: Tier): Map<number, ScoreRow> {
  const out = new Map<number, ScoreRow>();
  s.fund_id.forEach((id, i) => {
    const p = s.picking[i];
    const a = s.allocation[i];
    if (s.tier[i] !== t || p == null || a == null) return;
    out.set(id, { fund_id: id, tier: t, picking: p, allocation: a, n: s.n[i], coverage: s.coverage[i] ?? 0, span_q: s.span_q[i] });
  });
  return out;
}

/** A fund name short enough to sit beside a dot: "Kelpwood Capital LP" → "Kelpwood Capital". */
export function shortFund(name: string): string {
  const t = tidyName(name).replace(/[,.]?\s+(L\.?P\.?|LLC|L\.L\.C\.|Inc\.?|Ltd\.?|Co\.?|Corp\.?|N\.A\.)$/i, "").trim();
  return t.replace(/\s+(Management|Mgmt)$/i, "").trim() || name;
}

export type Peer = { fund_id: number; name: string; pick: number; alloc: number; n: number };
export type PeerList = { name: string; peers: Peer[] };
export type Peers = {
  /** The famous lists the fund is in, with at least 3 eligible peers, in the home page's order. */
  lists: PeerList[];
  /** When it is in none of those: the 12 eligible funds nearest in size. */
  similar: Peer[] | null;
};

const MIN_PEERS = 3;
const SIMILAR = 12;

/** The funds to draw beside this one on the map (spec §5.1). */
export function peersFor(fundId: number, t: Tier, famous: TopRow[] | undefined, scores: SectorScores, funds: FundsIndex): Peers {
  const rows = scoreRows(scores, t);
  const names = new Map(funds.id.map((id, i) => [id, funds.name[i]]));
  const peer = (id: number): Peer | null => {
    const r = rows.get(id);
    if (!r || id === fundId || !isEligible(r)) return null;
    return { fund_id: id, name: shortFund(names.get(id) ?? String(id)), pick: r.picking, alloc: r.allocation, n: r.n };
  };
  const mine = new Set((famous ?? []).filter((r) => r.fund_id === fundId && r.group).map((r) => r.group as string));
  const order = [...FAMOUS_GROUPS.map((g) => g.name), ...[...mine].sort()];
  const lists: PeerList[] = [];
  for (const g of order) {
    if (!mine.has(g) || lists.some((l) => l.name === g)) continue;
    const ids = [...new Set((famous ?? []).filter((r) => r.group === g).map((r) => r.fund_id))];
    const peers = ids.map(peer).filter((p): p is Peer => p !== null);
    if (peers.length >= MIN_PEERS) lists.push({ name: g, peers });
  }
  if (lists.length > 0) return { lists, similar: null };
  const book = new Map(funds.id.map((id, i) => [id, funds.book[i]]));
  const mineBook = book.get(fundId) ?? 0;
  const near = [...rows.keys()]
    .map(peer)
    .filter((p): p is Peer => p !== null)
    .sort((a, b) => Math.abs(Math.log((book.get(a.fund_id) || 1) / (mineBook || 1))) - Math.abs(Math.log((book.get(b.fund_id) || 1) / (mineBook || 1))) || a.fund_id - b.fund_id)
    .slice(0, SIMILAR);
  return { lists, similar: near };
}

/** A 3-year window of the map's path: its scores over the 12 quarters to q (fractions a year). */
export type PathPoint = { q: number; pick: number; alloc: number };

const ann3 = (rs: number[]): number => Math.pow(rs.reduce((a, r) => a * (1 + r), 1), 1 / 3) - 1;

/**
 * Rolling 3-year windows ending each Q4 and the latest quarter: stock choice = ann(fund) − ann(label), sector
 * choice = ann(label) − ann(market), ann = (Π(1 + r))^(1/3) − 1. A window with a missing quarter is skipped.
 */
export function rollingPath(skill: Skill, t: Tier): PathPoint[] {
  const Q = skill.quarters;
  const lab = tierOf(skill, t).quarters.label;
  const out: PathPoint[] = [];
  const n = Q.q.length;
  for (let i = 11; i < n; i++) {
    const q = Q.q[i];
    if (qOfYear(q) !== 3 && i !== n - 1) continue;
    const f: number[] = [];
    const l: number[] = [];
    const m: number[] = [];
    let ok = true;
    for (let j = i - 11; j <= i; j++) {
      const a = Q.fund[j];
      const b = lab[j];
      const c = Q.mkt[j];
      if (a == null || b == null || c == null) {
        ok = false;
        break;
      }
      f.push(a);
      l.push(b);
      m.push(c);
    }
    if (!ok) continue;
    const af = ann3(f);
    const al = ann3(l);
    out.push({ q, pick: af - al, alloc: al - ann3(m) });
  }
  return out;
}
