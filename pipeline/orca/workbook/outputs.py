"""The Outputs tab (spec 3.4): one row per stock in Model's order with the positions at the
latest quarter at latest prices and the what-if figures (`layout.OUTPUT_COLUMNS`), Orca's
figures beside them with a difference cell each, a Total row, the "All other positions" sums of
a cut fund (Orca's inputs, which the fund-level formulas add in), and the checks table."""

from collections.abc import Callable
from dataclasses import dataclass

from xlsxwriter.worksheet import Worksheet

from orca.workbook.inputs import FundInputs
from orca.workbook.layout import (
    CHECKS,
    GENERAL,
    LABEL_COLUMNS,
    OUTPUT_COLUMNS,
    RATIO,
    SCI,
    TOLERANCE,
    USD,
    WHOLE,
    col_letter,
)
from orca.workbook.model import LABEL_WIDTHS, LABELS, OTHER_NAME, ModelMap
from orca.workbook.sheet import Formats, TabWriter

TAB = "Outputs"
FIRST_STOCK_ROW = 6  # below the title, the notes, a blank line, the names and the units
OTHER_VALUE = len(LABEL_COLUMNS)  # the "All other positions" values sit in column F
_CHECK_FIELDS = {"measure": 0, "compared": 1, "max": 2, "tolerance": 3, "result": 4}
# The cut's sums the fund-level formulas add in (spec section 4): field, label, format.
_OTHER_FIELDS = (
    ("count", "Positions", WHOLE),
    ("held_now", "Held now", WHOLE),
    ("value_now", "Value now at latest prices ($)", USD),
    ("before_value_now", "Shares the quarter before the latest filed, at latest prices ($)", USD),
    ("profitable", "Positions with a total P&L above 0", WHOLE),
    ("computable", "Positions whose total P&L can be computed", WHOLE),
    ("hold_sum_all", "Hold lengths, summed (years)", RATIO),
    ("hold_n_all", "Hold lengths, counted", WHOLE),
    ("hold_sum_sold", "Hold lengths of the positions sold out, summed (years)", RATIO),
    ("hold_n_sold", "Positions sold out", WHOLE),
    ("buys_1y_sum", "Buys: returns 12 months after, summed", RATIO),
    ("buys_1y_n", "Buys with a return 12 months after", WHOLE),
    ("sells_1y_sum", "Sales: returns 12 months after, summed", RATIO),
    ("sells_1y_n", "Sales with a return 12 months after", WHOLE),
    ("beat_pairs", "Last sales beating SPY", WHOLE),
    ("beat_n", "Last sales with both one-year returns", WHOLE),
    ("missed_early", "Sold too early: missed ($)", USD),
    ("missed_dodged", "Losses dodged ($)", USD),
)
_WIDTH = 14


@dataclass(frozen=True)
class OutputsMap:
    """Where everything is on Outputs (rows 1-based): the stock rows, each column, the Total
    row, the cut's "All other positions" inputs (empty when not cut) and the checks table."""

    stock_row: dict[int, int]  # stock_id -> row
    first: int
    last: int  # the last stock row
    cols: dict[str, int]  # column id (or a label column) -> 0-based column
    total: int
    other: dict[str, int]  # OtherInputs field -> row, its value in column F
    checks_title: int
    check_rows: dict[str, int]  # measure -> row
    last_row: int

    def cell(self, column_id: str, stock_id: int) -> str:
        return f"{col_letter(self.cols[column_id])}{self.stock_row[stock_id]}"

    def column(self, column_id: str) -> str:
        """Column `column_id` down the stock rows, as a range."""
        letter = col_letter(self.cols[column_id])
        return f"{letter}{self.first}:{letter}{self.last}"

    def total_cell(self, column_id: str) -> str:
        return f"{col_letter(self.cols[column_id])}{self.total}"

    def other_cell(self, field: str) -> str | None:
        """The cut's input `field`, None when the fund is not cut."""
        row = self.other.get(field)
        return None if row is None else f"{col_letter(OTHER_VALUE)}{row}"

    def check(self, measure: str, field: str = "result") -> str:
        return f"{col_letter(_CHECK_FIELDS[field])}{self.check_rows[measure]}"

    @property
    def results(self) -> str:
        """Every Result cell of the checks table."""
        rows = sorted(self.check_rows.values())
        letter = col_letter(_CHECK_FIELDS["result"])
        return f"{letter}{rows[0]}:{letter}{rows[-1]}"


