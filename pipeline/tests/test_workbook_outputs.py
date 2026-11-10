"""The workbook's Outputs and Summary tabs and its in-file checks: built from FundInputs and
recalculated by LibreOffice, every check passes, every figure Orca publishes equals the engine's,
the site-only figures follow the site's rules, and a corrupted Orca figure fails its check."""

import dataclasses
import math
import re
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import lo
import openpyxl
import pytest
import xlsxwriter
from conftest import demo_batch
from test_workbook_model import built_formulas

from orca.engine.position import PositionResult
from orca.publish import _last_change
from orca.quarters import BASE_YEAR, q_label
from orca.run.compute import FundResult, Prepared
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.build import build_workbook, file_name, workbook_map
from orca.workbook.inputs import FundInputs, build_inputs
from orca.workbook.layout import ALLOWED_FUNCTIONS, CHECKS, OUTPUT_COLUMNS, mid_quarter
from orca.workbook.sheet import Formats, TabWriter

CIKS = list(range(9100001, 9100013))
CUT_CIK, CUT_KEEP = 9100009, 3  # Seastack cut to 3 stock rows
CARRIED = 9100005  # Saltglass: end_q = period_q + 1 (Review Focus 2)
INACTIVE = 9100010  # Cobblereef: bound after end_q, so the flows end in empty cells
RANGE_CIK, RANGE = 9100001, (2016, 2019)
SHEETS = {"Model": 1, "Outputs": 2, "Summary": 3}  # xl/worksheets/sheet<n>.xml
BLUE, BLACK, GREEN = "FF0000FF", "FF000000", "FF008000"
IRR_TOL = 1e-7  # spec 7: the site's bisection against LibreOffice's XIRR


@dataclass(frozen=True)
class Case:
    fi: FundInputs
    p: Prepared
    r: FundResult
    path: Path


def _edit_inputs(path: Path, tab: str, cells: dict[str, float | None]) -> None:
    """Change input number cells of one tab in the built file, in place: a new value, or with
    None no cell at all (blank)."""
    name = f"xl/worksheets/sheet{SHEETS[tab]}.xml"
    with zipfile.ZipFile(path) as z:
        members = [(info, z.read(info)) for info in z.infolist()]
    with zipfile.ZipFile(path, "w") as z:
        for info, data in members:
            if info.filename == name:
                text = data.decode()
                for ref, value in cells.items():
                    pattern = rf'(<c r="{ref}"[^>]*><v>)[^<]*(</v></c>)'
                    new = "" if value is None else rf"\g<1>{value!r}\g<2>"
                    text, n = re.subn(pattern, new, text)
                    assert n == 1, (ref, n)
                data = text.encode()
            z.writestr(info, data)


def _irr_inputs(fi: FundInputs, r: FundResult) -> tuple[FundInputs, dict[str, int]]:
    """Review Focus 4 by hand: a held stock without a latest close, a stock bought and sold a
    quarter later at three times the price (an IRR far above 1,000%), and a sold-out stock."""
    positions = {pos.stock_id: pos for pos in r.output.positions}
    held = next(st for st in fi.stocks if positions[st.stock_id].shares_now > 0)
    sold = next(st for st in fi.stocks if positions[st.stock_id].to_q is not None)
    fast = next(st for st in fi.stocks if st.stock_id not in (held.stock_id, sold.stock_id))
    n, i = len(fi.quarters), 2  # bought in the third quarter (not a first report: at the VWAP)
    only = [None] * n
    shares, value, px = list(only), list(only), list(only)
    shares[i], value[i] = 1000.0, 1000.0
    px[i], px[i + 1] = 1.0, 3.0
    quick = dataclasses.replace(
        fast, shares_filed=shares, value_filed=value, split_factor=[1.0] * n, close=px,
        vwap=list(px), div_ps=[0.0] * n, close_before=None, close_latest=3.0,
    )  # fmt: skip
    stocks = [
        dataclasses.replace(st, close_latest=None) if st is held else quick if st is fast else st
        for st in fi.stocks
    ]
    ids = {"held": held.stock_id, "sold": sold.stock_id, "fast": fast.stock_id}
    return dataclasses.replace(fi, stocks=stocks), ids


