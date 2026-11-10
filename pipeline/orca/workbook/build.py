"""The fund workbook builder: FundInputs -> .xlsx with xlsxwriter (constant memory), tabs Model,
Outputs and Summary (spec 3). Model is written top to bottom from the block registry
(`layout.MODEL_ROWS`), so every formula comes from `layout` and none from here: notes, header
rows, block index, fund inputs, stock input blocks, stock calculation blocks, fund rows, year
rows. Outputs and Summary are created empty (Task 7 fills them).

The file stores no values (spec 3.1, 11): xlsxwriter always writes a result after a formula, so
every formula is written with an empty result and the saved file is rewritten without it. The
workbook asks for a full calculation on load, so Excel, LibreOffice, Google Sheets and Numbers
compute every figure from the inputs when the file is opened."""

import os
import re
import time
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import xlsxwriter
from xlsxwriter.format import Format
from xlsxwriter.worksheet import Worksheet

from orca.quarters import BASE_YEAR, q_end, q_label
from orca.workbook.inputs import FundInputs
from orca.workbook.layout import (
    BY_ID,
    DATE,
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

TABS = ("Model", "Outputs", "Summary")
OTHER_STOCK = -1  # the stock id `cell_of` takes for the "All other positions" row
OTHER_NAME = "All other positions"
HOW_IT_WORKS = "https://www.orcaetf.com/how-it-works"
DISCLAIMER = "Estimates from SEC 13F filings, not the fund's real returns. Not investment advice."
# Defined names that live on Summary (its From and To years, Task 7): a formula naming one, or
# any sheet reference, reads another tab and is green.
_OTHER_TAB = re.compile(r"!|\b(?:FromYear|ToYear)\b")
_INPUT, _FORMULA, _OTHER_TAB_FORMULA = "#0000FF", "#000000", "#008000"  # blue, black, green
_LABELS = tuple(name.lower() for name in LABEL_COLUMNS)  # columns A-E, for `cell_of`
_SECTIONS = {"fund_input": "Fund inputs", "fund": "Fund rows", "year_only": "Year rows"}
_WIDTHS = {"label": (34, 10, 32, 9, 8), "year": 13, "gap": 2, "quarter": 13}
_STDEV_S = re.compile(r"\bSTDEV\.S\(")


class Sheet(Worksheet):
    """A worksheet that prepares a formula without xlsxwriter's 150-odd regex passes, which
    took about 90% of the build time. The builder's formulas use only layout.ALLOWED_FUNCTIONS,
    and of those xlsxwriter rewrites only STDEV.S (to _xlfn.STDEV.S, as use_future_functions
    asks); the tests check this gives xlsxwriter's own text for every registry formula."""

    def _prepare_formula(self, formula, expand_future_functions=False):
        if expand_future_functions:  # conditional formats and the like: xlsxwriter's own
            return super()._prepare_formula(formula, expand_future_functions)
        formula = formula.removeprefix("=")
        if self.use_future_functions and "_xlfn." not in formula:
            formula = _STDEV_S.sub("_xlfn.STDEV.S(", formula)
        return formula


@dataclass(frozen=True)
class BuildInfo:
    rows: int  # Model's last row
    cols: int  # Model's columns
    bytes: int
    seconds: float


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
        if key in _LABELS:
            return _LABELS.index(key)
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


_last_map: tuple[FundInputs, ModelMap] | None = None


def model_map(fi: FundInputs) -> ModelMap:
    """The Model layout of `fi` (the last one is kept, so repeated lookups are cheap)."""
    global _last_map
    if _last_map is None or _last_map[0] is not fi:
        _last_map = (fi, _plan(fi))
    return _last_map[1]


def cell_of(
    fi: FundInputs, tab: str, block_id: str, stock_id: int | None, column: int | str
) -> str:
    """The A1 address of a cell: block or row `block_id`, stock `stock_id` (None for a single
    row, OTHER_STOCK for "All other positions"), `column` as `ModelMap.column` takes it."""
    if tab != "Model":
        raise ValueError(f"no cell map for tab {tab!r} yet")
    return model_map(fi).cell(block_id, stock_id, column)


def file_name(fi: FundInputs) -> str:
    """orca-<fund_id>-<name slug>-<price date>.xlsx (spec 3.1)."""
    plain = unicodedata.normalize("NFKD", fi.name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-") or "fund"
    return f"orca-{fi.fund_id}-{slug}-{fi.latest_date.isoformat()}.xlsx"


def build_workbook(fi: FundInputs, path: Path) -> BuildInfo:
    """Write the workbook of `fi` to `path`."""
    began, path = time.perf_counter(), Path(path)
    if not fi.stocks:
        raise ValueError(f"fund {fi.fund_id}: no stock rows to build")
    m = model_map(fi)
    book = xlsxwriter.Workbook(
        str(path),
        {
            "constant_memory": True,  # rows are flushed as written: top to bottom only
            "use_future_functions": True,  # STDEV.S on Summary
            "strings_to_formulas": False,
            "strings_to_numbers": False,
            "strings_to_urls": False,
        },
    )
    model = book.add_worksheet(TABS[0], worksheet_class=Sheet)
    for name in TABS[1:]:
        book.add_worksheet(name, worksheet_class=Sheet)
    _ModelWriter(book, model, fi, m).write()
    book.close()
    _strip_results(path)
    size = path.stat().st_size
    return BuildInfo(m.last_row, m.cols.latest_index + 1, size, time.perf_counter() - began)


def _strip_results(path: Path) -> None:
    """Rewrite the saved file without the (empty) result xlsxwriter stores after each formula,
    so it holds no cached values at all (ruling R5)."""
    tmp = path.with_name(path.name + ".tmp")
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(tmp, "w") as dst:
        for info in src.infolist():
            data = src.read(info)
            if info.filename.startswith("xl/worksheets/sheet"):
                data = data.replace(b"</f><v></v>", b"</f>")
                if b"</f><v>" in data:  # a formula written with a result: never stored
                    raise RuntimeError(f"{path.name}: a formula with a stored result")
            dst.writestr(info, data)
    os.replace(tmp, path)


# --- the layout ---------------------------------------------------------------------------------


def _notes(fi: FundInputs) -> list[str]:
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

    for i in range(len(_notes(fi))):
        line("note", str(i))
    for b in HEADER_ROWS:
        first[b.id] = line("single", b.id)
    freeze = row

    body = [b for b in MODEL_ROWS[len(HEADER_ROWS) :] if cut or not b.cut_only]
    entries = []  # the index: each section, and each stock block
    for b in body:
        key = b.id if b.per_stock else b.kind
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
        if b.kind != section:
            line("blank")
            titles[b.kind] = line("section_title", b.kind)
            section = b.kind
        first[b.id] = line("single", b.id)

    offsets = {st.stock_id: i for i, st in enumerate(fi.stocks)}
    rows = Rows(first, n, cut)
    return ModelMap(cols, rows, offsets, titles, freeze, row - 1, tuple(lines))


# --- writing ------------------------------------------------------------------------------------


class _ModelWriter:
    """Writes the Model lines in order (constant memory: a row is final once the next starts)."""

    def __init__(self, book: xlsxwriter.Workbook, ws: Worksheet, fi: FundInputs, m: ModelMap):
        self.book, self.ws, self.fi, self.m = book, ws, fi, m
        self.cols, self.rows = m.cols, m.rows
        self.notes = _notes(fi)
        self._formats: dict[tuple, Format] = {}
        tracked = [q for q in fi.quarters if q <= fi.end_q]
        self.tracked = [(q, self.cols.quarter_index(q)) for q in tracked]
        self.all_q = [(q, self.cols.quarter_index(q)) for q in fi.quarters]
        self.year_cols = [self.cols.year_index(y) for y in self.cols.years]

    def fmt(self, number_format: str = "General", font: str | None = None, **extra) -> Format:
        key = (number_format, font, tuple(sorted(extra.items())))
        if key not in self._formats:
            props = {"num_format": number_format, **extra}
            if font:
                props["font_color"] = font
            self._formats[key] = self.book.add_format(props)
        return self._formats[key]

    # cells (row is 1-based, as in the map; xlsxwriter's is 0-based)

    def number(self, row: int, col: int, value: float, number_format: str) -> None:
        self.ws.write_number(row - 1, col, value, self.fmt(number_format, _INPUT))

    def formula(self, row: int, col: int, text: str, number_format: str) -> None:
        font = _OTHER_TAB_FORMULA if _OTHER_TAB.search(text) else _FORMULA
        self.ws.write_formula(row - 1, col, text, self.fmt(number_format, font), "")

    def text(self, row: int, col: int, value: str, fmt: Format | None = None) -> None:
        self.ws.write_string(row - 1, col, value, fmt)  # data text is never a formula

    def input_cell(self, row: int, col: int, value: object, number_format: str) -> None:
        """An input: a number, a date or text; None stays an empty cell."""
        if value is None:
            return
        if isinstance(value, str):
            self.ws.write_string(row - 1, col, value, self.fmt(number_format, _INPUT))
        elif isinstance(value, date):
            self.ws.write_datetime(row - 1, col, value, self.fmt(DATE, _INPUT))
        else:
            self.number(row, col, float(value), number_format)

    def labels(self, row: int, name: str, units: str, stock: int | None = None) -> None:
        """Columns A-E: row name, ticker, company, stock id, units."""
        self.text(row, 0, name)
        if stock is not None and stock < self.rows.stocks:
            st = self.fi.stocks[stock]
            self.text(row, 1, st.ticker)
            self.text(row, 2, st.name)
            self.ws.write_number(row - 1, 3, st.stock_id, self.fmt(WHOLE))
        elif stock is not None:
            self.text(row, 2, OTHER_NAME)
        if units:
            self.text(row, 4, units)

    # the tab

    def write(self) -> None:
        ws, cols = self.ws, self.cols
        widths = _WIDTHS["label"]
        for i, width in enumerate(widths):
            ws.set_column(i, i, width)
        if cols.years:
            ws.set_column(self.year_cols[0], self.year_cols[-1], _WIDTHS["year"])
        ws.set_column(cols.gap_index, cols.gap_index, _WIDTHS["gap"])
        ws.set_column(cols.before_index, cols.latest_index, _WIDTHS["quarter"])
        ws.freeze_panes(self.m.freeze - 1, len(widths))  # below the header rows, at column F
        for row, what, key in self.m.lines:
            getattr(self, f"_{what}")(row, key)

    def _note(self, row: int, key: str) -> None:
        i = int(key)
        if i == len(self.notes) - 1:
            self.ws.write_url(row - 1, 0, HOW_IT_WORKS, string=self.notes[i])
        else:
            self.text(row, 0, self.notes[i], self.fmt(bold=True, font_size=13) if i == 0 else None)

    def _blank(self, row: int, key: str) -> None:
        pass

    def _index_title(self, row: int, key: str) -> None:
        self.text(row, 0, "Blocks (click to go there)", self.fmt(bold=True))

    def _index(self, row: int, key: str) -> None:
        target = self.m.titles[key]
        name = _SECTIONS.get(key) or f"{key} {BY_ID[key].name}"
        self.ws.write_url(row - 1, 0, f"internal:'Model'!A{target}", string=name)

    def _section_title(self, row: int, key: str) -> None:
        self.text(row, 0, _SECTIONS[key], self.fmt(bold=True))

    def _block_title(self, row: int, key: str) -> None:
        self.text(row, 0, f"{key} {BY_ID[key].name}", self.fmt(bold=True))

    def _single(self, row: int, key: str) -> None:
        b = BY_ID[key]
        self.labels(row, b.name, b.units)
        if b.kind == "header":
            self._header(row, b)
        elif b.kind == "fund_input":
            values = _source(self.fi, b.source)
            for (q, col), value in zip(self.all_q, values, strict=True):
                self.input_cell(row, col, value, b.number_format)
        elif b.kind == "fund":
            self._before(row, b, 0)
            for _, col in self.tracked:
                self.formula(row, col, b.formula(Ref(self.cols, self.rows, col)), b.number_format)
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
        elif b.kind == "calc":
            self._before(row, b, stock)
            for _, col in self.tracked:
                ref = Ref(self.cols, self.rows, col, stock)
                self.formula(row, col, b.formula(ref), b.number_format)
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
