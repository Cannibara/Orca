// Pure model of "Which decisions made the gap" (spec §5.4): each big pick against its own label's index, and
// each label they bought against the whole market, with the share of their money and what it added.
//
// Every figure is on the fund's own money (contract.md, Sector files): a pick's return a year is what its money
// made ÷ the dollar-years it was held, against the same money in its label's index. Adds is the dollars that
// decision gained over the benchmark ÷ the whole fund's dollar-years, so the rows sum exactly to the score.

import type { SkillTier } from "../data/types";
import type { Stock } from "../data/api";
import { labelName, type Tier } from "./skill";

export type DecRow = {
  key: string;
  /** The ticker (stock view) or the label's name (bets view). */
  lab: string;
  /** Under the name: "Nvidia · Semiconductors" or "market holds 12%". */
  sub: string;
  /** Share of all the dollars they put in (0 to 1). */
  share: number;
  /** The market's share of the same label when they were buying (bets view only). */
  mktShare: number | null;
  bought: number;
  /** The benchmark's return a year: the label index (stock view) or the market (bets view). */
  bench: number | null;
  /** The choice's return a year: the stock, or the label's index. */
  choice: number | null;
  /** choice − bench (fractions a year); null when either is missing. */
  beat: number | null;
  /** Points a year this decision added to the whole fund (the rows sum to the score). */
  adds: number | null;
  /** A sector they never bought (bets view, tier 1): faded, Adds 0. */
  skipped: boolean;
  /** The "All other picks" row. */
  rest: boolean;
  /** The label's full path, for the tooltip. */
  label: string | null;
};

export type Decisions = { rows: DecRow[]; bought: number; adds: number };

const sum = (a: number[]) => a.reduce((x, v) => x + v, 0);

function finish(rows: DecRow[]): Decisions {
  return { rows, bought: sum(rows.map((r) => r.bought)), adds: sum(rows.map((r) => r.adds ?? 0)) };
}

/** Stocks vs their label: the biggest picks by Adds, largest first, "All other picks" last. */
export function stockRows(t: SkillTier, stocks: Map<number, Stock>): Decisions {
  const P = t.picks;
  const total = sum(P.bought) || 1;
  const rows: DecRow[] = P.bought.map((bought, i) => {
    const id = P.stock_id[i];
    const s = id == null ? undefined : stocks.get(id);
    const bench = P.ret_label[i];
    const choice = P.ret_own[i];
    const beat = bench == null || choice == null ? null : choice - bench;
    const share = bought / total;
    const rest = id == null;
    return {
      key: rest ? "rest" : "s" + id,
      lab: rest ? "All other picks" : (s?.ticker ?? "#" + id),
      sub: rest ? "Smaller positions together" : `${s?.name ?? "Unknown"} · ${labelName(P.label[i])}`,
      share,
      mktShare: null,
      bought,
      bench,
      choice,
      beat,
      adds: P.adds[i] ?? null,
      skipped: false,
      rest,
      label: P.label[i],
    };
  });
  rows.sort((a, b) => Number(a.rest) - Number(b.rest) || (b.adds ?? -Infinity) - (a.adds ?? -Infinity) || b.bought - a.bought);
  return finish(rows);
}

/** Labels vs the market: by share of their money; at tier 1 the sectors they never bought come last, faded. */
export function betRows(t: SkillTier, tier: Tier): Decisions {
  const B = t.bets;
  const total = sum(B.bought) || 1;
  const rows: DecRow[] = [];
  B.label.forEach((label, i) => {
    const bought = B.bought[i];
    const skipped = bought <= 0;
    if (skipped && tier !== 1) return;
    const bench = B.ret_mkt[i];
    const choice = B.ret[i];
    const beat = bench == null || choice == null ? null : choice - bench;
    const share = bought / total;
    const ms = B.mkt_share[i];
    rows.push({
      key: "b" + label,
      lab: labelName(label),
      sub: ms == null ? "market share unknown" : `market holds ${Math.round(ms * 100)}%`,
      share,
      mktShare: ms,
      bought,
      bench: skipped ? null : bench,
      choice: skipped ? null : choice,
      beat: skipped ? null : beat,
      adds: skipped ? 0 : (B.adds[i] ?? null),
      skipped,
      rest: false,
      label,
    });
  });
  rows.sort((a, b) => Number(a.skipped) - Number(b.skipped) || b.share - a.share || (b.mktShare ?? 0) - (a.mktShare ?? 0));
  return finish(rows);
}

/** Return-axis ticks every 5 or 10 points covering every row's two dots. */
export function returnTicks(rows: DecRow[]): { lo: number; hi: number; step: number; ticks: number[] } {
  const vals = rows.flatMap((r) => [r.bench, r.choice]).filter((v): v is number => v != null);
  if (!vals.length) vals.push(0);
  let lo = Math.floor(Math.min(0, ...vals) / 0.05) * 0.05;
  let hi = Math.ceil(Math.max(0, ...vals) / 0.05) * 0.05;
  if (hi - lo < 0.1) hi = lo + 0.1;
  const step = hi - lo > 0.4 ? 0.1 : 0.05;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, step, ticks };
}
