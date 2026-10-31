import type { ReactNode } from "react";
import { printsZero } from "../lib/format";

/** Colour of a tile's value: "up" green, "down" red; none for a neutral or missing figure, or one that prints as zero. */
export type Tone = "up" | "down" | "";

/** One figure with its label above and an optional explanation or detail below. */
export function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="tile">
      <span className="k">{label}</span>
      <span className={tone && !printsZero(value) ? `v ${tone}` : "v"}>{value}</span>
      {sub && <span className="d">{sub}</span>}
    </div>
  );
}

/** A responsive grid of tiles, named for assistive technology. */
export function Tiles({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tiles" role="group" aria-label={label}>
      {children}
    </div>
  );
}
