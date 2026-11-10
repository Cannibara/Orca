"""The workbook's Model tab: built from FundInputs, recalculated by LibreOffice (the file stores
no values), every stock cell, fund quarter and year equals the engine's."""

import dataclasses
import re
import statistics
import zipfile
from dataclasses import dataclass
from pathlib import Path

import lo
import openpyxl
import pytest
import xlsxwriter
from conftest import demo_batch
from test_workbook_layout import rendered

from orca.engine.fund import full_years
from orca.engine.whatif import _return_after
from orca.quarters import BASE_YEAR
from orca.run.compute import FundResult, Prepared
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.build import (
    OTHER_STOCK,
    BuildInfo,
    Sheet,
    build_workbook,
    cell_of,
    file_name,
    model_map,
)
from orca.workbook.inputs import FundInputs, build_inputs
from orca.workbook.layout import BLOCKS, MODEL_ROWS

CIKS = list(range(9100001, 9100013))
CUT_CIK, CUT_KEEP = 9100009, 3  # Seastack (18-24 positions) cut to 3 stock rows
INACTIVE = 9100010  # Cobblereef: last filed Q4 2023, so bound is after end_q
ZERO_AFTER_END = {"C17", "C18"}  # the cash flows: the only blocks with a value after end_q

# engine.position.PositionQuarter field of each stock block (spec 3.2)
STOCK_FIELDS = {
    "C5": "shares", "C7": "delta", "C9": "net_buying", "C10": "market_move",
    "C11": "trade_gain", "C12": "dividends", "C14": "cost", "C15": "realised", "C16": "value",
}  # fmt: skip
FUND_MONEY = (
    "start", "end", "buys", "sells", "net_buying", "market_move", "trade_gains", "dividends"
)  # fmt: skip
BLUE, BLACK, GREEN = "FF0000FF", "FF000000", "FF008000"


@dataclass(frozen=True)
class Case:
    fi: FundInputs
    p: Prepared
    r: FundResult
    path: Path
    info: BuildInfo


@pytest.fixture(scope="module")
def cases(demo_run, tmp_path_factory) -> dict[str, Case]:
    """The 12 demo funds' workbooks, keyed by CIK, and Seastack cut to 3 rows as "cut"."""
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    out = tmp_path_factory.mktemp("workbooks")
    built = {}
    for p, r in batch:
        runs = [(str(p.cik), 500)] + ([("cut", CUT_KEEP)] if p.cik == CUT_CIK else [])
        for key, keep in runs:
            fi = build_inputs(ctx, p, r, latest, securities, max_positions=keep)
            path = out / f"{key}-{file_name(fi)}"
            built[key] = Case(fi, p, r, path, build_workbook(fi, path))
    assert len(built) == 13 and built["cut"].fi.other is not None
    return built


@pytest.fixture(scope="module")
def computed(cases, tmp_path_factory) -> dict[str, dict]:
    """Each workbook's values as LibreOffice computed them."""
    lo.require_libreoffice()
    out = tmp_path_factory.mktemp("recalculated")
    paths = lo.recalc_all([case.path for case in cases.values()], out)
    return {key: lo.values(path) for key, path in zip(cases, paths, strict=True)}


def reader(case: Case, values: dict):
    """get(block, stock_id, column): the computed value of a Model cell (None when blank)."""
    model = model_map(case.fi)
    return lambda block, stock, column: values.get(("Model", model.cell(block, stock, column)))


@pytest.mark.libreoffice
def test_model_stock_cells_equal_engine(cases, computed):
    held_quarters = 0
    for key, case in cases.items():
        get = reader(case, computed[key])
        positions = {pos.stock_id: pos for pos in case.r.output.positions}
        for st in case.fi.stocks:
            sid, pos = st.stock_id, positions.get(st.stock_id)
            held = {pq.q: pq for pq in pos.quarters} if pos else {}
            scale = lo.stock_scale(pos)
            for q in range(case.fi.start, case.fi.end_q + 1):
                where = f"{key} stock {sid} q {q}"
                pq = held.get(q)
                if pq is None:  # not held before or now: the engine skipped the quarter
                    lo.assert_exact(get("C6", sid, q), 0, f"{where} C6")
                    for block in STOCK_FIELDS:
                        lo.assert_money(get(block, sid, q), 0.0, scale, f"{where} {block}")
                    lo.assert_ratio(get("C8", sid, q), None, f"{where} C8")
                    continue
                held_quarters += 1
                lo.assert_exact(get("C6", sid, q), 1, f"{where} C6")
                for block, field in STOCK_FIELDS.items():
                    want = getattr(pq, field)
                    lo.assert_money(get(block, sid, q), want, scale, f"{where} {block}")
                lo.assert_ratio(get("C8", sid, q), pq.trade_px, f"{where} C8")
    assert held_quarters > 1000


