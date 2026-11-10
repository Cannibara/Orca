"""The Summary tab (spec 3.5): the fund's header, the From and To years (inputs, the workbook
names FromYear and ToYear that Model's In range row reads), the tiles over that range and over
the whole period, the whole-period figures beside Orca's with a difference each, and the checks'
outcome. Every formula reads Model and Outputs; the formulas are here, the layout too."""

from collections.abc import Callable
from dataclasses import dataclass

from xlsxwriter.worksheet import Worksheet

from orca.quarters import BASE_YEAR, q_label
from orca.workbook.inputs import FundInputs
from orca.workbook.layout import (
    CHECKS,
    DATE,
    GENERAL,
    PCT,
    RATIO,
    SCI,
    SUMMARY_CHECKED,
    USD,
    WHOLE,
    CheckKind,
    col_letter,
    difference,
)
from orca.workbook.model import DISCLAIMER, ModelMap
from orca.workbook.outputs import OutputsMap
from orca.workbook.sheet import Formats, TabWriter

TAB = "Summary"
FACTOR = "0.0000"
VALUE, ORCA, DIFF = 1, 2, 3  # columns B, C, D of the vertical tables
_KIND: dict[str, CheckKind] = {item: kind for _, item, kind in SUMMARY_CHECKED}


class Refs:
    """What a Summary formula reads: Model's fund rows over the tracked quarters (`q`) or the
    year columns (`y`), a cell in end_q's column (`end`), a stock block's stock rows over the
    tracked quarters (`stocks`), I2 down end_q's column with the cut's row (`down_end`), an
    Outputs column (`out`), the cut's inputs (`plus`: "+<cell>", or "" when not cut) and
    Summary's own cells (`me`)."""

    def __init__(self, fi: FundInputs, m: ModelMap, om: OutputsMap, sm: "SummaryMap") -> None:
        self.fi, self.m, self.om, self.sm = fi, m, om, sm

    def q(self, row_id: str) -> str:
        return f"Model!{self.m.span(row_id, 'q')}"

    def y(self, row_id: str) -> str:
        return f"Model!{self.m.span(row_id, 'y')}"

    def stocks(self, block_id: str) -> str:
        return f"Model!{self.m.span(block_id, 'q', stocks=True)}"

    def end(self, row_id: str) -> str:
        return f"Model!{self.m.cell(row_id, None, self.fi.end_q)}"

    def down_end(self, block_id: str) -> str:
        top, bottom = self.m.rows.down(block_id)
        letter = self.m.cols.quarter(self.fi.end_q)
        return f"Model!{letter}{top}:{letter}{bottom}"

    def out(self, column_id: str) -> str:
        return f"Outputs!{self.om.column(column_id)}"

    def plus(self, field: str) -> str:
        cell = self.om.other_cell(field)
        return f"+Outputs!{cell}" if cell else ""

    def me(self, item: str) -> str:
        return self.sm.cell(item)


Formula = Callable[[Refs], str]


def _ann(n: str, growth: str) -> Formula:
    """metrics.performance and spanKpi: growth ** (4 / n) - 1, blank under four quarters."""
    return lambda s: f'=IF({s.me(n)}<4,"",MAX({s.me(growth)},0)^(4/{s.me(n)})-1)'


def _last_in_range(s: Refs) -> str:
    last = f"SUMPRODUCT(MAX(({s.q('in_range')}=1)*({s.q('quarter')}+1)))"
    return f'=IF({last}=0,"",{last}-1)'


def _range_growth(s: Refs) -> str:
    """The Range index at the range's last quarter (1 for an empty range)."""
    last = s.me("r_last_q")
    return f'=IF({last}="",1,INDEX({s.q("range_index")},MATCH({last},{s.q("quarter")},0)))'


def _years_in_range(s: Refs, row_id: str, criterion: str) -> str:
    year = s.y("year")
    lo, hi = s.me("from_year"), s.me("to_year")
    return f'=COUNTIFS({year},">="&{lo},{year},"<="&{hi},{s.y(row_id)},{criterion})'


