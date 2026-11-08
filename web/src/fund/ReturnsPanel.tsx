import type { Range, Series, Win } from "./series";
import type { Span } from "./span";

export type ReturnsPanelProps = {
  series: Series;
  win: Win;
  range: Range;
  onRange: (r: Range) => void;
  /** Selected year label (the highlighted bar); null when the fund has no year. */
  sel: string | null;
  onSelect: (label: string) => void;
  /** The annualised-return bracket as year labels of the drawn return years; null = the whole window. */
  br: Span | null;
  onBr: (span: Span) => void;
};

/** Stub: the RETURNS agent replaces it. */
export function ReturnsPanel(_props: ReturnsPanelProps) {
  return <section className="panel" id="retPanel" />;
}
