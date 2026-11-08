import type { Summary } from "../data/types";

/** Stub: the RETURNS agent replaces it (name, reported book, holdings, filing pill, Overview/Positions tabs, data-quality warnings). */
export function FundHeader({ summary }: { summary: Summary; positionsEver: number }) {
  return <h1>{summary.name}</h1>;
}
