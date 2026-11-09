import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Choice } from "../src/components/Choice";
import { DataTable, type Column } from "../src/components/DataTable";
import { Pager } from "../src/components/Pager";
import { Panel } from "../src/components/Panel";
import { Signed } from "../src/components/Signed";
import { State } from "../src/components/State";
import { Tile } from "../src/components/Tiles";
import { money, pct, pp } from "../src/lib/format";
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

  it("draws a chevron on the sorted heading only", () => {
    const { rerender } = render(<DataTable columns={columns} rows={rows} sort={{ key: "n", dir: -1 }} onSort={vi.fn()} />);
    const chevron = (name: string) => screen.getByRole("button", { name }).querySelector("svg.ico");
    expect(chevron("Count")).not.toBeNull();
    expect(chevron("Name")).toBeNull();
    expect(chevron("Count")!.querySelector("path")).toHaveAttribute("d", "M4 6.25 8 10.25l4-4"); // down: largest first
    rerender(<DataTable columns={columns} rows={rows} sort={{ key: "n", dir: 1 }} onSort={vi.fn()} />);
    expect(chevron("Count")!.querySelector("path")).toHaveAttribute("d", "M4 9.75l4-4 4 4"); // up: smallest first
    expect(chevron("Count")).toHaveAttribute("aria-hidden", "true");
  });

  it("is a focusable, named region so the keyboard can scroll it sideways", () => {
    render(<DataTable columns={columns} rows={rows} label="Demo rows" />);
    const region = screen.getByRole("region", { name: "Demo rows, scrollable" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table", { name: "Demo rows" })).toBeInTheDocument();
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
      fireEvent.scroll(scroller, { target: { scrollTop: 38 * 1000 } });
      expect(screen.getByText("row 1000")).toBeInTheDocument();
      expect(screen.queryByText("row 0")).not.toBeInTheDocument();
      unmount(); // before the virtualizer's scroll-idle timer fires
    });

    it("keeps the full height with spacer rows so the scrollbar is the right size", () => {
      render(<DataTable columns={columns} rows={many} virtual />);
      const spacers = screen.getAllByRole("row", { hidden: true }).filter((r) => r.getAttribute("aria-hidden") === "true");
      expect(spacers).toHaveLength(1); // at the top there is only a bottom spacer
      expect(parseInt(spacers[0].style.height, 10)).toBeGreaterThan(38 * 1900);
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
      fireEvent.scroll(scroller, { target: { scrollTop: 38 * 1500 } });
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
      fireEvent.scroll(scroller, { target: { scrollTop: 38 * 1500 } });
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

describe("Signed and Tile colour what is printed", () => {
  it("leaves a figure that prints as zero uncoloured, whatever its sign before rounding", () => {
    render(
      <>
        <Signed v={-0.4}>{money(-0.4, true)}</Signed>
        <Signed v={-0.0001}>{pct(-0.0001, 0)}</Signed>
        <Signed v={0.04}>{pp(0.04)}</Signed>
        <Signed v={-0.6}>{money(-0.6, true)}</Signed>
        <Signed v={-0.0006}>{pct(-0.0006)}</Signed>
      </>,
    );
    expect(screen.getByText("$0")).not.toHaveAttribute("class");
    expect(screen.getByText("0%")).not.toHaveAttribute("class");
    expect(screen.getByText("0.0 pts")).not.toHaveAttribute("class");
    expect(screen.getByText("−$1")).toHaveClass("down");
    expect(screen.getByText("−0.1%")).toHaveClass("down");
  });

  it("colours a tile's value by its tone, except a value that prints as zero", () => {
    render(
      <>
        <Tile label="Early" value="$0" tone="down" />
        <Tile label="Dodged" value="$1.2M" tone="up" />
        <Tile label="Flat" value="0.0%" tone="up" />
        <Tile label="Plain" value="$5" />
      </>,
    );
    const value = (label: string) => screen.getByText(label).parentElement!.querySelector(".v")!;
    expect(value("Early")).not.toHaveClass("down");
    expect(value("Early")).toHaveAttribute("class", "v");
    expect(value("Dodged")).toHaveClass("v", "up");
    expect(value("Flat")).toHaveAttribute("class", "v");
    expect(value("Plain")).toHaveAttribute("class", "v");
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

  it("keeps a sliding bar under the strip that is not itself a tab", () => {
    const { container } = render(<Harness />);
    const bar = container.querySelector(".tabs .ind");
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
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

describe("Choice", () => {
  it("shows which option is pressed and reports a change", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Choice
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

describe("Panel", () => {
  it("is a region named by its title, with the subtitle and controls in its head", () => {
    render(
      <Panel title="Top funds" subtitle="Best first." controls={<button type="button">Go</button>}>
        <p>body</p>
      </Panel>,
    );
    const panel = screen.getByRole("region", { name: "Top funds" });
    expect(within(panel).getByRole("heading", { level: 2, name: "Top funds" })).toHaveClass("pt");
    expect(within(panel).getByText("Best first.")).toHaveClass("ps");
    expect(within(panel).getByRole("button", { name: "Go" }).closest(".ph-c")).not.toBeNull();
    expect(within(panel).getByText("body")).toBeInTheDocument();
  });

  it("leaves out the subtitle and the controls when there are none", () => {
    const { container } = render(<Panel title="Plain">x</Panel>);
    expect(container.querySelector(".ps")).toBeNull();
    expect(container.querySelector(".ph-c")).toBeNull();
  });
});

describe("State", () => {
  it("is plain for an empty list and an alert for an error", () => {
    const { rerender } = render(<State>Nothing here.</State>);
    expect(screen.getByText("Nothing here.").closest(".state")).not.toHaveClass("err");
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(
      <State kind="error" title="Couldn't load">
        Try again.
      </State>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("state", "err");
    expect(alert).toHaveTextContent("Couldn't load");
    expect(alert).toHaveTextContent("Try again.");
  });
});

describe("Pager", () => {
  it("says which rows are shown, pages with Previous and Next, and is absent for an empty list", async () => {
    const onPage = vi.fn();
    const user = userEvent.setup();
    const { rerender, container } = render(<Pager page={1} pageSize={100} total={250} onPage={onPage} noun="funds" />);
    expect(screen.getByRole("navigation", { name: "Pages of funds" })).toHaveTextContent("Showing 101–200 of 250 funds");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenLastCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPage).toHaveBeenLastCalledWith(0);
    rerender(<Pager page={2} pageSize={100} total={250} onPage={onPage} noun="funds" />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    rerender(<Pager page={0} pageSize={100} total={0} onPage={onPage} noun="funds" />);
    expect(container).toBeEmptyDOMElement();
  });
});
