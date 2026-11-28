// The home Landscape's model, pure: home/landscape.json as a tree of investor types (orca/investors.py) with
// each type's filers, the nested tree map's layout (a heading strip per group, its children below), and what
// each tile's labels say. No DOM: LandscapeMap draws what this computes with the fund page's tree map view.

import type { ByPeriod, Landscape } from "../data/types";
import { ellipsize, layout, type LabelSet, type Measure, type Rect } from "../fund/treemap";
import { shortNameOf } from "../lib/famousNames";
import { count, money, pct, tidyName } from "../lib/format";

export type Period = keyof ByPeriod<number>;

export const ROOT = "all";
export const ROOT_LABEL = "All 13F filers";

export type LNode = {
  /** "t:<type>" for a type, "f:<fund_id>" for a filer, "r:<type>" for the rest of a type. */
  key: string;
  kind: "type" | "fund" | "rest";
  /** The type's own key; a filer's or a rest's leaf type. */
  type: string;
  /** The type's label, the filer's short name, or "1,234 others". */
  label: string;
  /** A filer's full name (tidied), else the label. */
  name: string;
  fundId?: number;
  /** 13F book, dollars. */
  value: number;
  /** Filers it stands for. */
  n: number;
  /** Estimated annual return over the period; a type's or a rest's is the book-weighted mean of those with one. */
  ret: number | null;
  /** Dollars of `value` that have a return (a type's or a rest's mean is over these). */
  covered: number;
  children: LNode[];
  /** A merged rest tile's filers too small to draw, largest first (for its tooltip). */
  others?: LNode[];
  /** A firm's filers (tidied names, largest first) when it files under several names. */
  members?: string[];
};

const weighted = (nodes: LNode[]): { ret: number | null; covered: number } => {
  let covered = 0;
  let sum = 0;
  for (const c of nodes)
    if (c.ret !== null && c.covered > 0) {
      covered += c.covered;
      sum += c.ret * c.covered;
    }
  return { ret: covered > 0 ? sum / covered : null, covered };
};

/** A type's node from its children: their book, filers and weighted return. */
function typeNode(type: string, label: string, children: LNode[]): LNode {
  const value = children.reduce((s, c) => s + c.value, 0);
  const n = children.reduce((s, c) => s + c.n, 0);
  return { key: `t:${type}`, kind: "type", type, label, name: label, value, n, ...weighted(children), children };
}

/**
 * The file as a tree for one period: the root (all filers), its top-level types, their sub-types, and each
 * leaf type's filers (largest first) with the rest of the type as one node. Types without filers are left out.
 */
export function buildTree(file: Landscape, period: Period): LNode {
  const leafKids = new Map<string, LNode[]>();
  const f = file.funds;
  for (let i = 0; i < f.fund_id.length; i++) {
    const ret = f.ret[period]?.[i] ?? null;
    const n = f.n?.[i] ?? 1;
    // a firm's row is named by the pipeline (investor_parents.csv); a filer's by its short name
    const node: LNode = {
      key: `f:${f.fund_id[i]}`,
      kind: "fund",
      type: f.type[i],
      label: n > 1 ? f.name[i] : shortNameOf(f.fund_id[i], f.name[i]),
      name: n > 1 ? f.name[i] : tidyName(f.name[i]),
      fundId: f.fund_id[i],
      value: f.book[i],
      n,
      ret,
      covered: ret === null ? 0 : f.book[i],
      children: [],
      ...(n > 1 ? { members: (f.members?.[i] ?? []).map(tidyName) } : {}),
    };
    leafKids.set(node.type, [...(leafKids.get(node.type) ?? []), node]);
  }
  const r = file.rest;
  for (let i = 0; i < r.type.length; i++) {
    const ret = r.ret[period]?.[i] ?? null;
    const node: LNode = {
      key: `r:${r.type[i]}`,
      kind: "rest",
      type: r.type[i],
      label: `${count(r.n[i])} others`,
      name: `${count(r.n[i])} others`,
      value: r.book[i],
      n: r.n[i],
      ret,
      covered: (r.covered[period]?.[i] ?? 0) * r.book[i],
      children: [],
    };
    leafKids.set(node.type, [...(leafKids.get(node.type) ?? []), node]);
  }
  const t = file.types;
  const childTypes = new Map<string, number[]>();
  t.key.forEach((_, i) => {
    const p = t.parent[i] ?? ROOT;
    childTypes.set(p, [...(childTypes.get(p) ?? []), i]);
  });
  const make = (i: number): LNode | null => {
    const key = t.key[i];
    const subs = (childTypes.get(key) ?? []).map(make).filter((n): n is LNode => n !== null);
    const kids = subs.length ? subs : (leafKids.get(key) ?? []);
    const live = kids.filter((k) => k.value > 0).sort(bySize);
    return live.length ? typeNode(key, t.label[i], live) : null;
  };
  const tops = (childTypes.get(ROOT) ?? []).map(make).filter((n): n is LNode => n !== null);
  return { ...typeNode(ROOT, ROOT_LABEL, tops.sort(bySize)), key: `t:${ROOT}` };
}

const bySize = (a: LNode, b: LNode) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The path from the root to the type `type` (the root alone when there is none such): the breadcrumb. */
export function pathTo(root: LNode, type: string): LNode[] {
  const walk = (n: LNode, trail: LNode[]): LNode[] | null => {
    const here = [...trail, n];
    if (n.kind === "type" && n.type === type) return here;
    for (const c of n.children) {
      const found = c.kind === "type" ? walk(c, here) : null;
      if (found) return found;
    }
    return null;
  };
  return walk(root, []) ?? [root];
}

// ---- layout ---------------------------------------------------------------------------------

