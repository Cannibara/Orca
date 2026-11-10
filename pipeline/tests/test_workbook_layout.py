"""The workbook's block registry and column map: every formula is the spec's (section 3.2),
renders to A1 references, and uses only the portable functions."""

import ast
import math
import re
from datetime import date

from orca.engine.fund import FundQuarter, fund_years
from orca.workbook.layout import (
    ALLOWED_FUNCTIONS,
    BLOCKS,
    BY_ID,
    FUND_INPUTS,
    HEADER_ROWS,
    MODEL_ROWS,
    Columns,
    Ref,
    Rows,
    mid_quarter,
    year_formula,
)

TOKEN = re.compile(r"[A-Z][A-Z0-9.]*\(")


class Stub:
    """A Ref that names cells instead of placing them: `prev_C5` is C5 one column left."""

    def __init__(self, cut: bool = False) -> None:
        self.cut = cut

    def this(self, row_id):
        return row_id

    def down(self, row_id):
        return f"{row_id}_column"

    def prev(self, row_id):
        return f"prev_{row_id}"

    def ahead(self, row_id, k):
        return f"{row_id}_plus{k}"

    def col_header(self, row_id):
        return row_id

    def fund(self, row_id):
        return row_id

    def year_last(self, row_id):
        return f"last_{row_id}"


class _LazyIf(ast.NodeTransformer):
    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "IF":
            return ast.IfExp(test=node.args[0], body=node.args[1], orelse=node.args[2])
        return node


def evaluate(formula: str, cells: dict) -> object:
    """The value of a Stub-rendered formula of IF, comparisons and arithmetic, with `cells`
    naming the Stub's cells. IF is lazy, as in Excel, so an untaken branch is not computed."""
    text = re.sub(r"(?<![<>!=])=", "==", formula[1:].replace("<>", "!="))
    tree = ast.fix_missing_locations(_LazyIf().visit(ast.parse(text, mode="eval")))
    return eval(compile(tree, "<formula>", "eval"), {}, dict(cells))


# Names in the spec's formula text -> the Stub's names, longest first.
_SPEC_NAMES = [
    ("First tracked quarter", "first_tracked"),
    ("Has return year total", "has_return"),
    ("Excess return", "excess"),
    ("Risk-free used", "rf_used"),
    ("Market move", "market_move"),
    ("Trade gains", "trade_gains"),
    ("Net buying", "net_buying"),
    ("Mean book", "mean_book"),
    ("Full year", "full_year"),
    ("In range", "in_range"),
    ("T-bill", "tbill"),
    ("Return", "ret"),
    ("Dividends", "dividends"),
    ("Inflows", "inflows"),
    ("Gains", "gains"),
    ("Start", "start"),
    ("Buys", "buys"),
    ("Sells", "sells"),
    ("End", "end"),
    ("Growth", "growth"),
    ("Index", "index"),
    ("Peak", "peak"),
    ("+4 I4", "I4_plus4"),
    ("year ", ""),
    ("prev ", "prev_"),
    (" column", "_column"),
    ("×", "*"),
    ("÷", "/"),
    ("−", "-"),
    (" ", ""),
]


def spec(text: str) -> str:
    """The spec's formula text in the Stub's names."""
    for old, new in _SPEC_NAMES:
        text = text.replace(old, new)
    return "=" + text