def _sharpe(s: Refs) -> str:
    excess, n = s.q("excess"), s.me("n_q")
    sd = f"STDEV.S({excess})"
    return f'=IF({n}<4,"",IF({sd}=0,"",AVERAGE({excess})*4/({sd}*2)))'


def _sortino(s: Refs) -> str:
    excess, down, n = s.q("excess"), s.q("downside2"), s.me("n_q")
    return (
        f'=IF({n}<4,"",IF(SUM({down})=0,"",'
        f"AVERAGE({excess})*4/(SQRT(SUM({down})/{n})*2)))"
    )


def _calmar(s: Refs) -> str:
    ann, mdd = s.me("ann_return"), s.me("max_dd")
    return f'=IF(OR({ann}="",{mdd}=""),"",IF({mdd}=0,"",{ann}/ABS({mdd})))'


def _extreme_ret(how: str) -> Formula:
    """Best (MAX) or worst (MIN) full year's return; blank without a full year."""
    return lambda s: (
        f'=IF(COUNT({s.y("ret_if_full")})=0,"",{how}({s.y("ret_if_full")}))'
    )


def _extreme_year(item: str) -> Formula:
    """The year of it: the earliest on a tie, as the engine's max/min over the years in order."""
    return lambda s: (
        f'=IF({s.me(item)}="","",INDEX({s.y("year")},MATCH({s.me(item)},{s.y("ret_if_full")},0)))'
    )


def _years_total(s: Refs) -> str:
    full = f"COUNTIF({s.y('full_year')},1)"
    return f'=IF({full}=0,"",{full})'


def _mean_with_other(total: str, count: str, empty: str) -> str:
    """(sum + the cut's sum) / (count + the cut's count), `empty` when nothing is counted."""
    return f"=IF({count}=0,{empty},({total})/({count}))"


def _hold_all(s: Refs) -> str:
    hold = s.out("hold")
    n = f"COUNT({hold}){s.plus('hold_n_all')}"
    return _mean_with_other(f"SUM({hold}){s.plus('hold_sum_all')}", n, "0")


def _hold_sold(s: Refs) -> str:
    hold, to = s.out("hold"), s.out("to_q")
    n = f'COUNTIF({to},">=0"){s.plus("hold_n_sold")}'
    total = f'SUMIF({to},">=0",{hold}){s.plus("hold_sum_sold")}'
    return _mean_with_other(total, n, '""')


def _after_12m(side: str, field: str) -> Formula:
    """whatif.buys_vs_sells: the mean 1-year-after return (C19) of the buys (C7 > 0) or the
    sales (C7 < 0) that have one."""

    def formula(s: Refs) -> str:
        c19, c7 = s.stocks("C19"), s.stocks("C7")
        n = f'COUNTIFS({c7},"{side}0",{c19},">-1E+300"){s.plus(f"{field}_n")}'
        total = f'SUMIFS({c19},{c7},"{side}0"){s.plus(f"{field}_sum")}'
        return _mean_with_other(total, n, '""')

    return formula


def _beat_spy(s: Refs) -> str:
    beat = s.out("beat_spy")
    n = f"COUNT({beat}){s.plus('beat_n')}"
    return _mean_with_other(f"SUM({beat}){s.plus('beat_pairs')}", n, '""')


def _profitable(s: Refs) -> str:
    """live.profitablePct: of the positions whose total P&L can be computed."""
    total = s.out("total_pnl")
    n = f"COUNT({total}){s.plus('computable')}"
    return _mean_with_other(f'COUNTIF({total},">0"){s.plus("profitable")}', n, '""')


def _priced(s: Refs) -> str:
    """metrics.priced_pct: the filed value of the mapped stocks over the whole reported value."""
    total = s.end("total_reported")
    return f"=IF({total}>0,SUM({s.down_end('I2')})/{total},0)"


