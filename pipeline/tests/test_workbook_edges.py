"""The workbook on the hard branches: small hand-built funds (workbook_fixtures) run through the
real pipeline, built into a workbook, recalculated by LibreOffice, every check PASS, and each
case's own cells equal to numbers worked out here by hand from the case's inputs (never read
back from the workbook's formulas). Also the 500 cut end to end (Seastack, and an inactive fund
that is cut) and the size and time of a 500-stock, 54-quarter file."""

import time
from dataclasses import dataclass
from pathlib import Path

import lo
import openpyxl
import pytest
from conftest import demo_batch
from test_workbook_outputs import Read, position_irr
from workbook_fixtures import edge_cases, synthetic_inputs

from orca.run.compute import FundResult, Prepared
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.build import build_workbook, file_name, workbook_map
from orca.workbook.inputs import FundInputs, build_inputs, validate
from orca.workbook.layout import BLOCKS, CHECKS, OTHER_ROWS, SUMMARY_CHECKED
from orca.workbook.model import OTHER_NAME, OTHER_STOCK

CUT_CIK, CUT_KEEP = 9100009, 3  # Seastack (18-24 positions) cut to 3 stock rows
INACTIVE_CIK, INACTIVE_KEEP = 9100010, 6  # Cobblereef: last filed Q4 2023, cut to 6 stock rows
ZERO_AFTER_END = {"C17", "C18"}  # the cash flows: the only stock blocks with a value after end_q
BLUE = "FF0000FF"
MAX_SECONDS, MAX_BYTES = 60, 15 * 1024 * 1024  # spec 7.5


@dataclass(frozen=True)
class Case:
    fi: FundInputs
    p: Prepared
    r: FundResult
    path: Path


@pytest.fixture(scope="module")
def cases(demo_run, tmp_path_factory) -> dict[str, Case]:
    """The hand-built funds (workbook_fixtures.edge_cases) and two demo funds cut: Seastack to 3
    rows ("cut") and the inactive Cobblereef to 6 ("inactive_cut"), each built into a workbook."""
    root = tmp_path_factory.mktemp("edges")
    out = root / "workbooks"
    out.mkdir()
    built: dict[str, Case] = {}

    def add(key: str, fi: FundInputs, p: Prepared, r: FundResult) -> None:
        path = out / f"{key}-{file_name(fi)}"
        build_workbook(fi, path)
        built[key] = Case(fi, p, r, path)

    for key, b in edge_cases(root / "pipeline").items():
        add(key, b.fi, b.p, b.r)
    ctx, batch = demo_batch(demo_run, [CUT_CIK, INACTIVE_CIK])
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    for p, r in batch:
        key, keep = ("cut", CUT_KEEP) if p.cik == CUT_CIK else ("inactive_cut", INACTIVE_KEEP)
        add(key, build_inputs(ctx, p, r, latest, securities, max_positions=keep), p, r)
    return built


@pytest.fixture(scope="module")
def computed(cases, tmp_path_factory) -> dict[str, dict]:
    lo.require_libreoffice()
    out = tmp_path_factory.mktemp("recalculated")
    paths = lo.recalc_all([case.path for case in cases.values()], out)
    return {key: lo.values(path) for key, path in zip(cases, paths, strict=True)}