@pytest.fixture(scope="module")
def cases(demo_run, tmp_path_factory) -> dict[str, Case]:
    """The 12 demo funds keyed by CIK, Seastack cut to 3 rows ("cut"), and four variants: the
    IRR edge cases ("irr"), a range of 2016-2019 typed into Summary ("range"), one Orca figure
    corrupted by +1% ("broken") and one Orca figure taken out ("emptied")."""
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    out = tmp_path_factory.mktemp("workbooks")
    built: dict[str, Case] = {}

    def build(key: str, fi: FundInputs, p: Prepared, r: FundResult) -> Case:
        path = out / f"{key}-{file_name(fi)}"
        build_workbook(fi, path)
        built[key] = Case(fi, p, r, path)
        return built[key]

    for p, r in batch:
        fi = build_inputs(ctx, p, r, latest, securities)
        build(str(p.cik), fi, p, r)
        if p.cik == CUT_CIK:
            build("cut", build_inputs(ctx, p, r, latest, securities, max_positions=CUT_KEEP), p, r)
    base = built[str(RANGE_CIK)]
    irr_fi, _ = _irr_inputs(base.fi, base.r)
    build("irr", irr_fi, base.p, base.r)
    summary = workbook_map(base.fi).summary
    ranged = build("range", base.fi, base.p, base.r)
    _edit_inputs(
        ranged.path,
        "Summary",
        {summary.cell("from_year"): RANGE[0], summary.cell("to_year"): RANGE[1]},
    )
    broken = build("broken", base.fi, base.p, base.r)
    sid, cost = next((o.stock_id, o.avg_cost) for o in base.fi.orca_stocks if o.avg_cost)
    ref = workbook_map(base.fi).outputs.cell("orca_avg_cost", sid)
    _edit_inputs(broken.path, "Outputs", {ref: cost * 1.01})
    emptied = build("emptied", base.fi, base.p, base.r)
    sid = next(o.stock_id for o in base.fi.orca_stocks if o.one_y is not None)
    one_y = workbook_map(base.fi).outputs.cell("orca_one_y", sid)
    _edit_inputs(emptied.path, "Outputs", {one_y: None})
    return built


@pytest.fixture(scope="module")
def computed(cases, tmp_path_factory) -> dict[str, dict]:
    lo.require_libreoffice()
    out = tmp_path_factory.mktemp("recalculated")
    paths = lo.recalc_all([case.path for case in cases.values()], out)
    return {key: lo.values(path) for key, path in zip(cases, paths, strict=True)}


def latest_prices(cases: dict[str, Case], key: str) -> dict[int, float]:
    """The latest close of every stock of the fund (a cut fund's kept stocks are only some)."""
    whole = cases[str(CUT_CIK)] if key == "cut" else cases[key]
    return {st.stock_id: st.close_latest for st in whole.fi.stocks if st.close_latest is not None}


def real(cases: dict[str, Case]) -> list[str]:
    """The demo funds and the cut, not the hand-made variants."""
    return [key for key in cases if key not in ("irr", "range", "broken", "emptied")]


class Read:
    """The computed cells of one case by name (None when blank)."""

    def __init__(self, case: Case, values: dict) -> None:
        self.map, self.values = workbook_map(case.fi), values

    def out(self, column: str, stock_id: int) -> object:
        return self.values.get(("Outputs", self.map.outputs.cell(column, stock_id)))

    def check(self, measure: str, field: str = "result") -> object:
        return self.values.get(("Outputs", self.map.outputs.check(measure, field)))

    def summary(self, item: str, field: str = "value") -> object:
        return self.values.get(("Summary", self.map.summary.cell(item, field)))

    def model(self, block: str, stock_id: int | None, column: int | str) -> object:
        return self.values.get(("Model", self.map.model.cell(block, stock_id, column)))