@pytest.mark.libreoffice
def test_model_fund_rows_equal_engine(cases, computed):
    for key, case in cases.items():
        get = reader(case, computed[key])
        quarters = case.r.output.quarters
        assert [fq.q for fq in quarters] == list(range(case.fi.start, case.fi.end_q + 1))
        for fq in quarters:
            where, scale = f"{key} q {fq.q}", lo.quarter_scale(fq)
            for row in FUND_MONEY:
                lo.assert_money(get(row, None, fq.q), getattr(fq, row), scale, f"{where} {row}")
            lo.assert_ratio(get("ret", None, fq.q), fq.ret, f"{where} ret")
            lo.assert_exact(get("bridge_ok", None, fq.q), 1, f"{where} bridge_ok")


@pytest.mark.libreoffice
def test_model_year_columns(cases, computed):
    for key, case in cases.items():
        get, out = reader(case, computed[key]), case.r.output
        by_q = {fq.q: fq for fq in out.quarters}
        positions = {pos.stock_id: pos for pos in out.positions}
        full = {y.label for y in full_years(out.years, out.quarters)}
        kept = {st.stock_id for st in case.fi.stocks}
        terms = []
        for year, fy in zip(case.fi.years, out.years, strict=True):
            col, where = str(year), f"{key} {fy.label}"
            qs = [by_q[q] for q in fy.qs]
            scale = lo.year_scale(qs)
            lo.assert_ratio(get("ret", None, col), fy.ret, f"{where} ret")
            for row in ("start", "end", "gains", "inflows", "dividends"):
                lo.assert_money(get(row, None, col), getattr(fy, row), scale, f"{where} {row}")
            lo.assert_ratio(get("approx_ret", None, col), fy.approx_ret, f"{where} approx")
            lo.assert_exact(get("full_year", None, col), int(fy.label in full), where)

            # metrics.turnover's term for the year: full years with a positive mean book
            term = None
            if fy.label in full:
                book = statistics.fmean([fy.start, *(fq.end for fq in qs)])
                if book > 0:
                    term = min(sum(fq.buys for fq in qs), sum(fq.sells for fq in qs)) / book
                    terms.append(term)
            lo.assert_ratio(get("turnover", None, col), term, f"{where} turnover")

            # What drove: points and P&L per stock; blank without a quarter in the book
            drove = {sid: (pts, pnl) for sid, pts, pnl in out.contributions[fy.label]}
            for st in case.fi.stocks:
                sid, want = st.stock_id, drove.get(st.stock_id)
                lo.assert_ratio(get("C20", sid, col), want and want[0], f"{where} {sid} C20")
                if want:
                    own = lo.stock_scale(positions[sid])
                    lo.assert_money(get("C13", sid, col), want[1], own, f"{where} {sid} C13")
            if case.fi.other is not None:  # the positions beyond the cut, summed (fund scale)
                rest = [row for sid, row in drove.items() if sid not in kept]
                den = fy.start + fy.inflows / 2
                pts = sum(p for p, _ in rest) if den > 0 else None
                lo.assert_ratio(get("C20", OTHER_STOCK, col), pts, f"{where} other C20")
                if den > 0:  # else the engine lists no contributions for the year
                    pnl = sum(m for _, m in rest)
                    lo.assert_money(get("C13", OTHER_STOCK, col), pnl, scale, f"{where} other")
        want = out.metrics["turnover"]
        assert (statistics.fmean(terms) if terms else None) == pytest.approx(want), key