class Fund:
    """One built case after LibreOffice: its cells by ticker, and its checks."""

    def __init__(self, key: str, case: Case, values: dict) -> None:
        self.key, self.case, self.fi = key, case, case.fi
        self.read = Read(case, values)
        self.id = {st.ticker: st.stock_id for st in case.fi.stocks}

    def passes(self) -> None:
        """Every check PASS, none vacuous, the Summary says so."""
        read, fi = self.read, self.fi
        failed = [c.measure for c in CHECKS if read.check(c.measure) != "PASS"]
        assert not failed, (self.key, failed)
        assert read.check("Quarter: end", "compared") == fi.end_q - fi.start + 1, self.key
        assert read.summary("fails") == 0 and read.summary("overall") == "PASS", self.key

    def model(self, block: str, ticker: str | None, quarters, want: list) -> None:
        """Model row `block` of the stock `ticker` (None: a fund row) over `quarters` equals
        `want`, where None is a blank cell."""
        sid = None if ticker is None else self.id[ticker]
        got = [self.read.model(block, sid, q) for q in quarters]
        self.same(got, want, f"{self.key} {block} {ticker}")

    def out(self, ticker: str, **want) -> None:
        """Outputs columns of the stock `ticker` equal `want` (column id -> value, None blank)."""
        for column, value in want.items():
            self.same([self.read.out(column, self.id[ticker])], [value], f"{ticker} {column}")

    def summary(self, **want) -> None:
        for item, value in want.items():
            self.same([self.read.summary(item)], [value], f"{self.key} {item}")

    @staticmethod
    def same(got: list, want: list, where: str) -> None:
        assert len(got) == len(want), where
        for i, (g, w) in enumerate(zip(got, want, strict=True)):
            if w is None or isinstance(w, str):
                assert g == w, (where, i, g)
            else:
                assert isinstance(g, (int, float)) and not isinstance(g, bool), (where, i, g)
                assert g == pytest.approx(w, rel=1e-9, abs=1e-9), (where, i, g, w)


@pytest.fixture(scope="module")
def funds(cases, computed) -> dict[str, Fund]:
    return {key: Fund(key, case, computed[key]) for key, case in cases.items()}


Q42_45 = range(42, 46)  # Q3 2023 .. Q2 2024 (45 is the deadline quarter)
Q43_45 = range(43, 46)

# --- the hand-built funds ---------------------------------------------------------------------


@pytest.mark.libreoffice
def test_reported_value_fallback(funds):
    # BRAV has no prices; the fund reports 5,000 for 100 shares, 5,500 for 100 and 12,000 for 200
    f = funds["reported_value"]
    f.passes()
    f.model("C3", "BRAV", Q43_45, [5000 / 100, 5500 / 100, 12000 / 200])  # value per share
    f.model("C4", "BRAV", Q43_45, [50, 55, 60])  # valued at it
    f.model("C5", "BRAV", Q43_45, [100, 100, 200])
    f.model("C8", "BRAV", Q43_45, [50, None, 60])  # trades at it (no VWAP, no earlier close)
    f.model("C9", "BRAV", Q43_45, [100 * 50, 0, 100 * 60])
    f.model("C10", "BRAV", Q43_45, [0, 100 * (55 - 50), 100 * (60 - 55)])
    f.model("C11", "BRAV", Q43_45, [0, 0, 0])  # traded at the valuation price: no gain
    f.model("C14", "BRAV", Q43_45, [5000, 5000, 5000 + 6000])
    f.model("C16", "BRAV", Q43_45, [5000, 5500, 12000])
    # no latest close: the position is held but cannot be valued at latest prices
    f.out("BRAV", shares_now=200, invested=11_000, avg_cost=11_000 / 200, from_q=43, weight=0)
    f.out("BRAV", latest_price=None, value_now=None, total_pnl=None, ret=None, irr=None)
    # ALFA: 1,000 shares bought at 10, a latest close of 13
    f.out("ALFA", latest_price=13, value_now=13_000, total_pnl=3_000, ret=0.3)
    f.summary(book=12_000 + 12_000, n_holdings=2, positions_ever=2, priced_pct=1.0,
              profitable=1.0)  # fmt: skip


@pytest.mark.libreoffice
def test_never_priced_stock(funds):
    # CHAR is filed with 500 shares and no value, and has no prices: zero rows, not a position.
    # A bond makes the fund's reported value 13,000 / 14,000 / 15,000 against ALFA's 10,000 /
    # 11,000 / 12,000.
    f = funds["never_priced"]
    f.passes()
    fi = f.fi
    assert [st.ticker for st in fi.stocks] == ["ALFA", "CHAR"]  # after the ranked, by stock id
    assert f.id["CHAR"] not in {pos.stock_id for pos in f.case.r.output.positions}
    assert fi.orca_stocks[1].shares_now is None and fi.orca_stocks[1].from_q is None
    assert fi.total_reported == [13_000, 14_000, 15_000]
    f.model("I1", "CHAR", Q43_45, [500, 500, 500])  # filed
    f.model("C1", "CHAR", Q43_45, [500, 500, 500])
    f.model("C4", "CHAR", Q43_45, [None] * 3)  # nothing to value it at
    for block in ("C5", "C6", "C7", "C9", "C14", "C16"):
        f.model(block, "CHAR", Q43_45, [0] * 3)  # rows of zeros
    f.model("C8", "CHAR", Q43_45, [None] * 3)
    blank = dict.fromkeys(("from_q", "shares_now", "avg_cost", "invested", "value_now", "weight",
                           "irr", "total_pnl", "hold"))  # fmt: skip
    f.out("CHAR", **blank)
    # never among the positions; its (zero) filed value is in % priced: 12,000 of 15,000
    f.summary(positions_ever=1, n_holdings=1, book=12_000, priced_pct=12_000 / 15_000)