# --- the site's rules, ported (web/src/lib/live.ts, fund/positions.ts, fund/series.ts) --------

_DAY0 = date(2013, 1, 1)


def _years(day: date) -> float:
    return (day - _DAY0).days / 365


def site_irr(flows: list[tuple[float, float]]) -> float | None:
    """live.irr: bisection on [-0.99, 10], 200 iterations; None without a sign change."""
    if not all(math.isfinite(t) and math.isfinite(a) for t, a in flows):
        return None
    if not (any(a < 0 for _, a in flows) and any(a > 0 for _, a in flows)):
        return None

    def npv(rate: float) -> float:
        return sum(a / (1 + rate) ** t for t, a in flows)

    lo_, hi = -0.99, 10.0
    f_lo, f_hi = npv(lo_), npv(hi)
    if f_lo == 0:
        return lo_
    if f_hi == 0:
        return hi
    if math.copysign(1, f_lo) == math.copysign(1, f_hi):
        return None
    sign = math.copysign(1, f_lo)
    for _ in range(200):
        mid = (lo_ + hi) / 2
        f = npv(mid)
        if f == 0:
            return mid
        if math.copysign(1, f) == sign:
            lo_ = mid
        else:
            hi = mid
    return (lo_ + hi) / 2


def shares_at(pos: PositionResult, q: int) -> float:
    """positions.sharesAt: the shares after the last trade up to quarter q."""
    shares = 0.0
    for t in pos.trades:
        if t.q > q:
            break
        shares = t.shares_after
    return shares if shares > 1e-6 else 0.0


def position_irr(pos: PositionResult, fi: FundInputs, price: float | None) -> float | None:
    """buildRows' IRR at the newest quarter (period_q): positionFlows of the trades up to it."""
    trades = [t for t in pos.trades if t.q <= fi.period_q]
    held = shares_at(pos, fi.period_q)
    if held > 0 and price is None:
        return None
    flows = [(_years(mid_quarter(t.q)), -t.delta * t.px) for t in trades]
    if held > 0:
        flows.append((_years(fi.latest_date), held * price))
    return site_irr(flows)


def held_irr(pos: PositionResult, fi: FundInputs, price: float | None) -> float | None:
    """buildSaleRows' irrHeld: heldFlows, every bought share at the latest price."""
    if price is None:
        return None
    buys = [t for t in pos.trades if t.delta > 0]
    flows = [(_years(mid_quarter(t.q)), -t.delta * t.px) for t in buys]
    flows.append((_years(fi.latest_date), sum(t.delta for t in buys) * price))
    return site_irr(flows)


def last_change(positions: list[PositionResult], fi: FundInputs, prices: dict) -> dict:
    """buildRows' tag and dw at the newest quarter: stock_id -> (tag, dw)."""
    q = fi.period_q
    rows, vb = {}, 0.0
    for pos in positions:
        a, b = shares_at(pos, q), shares_at(pos, q - 1)
        px = prices.get(pos.stock_id)
        rows[pos.stock_id] = (a, b, px)
        if px is not None:
            vb += b * px
    out = {}
    for sid, (a, b, px) in rows.items():
        if a == 0 and b == 0:
            tag = None
        elif b <= 1e-6:
            tag = "new"
        elif a <= 1e-6:
            tag = "exit"
        elif a > b * 1.000001:
            tag = "add"
        elif a < b * 0.999999:
            tag = "trim"
        else:
            tag = None
        dw = None
        if px is not None and tag is not None:
            big_a, big_b = a * px, b * px
            den = vb - big_b + big_a
            dw = ((big_a / den if den > 0 else 0) - (big_b / vb if vb > 0 else 0)) * 100
        out[sid] = (tag, dw)
    return out


def total_pnl(pos: PositionResult, price: float | None) -> float | None:
    """live.totalPnl."""
    if pos.shares_now == 0:
        return pos.realised + pos.dividends
    if price is None:
        return None
    return pos.realised + pos.shares_now * price - pos.cost_now + pos.dividends


