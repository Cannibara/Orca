import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Chips } from "../src/components/Chips";
import { DataTable, type Column } from "../src/components/DataTable";
import { Signed } from "../src/components/Signed";
import { Tabs, tabPanelProps } from "../src/components/Tabs";

type Row = { name: string; n: number };
const columns: Column<Row>[] = [
  { header: "Name", key: "name", align: "l", cell: (r) => r.name },
  { header: "Count", key: "n", cell: (r) => r.n },
  { header: "Note", cell: () => "x" },
];
const rows: Row[] = [
  { name: "alpha", n: 3 },
  { name: "beta", n: 1 },
];

describe("DataTable", () => {
  it("renders headers and cells, left-aligning only the columns that ask for it", () => {
    render(<DataTable columns={columns} rows={rows} label="Demo rows" />);
    const table = screen.getByRole("table", { name: "Demo rows" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Count", "Note"]);
    const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells.map((c) => c.textContent)).toEqual(["alpha", "3", "x"]);
    expect(cells.map((c) => c.classList.contains("l"))).toEqual([true, false, false]);
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveClass("l");
    expect(screen.getByRole("columnheader", { name: "Count" })).not.toHaveClass("l");
  });

  it("scrolls inside its own container", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap).toHaveClass("tbl-wrap");
    expect(wrap.querySelector("table")).not.toBeNull();
  });

  it("says so when there are no rows", () => {
    render(<DataTable columns={columns} rows={[]} empty="No exits yet." />);
    const cell = screen.getByText("No exits yet.");
    expect(cell).toHaveAttribute("colspan", "3");
  });

  it("makes a header sortable only when it has a key and onSort is given", async () => {
    const onSort = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<DataTable columns={columns} rows={rows} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    rerender(<DataTable columns={columns} rows={rows} sort={{ key: "n", dir: -1 }} onSort={onSort} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Name", "Count"]); // "Note" has no key
    expect(screen.getByRole("button", { name: "Count" })).toHaveAttribute("data-dir", "↓");
    expect(screen.getByRole("button", { name: "Name" })).not.toHaveAttribute("data-dir");
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute("aria-sort");

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenCalledWith("name");

    rerender(<DataTable columns={columns} rows={rows} sort={{ key: "n", dir: 1 }} onSort={onSort} />);
    expect(screen.getByRole("button", { name: "Count" })).toHaveAttribute("data-dir", "↑");
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("opens a row on click and on Enter or Space, but not when a link inside it is used", async () => {
    const onRow = vi.fn();
    const user = userEvent.setup();
    const linkCols: Column<Row>[] = [
      { header: "Name", align: "l", cell: (r) => <a href={`#${r.name}`}>{r.name}</a> },
      { header: "Count", cell: (r) => r.n },
    ];
    render(<DataTable columns={linkCols} rows={rows} onRow={onRow} />);
    const [first, second] = screen.getAllByRole("row").slice(1);
    expect(first).toHaveAttribute("tabindex", "0");
    expect(first).toHaveClass("click");

    await user.click(within(first).getByText("3"));
    expect(onRow).toHaveBeenLastCalledWith(rows[0]);

    second.focus();
    await user.keyboard("{Enter}");
    expect(onRow).toHaveBeenLastCalledWith(rows[1]);
    await user.keyboard(" ");
    expect(onRow).toHaveBeenCalledTimes(3);

    onRow.mockClear();
    await user.click(within(first).getByRole("link", { name: "alpha" }));
    within(second).getByRole("link", { name: "beta" }).focus();
    await user.keyboard("{Enter}");
    expect(onRow).not.toHaveBeenCalled();
  });

  it("rows are plain when onRow is not given", () => {
    render(<DataTable columns={columns} rows={rows} />);
    const row = screen.getAllByRole("row")[1];
    expect(row).not.toHaveAttribute("tabindex");
    expect(row).not.toHaveClass("click");
  });

  describe("virtual", () => {
    const many: Row[] = Array.from({ length: 2000 }, (_, i) => ({ name: `row ${i}`, n: i }));

    it("renders a window of rows, not all 2,000 and not none", () => {
      render(<DataTable columns={columns} rows={many} virtual />);
      const body = screen.getAllByRole("row").slice(1); // spacer rows are aria-hidden, so not counted
      expect(body.length).toBeGreaterThan(0);
      expect(body.length).toBeLessThan(100);
      expect(screen.getByText("row 0")).toBeInTheDocument();
      expect(screen.queryByText("row 1999")).not.toBeInTheDocument();
      expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "2001");
      expect(body[0]).toHaveAttribute("aria-rowindex", "2");
    });

    it("renders different rows after scrolling", () => {
      const { container, unmount } = render(<DataTable columns={columns} rows={many} virtual />);
      const scroller = container.firstElementChild as HTMLElement;
      expect(scroller).toHaveClass("virtual");
      fireEvent.scroll(scroller, { target: { scrollTop: 40 * 1000 } });
      expect(screen.getByText("row 1000")).toBeInTheDocument();
      expect(screen.queryByText("row 0")).not.toBeInTheDocument();
      unmount(); // before the virtualizer's scroll-idle timer fires
    });

    it("keeps the full height with spacer rows so the scrollbar is the right size", () => {
      render(<DataTable columns={columns} rows={many} virtual />);
      const spacers = screen.getAllByRole("row", { hidden: true }).filter((r) => r.getAttribute("aria-hidden") === "true");
      expect(spacers).toHaveLength(1); // at the top there is only a bottom spacer
      expect(parseInt(spacers[0].style.height, 10)).toBeGreaterThan(40 * 1900);
    });

    it("falls back to the plain table when virtual is off", () => {
      render(<DataTable columns={columns} rows={many.slice(0, 150)} />);
      expect(screen.getAllByRole("row")).toHaveLength(151);
    });
  });

  describe("column widths of a virtual table", () => {
    // jsdom has no layout, so model the auto layout: a header is as wide as its widest visible cell
    // (10 px a character).
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        if (this.tagName !== "TH") return 0;
        const i = Array.from(this.parentElement!.children).indexOf(this);
        const cells = Array.from(
          this.closest("table")!.querySelectorAll<HTMLElement>(`tbody tr:not([aria-hidden]) td:nth-child(${i + 1})`),
        );
        return 10 * Math.max(this.textContent!.length, ...cells.map((c) => c.textContent!.length));
      });
    });
    afterEach(() => vi.restoreAllMocks());

    // rows 0-999 have a one-letter name, the rest a long one
    const names = (long: string): Row[] => Array.from({ length: 2000 }, (_, i) => ({ name: i < 1000 ? "s" : long, n: i }));
    const pinned = () =>
      Array.from(document.querySelectorAll<HTMLElement>("thead th")).map((th) => th.style.minWidth);

    it("pins each column at the widest it has shown while scrolling, and never narrower", () => {
      const rows = names("a long name");
      const { container, unmount } = render(<DataTable columns={columns} rows={rows} virtual />);
      expect(pinned()).toEqual(["40px", "50px", "40px"]);
      const scroller = container.firstElementChild as HTMLElement;
      fireEvent.scroll(scroller, { target: { scrollTop: 40 * 1500 } });
      expect(pinned()).toEqual(["110px", "50px", "40px"]);
      fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
      expect(screen.getAllByText("s", { selector: "td" }).length).toBeGreaterThan(0); // back among the short names
      expect(pinned()).toEqual(["110px", "50px", "40px"]);
      unmount(); // before the virtualizer's scroll-idle timer fires
    });

    it("starts again from what is measured when the columns change", () => {
      const rows = names("a long name");
      const { rerender } = render(<DataTable columns={columns} rows={rows} virtual />);
      expect(pinned()).toEqual(["40px", "50px", "40px"]);
      const other: Column<Row>[] = [
        { header: "Ab", key: "name", align: "l", cell: (r) => r.name },
        { header: "Cd", key: "n", cell: (r) => r.n },
      ];
      rerender(<DataTable columns={other} rows={rows} virtual />);
      expect(pinned()).toEqual(["20px", "20px"]); // narrower than before; no pin of the old table is left
    });

    it("starts again from what is measured when the rows change", () => {
      const { container, rerender, unmount } = render(<DataTable columns={columns} rows={names("a long name")} virtual />);
      const scroller = container.firstElementChild as HTMLElement;
      fireEvent.scroll(scroller, { target: { scrollTop: 40 * 1500 } });
      fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
      expect(pinned()[0]).toBe("110px"); // same rows: the pin stays
      // a new row set (a filter or a sort): the widest cell is no longer among them
      rerender(<DataTable columns={columns} rows={names("a long name").slice(0, 900)} virtual />);
      expect(pinned()[0]).toBe("40px");
      unmount();
    });

    it("leaves no pins behind once the table is not virtual", () => {
      const rows = names("a long name");
      const { rerender } = render(<DataTable columns={columns} rows={rows} virtual />);
      expect(pinned()[0]).toBe("40px");
      rerender(<DataTable columns={columns} rows={rows} />);
      expect(pinned()).toEqual(["", "", ""]);
    });
  });
});