@pytest.mark.libreoffice
def test_inactive_fund_blank_after_end_q(cases, computed):
    # Review Focus 1: calculation and fund cells after end_q are not written, the cash flows
    # aside (ruling R23: the number 0 there, so no XIRR range has an empty cell); the years stop
    # at end_q's year; the Close block runs to bound, so the what-if one-year figures exist
    case = cases[str(INACTIVE)]
    fi, values, model = case.fi, computed[str(INACTIVE)], model_map(case.fi)
    get = reader(case, values)
    assert fi.bound > fi.end_q
    after = range(fi.end_q + 1, fi.bound + 1)
    raw = openpyxl.load_workbook(case.path)["Model"]
    cells = zeros = 0
    for block in BLOCKS:
        if block.kind not in ("calc", "fund"):
            continue
        stocks = [st.stock_id for st in fi.stocks] if block.per_stock else [None]
        for sid in stocks:
            for q in after:
                ref = model.cell(block.id, sid, q)
                if block.id in ZERO_AFTER_END:
                    # a number the builder wrote, not a formula: blue like its other constants
                    # (the Before column's starting values), in the block's number format
                    cell = raw[ref]
                    assert cell.value == 0 and cell.data_type == "n", (block.id, ref)
                    assert cell.font.color.rgb == BLUE, (block.id, ref)
                    assert cell.number_format == block.number_format, (block.id, ref)
                    assert values[("Model", ref)] == 0, (block.id, ref)
                    zeros += 1
                    continue
                assert raw[ref].value is None and ("Model", ref) not in values, (block.id, ref)
                cells += 1
    assert cells > 1000 and zeros == len(ZERO_AFTER_END) * len(fi.stocks) * len(after)
    for q in fi.quarters:
        lo.assert_exact(get("held_through", None, q), int(q <= fi.end_q), f"held q {q}")
    assert fi.years[-1] == BASE_YEAR + fi.end_q // 4 and model.cols.years == fi.years
    with pytest.raises(KeyError):
        model.cell("ret", None, str(fi.years[-1] + 1))

    closes = 0
    for st in fi.stocks:
        for i, q in enumerate(fi.quarters):
            if q > fi.end_q:
                lo.assert_ratio(get("I4", st.stock_id, q), st.close[i], f"close q {q}")
                closes += st.close[i] is not None
    assert closes
    late = 0  # trades whose close four quarters on lies after end_q
    for pos in case.r.output.positions:
        for t in pos.trades:
            if fi.end_q < t.q + 4 <= fi.bound:
                want = _return_after(case.p.px[pos.stock_id], t.q, t.px)
                lo.assert_ratio(get("C19", pos.stock_id, t.q), want, f"C19 {pos.stock_id}")
                late += want is not None
    assert late


def test_formula_like_names_stay_text(cases, tmp_path):
    # Review Focus 5: a ticker or name from the data that looks like a formula stays text
    fi = cases["9100001"].fi
    odd = ["=CMD()", "+1", "@x"]
    stocks = [
        dataclasses.replace(st, name=text, ticker=text) for st, text in zip(fi.stocks, odd)
    ] + fi.stocks[len(odd) :]
    fi = dataclasses.replace(fi, stocks=stocks)
    path = tmp_path / "odd.xlsx"
    build_workbook(fi, path)
    book = openpyxl.load_workbook(path)
    # every stock block on Model, and the stock table on Outputs, carry the ticker and name
    for sheet, tab, at in (("sheet1", "Model", ("C5", "stocks")), ("sheet2", "Outputs", None)):
        with zipfile.ZipFile(path) as z:
            xml = z.read(f"xl/worksheets/{sheet}.xml").decode()
        assert "CMD()</f>" not in xml
        ws = book[tab]
        for st, text in zip(stocks, odd):
            for column in ("ticker", "company"):
                if at:
                    ref = cell_of(fi, tab, at[0], st.stock_id, column)
                else:
                    ref = cell_of(fi, tab, "stocks", st.stock_id, column)
                assert ws[ref].value == text and ws[ref].data_type == "s", (ref, ws[ref].value)
                # xlsxwriter's string cell: an inline string, never a formula
                cell = re.search(rf'<c r="{ref}"[^>]*>(.*?)</c>', xml).group(0)
                assert 't="inlineStr"' in cell and "<f>" not in cell, cell
        blocks = sum(b.per_stock for b in MODEL_ROWS) if tab == "Model" else 1
        assert xml.count("<t>=CMD()</t>") == 2 * blocks, tab


def test_no_cached_values_and_full_calc(cases):
    for key, case in cases.items():
        with zipfile.ZipFile(case.path) as z:
            assert re.search(r'<calcPr[^>]*fullCalcOnLoad="1"', z.read("xl/workbook.xml").decode())
            sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
            assert len(sheets) == 3, sheets
            formulas = 0
            for name in sheets:
                xml = z.read(name).decode()
                formulas += len(re.findall(r"<f[ >]", xml))
                assert not re.search(r"</f>\s*<v", xml), (key, name)  # no stored result
                assert not re.search(r'<c [^>]*t="[^"]*"[^>]*><f', xml), (key, name)
        assert formulas > 1000, key
        assert case.info.bytes == case.path.stat().st_size and case.info.seconds > 0
        model = model_map(case.fi)
        assert (case.info.rows, case.info.cols) == (model.last_row, model.cols.latest_index + 1)


