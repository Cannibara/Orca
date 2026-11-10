"""The Model tab (spec 3.2), written top to bottom from the block registry (`layout.MODEL_ROWS`),
so every formula comes from `layout` and none from here: notes, header rows, block index, fund
inputs, stock input blocks, stock calculation blocks, fund rows, year rows, and last Orca's
figures (inputs) with their difference rows and blocks, which the checks table reads."""

from dataclasses import dataclass

from xlsxwriter.worksheet import Worksheet

from orca.quarters import BASE_YEAR, q_end, q_label
from orca.workbook.inputs import FundInputs
from orca.workbook.layout import (
    BY_ID,
    HEADER_ROWS,
    LABEL_COLUMNS,
    MODEL_ROWS,
    OTHER_ROWS,
    WHOLE,
    Block,
    Columns,
    Ref,
    Rows,
    col_letter,
    mid_quarter,
    year_formula,
)
from orca.workbook.sheet import Formats, TabWriter

OTHER_STOCK = -1  # the stock id `cell_of` takes for the "All other positions" row
OTHER_NAME = "All other positions"
HOW_IT_WORKS = "https://www.orcaetf.com/how-it-works"
DISCLAIMER = "Estimates from SEC 13F filings, not the fund's real returns. Not investment advice."
LABELS = tuple(name.lower() for name in LABEL_COLUMNS)  # columns A-E, for `cell_of`
LABEL_WIDTHS = (34, 10, 32, 9, 8)
_SECTIONS = {
    "fund_input": "Fund inputs",
    "fund": "Fund rows",
    "year_only": "Year rows",
    "orca": "Orca's figures and the differences (the checks table reads these)",
}
_SECTION_OF = {"check": "orca"}  # difference rows sit with Orca's figures
_WIDTHS = {"year": 13, "gap": 2, "quarter": 13}


@dataclass(frozen=True)
class ModelMap:
    """Where everything is on one fund's Model tab: the columns, the row of every block
    (`rows`, 1-based), each section's and stock block's title row (`titles`), the first row
    below the frozen header rows (`freeze`) and the lines to write, top to bottom (`lines`:
    (row, what, key))."""

    cols: Columns
    rows: Rows
    stock_offset: dict[int, int]  # stock_id -> its row in a stock block (0 = the first)
    titles: dict[str, int]
    freeze: int
    last_row: int
    lines: tuple[tuple[int, str, str], ...]

    def column(self, column: int | str) -> int:
        """The 0-based column of a quarter `q` (int), a year ("2015"), "before", "latest",
        "gap", or a label column ("name", "ticker", "company", "stock id", "units")."""
        if isinstance(column, int):
            return self.cols.quarter_index(column)
        key = column.lower()
        if key in ("before", "latest", "gap"):
            return getattr(self.cols, f"{key}_index")
        if key in LABELS:
            return LABELS.index(key)
        if key.isdigit():
            return self.cols.year_index(int(key))
        raise KeyError(f"no column {column!r}")

    def row(self, block_id: str, stock_id: int | None = None) -> int:
        """The 1-based row of a single row, or of stock `stock_id` in a stock block
        (OTHER_STOCK for its "All other positions" row)."""
        if not BY_ID[block_id].per_stock:
            if stock_id is not None:
                raise ValueError(f"{block_id} is not a stock block")
            return self.rows.row(block_id)
        if stock_id is None:
            raise ValueError(f"{block_id} is a stock block: give a stock id")
        offset = self.rows.stocks if stock_id == OTHER_STOCK else self.stock_offset[stock_id]
        return self.rows.row(block_id, offset)

    def cell(self, block_id: str, stock_id: int | None, column: int | str) -> str:
        return f"{col_letter(self.column(column))}{self.row(block_id, stock_id)}"

    def span(self, block_id: str, where: str, stocks: bool = False) -> str:
        """Row (or with `stocks`, every stock row of block) `block_id` over the tracked quarter
        columns ("q", start..end_q) or the year columns ("y"), as an A1 range."""
        cols = self.cols
        if where == "q":
            first, last = cols.first_q, cols.quarter(cols.end_q)
        else:
            first, last = cols.year(cols.years[0]), cols.year(cols.years[-1])
        if stocks:
            top = self.rows.row(block_id, 0)
            bottom = top + self.rows.stocks - 1
        else:
            top = bottom = self.rows.row(block_id)
        return f"{first}{top}:{last}{bottom}"