@pytest.mark.libreoffice
def test_priced_later_enters_at_close(funds):
    # BRAV: 1,000 shares filed from Q3 2023 with no value and no prices; priced from Q1 2024,
    # where its close is 20 and its VWAP 18
    f = funds["priced_later"]
    f.passes()
    f.model("C1", "BRAV", Q42_45, [1000] * 4)  # filed all along
    f.model("C4", "BRAV", Q42_45, [None, None, 20, 22])  # cannot be valued before
    f.model("C5", "BRAV", Q42_45, [0, 0, 1000, 1000])  # out of the book until priced
    f.model("C6", "BRAV", Q42_45, [0, 0, 1, 1])
    f.model("C7", "BRAV", Q42_45, [0, 0, 1000, 0])
    f.model("C8", "BRAV", Q42_45, [None, None, 20, None])  # at the close, not the VWAP of 18
    sid = f.id["BRAV"]
    assert f.read.model("I5", sid, 44) == 18 and f.read.model("I4", sid, 44) == 20
    assert f.read.model("C8", sid, 44) == f.read.model("I4", sid, 44)  # C8 = I4
    f.model("C9", "BRAV", Q42_45, [0, 0, 1000 * 20, 0])
    f.model("C10", "BRAV", Q42_45, [0, 0, 0, 1000 * (22 - 20)])
    f.model("C11", "BRAV", Q42_45, [0, 0, 0, 0])  # bought at the close it is valued at
    f.model("C14", "BRAV", Q42_45, [0, 0, 20_000, 20_000])
    f.out("BRAV", from_q=44, invested=20_000, avg_cost=20, shares_now=1000, hold=2 / 4,
          last_q=44, last_type="new")  # fmt: skip


@pytest.mark.libreoffice
def test_delisted_uses_last_close(funds):
    # CHAR: 100 shares bought in Q3 2023 at the close of 30; its last close is 25 (end of Q4
    # 2023); still filed in Q1 2024 (reported at 20 a share, which is not its price); gone in
    # Q2 2024
    f = funds["delisted"]
    f.passes()
    f.model("C2", "CHAR", Q42_45, [30, 25, 25, 25])
    f.model("C4", "CHAR", Q42_45, [30, 25, 25, 25])  # valued at the last close afterwards
    f.model("C5", "CHAR", Q42_45, [100, 100, 100, 0])
    f.model("C7", "CHAR", Q42_45, [100, 0, 0, -100])
    f.model("C8", "CHAR", Q42_45, [30, None, None, 25])  # the exit trades at the last close
    f.model("C10", "CHAR", Q42_45, [0, 100 * (25 - 30), 0, 0])
    f.model("C15", "CHAR", Q42_45, [0, 0, 0, 100 * (25 - 30)])  # realised on 3,000 of cost
    f.model("C16", "CHAR", Q42_45, [3000, 2500, 2500, 0])
    f.out("CHAR", shares_now=0, to_q=45, avg_cost=30, avg_exit=25, realised=-500, sold_shares=100,
          sold_usd=2_500, latest_price=25, value_now=0, total_pnl=-500, since_sale=0, missed=0,
          status="Sold all")  # fmt: skip