# Spec 3.2, verbatim (C19 and C20 are checked on their own below).
SPEC_STOCK = {
    "C1": 'IF(I1="",0,I1×I3)',
    "C2": 'IF(I4<>"",I4,prev C2)',
    "C3": 'IF(AND(C1>0,I2>0),I2/C1,"")',
    "C4": 'IF(AND(C1=0,prev C5=0),"", IF(I4<>"",I4, IF(prev C2<>"",prev C2, IF(C3<>"",C3,'
    ' IF(prev C5>0,prev C4,"")))))',
    "C5": 'IF(C4="",0,C1)',
    "C6": "IF(OR(C5>0,prev C5>0),1,0)",
    "C7": "C5 − prev C5",
    "C8": 'IF(C7=0,"", IF(AND(prev C5=0,OR(First tracked quarter=1,prev C1>0),I4<>""),I4,'
    ' IF(I5<>"",I5, IF(prev C2<>"",prev C2, IF(C3<>"",C3,C4)))))',
    "C9": "IF(C7=0,0,C7×C8)",
    "C10": "IF(prev C5>0,prev C5×(C4−prev C4),0)",
    "C11": "IF(C7=0,0,C7×(C4−C8))",
    "C12": "IF(prev C5>0,prev C5×I6,0)",
    "C13": "C10+C11+C12",
    "C14": "IF(C7>0,prev C14+C9, IF(C7<0,IF(C5=0,0,prev C14+C7×prev C14/prev C5),prev C14))",
    "C15": "IF(C7<0,−C7×(C8−prev C14/prev C5),0)",
    "C16": "IF(C5=0,0,C5×C4)",
    "C17": "−C9",
    "C18": "IF(C7>0,−C9,0)",
    "C20": 'IF(year C6=0,"",IF(year Start+year Net buying/2>0, year C13/(year Start+year Net'
    ' buying/2)×100,""))',
}

SPEC_FUND = {
    "start": "prev End",
    "end": "SUM(C16 column)",  # "SUM of C16 down the column"
    "buys": 'SUMIF(C9 column,">0")',
    "sells": '−SUMIF(C9 column,"<0")',
    "net_buying": "Buys − Sells",
    "market_move": "SUM(C10 column)",
    "trade_gains": "SUM(C11 column)",
    "dividends": "SUM(C12 column)",
    "bridge_gap": "End − (Start + Market move + Net buying + Trade gains)",
    "index": "prev Index × Growth",
    "peak": "MAX(prev Peak, Index)",
    "drawdown": "Index ÷ Peak − 1",
    "gains": "Market move + Trade gains",
    "inflows": "Net buying",
    "ret":'IF(AND(First tracked quarter=0,Start>0,Start+Net buying/2>0),'
    '(End−Start−Net buying+Dividends)/(Start+Net buying/2),"")',
    "growth": 'IF(Return="",1,1+Return)',
    "has_return": 'IF(Return="",0,1)',
    "rf_used": 'IF(T-bill<>"",T-bill,prev Risk-free used)',
    "excess": 'IF(Return="","",Return−Risk-free used/4)',
    "downside2": 'IF(Excess return="","",MIN(0,Excess return)^2)',
    "ret_in_range": 'IF(AND(In range=1,Return<>""),Return,"")',
    "full_year": "IF(Has return year total=4,1,0)",
    "ret_if_full": 'IF(Full year=1,year Return,"")',
    "approx_ret": 'IF(Start+Inflows/2>0,(Gains+Dividends)/(Start+Inflows/2),"")',
    "turnover": 'IF(AND(Full year=1,Mean book>0),MIN(Buys,Sells)/Mean book,"")',
}


def sheet(n_stocks: int = 3, cut: bool = False) -> Rows:
    """Every registry row stacked from row 2, each block after a title line."""
    other = frozenset(b.id for b in MODEL_ROWS if b.other) if cut else frozenset()
    first, row = {}, 2
    for b in MODEL_ROWS:
        if b.cut_only and not cut:
            continue
        first[b.id] = row + 1
        row += 1 + (n_stocks + (b.id in other) if b.per_stock else 1)
    return Rows(first, n_stocks, other)


# Two years, end_q = Q4 2015, bound two quarters later (an inactive fund).
COLS = Columns([2014, 2015], list(range(4, 14)), end_q=11)


def rendered(cut: bool) -> list[str]:
    """Every formula the registry writes, in every column it writes it."""
    rows = sheet(cut=cut)

    def at(col: int) -> Ref:
        return Ref(COLS, rows, col, stock=1, cut=cut)

    out = []
    for b in MODEL_ROWS:
        if b.cut_only and not cut:
            continue
        if b.kind == "year_only":
            out += [b.formula(at(COLS.year_index(y))) for y in COLS.years]
        elif b.formula is not None:
            out += [b.formula(at(COLS.quarter_index(q))) for q in range(4, 12)]
        out += [f for y in COLS.years if (f := year_formula(b, at(COLS.year_index(y))))]
        if callable(b.before):
            out.append(b.before(at(COLS.before_index)))
        if callable(b.latest):
            out.append(b.latest(at(COLS.latest_index)))
        if cut and callable(b.other):  # the "All other positions" row's own formula
            cols = [COLS.year_index(y) for y in COLS.years] if b.kind == "year_only" else [
                COLS.quarter_index(q) for q in range(4, 12)
            ]
            out += [b.other(Ref(COLS, rows, col, stock=rows.stocks, cut=True)) for col in cols]
    return out