# --- the checks -------------------------------------------------------------------------------


@pytest.mark.libreoffice
def test_all_checks_pass(cases, computed):
    assert len(CHECKS) == len({c.measure for c in CHECKS}) == 57
    for key in real(cases):
        read = Read(cases[key], computed[key])
        failed = [c.measure for c in CHECKS if read.check(c.measure) != "PASS"]
        assert not failed, (key, failed)
        # every difference cell is counted: 8 quarter rows, 7 year rows, 22 Summary figures,
        # points and P&L per stock and year, 18 Outputs columns per stock
        fi = cases[key].fi
        n_q, n_y, n_s = fi.end_q - fi.start + 1, len(fi.years), len(fi.stocks)
        compared = sum(read.check(c.measure, "compared") for c in CHECKS)
        assert compared == 8 * n_q + 7 * n_y + 22 + 2 * n_s * n_y + 18 * n_s, key
        assert read.summary("fails") == 0 and read.summary("overall") == "PASS", key


@pytest.mark.libreoffice
def test_a_broken_formula_fails_a_check(cases, computed):
    read = Read(cases["broken"], computed["broken"])
    failed = [c.measure for c in CHECKS if read.check(c.measure) != "PASS"]
    assert failed == ["Stock: avg cost"]
    assert read.check("Stock: avg cost", "max") == pytest.approx(0.01 / 1.01, rel=1e-6)
    assert read.summary("fails") == 1 and read.summary("overall") == "FAIL"
    # a figure only one side has fails outright
    read = Read(cases["emptied"], computed["emptied"])
    assert [c.measure for c in CHECKS if read.check(c.measure) != "PASS"] == [
        "Stock: one-year return"
    ]
    assert read.check("Stock: one-year return", "max") == 1e300
    assert read.summary("overall") == "FAIL"


# --- Outputs ----------------------------------------------------------------------------------


@pytest.mark.libreoffice
def test_outputs_equal_published_fields(cases, computed):
    numeric = 0
    for key in real(cases):
        case, read = cases[key], Read(cases[key], computed[key])
        out = case.r.output
        positions = {pos.stock_id: pos for pos in out.positions}
        exits = {row.stock_id: row for row in out.exits}
        for st in case.fi.stocks:
            sid, pos, ex = st.stock_id, positions.get(st.stock_id), exits.get(st.stock_id)
            scale, where = lo.stock_scale(pos), f"{key} {st.stock_id}"

            def money(column, want, read=read, sid=sid, scale=scale, where=where):
                lo.assert_money(read.out(column, sid), want, scale, f"{where} {column}")

            def ratio(column, want, read=read, sid=sid, where=where):
                lo.assert_ratio(read.out(column, sid), want, f"{where} {column}")

            def exact(column, want, read=read, sid=sid, where=where):
                lo.assert_exact(read.out(column, sid), want, f"{where} {column}")

            last = _last_change(pos) if pos else (None, None, None, None)
            ratio("avg_cost", pos and pos.avg_cost)
            ratio("avg_exit", pos and pos.avg_exit)
            for column in ("invested", "realised", "dividends", "shares_now", "cost_now"):
                money(column, pos and getattr(pos, column))
            exact("from_q", pos and pos.from_q)
            exact("to_q", pos and pos.to_q)
            exact("last_q", last[0])
            exact("last_type", last[1])
            ratio("last_pct", last[2])
            money("last_usd", last[3])
            money("sold_shares", ex and ex.sold_shares)
            money("sold_usd", ex and ex.sold_usd)
            exact("last_sale_q", ex and ex.last_sale_q)
            ratio("one_y", ex and ex.one_y)
            ratio("spy_one_y", ex and ex.spy_one_y)
            exact("status", ex and {"sold_all": "Sold all", "trimmed": "Trimmed"}[ex.status])
            numeric += ex is not None and ex.one_y is not None
            if pos:  # Shares now is C5 in end_q's column
                c5 = read.model("C5", sid, case.fi.end_q)
                lo.assert_money(c5, pos.shares_now, scale, where)
    assert numeric > 50