def _checks_passing(s: Refs) -> str:
    return f'=COUNTIF(Outputs!{s.om.results},"PASS")'


# The tab, top to bottom. A line is ("title", text), ("blank",), ("head",) (the column titles
# Workbook / Orca / Difference), ("item", id, label, format, formula or None for an input), or
# ("tiles", [(id, label, format, formula), ...]) for a row of labels over a row of values.
Line = tuple
_LINES: tuple[Line, ...] = (
    ("title", "Fund"),
    ("head",),
    ("item", "name", "Fund", GENERAL, None),
    ("item", "fund_id", "Fund id", WHOLE, None),
    ("item", "cik", "CIK", WHOLE, None),
    ("item", "period_label", "Latest quarter filed", GENERAL, None),
    ("item", "period_q", "Latest quarter filed (q)", WHOLE, None),
    ("item", "filed", "Filed", DATE, None),
    ("item", "book", "Book (End in the last held quarter)", USD, lambda s: f"={s.end('end')}"),
    ("item", "n_holdings", "Holdings now", WHOLE,
     lambda s: f'=COUNTIF({s.out("shares_now")},">0"){s.plus("held_now")}'),
    ("item", "positions_ever", "Positions ever", WHOLE,
     lambda s: f"=COUNT({s.out('from_q')}){s.plus('count')}"),
    ("item", "priced_pct", "% priced", PCT, _priced),
    ("blank",),
    ("title", "Range (type the years of the site's bracket to reproduce its first row of tiles)"),
    ("item", "from_year", "From year", WHOLE, None),
    ("item", "to_year", "To year", WHOLE, None),
    ("blank",),
    ("title", "Tiles over the range"),
    ("tiles", (
        ("r_ann", "Annualised return", PCT, _ann("r_n", "r_growth")),
        ("r_growth", "Growth of $1", FACTOR, _range_growth),
        ("r_years_pos", "Years positive", WHOLE,
         lambda s: _years_in_range(s, "ret_if_full", '">0"')),
        ("r_full_years", "Full years", WHOLE, lambda s: _years_in_range(s, "full_year", "1")),
        ("r_qpos", "% quarters positive", PCT,
         lambda s: f'=IF({s.me("r_n")}=0,"",COUNTIF({s.q("ret_in_range")},">0")/{s.me("r_n")})'),
        ("r_mdd", "Max drawdown", PCT, lambda s: f"=MIN({s.q('range_drawdown')})"),
        ("r_vol", "Volatility", PCT,
         lambda s: f'=IF({s.me("r_n")}<4,"",STDEV.S({s.q("ret_in_range")})*2)'),
        ("r_n", "Quarters with a return", WHOLE, lambda s: f"=COUNT({s.q('ret_in_range')})"),
        ("r_last_q", "Last quarter in range (q)", WHOLE, _last_in_range),
    )),
    ("blank",),
    ("title", "Tiles over the whole period"),
    ("tiles", (
        ("t_sharpe", "Sharpe", RATIO, lambda s: f"={s.me('sharpe')}"),
        ("t_sortino", "Sortino", RATIO, lambda s: f"={s.me('sortino')}"),
        ("t_calmar", "Calmar", RATIO, lambda s: f"={s.me('calmar')}"),
        ("t_turnover", "Turnover", RATIO, lambda s: f"={s.me('turnover')}"),
        ("t_hold_all", "Average hold, all (years)", RATIO, lambda s: f"={s.me('hold_all')}"),
        ("t_hold_sold", "Average hold, sold (years)", RATIO, lambda s: f"={s.me('hold_sold')}"),
        ("profitable", "Positions profitable", PCT, _profitable),
    )),
    ("blank",),
    ("title", "Whole period"),
    ("head",),
    ("item", "n_q", "Quarters with a return", WHOLE, lambda s: f"=COUNT({s.q('ret')})"),
    ("item", "growth", "Growth of $1", FACTOR, lambda s: f"={s.end('index')}"),
    ("item", "ann_return", "Annualised return", PCT, _ann("n_q", "growth")),
    ("item", "sharpe", "Sharpe", RATIO, _sharpe),
    ("item", "sortino", "Sortino", RATIO, _sortino),
    ("item", "vol", "Volatility", PCT,
     lambda s: f'=IF({s.me("n_q")}<4,"",STDEV.S({s.q("ret")})*2)'),
    ("item", "max_dd", "Max drawdown", PCT,
     lambda s: f'=IF({s.me("n_q")}<4,"",MIN({s.q("drawdown")}))'),
    ("item", "calmar", "Calmar", RATIO, _calmar),
    ("item", "quarters_pos_pct", "% quarters positive", PCT,
     lambda s: f'=IF({s.me("n_q")}<4,"",COUNTIF({s.q("ret")},">0")/{s.me("n_q")})'),
    ("item", "best_year", "Best year", WHOLE, _extreme_year("best_year_ret")),
    ("item", "best_year_ret", "Best year return", PCT, _extreme_ret("MAX")),
    ("item", "worst_year", "Worst year", WHOLE, _extreme_year("worst_year_ret")),
    ("item", "worst_year_ret", "Worst year return", PCT, _extreme_ret("MIN")),
    ("item", "years_pos", "Years positive", WHOLE,
     lambda s: f'=IF({s.me("years_total")}="","",COUNTIF({s.y("ret_if_full")},">0"))'),
    ("item", "years_total", "Full years", WHOLE, _years_total),
    ("item", "turnover", "Turnover", RATIO,
     lambda s: f'=IF(COUNT({s.y("turnover")})=0,"",AVERAGE({s.y("turnover")}))'),
    ("item", "hold_all", "Average hold, all (years)", RATIO, _hold_all),
    ("item", "hold_sold", "Average hold, sold (years)", RATIO, _hold_sold),
    ("item", "buys_12m", "Buys: return 12 months after", PCT, _after_12m(">", "buys_1y")),
    ("item", "sells_12m", "Sales: return 12 months after", PCT, _after_12m("<", "sells_1y")),
    ("item", "beat_spy_pct", "Sales beating SPY", PCT, _beat_spy),
    ("blank",),
    ("title", "Checks"),
    ("item", "checks", "Checks", WHOLE, None),
    ("item", "passing", "Checks passing", WHOLE, _checks_passing),
    ("item", "fails", "Checks failing", WHOLE, lambda s: f"={s.me('checks')}-{s.me('passing')}"),
    ("item", "overall", "Overall", GENERAL,
     lambda s: f'=IF({s.me("fails")}=0,"PASS","FAIL")'),
    ("link",),
)  # fmt: skip