describe("Signed", () => {
  it("colours a figure by its sign", () => {
    render(
      <>
        <Signed v={5}>gain</Signed>
        <Signed v={-5}>loss</Signed>
        <Signed v={0}>flat</Signed>
        <Signed v={null}>none</Signed>
      </>,
    );
    expect(screen.getByText("gain")).toHaveClass("up");
    expect(screen.getByText("loss")).toHaveClass("down");
    expect(screen.getByText("flat")).not.toHaveAttribute("class");
    expect(screen.getByText("none")).not.toHaveAttribute("class");
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ];
  function Harness() {
    const [value, setValue] = useState("a");
    return (
      <>
        <Tabs tabs={tabs} value={value} onChange={setValue} label="Letters" idPrefix="t" />
        <div {...tabPanelProps("t", value)}>panel {value}</div>
      </>
    );
  }

  it("marks the selected tab, links it to its panel and switches on click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Letters" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Alpha");
    await user.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel b");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Beta");
  });

  it("moves with the arrow keys, Home and End, wrapping around", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("tab", { name: "Alpha" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Gamma" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    // only the selected tab is in the tab order
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });
});

describe("Chips", () => {
  it("shows which chip is pressed and reports a change", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Chips
        label="Period"
        options={[
          { id: "1y", label: "1 year" },
          { id: "3y", label: "3 years" },
        ]}
        value="3y"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 years" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1 year" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "1 year" }));
    expect(onChange).toHaveBeenCalledWith("1y");
  });
});