def test_mid_quarter():
    assert [mid_quarter(q) for q in (4, 5, 6, 7, 12)] == [
        date(2014, 2, 14),
        date(2014, 5, 16),
        date(2014, 8, 15),
        date(2014, 11, 15),
        date(2016, 2, 15),
    ]


def test_columns():
    cols = Columns([2014, 2015], list(range(4, 12)))
    assert (cols.year(2014), cols.year(2015), cols.gap, cols.before) == ("F", "G", "H", "I")
    assert (cols.quarter(4), cols.quarter(11), cols.latest) == ("J", "Q", "R")
    assert (cols.first_q, cols.last_q) == ("J", "Q")
    assert cols.year_span(2014) == ("J", "M")
    assert cols.year_span(2015) == ("N", "Q")


def test_year_span_stops_at_end_q():
    # bound is Q3 2015 but the fund's last held quarter Q1 2015: the year ends there
    cols = Columns([2014, 2015], list(range(5, 11)), end_q=8)
    assert cols.year_span(2014) == ("J", "L")
    assert cols.year_span(2015) == ("M", "M")
    assert cols.last_q == "O"


def test_every_block_complete():
    for b in BLOCKS:
        if b.kind in ("calc", "fund"):
            assert b.formula is not None and b.year_rule != "none", b.id
        elif b.kind == "year_only":
            assert b.formula is not None and b.year_rule == "none", b.id
        else:
            assert b.kind == "input" and b.formula is None and b.source, b.id
    for b in FUND_INPUTS:
        assert b.kind == "fund_input" and b.formula is None and b.source, b.id
    for b in HEADER_ROWS:
        assert b.kind == "header" and b.formula is None, b.id
    assert len(BY_ID) == len(MODEL_ROWS)


def test_block_order():
    ids = [b.id for b in BLOCKS]
    assert ids[:26] == [f"I{i}" for i in range(1, 7)] + [f"C{i}" for i in range(1, 21)]
    kinds = [b.kind for b in BLOCKS[26:]]
    assert kinds == sorted(kinds, key=lambda k: k == "year_only")  # fund rows, then year-only
    assert [b.id for b in HEADER_ROWS] == [
        "quarter", "label", "year", "quarter_end", "mid_quarter", "first_tracked", "held_through"
    ]
    assert [b.id for b in FUND_INPUTS] == [
        "carried", "tbill", "spy_close", "spy_vwap", "total_reported", "other_buys", "other_sells"
    ]
    assert [b.id for b in FUND_INPUTS if b.cut_only] == ["other_buys", "other_sells"]


def test_formulas_use_allowed_functions_only():
    assert ALLOWED_FUNCTIONS == {
        "IF", "AND", "OR", "SUM", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGE",
        "AVERAGEIFS", "SUMPRODUCT", "INDEX", "MATCH", "MAX", "MIN", "ABS", "EXP", "LN", "SQRT",
        "STDEV.S", "COUNT", "XIRR", "IFERROR",
    }
    for cut in (False, True):
        for formula in rendered(cut):
            assert formula.startswith("=") and " " not in formula, formula
            used = {token[:-1] for token in TOKEN.findall(formula)}
            assert used <= ALLOWED_FUNCTIONS, formula
            assert "IFERROR" not in used, formula  # only around XIRR, which Model has none of


def test_c8_trade_price_order():
    # close if first report, VWAP, last close before, implied, valuation price
    assert BY_ID["C8"].formula(Stub()) == (
        '=IF(C7=0,"",IF(AND(prev_C5=0,OR(first_tracked=1,prev_C1>0),I4<>""),I4,'
        'IF(I5<>"",I5,IF(prev_C2<>"",prev_C2,IF(C3<>"",C3,C4)))))'
    )


