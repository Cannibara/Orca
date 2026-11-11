import { useCallback, useEffect, useState } from "react";

// Light or dark: the owner's pick (kept in this browser) wins, otherwise the device's setting. tokens.css
// reads <html data-theme="light|dark">; with the attribute unset it follows prefers-color-scheme.

export type Theme = "light" | "dark";

const KEY = "orca-theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // storage blocked (private window, site data off): the pick lasts until the page closes
  }
}

function system(): Theme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme in force now. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === "light" || set === "dark" ? set : system();
}

/** Put a saved pick on the page; call once before the first render. */
export function initTheme(): void {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* not saved */
  }
}

/** The theme in force and a function that switches it. */
export function useTheme(): [Theme, () => void] {
  const [theme, setState] = useState<Theme>(currentTheme);
  // With no pick of the owner's, a change of the device's setting moves the page too.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setState(currentTheme());
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    setState(next);
  }, []);
  return [theme, toggle];
}
