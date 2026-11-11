import { useTheme } from "../lib/theme";

/** Light / dark switch: a square icon button showing the mode a press would switch to. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, toggle] = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={"theme-btn" + (className ? " " + className : "")}
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {dark ? (
          <>
            <circle cx="8" cy="8" r="2.9" />
            <path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
          </>
        ) : (
          <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
        )}
      </svg>
    </button>
  );
}