@dataclass(frozen=True)
class SummaryMap:
    """Where each Summary item is (rows 1-based): its value cell, and for a checked figure the
    Orca and difference cells beside it (columns C and D)."""

    at: dict[str, tuple[int, int]]  # item -> (row, 0-based column) of its value
    last_row: int

    def cell(self, item: str, field: str = "value") -> str:
        row, col = self.at[item]
        col = {"value": col, "orca": ORCA, "diff": DIFF}[field]
        if field != "value" and item not in _KIND:
            raise KeyError(f"{item} has no Orca figure")
        return f"{col_letter(col)}{row}"


def summary_map() -> SummaryMap:
    at, row = {}, 4  # below the name, the ids and the disclaimer
    for line in _LINES:
        if line[0] == "tiles":
            for i, (item, *_) in enumerate(line[1]):
                at[item] = (row + 1, VALUE + i)
            row += 2
            continue
        if line[0] == "item":
            at[line[1]] = (row, VALUE)
        row += 1
    return SummaryMap(at, row - 1)


def _inputs(fi: FundInputs) -> dict[str, object]:
    """Summary's inputs: the header, and the range's default years, the first and last year
    with a quarterly return (the tracked years when no quarter has one)."""
    years = [BASE_YEAR + q // 4 for q, ret in zip(fi.quarters, fi.orca.quarters["ret"],
                                                     strict=True) if ret is not None]  # fmt: skip
    years = years or fi.years
    return {
        "name": fi.name, "fund_id": fi.fund_id, "cik": fi.cik,
        "period_label": q_label(fi.period_q), "period_q": fi.period_q, "filed": fi.filed,
        "from_year": years[0], "to_year": years[-1], "checks": len(CHECKS),
    }  # fmt: skip