@pytest.mark.libreoffice
def test_outputs_follow_the_site_rules(cases, computed):
    # the figures only the site computes: as live.ts / positions.ts / whatif.ts
    irrs = 0
    for key in real(cases):
        case, read = cases[key], Read(cases[key], computed[key])
        fi, out = case.fi, case.r.output
        positions = {pos.stock_id: pos for pos in out.positions}
        prices = latest_prices(cases, key)
        kept = [positions[st.stock_id] for st in fi.stocks if st.stock_id in positions]
        changes = last_change(out.positions, fi, prices)  # the cut's positions included
        value_total = sum(pos.shares_now * prices.get(pos.stock_id, 0.0) for pos in out.positions)
        for pos in kept:
            sid, price, where = pos.stock_id, prices.get(pos.stock_id), f"{key} {pos.stock_id}"
            scale = lo.stock_scale(pos)
            value = None if price is None else pos.shares_now * price
            value = 0.0 if pos.shares_now == 0 else value
            lo.assert_money(read.out("value_now", sid), value, scale, f"{where} value")
            total = total_pnl(pos, price)
            lo.assert_money(read.out("total_pnl", sid), total, scale, f"{where} total")
            ret = total / pos.invested if total is not None and pos.invested > 0 else None
            lo.assert_ratio(read.out("ret", sid), ret, f"{where} ret")
            weight = (value or 0.0) / value_total if value_total > 0 else 0.0
            lo.assert_ratio(read.out("weight", sid), weight, f"{where} weight")
            tag, dw = changes[sid]
            lo.assert_exact(read.out("lc_tag", sid), tag, f"{where} tag")
            lo.assert_ratio(read.out("lc_dw", sid), dw, f"{where} dw")
            want = position_irr(pos, fi, price)
            got = read.out("irr", sid)
            assert (got is None) == (want is None), (where, got, want)
            if want is not None:
                assert abs(got - want) <= IRR_TOL, (where, got, want)
                irrs += 1
            if pos.sold_shares > 0:
                since = price / pos.avg_exit - 1 if price is not None else None
                lo.assert_ratio(read.out("since_sale", sid), since, f"{where} since")
                missed = pos.sold_shares * price - pos.sold_usd if price is not None else None
                lo.assert_money(read.out("missed", sid), missed, scale, f"{where} missed")
                want = held_irr(pos, fi, price)
                got = read.out("irr_held", sid)
                assert (got is None) == (want is None), (where, got, want)
                if want is not None:
                    assert abs(got - want) <= IRR_TOL, (where, got, want)
            else:
                for column in ("since_sale", "missed", "irr_held", "status"):
                    assert read.out(column, sid) is None, (where, column)
        # % profitable over every position, the cut's included (live.profitablePct)
        totals = [total_pnl(pos, prices.get(pos.stock_id)) for pos in out.positions]
        known = [t for t in totals if t is not None]
        want = sum(t > 0 for t in known) / len(known) if known else None
        lo.assert_ratio(read.summary("profitable"), want, f"{key} profitable")
    assert irrs > 150


@pytest.mark.libreoffice
def test_irr_through_empty_cells_after_end_q(cases, computed):
    # the inactive fund's flows run to Latest across quarter cells never written (R8):
    # LibreOffice's XIRR takes them as no flow and gives the site's answer
    case, read = cases[str(INACTIVE)], Read(cases[str(INACTIVE)], computed[str(INACTIVE)])
    fi = case.fi
    model = workbook_map(fi).model
    assert fi.bound > fi.end_q
    raw = openpyxl.load_workbook(case.path)["Model"]
    for q in range(fi.end_q + 1, fi.bound + 1):
        assert raw[model.cell("C17", fi.stocks[0].stock_id, q)].value is None
    numeric = 0
    for pos in case.r.output.positions:
        price = next(st.close_latest for st in fi.stocks if st.stock_id == pos.stock_id)
        want, got = position_irr(pos, fi, price), read.out("irr", pos.stock_id)
        assert (got is None) == (want is None) and (want is None or abs(got - want) <= IRR_TOL)
        numeric += want is not None and pos.shares_now > 0
    assert numeric >= 3  # held positions: the last flow sits in Latest, after the empty cells