def model_map(fi: FundInputs) -> ModelMap:
    """The Model layout of `fi`, planned afresh (nothing is cached between calls): a caller
    that looks up many cells keeps the map."""
    return _plan(fi)


def notes(fi: FundInputs) -> list[str]:
    """The notes block (spec 3.2); the last line is the link to the method page."""
    kept = sum(o.from_q is not None for o in fi.orca_stocks)  # positions with their own rows
    if fi.other is None:
        cut = "Nothing is cut: every stock the fund filed in its tracked period has its own rows."
    else:
        cut = (
            f"Cut: of the fund's {kept + fi.other.count} positions, the {kept} with the highest "
            f"peak value have their own rows; the other {fi.other.count} are one "
            f'"{OTHER_NAME}" row of Orca\'s own sums.'
        )
    return [
        f"{fi.name} · fund id {fi.fund_id} · CIK {fi.cik}",
        f"Data date {fi.latest_date.isoformat()} (latest prices); latest quarter filed "
        f"{q_label(fi.period_q)}, filed {fi.filed.isoformat()}.",
        DISCLAIMER,
        "How to read this tab: inputs are blue, formulas black, formulas that read another tab "
        "green. Years are on the left, quarters on the right.",
        cut,
        f"How it works: {HOW_IT_WORKS}",
    ]


def _section(b: Block) -> str:
    return _SECTION_OF.get(b.kind, b.kind)


def _plan(fi: FundInputs) -> ModelMap:
    """Every Model line in order: notes, header rows (frozen above the first block), the block
    index, then each section and stock block after a blank line and a title line."""
    cols, cut, n = Columns.for_inputs(fi), fi.other is not None, len(fi.stocks)
    lines: list[tuple[int, str, str]] = []
    first: dict[str, int] = {}
    titles: dict[str, int] = {}
    row = 1

    def line(what: str, key: str = "") -> int:
        nonlocal row
        lines.append((row, what, key))
        row += 1
        return row - 1

    for i in range(len(notes(fi))):
        line("note", str(i))
    for b in HEADER_ROWS:
        first[b.id] = line("single", b.id)
    freeze = row

    body = [b for b in MODEL_ROWS[len(HEADER_ROWS) :] if cut or not b.cut_only]
    entries = []  # the index: each section, and each stock block
    for b in body:
        key = b.id if b.per_stock else _section(b)
        if key not in entries:
            entries.append(key)
    line("index_title")
    for key in entries:
        line("index", key)

    section = None
    for b in body:
        if b.per_stock:
            line("blank")
            titles[b.id] = line("block_title", b.id)
            first[b.id] = row
            for i in range(n):
                line("stock", f"{b.id}:{i}")
            if cut and b.id in OTHER_ROWS:
                line("other", b.id)
            section = None
            continue
        if _section(b) != section:
            section = _section(b)
            line("blank")
            titles[section] = line("section_title", section)
        first[b.id] = line("single", b.id)

    offsets = {st.stock_id: i for i, st in enumerate(fi.stocks)}
    rows = Rows(first, n, cut)
    return ModelMap(cols, rows, offsets, titles, freeze, row - 1, tuple(lines))