def orca_figures(fi: FundInputs) -> dict[str, object]:
    """Orca's figure of each checked Summary item (the best and worst year as numbers)."""
    m, ex = fi.orca.metrics, fi.orca.exits_summary
    out = {item: m.get(item) for _, item, _ in SUMMARY_CHECKED if item in m}
    for side in ("best_year", "worst_year"):
        year = m[side]
        out[side] = None if year is None else int(year["label"])
        out[f"{side}_ret"] = None if year is None else year["ret"]
    out.update(ex)
    out.update(book=fi.orca.book, n_holdings=fi.orca.n_holdings, priced_pct=fi.orca.priced_pct)
    return out


class SummaryWriter(TabWriter):
    def __init__(self, ws: Worksheet, fmt: Formats, fi: FundInputs, m: ModelMap,
                 om: OutputsMap, sm: SummaryMap, checks_title: int) -> None:  # fmt: skip
        super().__init__(ws, fmt)
        self.fi, self.sm, self.refs = fi, sm, Refs(fi, m, om, sm)
        self.checks_title = checks_title

    def write(self) -> None:
        ws, fi, sm = self.ws, self.fi, self.sm
        ws.set_column(0, 0, 44)
        ws.set_column(1, 9, 16)
        self.bold(1, 0, fi.name, font_size=13)
        self.text(2, 0, f"Fund id {fi.fund_id} · CIK {fi.cik} · data date "
                        f"{fi.latest_date.isoformat()}")  # fmt: skip
        self.text(3, 0, DISCLAIMER)
        inputs, orca = _inputs(fi), orca_figures(fi)
        row = 4
        for line in _LINES:
            kind = line[0]
            if kind == "title":
                self.bold(row, 0, line[1])
            elif kind == "head":
                for col, name in ((VALUE, "Workbook"), (ORCA, "Orca"), (DIFF, "Difference")):
                    self.text(row, col, name, self.fmt(bold=True))
            elif kind == "item":
                _, item, label, number_format, formula = line
                self.text(row, 0, label)
                self._value(row, VALUE, item, number_format, formula, inputs)
                if item in _KIND:
                    self.input_cell(row, ORCA, orca[item], number_format)
                    self.formula(row, DIFF, self._difference(item), SCI)
            elif kind == "tiles":  # a row is final once a later one is written: labels first
                for i, (_, label, _, _) in enumerate(line[1]):
                    self.text(row, VALUE + i, label, self.fmt(bold=True, text_wrap=True))
                for i, (item, _, number_format, formula) in enumerate(line[1]):
                    self._value(row + 1, VALUE + i, item, number_format, formula, inputs)
                row += 1
            elif kind == "link":
                target = f"internal:'Outputs'!A{self.checks_title}"
                self.url(row, 0, target, "The checks table (Outputs)")
            row += 1
        assert row - 1 == sm.last_row

    def _value(self, row: int, col: int, item: str, number_format: str,
               formula: Formula | None, inputs: dict) -> None:  # fmt: skip
        if formula is None:
            self.input_cell(row, col, inputs[item], number_format)
        else:
            self.formula(row, col, formula(self.refs), number_format)

    def _difference(self, item: str) -> str:
        sm = self.sm
        return difference(_KIND[item], sm.cell(item), sm.cell(item, "orca"))