@pytest.mark.libreoffice
def test_irr_blank_cases(cases, computed):
    # Review Focus 4, on hand-edited inputs
    case, read = cases["irr"], Read(cases["irr"], computed["irr"])
    _, ids = _irr_inputs(cases[str(RANGE_CIK)].fi, case.r)
    assert read.out("shares_now", ids["held"]) > 0
    assert read.out("latest_price", ids["held"]) is None
    assert read.out("irr", ids["held"]) is None  # held, no latest price
    assert read.out("value_now", ids["held"]) is None and read.out("irr_held", ids["held"]) is None
    fast = ids["fast"]  # bought at 1 and sold at 3 a quarter later
    assert read.out("last_sale_px", fast) == 3.0 and read.out("avg_cost", fast) == 1.0
    trades = ((case.fi.start + 2, -1000.0), (case.fi.start + 3, 3000.0))
    flows = [(_years(mid_quarter(q)), cash) for q, cash in trades]
    assert site_irr(flows) is None  # above 1,000%: the site's search finds none
    assert read.out("irr", fast) is None
    sold = ids["sold"]  # sold out: numeric, the last flow 0
    pos = next(p for p in case.r.output.positions if p.stock_id == sold)
    price = next(st.close_latest for st in case.fi.stocks if st.stock_id == sold)
    got, want = read.out("irr", sold), position_irr(pos, case.fi, price)
    assert isinstance(got, float) and want is not None and abs(got - want) <= IRR_TOL
    assert read.model("C17", sold, "latest") == 0


@pytest.mark.libreoffice
def test_carried_last_quarter(cases, computed):
    # Review Focus 2: Saltglass's last held quarter is the carried copy after its last filing
    case, read = cases[str(CARRIED)], Read(cases[str(CARRIED)], computed[str(CARRIED)])
    fi, out = case.fi, case.r.output
    assert fi.end_q == fi.period_q + 1
    assert read.summary("period_q") == fi.period_q
    assert read.summary("period_label") == q_label(fi.period_q)
    prices = {st.stock_id: st.close_latest for st in fi.stocks if st.close_latest is not None}
    changes = last_change(out.positions, fi, prices)
    tagged = 0
    for pos in out.positions:
        sid, where = pos.stock_id, f"carried {pos.stock_id}"
        scale = lo.stock_scale(pos)
        lo.assert_money(read.out("lc_now", sid), shares_at(pos, fi.period_q), scale, where)
        lo.assert_money(read.out("lc_before", sid), shares_at(pos, fi.period_q - 1), scale, where)
        tag, dw = changes[sid]
        lo.assert_exact(read.out("lc_tag", sid), tag, where)
        lo.assert_ratio(read.out("lc_dw", sid), dw, where)
        tagged += tag is not None
        lo.assert_money(read.out("shares_now", sid), pos.shares_now, scale, where)
        lo.assert_money(read.model("C5", sid, fi.end_q), pos.shares_now, scale, where)
    assert tagged


# --- Summary ----------------------------------------------------------------------------------


