import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

export type Column<T> = {
  header: string;
  /** Set to make the header a sort button (needs `onSort` on the table). */
  key?: string;
  /** "l" left-aligns the column and drops tabular figures (text); anything else is a number column. */
  align?: "l" | "r";
  cell: (row: T) => ReactNode;
};

/** dir 1 = ascending, -1 = descending. The caller sorts `rows`; the table only shows the state. */
export type SortState = { key: string; dir: 1 | -1 };

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  sort?: SortState;
  onSort?: (key: string) => void;
  /** Makes each row clickable and keyboard-activatable (Enter, Space). Links and buttons inside a row keep their own action. */
  onRow?: (row: T) => void;
  /** Render only the rows in view, for tables of thousands of rows. */
  virtual?: boolean;
  rowKey?: (row: T, index: number) => string | number;
  /** Shown in place of the rows when there are none. */
  empty?: string;
  /** Accessible name of the table. */
  label?: string;
};

/** Fixed row height of a virtual table (see `.tbl-wrap.virtual td` in styles.css). */
const ROW_H = 40;
/** Viewport assumed when the scroll container reports no height (no layout: tests, a hidden tab). */
const FALLBACK_VIEW_H = 640;

const interactive = (target: EventTarget) => target instanceof Element && target.closest("a, button, input, select, textarea");

export function DataTable<T>({
  columns,
  rows,
  sort,
  onSort,
  onRow,
  virtual = false,
  rowKey,
  empty = "Nothing to show.",
  label,
}: Props<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    enabled: virtual,
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    initialRect: { width: 0, height: FALLBACK_VIEW_H },
    // Without layout the observed height is 0 and the virtualizer would render no rows at all.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { ...rect, height: FALLBACK_VIEW_H })),
  });

  // Only the rows in view are in the table, so its auto layout would resize the columns as the rows
  // change while scrolling. Never let a column shrink below the widest it has been.
  useLayoutEffect(() => {
    if (!virtual) return;
    scroller.current?.querySelectorAll<HTMLElement>("thead th").forEach((th) => {
      const w = th.offsetWidth;
      if (w > (parseFloat(th.style.minWidth) || 0)) th.style.minWidth = `${w}px`;
    });
  });

  // Indexes of the rows to render, and the height of the rows left out above and below them.
  const windowed = virtual ? virtualizer.getVirtualItems() : [];
  const indexes = virtual ? windowed.map((v) => v.index) : rows.map((_, i) => i);
  const padTop = windowed.length > 0 ? windowed[0].start : 0;
  const padBottom = windowed.length > 0 ? virtualizer.getTotalSize() - windowed[windowed.length - 1].end : 0;

  const header = (c: Column<T>, i: number) => {
    const dir = sort && c.key !== undefined && sort.key === c.key ? sort.dir : 0;
    return (
      <th
        key={i}
        scope="col"
        className={c.align === "l" ? "l" : undefined}
        aria-sort={dir === 0 ? undefined : dir > 0 ? "ascending" : "descending"}
      >
        {onSort && c.key !== undefined ? (
          <button
            type="button"
            data-dir={dir === 0 ? undefined : dir > 0 ? "↑" : "↓"}
            onClick={() => onSort(c.key as string)}
          >
            {c.header}
          </button>
        ) : (
          c.header
        )}
      </th>
    );
  };

  const body = (index: number) => {
    const row = rows[index];
    const activate = onRow
      ? {
          tabIndex: 0,
          onClick: (e: MouseEvent) => {
            if (!interactive(e.target)) onRow(row);
          },
          onKeyDown: (e: KeyboardEvent) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
              e.preventDefault();
              onRow(row);
            }
          },
        }
      : {};
    return (
      <tr
        key={rowKey ? rowKey(row, index) : index}
        className={onRow ? "click" : undefined}
        aria-rowindex={virtual ? index + 2 : undefined}
        {...activate}
      >
        {columns.map((c, i) => (
          <td key={i} className={c.align === "l" ? "l" : undefined}>
            {c.cell(row)}
          </td>
        ))}
      </tr>
    );
  };

  // The spacer rows stand in for the rows outside the window, so the scrollbar keeps its full length.
  const spacer = (height: number, key: string) =>
    height > 0 ? (
      <tr key={key} aria-hidden="true" style={{ height }}>
        <td colSpan={columns.length} style={{ padding: 0, border: 0 }} />
      </tr>
    ) : null;

  return (
    <div ref={scroller} className={virtual ? "tbl-wrap virtual" : "tbl-wrap"}>
      <table aria-label={label} aria-rowcount={virtual ? rows.length + 1 : undefined}>
        <thead>
          <tr>{columns.map(header)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="l cap">
                {empty}
              </td>
            </tr>
          ) : (
            <>
              {spacer(padTop, "pad-top")}
              {indexes.map(body)}
              {spacer(padBottom, "pad-bottom")}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
