"""What every tab's writer shares: the fast worksheet class, the fonts of the modelling
convention (inputs blue, formulas black, formulas that read another tab green) and the cell
writers. Rows are 1-based here, as on the sheet; xlsxwriter's are 0-based."""

import re
from datetime import date

import xlsxwriter
from xlsxwriter.format import Format
from xlsxwriter.worksheet import Worksheet

from orca.workbook.layout import DATE

# The fast Sheet below overrides a private xlsxwriter method. A different version may change it
# silently, so a bump must be deliberate: re-run the equivalence test (tests/test_workbook_model.py)
# and then update this pin.
assert xlsxwriter.__version__ == "3.3.1", (
    f"xlsxwriter {xlsxwriter.__version__}: the fast Sheet overrides a private method; "
    "re-run the equivalence test when bumping, then update this check"
)

INPUT, FORMULA, OTHER_TAB_FORMULA = "#0000FF", "#000000", "#008000"  # blue, black, green
# A sheet reference, or a defined name of Summary's From and To years (Model's In range row),
# reads another tab. Summary's own formulas use the cells, not the names.
_OTHER_TAB = re.compile(r"!|\b(?:FromYear|ToYear)\b")
_STDEV_S = re.compile(r"\bSTDEV\.S\(")


class Sheet(Worksheet):
    """A worksheet that prepares a formula without xlsxwriter's 150-odd regex passes, which
    took about 90% of the build time. The builder's formulas use only layout.ALLOWED_FUNCTIONS,
    and of those xlsxwriter rewrites only STDEV.S (to _xlfn.STDEV.S, as use_future_functions
    asks); the tests check this gives xlsxwriter's own text for every formula a build writes."""

    def _prepare_formula(self, formula, expand_future_functions=False):
        # conditional formats and the like, and array formulas ("{=...}"): xlsxwriter's own
        if expand_future_functions or formula.startswith("{"):
            return super()._prepare_formula(formula, expand_future_functions)
        formula = formula.removeprefix("=")
        if self.use_future_functions and "_xlfn." not in formula:
            formula = _STDEV_S.sub("_xlfn.STDEV.S(", formula)
        return formula


class Formats:
    """The workbook's cell formats, made once per (number format, font colour, extras)."""

    def __init__(self, book: xlsxwriter.Workbook) -> None:
        self.book, self._cache = book, {}

    def __call__(self, number_format: str = "General", font: str | None = None, **extra) -> Format:
        key = (number_format, font, tuple(sorted(extra.items())))
        if key not in self._cache:
            props = {"num_format": number_format, **extra}
            if font:
                props["font_color"] = font
            self._cache[key] = self.book.add_format(props)
        return self._cache[key]


class TabWriter:
    """Cell writers for one tab. In constant-memory mode a row is final once a later row is
    written (xlsxwriter drops a later write to it without a word), so each tab is written top
    to bottom and `at` refuses a row above the last one written."""

    def __init__(self, ws: Worksheet, fmt: Formats) -> None:
        self.ws, self.fmt = ws, fmt
        self._last = 0

    def at(self, row: int) -> int:
        """xlsxwriter's 0-based row of sheet row `row`, which must not be above the last one."""
        if row < self._last:
            raise RuntimeError(f"{self.ws.name}: row {row} written after row {self._last}")
        self._last = row
        return row - 1

    def number(self, row: int, col: int, value: float, number_format: str) -> None:
        """A number the builder writes: an input (blue)."""
        self.ws.write_number(self.at(row), col, value, self.fmt(number_format, INPUT))

    def formula(self, row: int, col: int, text: str, number_format: str) -> None:
        """A formula, stored without a result; green when it reads another tab."""
        font = OTHER_TAB_FORMULA if _OTHER_TAB.search(text) else FORMULA
        self.ws.write_formula(self.at(row), col, text, self.fmt(number_format, font), "")

    def text(self, row: int, col: int, value: str, fmt: Format | None = None) -> None:
        self.ws.write_string(self.at(row), col, value, fmt)  # data text is never a formula

    def url(self, row: int, col: int, target: str, label: str) -> None:
        self.ws.write_url(self.at(row), col, target, string=label)

    def bold(self, row: int, col: int, value: str, **extra) -> None:
        self.text(row, col, value, self.fmt(bold=True, **extra))

    def input_cell(self, row: int, col: int, value: object, number_format: str) -> None:
        """An input: a number, a date or text; None stays an empty cell."""
        if value is None:
            return
        if isinstance(value, str):
            self.ws.write_string(self.at(row), col, value, self.fmt(number_format, INPUT))
        elif isinstance(value, date):
            self.ws.write_datetime(self.at(row), col, value, self.fmt(DATE, INPUT))
        else:
            self.number(row, col, float(value), number_format)
