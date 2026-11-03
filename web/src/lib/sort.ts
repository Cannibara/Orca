import { useMemo, useState } from "react";
import type { Column, SortState } from "../components/DataTable";

/** A sortable column. `by` is the value it sorts on; null (a figure that is missing) sorts last either way. */
export type Col<R> = Column<R> & { key: string; by: (r: R) => number | string | null };

export function sortRows<R>(rows: R[], columns: Col<R>[], sort: SortState): R[] {
  const by = columns.find((c) => c.key === sort.key)?.by;
  if (!by) return rows;
  return rows.slice().sort((a, b) => {
    const x = by(a);
    const y = by(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return x < y ? -sort.dir : x > y ? sort.dir : 0;
  });
}

/** The rows in the order of the chosen column. A new column starts ascending for text and largest first for numbers. */
export function useSortedRows<R>(rows: R[], columns: Col<R>[], initial: SortState) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const onSort = (key: string) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: columns.find((c) => c.key === key)?.align === "l" ? 1 : -1 },
    );
  return { sorted, sort, onSort };
}
