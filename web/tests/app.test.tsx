import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import { clearDataCache } from "../src/data/api";

// The whole app on a MemoryRouter, with the demo files served through a mocked fetch.
const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../public/demo-data");

function stubData() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/^\/demo-data\//, "");
      if (!existsSync(join(DEMO, path))) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(DEMO, path), "utf8")) };
    }),
  );
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </MemoryRouter>,
  );
}

const FUND = 9100001; // Kelpwood Capital LP
const STOCK = 2; // NVDA in that fund

beforeEach(() => {
  clearDataCache();
  document.title = "Kelpwood Capital LP · Orca"; // what a pre-rendered fund page ships with
});
afterEach(() => vi.unstubAllGlobals());

// The title is set by an effect, which React may run a tick after the heading is on screen: wait for it.
describe("page title follows the route", () => {
  it("is Orca on the home page, whatever the page shipped with", async () => {
    stubData();
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: /Fund Manager Research/ });
    await waitFor(() => expect(document.title).toBe("Orca"));
  });

  it("names the fund on its page, and goes back to Orca on the way home", async () => {
    stubData();
    const user = userEvent.setup();
    document.title = "Orca";
    renderApp(`/fund/${FUND}`);
    await screen.findByRole("heading", { level: 1, name: "Kelpwood Capital LP" });
    await waitFor(() => expect(document.title).toBe("Kelpwood Capital LP · Orca"));

    await user.click(screen.getByRole("link", { name: "Orca home" }));
    await screen.findByRole("heading", { level: 1, name: /Fund Manager Research/ });
    await waitFor(() => expect(document.title).toBe("Orca"));
  });

  it("names the stock and the fund on a position page", async () => {
    stubData();
    renderApp(`/fund/${FUND}/stock/${STOCK}`);
    await screen.findByRole("heading", { level: 1, name: /NVDA/ });
    await waitFor(() => expect(document.title).toBe("NVDA · Kelpwood Capital LP · Orca"));
  });

  it("is 'How it works · Orca' on the methodology page", async () => {
    stubData();
    renderApp("/how-it-works");
    await screen.findByRole("heading", { level: 1, name: /How Orca estimates/ });
    await waitFor(() => expect(document.title).toBe("How it works · Orca"));
  });

  it.each(["/no-such-page", "/fund/424242", "/fund/abc"])("is 'Not found · Orca' on %s", async (path) => {
    stubData();
    renderApp(path);
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
    await waitFor(() => expect(document.title).toBe("Not found · Orca"));
  });
});

describe("site footer", () => {
  it.each(["/", `/fund/${FUND}`, `/fund/${FUND}/stock/${STOCK}`, "/how-it-works", "/no-such-page"])(
    "shows the estimate disclaimer and a link to How it works on %s",
    async (path) => {
      stubData();
      renderApp(path);
      const foot = await screen.findByRole("contentinfo");
      expect(foot).toHaveTextContent("Estimates from SEC 13F filings. Not investment advice.");
      expect(within(foot).getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/how-it-works");
    },
  );
});