def test_file_name_and_styles(cases):
    case = cases["9100001"]
    fi = case.fi
    assert file_name(fi) == f"orca-9100001-kelpwood-capital-lp-{fi.latest_date.isoformat()}.xlsx"
    assert file_name(fi) == "orca-9100001-kelpwood-capital-lp-2026-10-30.xlsx"  # the demo date
    book = openpyxl.load_workbook(case.path)
    assert book.sheetnames == ["Model", "Outputs", "Summary"]
    ws, model = book["Model"], model_map(fi)

    def colour(block, stock, column):
        return ws[model.cell(block, stock, column)].font.color.rgb

    sid, q, year = fi.stocks[0].stock_id, fi.start + 2, str(fi.years[1])
    for block, stock, column in [
        ("quarter", None, q), ("total_reported", None, q), ("I1", sid, q), ("I4", sid, q),
        ("I4", sid, "before"), ("I4", sid, "latest"), ("mid_quarter", None, "latest"),
    ]:  # fmt: skip
        assert colour(block, stock, column) == BLUE, (block, column)
    for block, stock, column in [
        ("C5", sid, q), ("C8", sid, q), ("I4", sid, year), ("C17", sid, "latest"),
        ("start", None, q), ("ret", None, year), ("turnover", None, year), ("C20", sid, year),
        ("year", None, year),
    ]:  # fmt: skip
        assert colour(block, stock, column) == BLACK, (block, column)
    # In range reads Summary's From and To years: a formula reading another tab
    assert colour("in_range", None, q) == GREEN
    assert ws.freeze_panes == f"F{model.rows.row('held_through') + 1}"  # below the header rows


def built_formulas(cases, tmp_path, monkeypatch) -> list[str]:
    """Every formula building the workbooks of the cut and the uncut Seastack and of the
    inactive fund writes, on every tab, one per shape (cell references aside: xlsxwriter's
    rewrites only look at function names)."""
    seen: set[str] = set()
    prepare = Sheet._prepare_formula

    def record(self, formula, expand_future_functions=False):
        seen.add(formula)
        return prepare(self, formula, expand_future_functions)

    monkeypatch.setattr(Sheet, "_prepare_formula", record)
    for key in ("cut", str(CUT_CIK), str(INACTIVE)):
        build_workbook(cases[key].fi, tmp_path / f"{key}.xlsx")
    monkeypatch.undo()
    shapes: dict[str, str] = {}
    for formula in sorted(seen):
        shapes.setdefault(re.sub(r"\$?\b[A-Z]{1,3}\$?[0-9]+\b", "A1", formula), formula)
    return list(shapes.values())


def test_sheet_prepares_formulas_as_xlsxwriter_does(cases, tmp_path, monkeypatch):
    # the builder's Sheet skips xlsxwriter's regex passes: its text must be xlsxwriter's own
    # for every registry formula, cut or not, for every formula a build writes on any tab
    # (Outputs, Summary, the differences and the checks), and for the future function the tabs
    # use (ruling R18)
    built = built_formulas(cases, tmp_path, monkeypatch)
    for marker in ("XIRR(INDEX(", "STDEV.S(", "COUNTIFS(", '"PASS"', "1E+300", "FromYear"):
        assert any(marker in formula for formula in built), marker
    formulas = rendered(False) + rendered(True) + built + [
        '=IF(COUNT(J5:J9)<4,"",STDEV.S(J5:J9)*2)', '=IFERROR(XIRR(J5:Q5,J1:Q1),"")'
    ]
    book = xlsxwriter.Workbook(str(tmp_path / "x.xlsx"), {"use_future_functions": True})
    fast, slow = book.add_worksheet(worksheet_class=Sheet), book.add_worksheet()
    for formula in formulas:
        assert fast._prepare_formula(formula) == slow._prepare_formula(formula), formula
    assert "_xlfn.STDEV.S(J5:J9)" in fast._prepare_formula(formulas[-2])
    # an array formula ("{=...}") goes to xlsxwriter's own path (ruling R20)
    for formula in ("{=SUM(A1:A2*B1:B2)}", "{=STDEV.S(A1:A9)}"):
        assert fast._prepare_formula(formula) == slow._prepare_formula(formula), formula
    book.close()