/** A group's heading strip, px. Its label sits on the tree map's first baseline (BASE.tk, 18 px). */
export const HEAD = 24;
/** The least room under a heading for the group's tiles, and the least width for a heading: else the group is one tile. */
const MIN_INNER = 20;
const MIN_HEAD_W = 56;
/** A filer smaller than this (px²) joins its type's rest. */
export const MIN_AREA = 600;
const GAP = 2;

export type LTile = {
  /** head: a group's heading strip (zooms in); box: a group too small to open (zooms in); fund; rest. */
  role: "head" | "box" | "fund" | "rest";
  node: LNode;
  rect: Rect;
  /** 1 for a top-level group of the view, 2 for its sub-groups, and so on. */
  depth: number;
};

/**
 * The tiles of the tree map of `root` in a W × H box: every group of the view gets a heading strip and its
 * children below it, down to the filers; a group too small for that is one tile. A leaf type's filers too small
 * to draw (under MIN_AREA) join its rest, unless one would be alone there. No two tiles overlap.
 */
export function layoutMap(root: LNode, W: number, H: number): LTile[] {
  const out: LTile[] = [];
  const place = (node: LNode, r: Rect, depth: number) => {
    if (node.kind !== "type") {
      out.push({ role: node.kind, node, rect: r, depth });
      return;
    }
    let inner = r;
    if (depth > 0) {
      if (r.h < HEAD + MIN_INNER || r.w < MIN_HEAD_W) {
        out.push({ role: "box", node, rect: r, depth });
        return;
      }
      out.push({ role: "head", node, rect: { x: r.x, y: r.y, w: r.w, h: HEAD }, depth });
      inner = { x: r.x, y: r.y + HEAD, w: r.w, h: r.h - HEAD };
    }
    const kids = drawn(node, inner.w * inner.h);
    const rects = layout(
      kids.map((k) => k.value),
      inner.w,
      inner.h,
      GAP,
    );
    kids.forEach((k, i) => place(k, { x: inner.x + rects[i].x, y: inner.y + rects[i].y, w: rects[i].w, h: rects[i].h }, depth + 1));
  };
  if (root.value > 0 && W > 0 && H > 0) place(root, { x: 0, y: 0, w: W, h: H }, 0);
  return out;
}

/** A group's children as drawn in `area` px²: sub-types as they are; filers too small to draw merged into the rest. */
function drawn(node: LNode, area: number): LNode[] {
  if (node.children.every((c) => c.kind === "type")) return node.children;
  const perDollar = node.value > 0 ? area / node.value : 0;
  const funds = node.children.filter((c) => c.kind === "fund");
  const rest = node.children.find((c) => c.kind === "rest");
  let big = funds.filter((c) => c.value * perDollar >= MIN_AREA);
  let small = funds.filter((c) => c.value * perDollar < MIN_AREA);
  if (small.length === 1 && !rest) {
    big = funds;
    small = [];
  }
  if (!small.length) return rest ? [...big, rest] : big;
  const merged = [...small, ...(rest ? [rest] : [])];
  const n = merged.reduce((s, c) => s + c.n, 0);
  const value = merged.reduce((s, c) => s + c.value, 0);
  const others: LNode = {
    key: `r:${node.type}`,
    kind: "rest",
    type: node.type,
    label: `${count(n)} others`,
    name: `${count(n)} others`,
    value,
    n,
    ...weighted(merged),
    children: [],
    others: small,
  };
  return [...big, others].sort(bySize);
}

// ---- labels ---------------------------------------------------------------------------------

/** A book as the Landscape prints it: trillions to one decimal ($6.6T), hundreds of billions whole ($170B), else
 * the app's money ($12.34B, $450M): the map's figures run from millions to tens of trillions. */
export function aum(usd: number): string {
  const a = Math.abs(usd);
  if (Math.round(a / 1e11) >= 10) return (usd < 0 ? "−" : "") + "$" + (a / 1e12).toFixed(1) + "T";
  if (Math.round(a / 1e9) >= 100) return (usd < 0 ? "−" : "") + "$" + Math.round(a / 1e9) + "B";
  return money(usd);
}

/** Labels of a filer, a rest or a group too small to open: its name (sans, the tree map's first row; the first of
 * several that fits), then
 * `$6.6T · +12.3%` or `$6.6T`, on the same row when the tile is too short for two. Left out when they do not fit. */
export function fitTile(label: string | string[], value: number, ret: number | null, w: number, h: number, measure: Measure): LabelSet {
  const o: LabelSet = { tk: null, w: null, n: null, v: null };
  const aw = w - 14;
  if (h < 24 || aw < 8) return o;
  // the first of the names that fits whole ("1,234 others", then "1,234"), else the first cut short
  const names = typeof label === "string" ? [label] : label;
  const first = names.find((s) => measure("oth", s) <= aw) ?? ellipsize("oth", names[0], aw, measure);
  if (first === null) return o;
  o.tk = first;
  const val = aum(value);
  const vr = ret === null ? null : `${val} · ${pct(ret)}`;
  if (h < 39) {
    const room = aw - measure("oth", first) - 8;
    o.v = vr !== null && measure("w", vr) <= room ? vr : measure("w", val) <= room ? val : null;
    return o;
  }
  o.w = [vr, val].find((s): s is string => s !== null && measure("w", s) <= aw) ?? null;
  return o;
}

/** A heading strip's labels: the group's name, and its book at the right end when both fit. */
export function fitHead(label: string, value: number, w: number, measure: Measure): LabelSet {
  const o: LabelSet = { tk: null, w: null, n: null, v: null };
  const aw = w - 14;
  const val = aum(value);
  const name = ellipsize("oth", label, aw, measure);
  if (name === null) return o;
  o.tk = name;
  if (measure("oth", name) + 8 + measure("w", val) <= aw && name === label) o.v = val;
  return o;
}
