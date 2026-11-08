import type { Stock } from "../data/api";
import type { Contrib } from "../data/types";
import type { Series, Win } from "./series";
import type { Span } from "./span";

export type DrivePanelProps = {
  series: Series;
  win: Win;
  contrib: Contrib;
  stocks: Map<number, Stock>;
  /** The selected year label (a period of just that year when `cr` is unset). */
  sel: string | null;
  /** The What-drove period as year labels; null = just `sel`. */
  cr: Span | null;
  onCr: (span: Span) => void;
};

/** Stub: the DRIVE agent replaces it. */
export function DrivePanel(_props: DrivePanelProps) {
  return <section className="panel" id="drvPanel" />;
}
