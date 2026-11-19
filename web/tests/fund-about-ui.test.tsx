import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { About, Summary } from "../src/data/types";
import { AboutPanel } from "../src/fund/AboutPanel";

const here = dirname(fileURLToPath(import.meta.url));
const demo: Summary = JSON.parse(readFileSync(resolve(here, "../public/demo-data/fund/9100001/summary.json"), "utf8"));

const ABOUT: About = {
  name: "KELPWOOD CAPITAL LP",
  street: "3555 FARNAM STREET",
  city: "OMAHA",
  state: "NE",
  signer: "MARC D. HAMBURG",
  signer_title: "SENIOR VICE PRESIDENT",
  signed: "2026-08-11",
  other_managers: ["WARREN E. BUFFETT", "GEICO CORP", "GENERAL RE CORP", "NATIONAL INDEMNITY CO", "BH FINANCE LLC", "COLUMBIA INSURANCE CO"],
  incorporated: "DE",
  former_names: [{ name: "NBH INC", from: "1998-08-10", to: "1999-01-04" }],
  sic: "INVESTMENT ADVICE",
  tickers: [],
  exchanges: [],
};
const withAbout = (about: About | null | undefined): Summary => ({ ...demo, about });

/** The label / value rows as [label, value text]. */
const rows = () => {
  const dl = document.querySelector("dl.ab-kv") as HTMLElement;
  const dts = Array.from(dl.querySelectorAll("dt"));
  return dts.map((dt) => [dt.textContent, (dt.nextElementSibling as HTMLElement).textContent]);
};

describe("About panel", () => {
  test("a sentence from the facts, then the rows that are known, then the source", () => {
    render(<AboutPanel summary={withAbout(ABOUT)} />);
    const panel = screen.getByRole("region", { name: "About" });
    expect(panel.querySelector(".ab-d")?.textContent).toBe(
      "Kelpwood Capital LP is an institutional investment manager based in Omaha, Nebraska. The SEC classes it under Investment Advice. " +
        "Its latest 13F, for the quarter to 30 Jun 2026, reports $24.0B across 10 holdings.",
    );
    expect(rows().map((r) => r[0])).toEqual(["Headquarters", "13F signed by", "Other managers in the report", "Incorporated in", "Former name", "SEC CIK"]);
    expect(rows()[0][1]).toBe("Omaha, Nebraska (3555 Farnam Street)");
    expect(rows()[1][1]).toBe("Marc D. Hamburg, Senior Vice President (11 Aug 2026)");
    expect(rows()[3][1]).toBe("Delaware");
    expect(rows()[4][1]).toBe("NBH Inc (1998–1999)");
    expect(within(panel).getByText("From SEC EDGAR: the filer's record and its latest 13F cover page.")).toBeInTheDocument();
  });

  test("other managers: the first four, then Show all N, and Show fewer", async () => {
    const user = userEvent.setup();
    render(<AboutPanel summary={withAbout(ABOUT)} />);
    const more = screen.getByRole("button", { name: "Show all 6" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    const dd = more.closest("dd") as HTMLElement;
    const shown = () => Array.from(dd.childNodes).filter((n) => !(n instanceof HTMLElement && (n.hidden || n.tagName === "BUTTON"))).map((n) => n.textContent).join("");
    expect(shown().trim()).toBe("Warren E. Buffett, Geico Corp, General Re Corp, National Indemnity Co");
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveTextContent("Show fewer");
    expect(shown().trim()).toBe("Warren E. Buffett, Geico Corp, General Re Corp, National Indemnity Co, BH Finance LLC, Columbia Insurance Co");
    expect(document.getElementById(more.getAttribute("aria-controls")!)).not.toHaveAttribute("hidden");
  });

  test("the CIK links to EDGAR's 13F-HR list, in a new tab, and says so", () => {
    render(<AboutPanel summary={withAbout(ABOUT)} />);
    const link = screen.getByRole("link", { name: `${demo.cik} (EDGAR filings, opens in a new tab)` });
    expect(link).toHaveAttribute("href", `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${demo.cik}&type=13F-HR`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("only the rows that are known; four managers or fewer have no button", () => {
    render(
      <AboutPanel
        summary={withAbout({ ...ABOUT, street: null, city: null, state: null, signer: null, signer_title: null, signed: null, other_managers: ["A B LLC"], incorporated: null, former_names: [] })}
      />,
    );
    expect(rows().map((r) => r[0])).toEqual(["Other managers in the report", "SEC CIK"]);
    expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
    expect(document.querySelector(".ab-d")?.textContent).toMatch(/^Kelpwood Capital LP is an institutional investment manager\. The SEC/);
  });

  test.each([null, undefined])("no SEC details (%s): the panel says so", (about) => {
    render(<AboutPanel summary={withAbout(about)} />);
    expect(screen.getByRole("region", { name: "About" })).toHaveTextContent("No SEC details yet");
    expect(document.querySelector("dl")).toBeNull();
    expect(document.body.textContent).not.toMatch(/null|undefined|NaN/);
  });
});
