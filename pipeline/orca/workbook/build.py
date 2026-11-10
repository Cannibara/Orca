"""The fund workbook builder: FundInputs -> .xlsx with xlsxwriter (constant memory), tabs Model,
Outputs and Summary (spec 3). The three tabs are planned first (`workbook_map`), so each can
refer to the others, then each is written top to bottom by its own module: model.py, outputs.py
and summary.py. Every formula comes from `layout` or summary.py, none from here.

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
from pathlib import Path

import xlsxwriter

from orca.workbook.inputs import FundInputs
from orca.workbook.layout import BY_ID, col_letter
from orca.workbook.model import OTHER_STOCK, ModelMap, ModelWriter, model_map
from orca.workbook.outputs import OutputsMap, OutputsWriter, outputs_map
from orca.workbook.sheet import Formats, Sheet
from orca.workbook.summary import SummaryMap, SummaryWriter, summary_map

__all__ = [
    "OTHER_STOCK", "TABS", "BuildInfo", "Sheet", "WorkbookMap", "build_workbook", "cell_of",
    "file_name", "model_map", "workbook_map",
]  # fmt: skip

TABS = ("Model", "Outputs", "Summary")
_RANGE_NAMES = (("FromYear", "from_year"), ("ToYear", "to_year"))  # on Summary
_CHECK_FIELDS = ("compared", "max", "tolerance", "result")


@dataclass(frozen=True)
class BuildInfo:
    rows: int  # Model's last row
    cols: int  # Model's columns
    bytes: int
    seconds: float


@dataclass(frozen=True)
class WorkbookMap:
    """Where everything is on each tab."""

    model: ModelMap
    outputs: OutputsMap
    summary: SummaryMap

    def where(self, place: str) -> str:
        """The A1 range of a checks place (layout.Check: "<tab>:<id>", "@q"/"@y" on Model),
        with its tab's name unless it is on Outputs, where the checks table is."""
        tab, _, key = place.partition(":")
        if tab == "Model":
            block_id, _, span = key.partition("@")
            return f"Model!{self.model.span(block_id, span, stocks=BY_ID[block_id].per_stock)}"
        if tab == "Outputs":
            return self.outputs.column(key)
        if tab == "Summary":
            item, _, field = key.partition(".")
            return f"Summary!{self.summary.cell(item, field or 'value')}"
        raise KeyError(f"no tab {tab!r}")


def workbook_map(fi: FundInputs) -> WorkbookMap:
    """The layout of every tab of `fi`'s workbook, planned afresh."""
    return WorkbookMap(model_map(fi), outputs_map(fi), summary_map())


def cell_of(
    fi: FundInputs, tab: str, block_id: str, stock_id: int | None, column: int | str
) -> str:
    """The A1 address of a cell.

    Model: block or row `block_id`, stock `stock_id` (None for a single row, OTHER_STOCK for
    "All other positions"), `column` as `ModelMap.column` takes it. Outputs: `block_id` names
    the table: "stocks" (`column` an OUTPUT_COLUMNS id or a label column, for `stock_id`),
    "totals" (a column id), "other" (an OtherInputs field) or a checks table field ("compared",
    "max", "tolerance", "result"; `column` the measure). Summary: `block_id` is "value", "orca"
    or "diff" and `column` the item."""
    wm = workbook_map(fi)
    if tab == "Model":
        return wm.model.cell(block_id, stock_id, column)
    if tab == "Outputs":
        if block_id == "stocks":
            return wm.outputs.cell(str(column), stock_id)
        if block_id == "totals":
            return wm.outputs.total_cell(str(column))
        if block_id == "other":
            cell = wm.outputs.other_cell(str(column))
            if cell is None:
                raise KeyError(f"fund {fi.fund_id} is not cut")
            return cell
        if block_id in _CHECK_FIELDS:
            return wm.outputs.check(str(column), block_id)
    if tab == "Summary":
        return wm.summary.cell(str(column), block_id)
    raise KeyError(f"no cell {block_id!r} on tab {tab!r}")


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
    wm = workbook_map(fi)
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
    model, outputs, summary = (book.add_worksheet(name, worksheet_class=Sheet) for name in TABS)
    for name, item in _RANGE_NAMES:  # Model's In range row reads them
        row, col = wm.summary.at[item]
        book.define_name(name, f"=Summary!${col_letter(col)}${row}")
    fmt = Formats(book)
    ModelWriter(model, fmt, fi, wm.model).write()
    OutputsWriter(outputs, fmt, fi, wm.model, wm.outputs, wm.where).write()
    checks = wm.outputs.checks_title
    SummaryWriter(summary, fmt, fi, wm.model, wm.outputs, wm.summary, checks).write()
    book.close()
    _strip_results(path)
    size = path.stat().st_size
    m = wm.model
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
