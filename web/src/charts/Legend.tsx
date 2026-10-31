export type LegendItem = {
  label: string;
  /** Any CSS colour, normally a `var(--…)` token. Only the swatch is coloured, never the text. */
  color: string;
  /** `sw` square (bars, bands), `lk` short line, `dot` circle. */
  kind?: "sw" | "lk" | "dot";
};

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <i className={it.kind ?? "sw"} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
