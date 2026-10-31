import { useRef, type KeyboardEvent } from "react";

export type TabItem<T extends string> = { id: T; label: string };

const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;

/** Props for the single panel that follows the tab strip: the selected tab labels it. */
export function tabPanelProps(idPrefix: string, value: string) {
  return {
    role: "tabpanel" as const,
    id: `${idPrefix}-panel`,
    "aria-labelledby": tabId(idPrefix, value),
  };
}

/**
 * Tab strip (WAI-ARIA tabs, automatic activation): arrow keys, Home and End move the
 * selection and focus, and only the selected tab is in the tab order. Render the panel
 * next to it with {...tabPanelProps(idPrefix, value)}.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  idPrefix: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next: number;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    buttons.current[next]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="tab"
            className="tab"
            id={tabId(idPrefix, t.id)}
            aria-selected={selected}
            aria-controls={selected ? `${idPrefix}-panel` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
