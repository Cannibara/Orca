import type { ReactNode } from "react";
import { signClass } from "../lib/format";

/** A figure coloured by the sign of `v`: green above zero, red below, plain at zero or when missing. */
export function Signed({ v, children }: { v: number | null; children: ReactNode }) {
  return <span className={signClass(v) || undefined}>{children}</span>;
}
