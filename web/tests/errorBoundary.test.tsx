import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { clearDataCache } from "../src/data/api";

// A page that throws while rendering, standing in for malformed data that gets past the loaders.
vi.mock("../src/pages/Method", () => ({
  default: () => {
    throw new Error("boom");
  },
}));

const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");

function Boom(): never {
  throw new Error("boom");
}

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clearDataCache();
  // React reports a caught render error with console.error; the tests expect exactly that and nothing else.
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
  vi.unstubAllGlobals();
});

describe("ErrorBoundary", () => {
  it("shows one line and a link home instead of a blank page", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole("link", { name: /home page/i })).toHaveAttribute("href", "/");
    expect(logged).toHaveBeenCalled(); // the error is still reported, not swallowed
  });

  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the app's header, and moving to another page leaves the error behind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace(/^\/demo-data\//, "");
        if (!existsSync(join(DEMO, path))) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(DEMO, path), "utf8")) };
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/how-it-works"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(screen.getByRole("link", { name: "Orca home" })).toBeInTheDocument(); // the header is outside the boundary

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByRole("heading", { level: 1, name: /Fund Manager Research/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