@pytest.mark.libreoffice
def test_summary_metrics_equal_engine(cases, computed):
    for key in real(cases):
        case, read = cases[key], Read(cases[key], computed[key])
        out = case.r.output
        m, ex, meta = out.metrics, out.exits_summary, out.meta
        for item in (
            "ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "quarters_pos_pct",
            "turnover", "hold_all", "hold_sold",
        ):  # fmt: skip
            lo.assert_ratio(read.summary(item), m[item], f"{key} {item}")
        for side in ("best_year", "worst_year"):
            year = m[side]
            lo.assert_exact(read.summary(side), year and int(year["label"]), f"{key} {side}")
            lo.assert_ratio(read.summary(f"{side}_ret"), year and year["ret"], f"{key} {side}")
        lo.assert_exact(read.summary("years_pos"), m["years_pos"], f"{key} years_pos")
        lo.assert_exact(read.summary("years_total"), m["years_total"], f"{key} years_total")
        lo.assert_ratio(read.summary("buys_12m"), ex.buys_12m, f"{key} buys")
        lo.assert_ratio(read.summary("sells_12m"), ex.sells_12m, f"{key} sells")
        lo.assert_ratio(read.summary("beat_spy_pct"), ex.beat_spy_pct, f"{key} beat")
        scale = lo.quarter_scale(out.quarters[-1])
        lo.assert_money(read.summary("book"), meta.book, scale, f"{key} book")
        lo.assert_exact(read.summary("n_holdings"), meta.n_holdings, f"{key} holdings")
        lo.assert_ratio(read.summary("priced_pct"), meta.priced_pct, f"{key} priced")
        lo.assert_exact(read.summary("positions_ever"), len(out.positions), f"{key} ever")
        # the Orca cells beside them hold the engine's own figures
        lo.assert_ratio(read.summary("sharpe", "orca"), m["sharpe"], f"{key} orca sharpe")