@pytest.mark.libreoffice
def test_exit_and_reentry(funds):
    # DELT: bought in Q3 2023 (a first report: the close of 50), held, gone in Q1 2024 (sold at
    # the VWAP of 61), bought again in Q2 2024 (150 shares): not a first report, so the VWAP of
    # 66, not the close of 65
    f = funds["exit_and_reentry"]
    f.passes()
    f.model("C5", "DELT", Q42_45, [200, 200, 0, 150])
    f.model("C7", "DELT", Q42_45, [200, 0, -200, 150])
    f.model("C8", "DELT", Q42_45, [50, None, 61, 66])
    f.model("C9", "DELT", Q42_45, [200 * 50, 0, -200 * 61, 150 * 66])
    f.model("C14", "DELT", Q42_45, [10_000, 10_000, 0, 9_900])
    f.model("C15", "DELT", Q42_45, [0, 0, 200 * (61 - 50), 0])
    f.model("C11", "DELT", Q42_45, [0, 0, -200 * (60 - 61), 150 * (65 - 66)])
    f.model("C16", "DELT", Q42_45, [10_000, 11_000, 0, 150 * 65])
    f.out("DELT", from_q=42, to_q=None, shares_now=150, invested=10_000 + 9_900,
          avg_cost=19_900 / 350, avg_exit=61, realised=2_200, sold_shares=200, sold_usd=12_200,
          last_q=45, last_type="new")  # fmt: skip


@pytest.mark.libreoffice
def test_dividends_on_shares_at_start(funds):
    # ALFA: 100 shares, 150 in Q1 2024 (dividend 0.5 a share in that quarter, VWAP 21), 60 in
    # Q2 2024 (dividend 0.25, VWAP 23); closes 20, 22, 24
    f = funds["dividends"]
    f.passes()
    f.model("I6", "ALFA", Q43_45, [0, 0.5, 0.25])
    f.model("C5", "ALFA", Q43_45, [100, 150, 60])
    f.model("C12", "ALFA", Q43_45, [0, 100 * 0.5, 150 * 0.25])  # the shares at the quarter's start
    f.model("dividends", None, Q43_45, [0, 50, 37.5])
    f.out("ALFA", dividends=50 + 37.5)
    # return = (End - Start - Net buying + Dividends) / (Start + Net buying / 2). Q1 2024: Start
    # 100 x 20, End 150 x 22, 50 bought at the VWAP of 21 (net buying 1,050), dividends 50.
    # Q2 2024: Start 3,300, End 60 x 24, 90 sold at the VWAP of 23 (net buying -2,070), dividends
    # 37.5
    ret_44 = (3_300 - 2_000 - 1_050 + 50) / (2_000 + 1_050 / 2)
    ret_45 = (1_440 - 3_300 + 2_070 + 37.5) / (3_300 - 2_070 / 2)
    f.model("ret", None, Q43_45, [None, ret_44, ret_45])
    assert ret_44 == pytest.approx(300 / 2_525) and ret_45 == pytest.approx(247.5 / 2_265)


@pytest.mark.libreoffice
def test_split_is_no_trade(funds):
    # ALFA splits 2 for 1 in Q1 2024: 100 shares filed for Q4 2023 are 200 on today's basis, the
    # 200 filed after are 200; the closes on today's basis are 10, 11, 12 (20 before the split)
    f = funds["split"]
    f.passes()
    f.model("I1", "ALFA", Q43_45, [100, 200, 200])
    f.model("I3", "ALFA", Q43_45, [2, 1, 1])  # the split after Q4 2023 only
    f.model("I4", "ALFA", Q43_45, [10, 11, 12])
    f.model("C1", "ALFA", Q43_45, [200, 200, 200])
    f.model("C7", "ALFA", Q43_45, [200, 0, 0])  # the split trades nothing
    f.model("C8", "ALFA", Q43_45, [10, None, None])
    f.model("C10", "ALFA", Q43_45, [0, 200 * (11 - 10), 200 * (12 - 11)])
    f.model("C16", "ALFA", Q43_45, [2_000, 2_200, 2_400])
    f.model("ret", None, Q43_45, [None, 200 / 2_000, 200 / 2_200])
    f.out("ALFA", shares_now=200, invested=2_000, avg_cost=10, realised=0, value_now=2_600)


