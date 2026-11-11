import type { ReactNode } from "react";

/**
 * Holds the chart's place, and so its height, while the table view covers it: hidden from sight, from the
 * tab order and from the accessibility tree. The table view fills the same box (`.tview`, see base.css), so
 * switching views never changes the panel's height.
 */
export function ChartSlot({ table, children }: { table: boolean; children: ReactNode }) {
  return (
    <div className="vchart" aria-hidden={table || undefined} {...(table ? ({ inert: "" } as Record<string, string>) : {})}>
      {children}
    </div>
  );
}
