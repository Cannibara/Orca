import "@testing-library/jest-dom/vitest";

// React Router 6 prints a notice per v7 future flag the first time a router
// mounts. Tests mount MemoryRouter directly, so drop exactly those notices to
// keep test output clean; every other warning still goes through.
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("React Router Future Flag Warning")) return;
  warn(...args);
};
