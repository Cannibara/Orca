import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { StockPanel } from "../src/fund/StockPanel";
import type { PosRow } from "../src/fund/positions";

vi.mock("../src/fund/usePositionData", () => ({
  useWeekly: () => ({ start: "2013-01-04", close: Array.from({ length: 600 }, (_, i) => 20 + (i % 50)) }),
}));

// Q1 2018 = 20: buy 1,000; Q1 2019 = 24: sell 250 (25% of 1,000); Q1 2020 = 28: sell the other 750.
const trades = [
  { q: 20, delta: 1000, px: 30, sharesAfter: 1000 },
  { q: 24, delta: -250, px: 35, sharesAfter: 750 },
  { q: 28, delta: -750, px: 40, sharesAfter: 0 },
];
const row = { id: 5, ticker: "ABC", name: "Abc Corp", from: 20, to: 28, pos: { trades } } as unknown as PosRow;

function renderPanel() {
  return render(
    <MemoryRouter>
      <StockPanel row={row} fundId={1} width={700} latestPrice={50} />
    </MemoryRouter>,
  );
}

describe("StockPanel", () => {
  it("labels each sale on the chart with the % of the shares held the quarter before", () => {
    const { container } = renderPanel();
    expect(Array.from(container.querySelectorAll("text.cut")).map((t) => t.textContent)).toEqual(["−25%", "−100%"]);
    expect(screen.getByText(/shares sold, as % of those held at the end of the quarter before/)).toBeInTheDocument();
  });

  it("shows the action as a filled box: blue for a buy, grey for a trim and for selling all", () => {
    renderPanel();
    const table = screen.getByRole("table");
    const box = (word: string) => within(table).getByText(word);
    expect(box("New")).toHaveClass("st", "add");
    expect(box("Trimmed")).toHaveClass("st", "sold");
    expect(box("Sold all")).toHaveClass("st", "sold");
  });
});