def outputs_map(fi: FundInputs) -> OutputsMap:
    cols = {name: i for i, name in enumerate(LABELS)}
    cols.update({c.id: len(LABEL_COLUMNS) + i for i, c in enumerate(OUTPUT_COLUMNS)})
    first = FIRST_STOCK_ROW
    stock_row = {st.stock_id: first + i for i, st in enumerate(fi.stocks)}
    last = first + len(fi.stocks) - 1
    total = last + 1
    row = total + 2
    other: dict[str, int] = {}
    if fi.other is not None:
        row += 1  # the block's title
        for field, _, _ in _OTHER_FIELDS:
            other[field] = row
            row += 1
        row += 1
    checks_title = row
    check_rows = {c.measure: checks_title + 2 + i for i, c in enumerate(CHECKS)}
    return OutputsMap(
        stock_row, first, last, cols, total, other, checks_title, check_rows,
        checks_title + 1 + len(CHECKS),
    )  # fmt: skip


class OutputsRef:
    """layout.OutRef for one stock's row: Model ranges of that stock's rows, Outputs cells of
    its own row."""

    def __init__(self, fi: FundInputs, m: ModelMap, om: OutputsMap, stock: int) -> None:
        self.fi, self.m, self.om, self.stock = fi, m, om, stock
        self.row = om.first + stock
        self.period_q = fi.period_q

    def _letters(self, span: str) -> tuple[str, str]:
        cols = self.m.cols
        end = cols.quarter(cols.end_q)
        return {
            "tracked": (cols.first_q, end),
            "before": (cols.before, end),
            "all": (cols.first_q, cols.last_q),
            "flows": (cols.first_q, cols.latest),
        }[span]

    def _column(self, column: int | str) -> str:
        cols = self.m.cols
        if column == "end":
            return cols.quarter(cols.end_q)
        if column == "latest":
            return cols.latest
        return cols.before if column < self.fi.start else cols.quarter(column)

    def _range(self, row: int, span: str) -> str:
        first, last = self._letters(span)
        return f"Model!{first}{row}:{last}{row}"

    def col(self, column_id: str) -> str:
        return f"{col_letter(self.om.cols[column_id])}{self.row}"

    def model(self, row_id: str, span: str = "tracked") -> str:
        return self._range(self.m.rows.row(row_id, self.stock), span)

    def model_at(self, row_id: str, column: int | str) -> str:
        return f"Model!{self._column(column)}{self.m.rows.row(row_id, self.stock)}"

    def header(self, row_id: str, span: str = "tracked") -> str:
        return self._range(self.m.rows.row(row_id), span)

    def header_at(self, row_id: str, column: int | str) -> str:
        return f"Model!{self._column(column)}{self.m.rows.row(row_id)}"

    def fund(self, row_id: str) -> str:
        return self._range(self.m.rows.row(row_id), "all")

    def total(self, column_id: str) -> str:
        return self.om.total_cell(column_id)