@pytest.mark.libreoffice
@pytest.mark.parametrize(
    ("key", "n", "growth", "hold"),
    [("returns_2", 2, 12 / 10, 3 / 4), ("returns_3", 3, 13 / 10, 4 / 4)],
)
def test_fewer_than_four_returns(funds, key, n, growth, hold):
    # ALFA alone at 10, 11, 12 (, 13) with 1,000 shares: 3 quarters give 2 returns, 4 give 3.
    # Nothing is annualised or rated, so Orca has none of these and neither has the workbook
    f = funds[key]
    f.passes()
    read = f.read
    blank_items = ("ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar",
                   "quarters_pos_pct", "best_year", "best_year_ret", "worst_year",
                   "worst_year_ret", "years_pos", "years_total", "turnover")  # fmt: skip
    for measure, item, _ in SUMMARY_CHECKED:
        if item in blank_items:
            assert read.summary(item) is None, (key, item)
            assert read.summary(item, "orca") is None, (key, item)
            assert read.check(measure) == "PASS", (key, measure)
    for item in ("r_ann", "r_vol", "t_sharpe", "t_sortino", "t_calmar", "t_turnover"):
        assert read.summary(item) is None, (key, item)  # the tiles over them
    # what needs no four returns is there: the product of the returns and the hold, by hand
    f.summary(n_q=n, growth=growth, r_n=n, hold_all=hold, t_hold_all=hold)
    assert f.fi.orca.metrics["ann_return"] is None and f.fi.orca.metrics["hold_all"] == hold


@pytest.mark.libreoffice
def test_best_and_worst_year_ties(funds):
    # ALFA's price doubles in Q1 2021 and Q1 2023 and is flat otherwise (powers of two: exact),
    # so the full years 2021..2024 return 1, 0, 1, 0 and 2020 is no full year (its first quarter
    # has no return): the earliest year wins each tie
    f = funds["year_ties"]
    f.passes()
    f.summary(best_year=2021, best_year_ret=1.0, worst_year=2022, worst_year_ret=0.0,
              years_pos=2, years_total=4, n_q=19, growth=4.0)  # fmt: skip
    f.summary(ann_return=4.0 ** (4 / 19) - 1)
    orca = f.read.summary("best_year", "orca"), f.read.summary("worst_year", "orca")
    assert orca == (2021, 2022)  # the engine's max and min keep the first of a tie
    assert f.fi.years == [2020, 2021, 2022, 2023, 2024]
    got = [f.read.model("ret_if_full", None, str(y)) for y in f.fi.years]
    f.same(got, [None, 1.0, 0.0, 1.0, 0.0], "ret_if_full")


# --- the cut ----------------------------------------------------------------------------------


@pytest.mark.libreoffice
def test_cut_end_to_end(funds):
    # Seastack (24 positions) cut to its 3 largest: 3 stock rows and one "All other positions"
    f = funds["cut"]
    f.passes()
    fi, out = f.fi, f.case.r.output
    wm = workbook_map(fi)
    assert wm.outputs.last - wm.outputs.first + 1 == len(fi.stocks) == CUT_KEEP
    peak = {pos.stock_id: max(pq.value for pq in pos.quarters) for pos in out.positions}
    top = sorted(peak, key=lambda sid: (-peak[sid], sid))[:CUT_KEEP]
    assert [st.stock_id for st in fi.stocks] == top
    rest = [pos for pos in out.positions if pos.stock_id not in top]
    assert len(rest) == len(out.positions) - CUT_KEEP > 0
    # the "All other positions" block of Outputs, Orca's counts
    read = f.read
    assert read.values[("Outputs", wm.outputs.other_cell("count"))] == len(rest)
    assert read.values[("Outputs", wm.outputs.other_cell("held_now"))] == sum(
        pos.shares_now > 0 for pos in rest
    )
    raw = openpyxl.load_workbook(f.case.path)
    first = min(wm.outputs.other.values()) - 1
    assert raw["Outputs"][f"A{first}"].value.startswith(OTHER_NAME)
    assert f"{len(rest)} positions" in raw["Outputs"][f"A{first}"].value
    assert raw["Outputs"][f"A{wm.outputs.total}"].value.endswith(OTHER_NAME.lower())
    # and one on Model in every block that sums positions
    model = wm.model
    others = [b.id for b in BLOCKS if b.id in OTHER_ROWS and b.per_stock]
    assert others == ["I2", "C10", "C11", "C12", "C13", "C16", "C20"]
    for block in others:
        row = model.row(block, OTHER_STOCK)
        assert raw["Model"].cell(row, 3).value == OTHER_NAME, block
    # the fund-level figures are exact, the engine's own
    f.summary(book=out.meta.book, n_holdings=out.meta.n_holdings, positions_ever=len(out.positions),
              priced_pct=out.meta.priced_pct)  # fmt: skip