@pytest.mark.libreoffice
def test_range_inputs_default_to_the_years_with_a_return(cases, computed):
    for key in real(cases):
        case, read = cases[key], Read(cases[key], computed[key])
        years = [BASE_YEAR + fq.q // 4 for fq in case.r.output.quarters if fq.ret is not None]
        assert (read.summary("from_year"), read.summary("to_year")) == (years[0], years[-1])
        # with the whole period in range, the range tiles are the whole-period figures
        lo.assert_ratio(read.summary("r_ann"), case.r.output.metrics["ann_return"], key)
        lo.assert_ratio(read.summary("r_vol"), case.r.output.metrics["vol"], key)
        lo.assert_ratio(read.summary("r_mdd"), case.r.output.metrics["max_dd"], key)
    book = openpyxl.load_workbook(cases[str(RANGE_CIK)].path)
    summary = workbook_map(cases[str(RANGE_CIK)].fi).summary
    for name, item in (("FromYear", "from_year"), ("ToYear", "to_year")):
        target = book.defined_names[name].attr_text.replace("$", "")
        assert target == f"Summary!{summary.cell(item)}"
        assert book["Summary"][summary.cell(item)].font.color.rgb == BLUE


@pytest.mark.libreoffice
def test_range_tiles_follow_from_to(cases, computed):
    # spanKpi's maths on the quarterly returns of 2016-2019 (web/src/fund/series.ts)
    case, read = cases["range"], Read(cases["range"], computed["range"])
    lo_year, hi_year = RANGE
    assert (read.summary("from_year"), read.summary("to_year")) == RANGE
    quarters = case.r.output.quarters
    rets = [
        fq.ret
        for fq in quarters
        if fq.ret is not None and lo_year <= BASE_YEAR + fq.q // 4 <= hi_year
    ]
    n = len(rets)
    growth = math.prod(1 + x for x in rets)
    mean = sum(rets) / n
    sd = math.sqrt(max(0.0, (sum(x * x for x in rets) - n * mean * mean) / (n - 1)))
    index, peak, worst = 1.0, 1.0, 0.0
    for x in rets:
        index *= 1 + x
        peak = max(peak, index)
        worst = min(worst, index / peak - 1)
    assert n == 16
    lo.assert_ratio(read.summary("r_ann"), max(growth, 0) ** (4 / n) - 1, "ann")
    lo.assert_ratio(read.summary("r_vol"), sd * 2, "vol")
    lo.assert_ratio(read.summary("r_growth"), growth, "growth")
    lo.assert_ratio(read.summary("r_mdd"), worst, "mdd")
    lo.assert_ratio(read.summary("r_qpos"), sum(x > 0 for x in rets) / n, "qpos")
    lo.assert_exact(read.summary("r_n"), n, "n")
    full = [y for y in case.r.output.years if len(y.qs) == 4 and y.ret is not None
            and all(fq.ret is not None for fq in quarters if fq.q in y.qs)
            and lo_year <= int(y.label) <= hi_year]  # fmt: skip
    lo.assert_exact(read.summary("r_full_years"), len(full), "full years")
    lo.assert_exact(read.summary("r_years_pos"), sum(y.ret > 0 for y in full), "years pos")
    # the whole-period figures do not move with the range
    lo.assert_ratio(read.summary("ann_return"), case.r.output.metrics["ann_return"], "whole")


# --- the file ---------------------------------------------------------------------------------


def test_output_columns_and_styles(cases):
    ids = [c.id for c in OUTPUT_COLUMNS]
    assert len(ids) == len(set(ids))
    orca = [c.id for c in OUTPUT_COLUMNS if c.id.startswith("orca_")]
    assert len(orca) == 18
    for column in orca:  # every Orca column has its difference cell beside it
        assert ids[ids.index(column) + 1] == "diff_" + column.removeprefix("orca_")
    case = cases["9100001"]
    wm, book = workbook_map(case.fi), openpyxl.load_workbook(case.path)
    ws = book["Outputs"]
    sid = case.fi.stocks[0].stock_id

    def colour(column):
        return ws[wm.outputs.cell(column, sid)].font.color.rgb

    assert colour("orca_avg_cost") == BLUE  # Orca's figures are inputs
    assert colour("invested") == GREEN  # reads Model
    assert colour("avg_cost") == BLACK  # reads its own tab only
    assert ws[wm.outputs.cell("ticker", sid)].value == case.fi.stocks[0].ticker
    titles = wm.outputs.first - 2  # every column's name and units above the stocks
    for column in OUTPUT_COLUMNS:
        letter = re.sub(r"\d", "", wm.outputs.cell(column.id, sid))
        assert ws[f"{letter}{titles}"].value == column.name, column.id
        assert ws[f"{letter}{titles + 1}"].value == (column.units or None), column.id
    model = book["Model"]
    o_start = wm.model.cell("o_start", None, case.fi.start + 1)
    assert model[o_start].font.color.rgb == BLUE
    summary = book["Summary"]
    assert summary[wm.summary.cell("sharpe")].font.color.rgb == GREEN
    for tile, label in (("r_ann", "Annualised return"), ("r_vol", "Volatility"),
                        ("t_sortino", "Sortino"), ("profitable", "Positions profitable")):
        row, col = wm.summary.at[tile]  # the tile's label sits above its value
        assert summary.cell(row - 1, col + 1).value == label, tile


def test_built_formulas_use_allowed_functions_only(cases, tmp_path, monkeypatch):
    # every formula a build writes, on every tab: only the portable functions, IFERROR only
    # around XIRR, never an error constant
    built = built_formulas(cases, tmp_path, monkeypatch)
    for formula in built:
        used = {token[:-1] for token in re.findall(r"[A-Z][A-Z0-9.]*\(", formula)}
        assert used <= ALLOWED_FUNCTIONS, formula
        for at in [m.end() for m in re.finditer(r"IFERROR\(", formula)]:
            assert formula[at:].startswith("IF(AND(XIRR("), formula
        bare = re.sub(r'"[^"]*"', '""', formula)  # text such as "Sold all" aside
        assert "#" not in bare and " " not in bare, formula


def test_a_row_above_the_last_written_is_refused(tmp_path):
    # constant memory drops a write to a row once a later row is written: refuse it instead
    book = xlsxwriter.Workbook(str(tmp_path / "x.xlsx"), {"constant_memory": True})
    writer = TabWriter(book.add_worksheet("T"), Formats(book))
    writer.text(2, 0, "names")
    writer.text(3, 0, "units")
    with pytest.raises(RuntimeError, match="row 2 written after row 3"):
        writer.text(2, 1, "a name too late")
    book.close()