class ModelWriter(TabWriter):
    """Writes the Model lines in order (constant memory: a row is final once the next starts)."""

    def __init__(self, ws: Worksheet, fmt: Formats, fi: FundInputs, m: ModelMap) -> None:
        super().__init__(ws, fmt)
        self.fi, self.m = fi, m
        self.cols, self.rows = m.cols, m.rows
        self.notes = notes(fi)
        tracked = [q for q in fi.quarters if q <= fi.end_q]
        self.tracked = [(q, self.cols.quarter_index(q)) for q in tracked]
        self.all_q = [(q, self.cols.quarter_index(q)) for q in fi.quarters]
        self.after = [col for q, col in self.all_q if q > fi.end_q]  # end_q + 1 .. bound
        self.year_cols = [self.cols.year_index(y) for y in self.cols.years]

    def labels(self, row: int, name: str, units: str, stock: int | None = None) -> None:
        """Columns A-E: row name, ticker, company, stock id, units."""
        self.text(row, 0, name)
        if stock is not None and stock < self.rows.stocks:
            st = self.fi.stocks[stock]
            self.text(row, 1, st.ticker)
            self.text(row, 2, st.name)
            self.ws.write_number(self.at(row), 3, st.stock_id, self.fmt(WHOLE))
        elif stock is not None:
            self.text(row, 2, OTHER_NAME)
        if units:
            self.text(row, 4, units)

    # the tab

    def write(self) -> None:
        ws, cols = self.ws, self.cols
        for i, width in enumerate(LABEL_WIDTHS):
            ws.set_column(i, i, width)
        if cols.years:
            ws.set_column(self.year_cols[0], self.year_cols[-1], _WIDTHS["year"])
        ws.set_column(cols.gap_index, cols.gap_index, _WIDTHS["gap"])
        ws.set_column(cols.before_index, cols.latest_index, _WIDTHS["quarter"])
        ws.freeze_panes(self.m.freeze - 1, len(LABEL_WIDTHS))  # below the header rows, at F
        for row, what, key in self.m.lines:
            getattr(self, f"_{what}")(row, key)

    def _note(self, row: int, key: str) -> None:
        i = int(key)
        if i == len(self.notes) - 1:
            self.url(row, 0, HOW_IT_WORKS, self.notes[i])
        elif i == 0:
            self.bold(row, 0, self.notes[i], font_size=13)
        else:
            self.text(row, 0, self.notes[i])

    def _blank(self, row: int, key: str) -> None:
        pass

    def _index_title(self, row: int, key: str) -> None:
        self.bold(row, 0, "Blocks (click to go there)")

    def _index(self, row: int, key: str) -> None:
        target = self.m.titles[key]
        name = _SECTIONS.get(key) or f"{key} {BY_ID[key].name}"
        self.url(row, 0, f"internal:'Model'!A{target}", name)

    def _section_title(self, row: int, key: str) -> None:
        self.bold(row, 0, _SECTIONS[key])

    def _block_title(self, row: int, key: str) -> None:
        self.bold(row, 0, f"{key} {BY_ID[key].name}")

    def _single(self, row: int, key: str) -> None:
        b = BY_ID[key]
        self.labels(row, b.name, b.units)
        if b.kind == "header":
            self._header(row, b)
        elif b.kind == "fund_input":
            values = _source(self.fi, b.source)
            for (q, col), value in zip(self.all_q, values, strict=True):
                self.input_cell(row, col, value, b.number_format)
        elif b.kind == "orca":  # the engine's quarter and year figures, where it has them
            quarters = self.fi.orca.quarters.get(b.source)
            years = self.fi.orca.years.get(b.source)
            for (q, col), value in zip(self.all_q, quarters or [], strict=quarters is not None):
                if q <= self.fi.end_q:
                    self.input_cell(row, col, value, b.number_format)
            for col, value in zip(self.year_cols, years or [], strict=years is not None):
                self.input_cell(row, col, value, b.number_format)
        elif b.kind in ("fund", "check"):
            self._before(row, b, 0)
            if b.formula is not None:
                for _, col in self.tracked:
                    ref = Ref(self.cols, self.rows, col)
                    self.formula(row, col, b.formula(ref), b.number_format)
        if b.kind == "year_only":
            for col in self.year_cols:
                self.formula(row, col, b.formula(Ref(self.cols, self.rows, col)), b.number_format)
        else:
            self._years(row, b, 0)

    def _header(self, row: int, b: Block) -> None:
        fi, cols = self.fi, self.cols
        for q, col in self.all_q:
            self.input_cell(row, col, _header_value(fi, b.id, q), b.number_format)
        if b.id == "label":  # the label columns' titles, and the Before and Latest columns'
            for i, title in enumerate(LABEL_COLUMNS[1:], start=1):
                self.text(row, i, title, self.fmt(italic=True, font_color="#808080"))
            self.input_cell(row, cols.before_index, "Before", b.number_format)
            self.input_cell(row, cols.latest_index, "Latest", b.number_format)
        if b.latest == "latest_date":
            self.input_cell(row, cols.latest_index, fi.latest_date, b.number_format)

    def _stock(self, row: int, key: str) -> None:
        block_id, i = key.split(":")
        b, stock = BY_ID[block_id], int(i)
        self.labels(row, b.id, b.units, stock)
        if b.kind == "input":
            st = self.fi.stocks[stock]
            for (q, col), value in zip(self.all_q, getattr(st, b.source), strict=True):
                self.input_cell(row, col, value, b.number_format)
            if isinstance(b.before, str):
                self.input_cell(row, self.cols.before_index, getattr(st, b.before), b.number_format)
            if isinstance(b.latest, str):
                self.input_cell(row, self.cols.latest_index, getattr(st, b.latest), b.number_format)
        elif b.kind == "orca":  # the engine's figure per calendar year (contributions)
            by_year = getattr(self.fi.orca_stocks[stock], b.source)
            for year, col in zip(self.cols.years, self.year_cols, strict=True):
                self.input_cell(row, col, by_year.get(year), b.number_format)
        elif b.kind in ("calc", "check"):
            self._before(row, b, stock)
            if b.formula is not None:
                for _, col in self.tracked:
                    ref = Ref(self.cols, self.rows, col, stock)
                    self.formula(row, col, b.formula(ref), b.number_format)
            if b.after_end is not None:  # the cash flows after the last filing: a written 0
                for col in self.after:
                    self.number(row, col, b.after_end, b.number_format)
            if callable(b.latest):
                ref = Ref(self.cols, self.rows, self.cols.latest_index, stock)
                self.formula(row, self.cols.latest_index, b.latest(ref), b.number_format)
        if b.kind == "year_only":
            for col in self.year_cols:
                ref = Ref(self.cols, self.rows, col, stock)
                self.formula(row, col, b.formula(ref), b.number_format)
        else:
            self._years(row, b, stock)

    def _other(self, row: int, key: str) -> None:
        """The "All other positions" row of a cut fund: Orca's sums as inputs (the input block
        to bound, a calculation block to end_q), or the block's own template for it."""
        b, stock = BY_ID[key], self.rows.stocks
        self.labels(row, b.id, b.units, stock)
        if isinstance(b.other, str):
            values = getattr(self.fi.other, b.other)
            columns = self.all_q if b.kind == "input" else self.tracked
            for q, col in columns:
                self.input_cell(row, col, values[q - self.fi.start], b.number_format)
        else:
            columns = self.year_cols if b.kind == "year_only" else [c for _, c in self.tracked]
            for col in columns:
                ref = Ref(self.cols, self.rows, col, stock)
                self.formula(row, col, b.other(ref), b.number_format)
        if b.kind != "year_only":
            self._years(row, b, stock)

    def _before(self, row: int, b: Block, stock: int) -> None:
        col = self.cols.before_index
        if isinstance(b.before, float):  # a starting value written by the builder: an input
            self.number(row, col, b.before, b.number_format)
        elif callable(b.before):
            self.formula(row, col, b.before(Ref(self.cols, self.rows, col, stock)), b.number_format)

    def _years(self, row: int, b: Block, stock: int) -> None:
        for col in self.year_cols:
            text = year_formula(b, Ref(self.cols, self.rows, col, stock))
            if text is not None:
                self.formula(row, col, text, b.number_format)


def _source(fi: FundInputs, source: str) -> list:
    """A fund input row's values: a FundInputs list, or "other.<field>" of the cut's sums."""
    if source.startswith("other."):
        return getattr(fi.other, source.removeprefix("other."))
    return getattr(fi, source)


def _header_value(fi: FundInputs, row_id: str, q: int) -> object:
    """A header row's quarter cell (spec 3.2): written by the builder, an input."""
    if row_id == "quarter":
        return q
    if row_id == "label":
        return q_label(q)
    if row_id == "year":
        return BASE_YEAR + q // 4
    if row_id == "quarter_end":
        return q_end(q)
    if row_id == "mid_quarter":
        return mid_quarter(q)
    if row_id == "first_tracked":
        return int(q == fi.start)
    if row_id == "held_through":
        return int(q <= fi.end_q)
    raise KeyError(f"no header row {row_id!r}")
