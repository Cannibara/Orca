import type { ReactNode } from "react";
import { Seg } from "../fund/Seg";

/** `icon` (an inline svg) goes before the word, as on the fund page's table toggles. */
export type ChoiceOption<T extends string> = { id: T; label: string; icon?: ReactNode };

/**
 * A single choice among a few: a period, a window, a filter. Drawn as the segmented control with the
 * sliding thumb (fund/Seg); exactly one option is pressed. (A chip is for picking several at once.)
 */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  wrap = false,
}: {
  /** Accessible name of the group. */
  label: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Lay the options out on as many rows as they need (the thumb then moves down as well as across). */
  wrap?: boolean;
}) {
  return (
    <Seg
      label={label}
      options={options}
      value={value}
      onChange={(id) => onChange(id as T)}
      className={wrap ? "wrap" : undefined}
    />
  );
}