class OutputsWriter(TabWriter):
    def __init__(self, ws: Worksheet, fmt: Formats, fi: FundInputs, m: ModelMap,
                 om: OutputsMap, where: Callable[[str], str]) -> None:  # fmt: skip
        super().__init__(ws, fmt)
        self.fi, self.m, self.om, self.where = fi, m, om, where

    def write(self) -> None:
        ws, om, fi = self.ws, self.om, self.fi
        for i, width in enumerate(LABEL_WIDTHS):
            ws.set_column(i, i, width)
        ws.set_column(len(LABEL_COLUMNS), len(LABEL_COLUMNS) + len(OUTPUT_COLUMNS), _WIDTH)
        ws.freeze_panes(om.first - 1, len(LABEL_COLUMNS))
        self.bold(1, 0, "Positions at the latest quarter filed, at the latest prices, and the "
                        "what-if figures", font_size=13)  # fmt: skip
        self.text(2, 0, "One row per stock, in Model's order. Orca's figures (inputs, blue) "
                        "follow the workbook's, each with its difference; the checks table is "
                        "below the stocks.")  # fmt: skip
        title = self.fmt(bold=True, text_wrap=True)
        for i, name in enumerate(LABEL_COLUMNS):
            self.text(om.first - 2, i, name, title)
        for c in OUTPUT_COLUMNS:  # a row is final once a later one is written: names first
            self.text(om.first - 2, om.cols[c.id], c.name, title)
        for c in OUTPUT_COLUMNS:
            if c.units:
                self.text(om.first - 1, om.cols[c.id], c.units, self.fmt(italic=True))
        for i, (st, orca) in enumerate(zip(fi.stocks, fi.orca_stocks, strict=True)):
            row = om.first + i
            self.text(row, 1, st.ticker)
            self.text(row, 2, st.name)
            self.ws.write_number(self.at(row), 3, st.stock_id, self.fmt(WHOLE))
            ref = OutputsRef(fi, self.m, om, i)
            for c in OUTPUT_COLUMNS:
                col = om.cols[c.id]
                if c.formula is not None:
                    self.formula(row, col, c.formula(ref), c.number_format)
                else:  # Orca's figure, the engine's own
                    self.input_cell(row, col, getattr(orca, c.source), c.number_format)
        self._totals()
        if fi.other is not None:
            self._other()
        self._checks()

    def _totals(self) -> None:
        om = self.om
        self.bold(om.total, 0, "Total" + (f", with {OTHER_NAME.lower()}" if self.fi.other else ""))
        for column_id, field in (("value_now", "value_now"), ("lc_value_before",
                                                              "before_value_now")):
            other = om.other_cell(field)
            text = f"=SUM({om.column(column_id)})" + (f"+{other}" if other else "")
            self.formula(om.total, om.cols[column_id], text, USD)

    def _other(self) -> None:
        om, other = self.om, self.fi.other
        first = min(om.other.values())
        self.bold(first - 1, 0, f"{OTHER_NAME}: Orca's sums over the {other.count} positions "
                                "beyond the cut (inputs)")  # fmt: skip
        for field, label, number_format in _OTHER_FIELDS:
            self.text(om.other[field], 0, label)
            self.input_cell(om.other[field], OTHER_VALUE, getattr(other, field), number_format)

    def _checks(self) -> None:
        om = self.om
        self.bold(om.checks_title, 0, "Checks: the workbook's figures against Orca's")
        head = self.fmt(bold=True)
        for field, col in _CHECK_FIELDS.items():
            name = {"max": "Max difference"}.get(field, field.capitalize())
            self.text(om.checks_title + 1, col, name, head)
        for c in CHECKS:
            row = om.check_rows[c.measure]
            cells = self.where(c.diff_cells)
            self.text(row, 0, c.measure)
            self.formula(row, 1, f"=COUNT({cells})", WHOLE)
            self.formula(row, 2, f"=MAX({cells})", SCI)
            self.number(row, 3, TOLERANCE[c.kind], SCI if TOLERANCE[c.kind] else GENERAL)
            max_cell, tol = om.check(c.measure, "max"), om.check(c.measure, "tolerance")
            self.formula(row, 4, f'=IF({max_cell}<={tol},"PASS","FAIL")', GENERAL)
