// Every figure that depends on the latest price, computed in the browser from
// latest_prices.json. All functions are pure and never return NaN or Infinity:
// a figure that cannot be computed is null (the UI shows "—").
import { toRows } from "../data/api";
import type { Holdings, PositionRow, Positions, Trade, TradeTuple } from "../data/types";

type Flow = [t: number, amount: number];

/** Trade time in years after 2013-01-01: the middle of quarter q (R10). */
export const tradeT = (q: number): number => q / 4 + 0.125;

/** What a trade did to the holding. */
export type Move = "New" | "Add" | "Trim" | "Exit";

/**
 * Names a trade from its signed change and the shares left afterwards: a buy that leaves exactly what it
 * bought is a New position (the first buy, or a buy after selling out), any other buy an Add; a sale that
 * leaves nothing is an Exit, any other sale a Trim. The tolerance absorbs float noise in the share counts.
 */
export function tradeMove(t: Pick<Trade, "delta" | "sharesAfter">): Move {
  const eps = 1e-6 * Math.max(1, Math.abs(t.delta));
  if (t.delta > 0) return Math.abs(t.sharesAfter - t.delta) <= eps ? "New" : "Add";
  return Math.abs(t.sharesAfter) <= eps ? "Exit" : "Trim";
}

/** Value of a set of dated flows at annual rate r. */
function npv(flows: Flow[], r: number): number {
  let sum = 0;
  for (const [t, amount] of flows) sum += amount / Math.pow(1 + r, t);
  return sum;
}

/**
 * Annualised internal rate of return of [years, amount] flows (money out negative),
 * by bisection on [−0.99, 10] over 200 iterations. null without a sign change
 * (no outflow and inflow, or no root in the range).
 */
export function irr(flows: Flow[]): number | null {
  let neg = false;
  let pos = false;
  for (const [t, amount] of flows) {
    if (!Number.isFinite(t) || !Number.isFinite(amount)) return null;
    if (amount < 0) neg = true;
    else if (amount > 0) pos = true;
  }
  if (!neg || !pos) return null;

  let lo = -0.99;
  let hi = 10;
  const fLo = npv(flows, lo);
  const fHi = npv(flows, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;
  if (Math.sign(fLo) === Math.sign(fHi)) return null;

  const loSign = Math.sign(fLo);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(flows, mid);
    if (f === 0) return mid;
    if (Math.sign(f) === loSign) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The position's actual cash flows: each trade is −delta × px at its quarter (buys
 * negative, sales positive), plus the shares still held valued at the latest price
 * at nowT. Dividends are left out (R9). [] when shares are held but the price is
 * unknown, so the IRR shows "—" (R10).
 */
export function positionFlows(trades: Trade[], sharesNow: number, price: number | undefined, nowT: number): Flow[] {
  if (sharesNow > 0 && price === undefined) return [];
  const flows: Flow[] = trades.map((t) => [tradeT(t.q), -t.delta * t.px]);
  if (sharesNow > 0 && price !== undefined) flows.push([nowT, sharesNow * price]);
  return flows;
}

/**
 * The same position had the fund never sold: only the buys, plus every bought share
 * valued at the latest price at nowT (R10). [] when the price is unknown.
 */
export function heldFlows(trades: Trade[], price: number | undefined, nowT: number): Flow[] {
  if (price === undefined) return [];
  const buys = trades.filter((t) => t.delta > 0);
  const flows: Flow[] = buys.map((t) => [tradeT(t.q), -t.delta * t.px]);
  flows.push([nowT, buys.reduce((a, t) => a + t.delta, 0) * price]);
  return flows;
}

/** Shares held now at the latest price less their cost: 0 with no shares, null when held but unpriced. */
export function unrealised(sharesNow: number, costNow: number, price: number | undefined): number | null {
  if (sharesNow === 0) return 0;
  if (price === undefined) return null;
  return sharesNow * price - costNow;
}

// The fields the P&L figures read (a PositionRow has them all).
type PnlRow = Pick<PositionRow, "realised" | "dividends" | "shares_now" | "cost_now">;

/** Realised + unrealised + dividends; realised + dividends once sold out. null when held but unpriced. */
export function totalPnl(row: PnlRow, price: number | undefined): number | null {
  const open = unrealised(row.shares_now, row.cost_now, price);
  if (open === null) return null;
  return row.realised + open + row.dividends;
}

/** Total P&L ÷ dollars invested (a fraction). null when nothing was invested or the total is unknown. */
export function returnPct(row: PnlRow & Pick<PositionRow, "invested">, price: number | undefined): number | null {
  if (!(row.invested > 0)) return null;
  const total = totalPnl(row, price);
  if (total === null) return null;
  const r = total / row.invested;
  return Number.isFinite(r) ? r : null;
}

/** Sold shares at the latest price less what they sold for: positive = sold too early, negative = dodged. */
export function missed(soldShares: number, soldUsd: number, price: number | undefined): number | null {
  if (price === undefined) return null;
  return soldShares * price - soldUsd;
}

/** Move in the price since the average exit (a fraction). null without an exit price or a latest price. */
export function sinceSale(avgExit: number | null, price: number | undefined): number | null {
  if (avgExit == null || !(avgExit > 0) || price === undefined) return null;
  return price / avgExit - 1;
}

/** Value of the holdings at the latest prices; `missing` counts holdings without a price (left out of the value). */
export function liveValue(holdings: Holdings, prices: Map<number, number>): { value: number; missing: number } {
  let value = 0;
  let missing = 0;
  holdings.stock_id.forEach((id, i) => {
    const p = prices.get(id);
    if (p === undefined) missing++;
    else value += holdings.shares[i] * p;
  });
  return { value, missing };
}

/**
 * Share of positions (a fraction) whose total P&L is positive, among the positions
 * whose total can be computed (R18). null when none can (R21).
 */
export function profitablePct(rows: PositionRow[], prices: Map<number, number>): number | null {
  let known = 0;
  let profitable = 0;
  for (const r of rows) {
    const t = totalPnl(r, prices.get(r.stock_id));
    if (t === null) continue;
    known++;
    if (t > 0) profitable++;
  }
  return known === 0 ? null : profitable / known;
}

const toTrade = ([q, delta, px, low, high, sharesAfter]: TradeTuple): Trade => ({ q, delta, px, low, high, sharesAfter });

/** positions.json columns -> one PositionRow per position, trade tuples parsed into Trade objects (R22). */
export function positionRows(p: Positions): PositionRow[] {
  return toRows<Omit<PositionRow, "trades"> & { trades: TradeTuple[] }>(p).map((r) => ({
    ...r,
    trades: r.trades.map(toTrade),
  }));
}
