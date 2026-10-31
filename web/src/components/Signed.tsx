import type { ReactNode } from "react";
import { printsZero, signClass } from "../lib/format";

/**
 * A figure coloured by the sign of `v`: green above zero, red below, plain at zero or when missing.
 * A figure that prints as zero ("$0", "0.0%") is plain too, however small the value behind it was.
 */
export function Signed({ v, children }: { v: number | null; children: ReactNode }) {
  const shownZero = typeof children === "string" && printsZero(children);
  return <span className={(!shownZero && signClass(v)) || undefined}>{children}</span>;
}
