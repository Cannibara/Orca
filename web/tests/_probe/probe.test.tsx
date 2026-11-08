import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "../../src/charts/Tooltip";
import { clearDataCache } from "../../src/data/api";
import Fund from "../../src/pages/Fund";

const DEMO = join(dirname(fileURLToPath(import.meta.url)), "../../public/demo-data");
test("probe", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.replace(/^\/demo-data\//, "");
    if (!existsSync(join(DEMO, path))) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(DEMO, path), "utf8")) };
  }));
  clearDataCache();
  render(<TooltipProvider><MemoryRouter initialEntries={["/fund/9100001"]}><Routes><Route path="/fund/:id" element={<Fund />} /></Routes></MemoryRouter></TooltipProvider>);
  await screen.findByRole("heading", { level: 1, name: "Kelpwood Capital LP" });
  const t = document.querySelector("#posPanel table") as HTMLElement;
  console.log("POSTABLE", t.getAttribute("aria-label"), t.querySelectorAll("tbody tr").length);
  console.log(Array.from(t.querySelectorAll("thead th")).map((h) => h.textContent).join("|"));
  console.log(Array.from(t.querySelectorAll("tbody tr")).slice(0, 3).map((r) => r.textContent).join("\n"));
  console.log(document.querySelector("#posPanel")?.querySelector(".ps, .sub, p")?.textContent);
  console.log(Array.from(document.querySelectorAll("#posPanel p")).map((p) => p.textContent).join("\n"));
  console.log(document.querySelector(".fh .meta")?.textContent);
  console.log(Array.from(document.querySelectorAll('[role=tab]')).map((p) => p.textContent).join("|"));
  console.log("MORE", document.querySelector('section[aria-labelledby="fund-more"]')?.textContent);
  console.log("KPIS", Array.from(document.querySelectorAll(".kpi")).map((k) => k.textContent).join("\n"));
  const w = document.querySelector('table[aria-label="Sold or trimmed stocks"]') as HTMLElement;
  console.log("WHATIF", w.querySelectorAll("tbody tr").length, Array.from(w.querySelectorAll("tbody tr")).slice(0,2).map((r) => r.textContent).join("\n"));
  console.log("ALL", document.body.textContent?.match(/NaN|undefined|null|Infinity/g));
});
