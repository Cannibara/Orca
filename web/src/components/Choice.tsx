import { Seg } from "../fund/Seg";

export type ChoiceOption<T extends string> = { id: T; label: string };

/**
 * A single choice among a few: a period, a window, a filter. Drawn as the segmented control with the
 * sliding thumb (fund/Seg); exactly one option is pressed. (A chip is for picking several at once.)
 */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** Accessible name of the group. */
  label: string;
  options: ChoiceOption<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  return <Seg label={label} options={options} value={value} onChange={(id) => onChange(id as T)} />;
}
