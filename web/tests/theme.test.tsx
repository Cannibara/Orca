import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "../src/components/ThemeToggle";
import { initTheme } from "../src/lib/theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme toggle", () => {
  it("switches the page between dark and light and remembers the pick", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    // jsdom has no dark preference: the page starts light, so the switch is off (day)
    const sw = screen.getByRole("switch", { name: "Dark mode" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("orca-theme")).toBe("dark");
    await user.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("orca-theme")).toBe("light");
  });

  it("puts a saved pick on the page at start, ignores anything else", () => {
    localStorage.setItem("orca-theme", "dark");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    delete document.documentElement.dataset.theme;
    localStorage.setItem("orca-theme", "sepia");
    initTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