@pytest.mark.libreoffice
def test_inactive_cut_fund(funds):
    # Cobblereef's last filing is Q4 2023, well before the deadline (Q2 2026): its tracked
    # quarters end at end_q, its columns run on to bound. Cut to 6 rows, the "All other
    # positions" rows follow the same rule as the stocks' (R8, R23)
    f = funds["inactive_cut"]
    f.passes()
    fi, case = f.fi, f.case
    assert fi.other is not None and len(fi.stocks) == INACTIVE_KEEP
    assert fi.bound > fi.end_q and fi.bound - fi.end_q >= 8
    model = workbook_map(fi).model
    after = range(fi.end_q + 1, fi.bound + 1)
    raw = openpyxl.load_workbook(case.path)["Model"]
    values = f.read.values
    assert "C17" not in OTHER_ROWS and "C18" not in OTHER_ROWS  # no Other row for the flows
    unwritten = zeros = 0
    for block in BLOCKS:
        if block.kind not in ("calc", "fund"):
            continue
        stocks = [st.stock_id for st in fi.stocks] if block.per_stock else [None]
        if block.id in OTHER_ROWS and block.per_stock:
            stocks.append(OTHER_STOCK)  # the "All other positions" row
        for sid in stocks:
            for q in after:
                ref, where = model.cell(block.id, sid, q), (block.id, sid, q)
                if block.id in ZERO_AFTER_END:
                    cell = raw[ref]
                    assert cell.value == 0 and cell.data_type == "n", where
                    assert cell.font.color.rgb == BLUE and values[("Model", ref)] == 0, where
                    zeros += 1
                else:  # nothing written after end_q: no formula, no value
                    assert raw[ref].value is None and ("Model", ref) not in values, where
                    unwritten += 1
    assert unwritten > 400 and zeros == 2 * INACTIVE_KEEP * len(after)
    # the Other row of the value filed (I2) is an input, written to bound; so are the fund's
    # rows of the other positions' buys and sells
    for block, sid in (("I2", OTHER_STOCK), ("other_buys", None), ("other_sells", None)):
        for q in after:
            ref = model.cell(block, sid, q)
            assert raw[ref].data_type == "n" and raw[ref].font.color.rgb == BLUE, (block, q)
            assert values[("Model", ref)] == 0, (block, q)  # none of them held past end_q
    assert raw[model.cell("I2", OTHER_STOCK, fi.end_q)].value > 0  # held at end_q
    # the kept stocks' IRRs, whose cash flows run on through the zeros to Latest, are the site's
    n_irr = 0
    prices = {st.stock_id: st.close_latest for st in fi.stocks}
    for pos in case.r.output.positions:
        if pos.stock_id not in prices:
            continue
        want = position_irr(pos, fi, prices[pos.stock_id])
        got = f.read.out("irr", pos.stock_id)
        assert (got is None) == (want is None), (pos.stock_id, got, want)
        assert want is None or abs(got - want) <= 1e-7, (pos.stock_id, got, want)
        n_irr += want is not None
    assert n_irr >= 3


# --- size and time ----------------------------------------------------------------------------


def test_size_and_time(tmp_path):
    # spec 7.5: a fund of 500 positions over 54 quarters builds in under 60 s into under 15 MB
    fi = synthetic_inputs(500, 54)
    validate(fi)
    assert len(fi.stocks) == 500 and len(fi.quarters) == 54 and fi.other is None
    path = tmp_path / "big.xlsx"
    began = time.perf_counter()
    info = build_workbook(fi, path)
    seconds = time.perf_counter() - began
    size = path.stat().st_size
    print(f"500 stocks x 54 quarters: {seconds:.1f} s, {size / 1e6:.2f} MB, {info.rows} rows")
    assert seconds < MAX_SECONDS and info.seconds < MAX_SECONDS
    assert size < MAX_BYTES and info.bytes == size
    assert info.rows > 15_000 and openpyxl.load_workbook(path, read_only=True).sheetnames == [
        "Model", "Outputs", "Summary",
    ]  # fmt: skip