def test_stock_formulas_are_the_spec_text():
    for block_id, text in SPEC_STOCK.items():
        assert BY_ID[block_id].formula(Stub()) == spec(text), block_id


def test_fund_formulas_are_the_spec_text():
    for row_id, text in SPEC_FUND.items():
        assert BY_ID[row_id].formula(Stub()) == spec(text), row_id
    gap = "ABS(gap) <= 1e-6×MAX(1,ABS(End),ABS(Start),Buys+Sells)"
    expected = spec(gap).replace("gap", "bridge_gap").replace("1e-6", "1E-6")
    assert BY_ID["bridge_ok"].formula(Stub()) == "=IF(" + expected[1:] + ",1,0)"
    # a cut fund adds the "All other positions" buys and sells (spec 3.2, section 4)
    assert BY_ID["buys"].formula(Stub(cut=True)) == spec('SUMIF(C9 column,">0")+other_buys')
    assert BY_ID["sells"].formula(Stub(cut=True)) == spec('−SUMIF(C9 column,"<0")+other_sells')


def test_c19_one_year_after_return():
    # the engine's _return_after: no figure without a positive trade price
    assert BY_ID["C19"].formula(Stub()) == (
        '=IF(C7=0,"",IF(AND(I4_plus4<>"",C8>0),I4_plus4/C8-1,""))'
    )
    rows = sheet()
    near_bound = Ref(COLS, rows, COLS.quarter_index(10), stock=0)  # q + 4 > bound (13)
    assert BY_ID["C19"].formula(near_bound) == '=""'
    inside = Ref(COLS, rows, COLS.quarter_index(9), stock=0)
    assert f"{COLS.quarter(13)}{rows.row('I4', 0)}" in BY_ID["C19"].formula(inside)


def test_ref_renders_a1():
    rows = sheet(n_stocks=3, cut=True)
    r = Ref(COLS, rows, COLS.quarter_index(4), stock=2, cut=True)
    c5 = rows.row("C5", 2)
    assert c5 == rows.first["C5"] + 2
    assert BY_ID["C7"].formula(r) == f"=J{c5}-I{c5}"  # the first quarter's prev is Before
    assert r.col_header("first_tracked") == f"J{rows.first['first_tracked']}"
    top = rows.first["C16"]
    assert BY_ID["end"].formula(r) == f"=SUM(J{top}:J{top + 3})"  # 3 stocks + All other
    top9 = rows.first["C9"]
    assert BY_ID["buys"].formula(r) == (
        f'=SUMIF(J{top9}:J{top9 + 2},">0")+J{rows.first["other_buys"]}'
    )
    uncut = sheet()
    top9 = uncut.first["C9"]
    assert BY_ID["sells"].formula(Ref(COLS, uncut, COLS.quarter_index(4))) == (
        f'=-SUMIF(J{top9}:J{top9 + 2},"<0")'
    )


def test_year_formula_rules():
    rows = sheet()
    y15 = Ref(COLS, rows, COLS.year_index(2015), stock=0)

    def row(row_id):
        return rows.row(row_id, 0)

    assert year_formula(BY_ID["C9"], y15) == f"=SUM(N{row('C9')}:Q{row('C9')})"
    assert year_formula(BY_ID["I4"], y15) == f'=IF(Q{row("I4")}="","",Q{row("I4")})'
    assert year_formula(BY_ID["start"], y15) == f"=N{row('start')}"
    assert year_formula(BY_ID["drawdown"], y15) == f"=MIN(N{row('drawdown')}:Q{row('drawdown')})"
    # the year's growth and return read the running product at the year's last quarter
    assert year_formula(BY_ID["growth"], y15) == f"=Q{row('ytd_growth')}"
    assert year_formula(BY_ID["ret"], y15) == (
        f'=IF(G{row("has_return")}=0,"",Q{row("ytd_growth")}-1)'
    )
    assert year_formula(BY_ID["year"], y15) == f"=MIN(N{row('year')}:Q{row('year')})"
    for blank in ("C8", "I5", "excess", "in_range", "C20", "full_year"):
        assert year_formula(BY_ID[blank], y15) is None, blank


