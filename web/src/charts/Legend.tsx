import "./charts.css";

export type LegendItem = {
  label: string;
  /** Any CSS colour, normally a `var(--…)` token. Only the swatch is coloured, never the text. */
  color: string;
  /** `sw` square (bars, bands), `lk` short line, `dot` circle, `up` / `dn` triangle (a buy / a sale). */
  kind?: "sw" | "lk" | "dot" | "up" | "dn";
};

/** The small inline key above a chart: a swatch in the series' colour and its name. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="legend chart-legend">
      {items.map((it) => (
        <span key={it.label}>
          {/* The swatch takes the colour as `currentColor`, so one rule per shape covers every colour. */}
          <i className={"lg-" + (it.kind ?? "sw")} style={{ color: it.color }} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </div>
  );
}
