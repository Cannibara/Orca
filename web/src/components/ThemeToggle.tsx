import { useTheme } from "../lib/theme";

/** Day / night switch: a sun on the left, a moon on the right, and a knob that slides to the side in force. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={theme === "dark"}
      aria-label="Dark mode"
      title={theme === "dark" ? "Night: switch to day" : "Day: switch to night"}
      className={"theme-sw" + (className ? " " + className : "")}
      onClick={toggle}
    >
      <span className="th" aria-hidden="true" />
      <svg className="sun" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.9" />
        <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
      </svg>
      <svg className="moon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
      </svg>
    </button>
  );
}
