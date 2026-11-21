import { useId, useState } from "react";
import { photoOf } from "../lib/people";
import { GROUP_LABEL, type IndexGroup, type IndexItem, type IndexLayout } from "./listIndex";

// The Famous funds list switch (layout in ./listIndex). On a wide or mid page: every list as a line of text on
// the index's grid, the pressed one in the site's pressed chip (the segmented control's thumb), Most searched as
// one tall cell with a few of its faces. Narrower (a phone): one field naming the list, over the device's own
// select, grouped the same way, so 16 lists never make a ragged row or a sideways scroll.

/** A face in Most searched's cell; nothing at all when the photo is missing or fails. */
function Mini({ manager }: { manager: string }) {
  const [failed, setFailed] = useState(false);
  const src = photoOf(manager);
  if (!src || failed) return null;
  return <img className="ix-face" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

const CHEVRON = (
  <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

export function ListIndex({
  items,
  layout,
  value,
  onChange,
  faces,
  featNote,
}: {
  items: IndexItem[];
  /** The grid layout; null draws the field over the device's select. */
  layout: IndexLayout | null;
  value: string;
  onChange: (name: string) => void;
  /** Managers whose photos show in Most searched's cell (wide layout). */
  faces: string[];
  /** The line under Most searched's name (wide layout). */
  featNote: string;
}) {
  const id = useId();
  if (!layout) {
    const groups = (["pop", "style", "who"] as IndexGroup[])
      .map((g) => ({ g, names: items.filter((i) => i.group === g).map((i) => i.name) }))
      .filter((x) => x.names.length > 0);
    return (
      <div className="fam-pick">
        <span className="pk-k" aria-hidden="true">
          List
        </span>
        <span className="pk-v" aria-hidden="true">
          {value}
        </span>
        <span className="pk-n" aria-hidden="true">
          {items.length} lists
        </span>
        {CHEVRON}
        <select id={id} aria-label="List" value={value} onChange={(e) => onChange(e.target.value)}>
          {groups.map(({ g, names }) => (
            <optgroup key={g} label={GROUP_LABEL[g]}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div
      className={"ix " + layout.mode}
      role="group"
      aria-label="List"
      style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: layout.rows }}
    >
      {/* in reading order: each heading, then its lists; the grid places them */}
      {(["pop", "style", "who"] as IndexGroup[]).flatMap((g) => {
        const h = layout.heads.find((x) => x.group === g);
        if (!h) return [];
        return [
          <span key={"h-" + g} className={"ix-h" + (h.row > 1 ? " later" : "")} style={{ gridColumn: `${h.col} / span ${h.span}`, gridRow: h.row }}>
            {GROUP_LABEL[g]}
          </span>,
          ...layout.cells
            .filter((c) => c.group === g)
            .map((c) => (
              <button
                key={c.name}
                type="button"
                className={"ix-c" + (c.feat ? " feat" : "")}
                aria-pressed={c.name === value}
                style={{ gridColumn: c.col, gridRow: `${c.row} / span ${c.rowSpan}` }}
                onClick={() => {
                  if (c.name !== value) onChange(c.name);
                }}
              >
                <span className="nm">{c.name}</span>
                {c.feat && layout.mode === "wide" && (
                  <>
                    {faces.length > 0 && (
                      <span className="ix-faces" aria-hidden="true">
                        {faces.map((m) => (
                          <Mini key={m} manager={m} />
                        ))}
                      </span>
                    )}
                    <span className="ix-note" aria-hidden="true">
                      {featNote}
                    </span>
                  </>
                )}
              </button>
            )),
        ];
      })}
    </div>
  );
}
