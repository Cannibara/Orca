// A span (the annualised-return bracket, the What-drove period) is kept as two year labels, so it
// survives a change of window; these turn it back into indexes into the list currently drawn.
export type Span = { a: string; b: string };

/** Indexes of the bracket in `labels`; the whole list when it is unset, no longer fits or is a single year. */
export function resolveBracket(labels: string[], span: Span | null): { a: number; b: number } {
  const a = span ? labels.indexOf(span.a) : -1;
  const b = span ? labels.indexOf(span.b) : -1;
  return a < 0 || b < 0 || b <= a ? { a: 0, b: labels.length - 1 } : { a, b };
}

/** Indexes of the What-drove period in `labels`; just the selected year when it is unset or lies outside the list. */
export function resolvePeriod(labels: string[], span: Span | null, sel: string | null): { a: number; b: number } {
  const at = Math.max(0, sel === null ? -1 : labels.indexOf(sel));
  const a = span ? labels.indexOf(span.a) : -1;
  const b = span ? labels.indexOf(span.b) : -1;
  return a < 0 || b < a ? { a: at, b: at } : { a, b };
}