def test_before_and_latest_cells():
    assert {b.id: b.before for b in MODEL_ROWS if isinstance(b.before, float)} == {
        "C1": 0.0, "C5": 0.0, "C14": 0.0, "end": 0.0, "rf_used": 0.0,
        "index": 1.0, "peak": 1.0, "range_index": 1.0, "range_peak": 1.0, "ytd_growth": 1.0,
    }
    assert (BY_ID["I4"].before, BY_ID["I4"].latest) == ("close_before", "close_latest")
    assert BY_ID["mid_quarter"].latest == "latest_date"
    rows = sheet()
    i4 = rows.row("I4", 0)
    before = Ref(COLS, rows, COLS.before_index, stock=0)
    assert BY_ID["C2"].before(before) == f'=IF(I{i4}<>"",I{i4},"")'
    latest = Ref(COLS, rows, COLS.latest_index, stock=0)
    c5, c7 = rows.row("C5", 0), rows.row("C7", 0)
    # Latest = shares at end_q (Q4 2015, column Q) at the latest close; quarters to end_q only
    assert BY_ID["C17"].latest(latest) == f'=IF(Q{c5}=0,0,IF(T{i4}="","",Q{c5}*T{i4}))'
    assert BY_ID["C18"].latest(latest) == f'=IF(T{i4}="","",SUMIF(J{c7}:Q{c7},">0")*T{i4})'


def test_year_chaining_without_ln():
    # quarters of -100% and -120%: LN of their growth would be #NUM!; the engine chains them
    for cut in (False, True):
        assert not [f for f in rendered(cut) if "LN(" in f]
    for rets in (
        [0.1, -1.0, -1.2, 0.05],
        [0.1, None, -1.2, 0.05],
        [None, -1.2, None, 0.3],
        [None, None],
    ):
        prev = {"prev_year": 2014, "prev_ytd_growth": 7.0}  # last year's product: restarts
        for ret in rets:
            cells = {"ret": "" if ret is None else ret, "year": 2015, **prev}
            cells["growth"] = evaluate(BY_ID["growth"].formula(Stub()), cells)
            ytd = evaluate(BY_ID["ytd_growth"].formula(Stub()), cells)
            prev = {"prev_year": 2015, "prev_ytd_growth": ytd}
        quarters = [FundQuarter(8 + i, 0, 0, 0, 0, 0, 0, 0, 0, r) for i, r in enumerate(rets)]
        (engine,) = fund_years(quarters)
        year = {"has_return": sum(r is not None for r in rets), "last_ytd_growth": ytd}
        expected = "" if engine.ret is None else engine.ret  # math.prod, bit for bit
        assert evaluate(year_formula(BY_ID["ret"], Stub()), year) == expected, rets
        growth = evaluate(year_formula(BY_ID["growth"], Stub()), year)
        assert growth == math.prod(1 + r for r in rets if r is not None), rets


def test_other_rows():
    # the "All other positions" rows of a cut fund: Orca's sums as inputs, P&L and points
    # as formulas over them (spec section 4)
    assert {b.id: b.other for b in MODEL_ROWS if isinstance(b.other, str)} == {
        "I2": "value_filed", "C10": "market_move", "C11": "trade_gain", "C12": "dividends",
        "C16": "value",
    }
    assert [b.id for b in MODEL_ROWS if callable(b.other)] == ["C13", "C20"]
    rows = sheet(n_stocks=3, cut=True)

    def other(row_id):
        return rows.row(row_id, 3)

    q = Ref(COLS, rows, COLS.quarter_index(5), stock=3, cut=True)
    assert BY_ID["C13"].other(q) == f"=K{other('C10')}+K{other('C11')}+K{other('C12')}"
    y = Ref(COLS, rows, COLS.year_index(2015), stock=3, cut=True)
    den = f"G{rows.row('start')}+G{rows.row('net_buying')}/2"
    assert BY_ID["C20"].other(y) == f'=IF({den}>0,G{other("C13")}/({den})*100,"")'
