"""The Model tab's block registry and column map: one table of every row of the fund workbook's
Model tab (id, name, kind, units, year rule, number format and formula template). The builder
writes the workbook from it and the tests read the same definitions, so each formula is defined
exactly once.

A template takes a `Ref` (logical row ids in, A1 references out) and returns the formula text
with a leading "=", English function names and commas, as xlsxwriter's `write_formula` takes
it. Only ALLOWED_FUNCTIONS appear; a blank is `""` and every guard is explicit. Each stock
calculation block C1-C19 mirrors `engine.position.compute_position` line by line, the fund rows
mirror `engine.fund` and `engine.metrics`, and the AUM rows the site's `aumParts`
(web/src/fund/aum.ts).

Columns (spec 3.1): A-E labels, one per calendar year, a gap, Before, one per quarter
start..bound, Latest. Input rows run to bound; calculation and fund cells are written for the
quarters start..end_q only, so they are blank after end_q by construction (no "Held through"
wrapper). Year cells follow the row's year rule (`year_formula`) over the year's contiguous
quarter columns, which stop at end_q.

The checks (spec 3.4): Model ends with Orca's figures (inputs) and a difference row or block
beside each (ORCA_ROWS); OUTPUT_COLUMNS is the Outputs tab's stock table, its Orca columns and
their difference columns; CHECKS lists every measure the checks table compares.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from typing import TYPE_CHECKING, Literal, Protocol

from orca.quarters import BASE_YEAR, q_end, q_start

if TYPE_CHECKING:
    from orca.workbook.inputs import FundInputs

Kind = Literal["header", "input", "calc", "fund", "fund_input", "year_only", "orca", "check"]
YearRule = Literal[
    "sum", "year_end", "first_start", "chained", "product", "min", "max", "own", "blank", "none"
]
CheckKind = Literal["money", "ratio", "exact"]

ALLOWED_FUNCTIONS = frozenset(
    {
        "IF", "AND", "OR", "SUM", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGE",
        "AVERAGEIFS", "SUMPRODUCT", "INDEX", "MATCH", "MAX", "MIN", "ABS", "EXP", "LN", "SQRT",
        "STDEV.S", "COUNT", "XIRR", "IFERROR",
    }
)  # fmt: skip

LABEL_COLUMNS = ("Name", "Ticker", "Company", "Stock id", "Units")  # columns A-E

# Number formats (spec 3.1).
USD = "#,##0"
SHARES = "#,##0"  # whole shares, with thousands separators like dollars
WHOLE = "0"  # quarter indices, years, 1/0 flags and counts
PRICE = "0.0000"
PCT = "0.00%"
RATIO = "0.00"
FACTOR = "0.0000"  # multipliers (split factors, growth, index): 2 dp would hide a 1:3 split
DATE = "yyyy-mm-dd"
GENERAL = "General"
SCI = "0.00E+00"  # difference cells: a few parts in 1e16 when all is well


def mid_quarter(q: int) -> date:
    """The date a quarter's trades are dated at for XIRR: quarter start + half the days from
    its first to its last day, rounded down (the site's `midQuarterMs`)."""
    start = q_start(q)
    return start + timedelta(days=(q_end(q) - start).days // 2)


@cache
def col_letter(index: int) -> str:
    """The letters of the 0-based column `index`: 0 is A, 25 Z, 26 AA."""
    letters, n = "", index + 1
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def _year_of(q: int) -> int:
    return BASE_YEAR + q // 4


class Columns:
    """The Model tab's columns: A-E labels, the `years`, a gap, Before, the `quarters`
    (start..bound) and Latest. Properties give column letters; `*_index` the 0-based index.
    `end_q` (the fund's last held quarter, default the last column) ends the tracked quarters
    that the year columns roll up; the builder uses `for_inputs`, which always passes it."""

    def __init__(self, years: list[int], quarters: list[int], end_q: int | None = None) -> None:
        if not quarters or quarters != list(range(quarters[0], quarters[-1] + 1)):
            raise ValueError("quarters must be consecutive and not empty")
        self.end_q = quarters[-1] if end_q is None else end_q
        if not quarters[0] <= self.end_q <= quarters[-1]:
            raise ValueError(f"end_q {self.end_q} is outside the quarter columns")
        tracked = sorted({_year_of(q) for q in range(quarters[0], self.end_q + 1)})
        if list(years) != tracked:
            raise ValueError(f"years {years} are not the tracked quarters' years {tracked}")
        self.years, self.quarters = list(years), list(quarters)
        n = len(LABEL_COLUMNS)
        self._year = {y: n + i for i, y in enumerate(years)}
        self.gap_index = n + len(years)
        self.before_index = self.gap_index + 1
        self._quarter = {q: self.before_index + 1 + i for i, q in enumerate(quarters)}
        self.latest_index = self.before_index + 1 + len(quarters)
        self._at_year = {i: y for y, i in self._year.items()}
        spans: dict[int, list[int]] = {}
        for q in range(quarters[0], self.end_q + 1):
            spans.setdefault(_year_of(q), []).append(q)
        self._span = {y: (self.quarter(qs[0]), self.quarter(qs[-1])) for y, qs in spans.items()}

    @classmethod
    def for_inputs(cls, fi: "FundInputs") -> "Columns":
        """The columns of fund `fi`: its years, its quarters start..bound, tracked to end_q."""
        return cls(fi.years, fi.quarters, end_q=fi.end_q)

    def year_index(self, y: int) -> int:
        return self._year[y]

    def quarter_index(self, q: int) -> int:
        return self._quarter[q]

    def year(self, y: int) -> str:
        return col_letter(self._year[y])

    def quarter(self, q: int) -> str:
        return col_letter(self._quarter[q])

    @property
    def gap(self) -> str:
        return col_letter(self.gap_index)

    @property
    def before(self) -> str:
        return col_letter(self.before_index)

    @property
    def latest(self) -> str:
        return col_letter(self.latest_index)

    @property
    def first_q(self) -> str:
        """The first quarter column (the segment's first quarter)."""
        return self.quarter(self.quarters[0])

    @property
    def last_q(self) -> str:
        """The last quarter column (bound)."""
        return self.quarter(self.quarters[-1])

    def year_span(self, y: int) -> tuple[str, str]:
        """The first and last quarter column of year `y` among the tracked quarters
        (start..end_q): a year's quarter columns are contiguous."""
        if y not in self._span:
            raise ValueError(f"year {y} has no tracked quarter")
        return self._span[y]

    def year_at(self, index: int) -> int | None:
        """The year of the year column at `index`, None for any other column."""
        return self._at_year.get(index)


@dataclass(frozen=True)
class Rows:
    """Where the builder put each row id: `first[id]` is the 1-based sheet row of a single row,
    or of a stock block's first stock. A stock block has `stocks` rows; when the fund is `cut`,
    the blocks in OTHER_ROWS end with an "All other positions" row."""

    first: Mapping[str, int]
    stocks: int
    cut: bool = False

    @property
    def other(self) -> frozenset[str]:
        """The blocks with an "All other positions" row on this sheet."""
        return OTHER_ROWS if self.cut else frozenset()

    def row(self, row_id: str, stock: int = 0) -> int:
        if row_id not in self.first:
            raise KeyError(f"row {row_id!r} is not on the sheet")
        if not BY_ID[row_id].per_stock:
            return self.first[row_id]
        if not 0 <= stock < self.stocks + (row_id in self.other):
            raise IndexError(f"block {row_id} has no stock row {stock}")
        return self.first[row_id] + stock

    def down(self, row_id: str) -> tuple[int, int]:
        """The first and last row of stock block `row_id`, its "All other positions" row
        included."""
        top = self.row(row_id, 0)
        bottom = top + self.stocks - 1 + (row_id in self.other)
        if bottom < top:
            raise ValueError(f"block {row_id} has no rows")
        return top, bottom


class Ref:
    """A template's view of the one cell being written: column `col` (0-based) and stock `stock`
    (for stock blocks) on the sheet laid out as `rows`. Every method takes a row id of the
    registry and returns an A1 reference or range."""

    __slots__ = ("cols", "rows", "col", "stock")

    def __init__(self, cols: Columns, rows: Rows, col: int, stock: int = 0) -> None:
        self.cols, self.rows, self.col, self.stock = cols, rows, col, stock

    @property
    def cut(self) -> bool:
        """Whether the fund is cut (has an "All other positions" line): the Rows' own flag."""
        return self.rows.cut

    def _at(self, row_id: str, col: int) -> str:
        return f"{col_letter(col)}{self.rows.row(row_id, self.stock)}"

    def _in_quarters(self, what: str) -> None:
        if not self.cols.before_index < self.col < self.cols.latest_index:
            raise ValueError(f"{what} is only defined in a quarter column")

    def _year(self) -> int:
        year = self.cols.year_at(self.col)
        if year is None:
            raise ValueError("a year range is only defined in a year column")
        return year

    def this(self, row_id: str) -> str:
        """Row `row_id` in this column (for a stock block, this stock's row)."""
        return self._at(row_id, self.col)

    def prev(self, row_id: str) -> str:
        """One column to the left: Before, in the first quarter."""
        self._in_quarters("prev")
        return self._at(row_id, self.col - 1)

    def ahead(self, row_id: str, k: int) -> str | None:
        """`k` quarters to the right; None past the last quarter column (bound), where the
        engine's prices stop."""
        self._in_quarters("ahead")
        col = self.col + k
        return None if col >= self.cols.latest_index else self._at(row_id, col)

    def col_header(self, row_id: str) -> str:
        """Header row `row_id` in this column."""
        if BY_ID[row_id].kind != "header":
            raise ValueError(f"{row_id!r} is not a header row")
        return self.this(row_id)

    def fund(self, row_id: str) -> str:
        """Fund row (or fund input row) `row_id` in this column."""
        block = BY_ID[row_id]
        if block.kind not in ("fund", "fund_input", "year_only") or block.per_stock:
            raise ValueError(f"{row_id!r} is not a fund row")
        return self.this(row_id)

    def at_end(self, row_id: str) -> str:
        """Row `row_id` in end_q's column (the fund's last held quarter)."""
        return self._at(row_id, self.cols.quarter_index(self.cols.end_q))

    def at_latest(self, row_id: str) -> str:
        """Row `row_id` in the Latest column."""
        return self._at(row_id, self.cols.latest_index)

    def tracked(self, row_id: str) -> str:
        """Row `row_id` over the tracked quarters, start..end_q."""
        row = self.rows.row(row_id, self.stock)
        return f"{self.cols.first_q}{row}:{self.cols.quarter(self.cols.end_q)}{row}"

    def down(self, row_id: str) -> str:
        """Stock block `row_id` down this column: every stock, and the "All other positions"
        row when the block has one."""
        top, bottom = self.rows.down(row_id)
        letter = col_letter(self.col)
        return f"{letter}{top}:{letter}{bottom}"

    def year_span(self, row_id: str) -> str:
        """Row `row_id` over this year column's tracked quarters."""
        first, last = self.cols.year_span(self._year())
        row = self.rows.row(row_id, self.stock)
        return f"{first}{row}:{last}{row}"

    def year_first(self, row_id: str) -> str:
        """Row `row_id` in this year's first tracked quarter."""
        return f"{self.cols.year_span(self._year())[0]}{self.rows.row(row_id, self.stock)}"

    def year_last(self, row_id: str) -> str:
        """Row `row_id` in this year's last tracked quarter."""
        return f"{self.cols.year_span(self._year())[1]}{self.rows.row(row_id, self.stock)}"


Template = Callable[[Ref], str]


@dataclass(frozen=True)
class Block:
    """One row (single) or block (one row per stock) of the Model tab.

    `formula` is the quarter-cell template (for a year-only block, the year-cell template).
    `before` and `latest` fill the Before and Latest columns: a number (a starting value), a
    template, or the name of the input field that holds the value. `source` names the field an
    input row is written from: a StockInputs field for stock blocks, a FundInputs field (or
    "other.<field>") for single rows; for Orca's figures ("orca"), a key of OrcaFund.quarters
    and .years (single rows) or an OrcaStock field (stock blocks). `other` fills the block's
    "All other positions" row when the fund is cut: the name of an OtherInputs list (an input
    row), or a template rendered with that row as the stock (a formula row). Like the block's
    stock rows, it covers the quarters start..bound in an input block (I2) and start..end_q in a
    calculation block, plus its year cells. `cut_only` rows exist only when the fund is cut.
    `year_cell` is the year-cell template of a row whose year rule is "own" (the differences)."""

    id: str
    name: str
    kind: Kind
    units: str
    year_rule: YearRule
    number_format: str
    formula: Template | None
    before: float | str | Template | None = None
    latest: str | Template | None = None
    source: str | None = None
    other: str | Template | None = None
    cut_only: bool = False
    year_cell: Template | None = None

    @property
    def per_stock(self) -> bool:
        """A stock block (I1-I6, C1-C20, and the checks' S1, O1-O2, D1-D2): one row per stock."""
        return self.id[0] in "ICSOD" and self.id[1:].isdigit()


def year_formula(block: Block, r: Ref) -> str | None:
    """The year cell of `block` in the year column of `r`, by its year rule (spec 3.3). The
    year's quarter columns are contiguous, so each rule reads that range directly: SUM, MIN, or
    the last or first quarter's cell. "product" (the Growth row) and "chained" (the Return row)
    read the Year-to-date growth row at the year's last quarter: a running product, so a quarter
    of -100% or worse still gives the engine's `math.prod` (LN of it would be #NUM!). The year's
    Return is blank without a quarterly return. "own" is the block's `year_cell` template. None
    for "blank" (no year cell) and "none" (a year-only block, whose formula is the year cell)."""
    rule = block.year_rule
    if rule == "sum":
        return f"=SUM({r.year_span(block.id)})"
    if rule == "min":
        return f"=MIN({r.year_span(block.id)})"
    if rule == "max":
        return f"=MAX({r.year_span(block.id)})"
    if rule == "own":
        return block.year_cell(r)
    if rule == "year_end":
        last = r.year_last(block.id)
        return f'=IF({last}="","",{last})'  # an empty input cell stays blank, not 0
    if rule == "first_start":
        return f"={r.year_first(block.id)}"
    if rule == "product":
        return f"={r.year_last('ytd_growth')}"
    if rule == "chained":
        return f'=IF({r.fund("has_return")}=0,"",{r.year_last("ytd_growth")}-1)'
    return None


# --- stock calculation blocks (engine.position.compute_position) ------------------------------


def _c1(r: Ref) -> str:
    """Split-adjusted shares; a quarter not filed is 0 shares."""
    i1 = r.this("I1")
    return f'=IF({i1}="",0,{i1}*{r.this("I3")})'


def _c2(r: Ref) -> str:
    """The latest close up to this quarter (`last_close_before` of the next quarter)."""
    i4 = r.this("I4")
    return f'=IF({i4}<>"",{i4},{r.prev("C2")})'


def _c2_before(r: Ref) -> str:
    i4 = r.this("I4")
    return f'=IF({i4}<>"",{i4},"")'  # the last close before the segment, blank when none


def _c3(r: Ref) -> str:
    c1, i2 = r.this("C1"), r.this("I2")
    return f'=IF(AND({c1}>0,{i2}>0),{i2}/{c1},"")'


def _c4(r: Ref) -> str:
    """`_valuation_close`: close, last close before, reported value per share; else the previous
    valuation while held. Blank when flat (nothing held before or now)."""
    c1, p5, i4 = r.this("C1"), r.prev("C5"), r.this("I4")
    p2, c3, p4 = r.prev("C2"), r.this("C3"), r.prev("C4")
    return (
        f'=IF(AND({c1}=0,{p5}=0),"",IF({i4}<>"",{i4},IF({p2}<>"",{p2},'
        f'IF({c3}<>"",{c3},IF({p5}>0,{p4},"")))))'
    )


def _c5(r: Ref) -> str:
    """A held stock that cannot be valued yet stays out of the book."""
    return f'=IF({r.this("C4")}="",0,{r.this("C1")})'


def _c6(r: Ref) -> str:
    return f"=IF(OR({r.this('C5')}>0,{r.prev('C5')}>0),1,0)"


def _c7(r: Ref) -> str:
    return f"={r.this('C5')}-{r.prev('C5')}"


def _c8(r: Ref) -> str:
    """`_trade_price`: the close for a first report, else VWAP, last close before, reported value
    per share, valuation price."""
    c7, p5, first, p1 = r.this("C7"), r.prev("C5"), r.col_header("first_tracked"), r.prev("C1")
    i4, i5, p2, c3, c4 = r.this("I4"), r.this("I5"), r.prev("C2"), r.this("C3"), r.this("C4")
    return (
        f'=IF({c7}=0,"",IF(AND({p5}=0,OR({first}=1,{p1}>0),{i4}<>""),{i4},'
        f'IF({i5}<>"",{i5},IF({p2}<>"",{p2},IF({c3}<>"",{c3},{c4})))))'
    )


def _c9(r: Ref) -> str:
    c7 = r.this("C7")
    return f"=IF({c7}=0,0,{c7}*{r.this('C8')})"


def _c10(r: Ref) -> str:
    p5 = r.prev("C5")
    return f"=IF({p5}>0,{p5}*({r.this('C4')}-{r.prev('C4')}),0)"


def _c11(r: Ref) -> str:
    c7 = r.this("C7")
    return f"=IF({c7}=0,0,{c7}*({r.this('C4')}-{r.this('C8')}))"


def _c12(r: Ref) -> str:
    p5 = r.prev("C5")
    return f"=IF({p5}>0,{p5}*{r.this('I6')},0)"


def _c13(r: Ref) -> str:
    return f"={r.this('C10')}+{r.this('C11')}+{r.this('C12')}"


def _c14(r: Ref) -> str:
    """Average cost: a buy adds its dollars; a sale takes out its shares at the average cost."""
    c7, c9, c5, p14, p5 = r.this("C7"), r.this("C9"), r.this("C5"), r.prev("C14"), r.prev("C5")
    return (
        f"=IF({c7}>0,{p14}+{c9},IF({c7}<0,IF({c5}=0,0,{p14}+{c7}*{p14}/{p5}),{p14}))"
    )


def _c15(r: Ref) -> str:
    c7 = r.this("C7")
    return f"=IF({c7}<0,-{c7}*({r.this('C8')}-{r.prev('C14')}/{r.prev('C5')}),0)"


def _c16(r: Ref) -> str:
    c5 = r.this("C5")
    return f"=IF({c5}=0,0,{c5}*{r.this('C4')})"


def _c17(r: Ref) -> str:
    return f"=-{r.this('C9')}"


def _c17_latest(r: Ref) -> str:
    """The holding at end_q valued at the latest close: 0 when nothing is held, blank when held
    but unpriced (the site's `positionFlows` gives no flows then)."""
    shares, close = r.at_end("C5"), r.this("I4")
    return f'=IF({shares}=0,0,IF({close}="","",{shares}*{close}))'


def _c18(r: Ref) -> str:
    c7 = r.this("C7")
    return f"=IF({c7}>0,-{r.this('C9')},0)"


def _c18_latest(r: Ref) -> str:
    """Every share bought, valued at the latest close (the site's `heldFlows`)."""
    close = r.this("I4")
    return f'=IF({close}="","",SUMIF({r.tracked("C7")},">0")*{close})'


def _c19(r: Ref) -> str:
    """`whatif._return_after`: the close four quarters on over the trade price. Past bound there
    is no such quarter (the engine's prices stop there), and a trade price that is not positive
    gives no figure."""
    later = r.ahead("I4", 4)
    if later is None:
        return '=""'
    c8 = r.this("C8")
    return f'=IF({r.this("C7")}=0,"",IF(AND({later}<>"",{c8}>0),{later}/{c8}-1,""))'


def _c20(r: Ref) -> str:
    """`fund.contributions`, in a year column: P&L over (year start + net buying / 2) x 100 for
    a stock with a quarter in the book that year."""
    den = f"{r.fund('start')}+{r.fund('net_buying')}/2"
    return f'=IF({r.this("C6")}=0,"",IF({den}>0,{r.this("C13")}/({den})*100,""))'


def _c20_other(r: Ref) -> str:
    """Points of the "All other positions" row: its P&L as for any stock. That row has no In
    book row, so a year in which none of those positions was held shows 0, their empty sum."""
    den = f"{r.fund('start')}+{r.fund('net_buying')}/2"
    return f'=IF({den}>0,{r.this("C13")}/({den})*100,"")'


# --- fund rows (engine.fund.aggregate_fund, engine.metrics) ------------------------------------


def _start(r: Ref) -> str:
    return f"={r.prev('end')}"  # End's Before is 0: the first quarter starts empty


def _end(r: Ref) -> str:
    return f"=SUM({r.down('C16')})"


def _buys(r: Ref) -> str:
    other = f"+{r.fund('other_buys')}" if r.cut else ""
    return f'=SUMIF({r.down("C9")},">0"){other}'


def _sells(r: Ref) -> str:
    other = f"+{r.fund('other_sells')}" if r.cut else ""
    return f'=-SUMIF({r.down("C9")},"<0"){other}'


def _net_buying(r: Ref) -> str:
    return f"={r.fund('buys')}-{r.fund('sells')}"


def _market_move(r: Ref) -> str:
    return f"=SUM({r.down('C10')})"


def _trade_gains(r: Ref) -> str:
    return f"=SUM({r.down('C11')})"


def _dividends(r: Ref) -> str:
    return f"=SUM({r.down('C12')})"


def _bridge_gap(r: Ref) -> str:
    f = r.fund
    return (
        f"={f('end')}-({f('start')}+{f('market_move')}+{f('net_buying')}+{f('trade_gains')})"
    )


def _bridge_ok(r: Ref) -> str:
    """`fund.check_bridge`: within one part in a million of the quarter's largest amount."""
    f = r.fund
    scale = f"MAX(1,ABS({f('end')}),ABS({f('start')}),{f('buys')}+{f('sells')})"
    return f"=IF(ABS({f('bridge_gap')})<=1E-6*{scale},1,0)"


def _ret(r: Ref) -> str:
    """No return in the segment's first quarter, nor without a positive start and denominator."""
    f = r.fund
    start, nb = f("start"), f("net_buying")
    den = f"{start}+{nb}/2"
    return (
        f'=IF(AND({r.col_header("first_tracked")}=0,{start}>0,{den}>0),'
        f'({f("end")}-{start}-{nb}+{f("dividends")})/({den}),"")'
    )


def _growth(r: Ref) -> str:
    ret = r.fund("ret")
    return f'=IF({ret}="",1,1+{ret})'


def _ytd_growth(r: Ref) -> str:
    """The running product of Growth within the calendar year, restarting at the year's first
    tracked quarter (Before is 1): its last quarter is the year's growth, `math.prod` exactly."""
    restart = f"{r.col_header('year')}<>{r.prev('year')}"
    return f"=IF({restart},1,{r.prev('ytd_growth')})*{r.fund('growth')}"


def _has_return(r: Ref) -> str:
    return f'=IF({r.fund("ret")}="",0,1)'


def _rf_used(r: Ref) -> str:
    """`metrics._quarterly_rf`: the year's rate, else the latest earlier one (Before: 0)."""
    tbill = r.fund("tbill")
    return f'=IF({tbill}<>"",{tbill},{r.prev("rf_used")})'


def _excess(r: Ref) -> str:
    ret = r.fund("ret")
    return f'=IF({ret}="","",{ret}-{r.fund("rf_used")}/4)'


def _downside2(r: Ref) -> str:
    excess = r.fund("excess")
    return f'=IF({excess}="","",MIN(0,{excess})^2)'


def _index(r: Ref) -> str:
    return f"={r.prev('index')}*{r.fund('growth')}"


def _peak(r: Ref) -> str:
    return f"=MAX({r.prev('peak')},{r.fund('index')})"


def _drawdown(r: Ref) -> str:
    return f"={r.fund('index')}/{r.fund('peak')}-1"


def _in_range(r: Ref) -> str:
    """Summary's From and To years are the workbook names FromYear and ToYear."""
    year = r.col_header("year")
    return f"=IF(AND({year}>=FromYear,{year}<=ToYear),1,0)"


def _ret_in_range(r: Ref) -> str:
    ret = r.fund("ret")
    return f'=IF(AND({r.fund("in_range")}=1,{ret}<>""),{ret},"")'


def _range_index(r: Ref) -> str:
    return f"=IF({r.fund('in_range')}=1,{r.prev('range_index')}*{r.fund('growth')},1)"


def _range_peak(r: Ref) -> str:
    return f"=IF({r.fund('in_range')}=1,MAX({r.prev('range_peak')},{r.fund('range_index')}),1)"


def _range_drawdown(r: Ref) -> str:
    f = r.fund
    return f'=IF({f("in_range")}=1,{f("range_index")}/{f("range_peak")}-1,"")'


# --- year-only rows (engine.fund.fund_years / full_years, metrics.turnover, aum.ts) -----------


def _full_year(r: Ref) -> str:
    """`fund.full_years`: four quarters with a return (so not the segment's first quarter)."""
    return f"=IF({r.fund('has_return')}=4,1,0)"


def _ret_if_full(r: Ref) -> str:
    return f'=IF({r.fund("full_year")}=1,{r.fund("ret")},"")'


def _gains(r: Ref) -> str:
    return f"={r.fund('market_move')}+{r.fund('trade_gains')}"


def _inflows(r: Ref) -> str:
    return f"={r.fund('net_buying')}"


def _approx_ret(r: Ref) -> str:
    f = r.fund
    den = f"{f('start')}+{f('inflows')}/2"
    return f'=IF({den}>0,({f("gains")}+{f("dividends")})/({den}),"")'


def _mean_book(r: Ref) -> str:
    """The mean of the year's start and its four quarter ends."""
    return f'=IF({r.fund("full_year")}=1,AVERAGE({r.fund("start")},{r.year_span("end")}),"")'


def _turnover(r: Ref) -> str:
    f = r.fund
    book = f("mean_book")
    return (
        f'=IF(AND({f("full_year")}=1,{book}>0),MIN({f("buys")},{f("sells")})/{book},"")'
    )


# The AUM chart's stack (aum.ts `aumParts`). Outflows and losses come off the gains first,
# then off the net inflows, then off the carried-over book. The fund's first year with a start
# of at most $100K is one block: carried over = the year's end, the rest 0.


def _aum(normal: Template, first_block: Template) -> Template:
    """IF(the fund's first year starts at <= $100K, `first_block`, `normal`); both are
    expressions without the leading "="."""

    def template(r: Ref) -> str:
        first = f'AND({r.col_header("first_tracked")}=1,{r.fund("start")}<=100000)'
        return f"=IF({first},{first_block(r)},{normal(r)})"

    return template


def _zero(r: Ref) -> str:
    return "0"


def _year_end_book(r: Ref) -> str:
    return r.fund("end")


def _removed(r: Ref) -> str:
    return f"({r.fund('aum_outflows')}+{r.fund('aum_losses')})"


def _aum_carried(r: Ref) -> str:
    rest = f"MAX({_removed(r)}-MAX({r.fund('gains')},0)-MAX({r.fund('inflows')},0),0)"
    return f"MAX(0,{r.fund('start')}-{rest})"


def _aum_inflows(r: Ref) -> str:
    rest = f"MAX({_removed(r)}-MAX({r.fund('gains')},0),0)"
    return f"MAX(MAX({r.fund('inflows')},0)-{rest},0)"


def _aum_gains(r: Ref) -> str:
    return f"MAX(MAX({r.fund('gains')},0)-{_removed(r)},0)"


def _aum_losses(r: Ref) -> str:
    return f"MAX(-{r.fund('gains')},0)"


def _aum_outflows(r: Ref) -> str:
    return f"MAX(-{r.fund('inflows')},0)"


# --- the registry ------------------------------------------------------------------------------

# The builder writes the header rows' quarter cells (spec 3.2); their year cells follow the rule.
HEADER_ROWS: tuple[Block, ...] = (
    Block("quarter", "Quarter", "header", "q", "blank", WHOLE, None),
    Block("label", "Label", "header", "", "blank", GENERAL, None),
    Block("year", "Year", "header", "year", "min", WHOLE, None),  # a year column's own year
    Block("quarter_end", "Quarter end", "header", "date", "blank", DATE, None),
    Block(
        "mid_quarter", "Mid-quarter", "header", "date", "blank", DATE, None, latest="latest_date"
    ),
    # its year cell is 1 in the segment's first year only (read by the AUM rows)
    Block("first_tracked", "First tracked quarter", "header", "1/0", "sum", WHOLE, None),
    Block("held_through", "Held through", "header", "1/0", "blank", WHOLE, None),
)

FUND_INPUTS: tuple[Block, ...] = (
    Block("carried", "Carried quarter", "fund_input", "1/0", "sum", WHOLE, None, source="carried"),
    Block(
        "tbill", "T-bill yearly average", "fund_input", "%", "year_end", PCT, None, source="tbill"
    ),
    Block(
        "spy_close", "SPY close", "fund_input", "$/share", "year_end", PRICE, None,
        source="spy_close",
    ),
    Block("spy_vwap", "SPY VWAP", "fund_input", "$/share", "blank", PRICE, None, source="spy_vwap"),
    Block(
        "total_reported", "Total reported value", "fund_input", "$", "year_end", USD, None,
        source="total_reported",
    ),
    Block(
        "other_buys", "Other positions buys", "fund_input", "$", "sum", USD, None,
        source="other.buys", cut_only=True,
    ),
    Block(
        "other_sells", "Other positions sells", "fund_input", "$", "sum", USD, None,
        source="other.sells", cut_only=True,
    ),
)  # fmt: skip

_STOCK_INPUTS: tuple[Block, ...] = (
    Block("I1", "Shares filed", "input", "shares", "year_end", SHARES, None, source="shares_filed"),
    Block(
        "I2", "Value filed ($)", "input", "$", "year_end", USD, None,
        source="value_filed", other="value_filed",
    ),
    Block("I3", "Split factor", "input", "×", "year_end", FACTOR, None, source="split_factor"),
    Block(
        "I4", "Close", "input", "$/share", "year_end", PRICE, None,
        before="close_before", latest="close_latest", source="close",
    ),
    Block("I5", "VWAP", "input", "$/share", "blank", PRICE, None, source="vwap"),
    Block("I6", "Dividends per share", "input", "$/share", "sum", PRICE, None, source="div_ps"),
)  # fmt: skip

_STOCK_CALCS: tuple[Block, ...] = (
    Block("C1", "Adjusted shares", "calc", "shares", "year_end", SHARES, _c1, before=0.0),
    Block("C2", "Last close", "calc", "$/share", "year_end", PRICE, _c2, before=_c2_before),
    Block("C3", "Implied price", "calc", "$/share", "blank", PRICE, _c3),
    Block("C4", "Valuation price", "calc", "$/share", "year_end", PRICE, _c4),
    Block("C5", "Shares held", "calc", "shares", "year_end", SHARES, _c5, before=0.0),
    Block("C6", "In book", "calc", "1/0", "sum", WHOLE, _c6),
    Block("C7", "Shares traded", "calc", "shares", "sum", SHARES, _c7),
    Block("C8", "Trade price", "calc", "$/share", "blank", PRICE, _c8),
    Block("C9", "Trade $", "calc", "$", "sum", USD, _c9),
    Block("C10", "Market move", "calc", "$", "sum", USD, _c10, other="market_move"),
    Block("C11", "Trade gain", "calc", "$", "sum", USD, _c11, other="trade_gain"),
    Block("C12", "Dividends $", "calc", "$", "sum", USD, _c12, other="dividends"),
    # the "All other positions" P&L is that row's market move + trade gain + dividends
    Block("C13", "P&L", "calc", "$", "sum", USD, _c13, other=_c13),
    Block("C14", "Cost", "calc", "$", "year_end", USD, _c14, before=0.0),
    Block("C15", "Realised", "calc", "$", "sum", USD, _c15),
    Block("C16", "Value", "calc", "$", "year_end", USD, _c16, other="value"),
    Block("C17", "Cash flow", "calc", "$", "sum", USD, _c17, latest=_c17_latest),
    Block("C18", "Cash flow if held", "calc", "$", "sum", USD, _c18, latest=_c18_latest),
    Block("C19", "1-year-after return", "calc", "%", "blank", PCT, _c19),
    Block("C20", "Points", "year_only", "points", "none", RATIO, _c20, other=_c20_other),
)

_FUND_ROWS: tuple[Block, ...] = (
    Block("start", "Start", "fund", "$", "first_start", USD, _start),
    Block("end", "End", "fund", "$", "year_end", USD, _end, before=0.0),
    Block("buys", "Buys", "fund", "$", "sum", USD, _buys),
    Block("sells", "Sells", "fund", "$", "sum", USD, _sells),
    Block("net_buying", "Net buying", "fund", "$", "sum", USD, _net_buying),
    Block("market_move", "Market move", "fund", "$", "sum", USD, _market_move),
    Block("trade_gains", "Trade gains", "fund", "$", "sum", USD, _trade_gains),
    Block("dividends", "Dividends", "fund", "$", "sum", USD, _dividends),
    Block("bridge_gap", "Bridge gap", "fund", "$", "sum", USD, _bridge_gap),
    Block("bridge_ok", "Bridge OK", "fund", "1/0", "min", WHOLE, _bridge_ok),
    Block("ret", "Return", "fund", "%", "chained", PCT, _ret),
    Block("growth", "Growth", "fund", "×", "product", FACTOR, _growth),
    Block(
        "ytd_growth", "Year-to-date growth", "fund", "×", "blank", FACTOR, _ytd_growth, before=1.0
    ),
    Block("has_return", "Has return", "fund", "1/0", "sum", WHOLE, _has_return),
    Block("rf_used", "Risk-free used", "fund", "%", "year_end", PCT, _rf_used, before=0.0),
    Block("excess", "Excess return", "fund", "%", "blank", PCT, _excess),
    Block("downside2", "Downside²", "fund", "%²", "blank", GENERAL, _downside2),
    Block("index", "Index", "fund", "×", "year_end", FACTOR, _index, before=1.0),
    Block("peak", "Peak", "fund", "×", "year_end", FACTOR, _peak, before=1.0),
    Block("drawdown", "Drawdown", "fund", "%", "min", PCT, _drawdown),
    Block("in_range", "In range", "fund", "1/0", "blank", WHOLE, _in_range),
    Block("ret_in_range", "Return in range", "fund", "%", "blank", PCT, _ret_in_range),
    Block("range_index", "Range index", "fund", "×", "blank", FACTOR, _range_index, before=1.0),
    Block("range_peak", "Range peak", "fund", "×", "blank", FACTOR, _range_peak, before=1.0),
    Block("range_drawdown", "Range drawdown", "fund", "%", "blank", PCT, _range_drawdown),
)

_YEAR_ROWS: tuple[Block, ...] = (
    Block("full_year", "Full year", "year_only", "1/0", "none", WHOLE, _full_year),
    Block("ret_if_full", "Return if full year", "year_only", "%", "none", PCT, _ret_if_full),
    Block("gains", "Gains", "year_only", "$", "none", USD, _gains),
    Block("inflows", "Inflows", "year_only", "$", "none", USD, _inflows),
    Block("approx_ret", "Approx. return", "year_only", "%", "none", PCT, _approx_ret),
    Block("mean_book", "Mean book", "year_only", "$", "none", USD, _mean_book),
    Block("turnover", "Turnover", "year_only", "ratio", "none", RATIO, _turnover),
    Block(
        "aum_carried", "AUM: carried over", "year_only", "$", "none", USD,
        _aum(_aum_carried, _year_end_book),
    ),
    Block(
        "aum_inflows", "AUM: net inflows", "year_only", "$", "none", USD,
        _aum(_aum_inflows, _zero),
    ),
    Block("aum_gains", "AUM: gains", "year_only", "$", "none", USD, _aum(_aum_gains, _zero)),
    Block("aum_losses", "AUM: losses", "year_only", "$", "none", USD, _aum(_aum_losses, _zero)),
    Block(
        "aum_outflows", "AUM: outflows", "year_only", "$", "none", USD,
        _aum(_aum_outflows, _zero),
    ),
)  # fmt: skip

BLOCKS: tuple[Block, ...] = _STOCK_INPUTS + _STOCK_CALCS + _FUND_ROWS + _YEAR_ROWS


# --- the checks (spec 3.4, ruling R21) ---------------------------------------------------------

TOLERANCE: dict[str, float] = {"money": 1e-9, "ratio": 1e-9, "exact": 0.0}


def difference(
    kind: CheckKind, excel: str, orca: str, scale: str | None = None, present: str | None = None
) -> str:
    """A difference cell: 0 when Excel's and Orca's cells are both blank, 1E+300 when only one
    is; else, for dollars and shares, |Excel - Orca| / MAX(1, |Orca|, scale), the scale being the
    size of the amounts the figure is summed from (without one, as a ratio: Summary's book, a
    sum of values that are never negative); for returns, ratios, prices and points,
    |Excel - Orca| / MAX(1, |Orca|); for quarters, counts and text, 0 when equal, else 1. Each
    compares with TOLERANCE[kind]. `present` is the cell whose blank stands for Excel's, when
    that is not `excel` itself."""
    e_blank, o_blank = f'{present or excel}=""', f'{orca}=""'
    if kind == "exact":
        gap = f"IF({excel}={orca},0,1)"
    elif kind == "money" and scale is not None:
        gap = f"ABS({excel}-{orca})/MAX(1,ABS({orca}),{scale})"
    else:
        gap = f"ABS({excel}-{orca})/MAX(1,ABS({orca}))"
    return f"=IF(AND({e_blank},{o_blank}),0,IF(OR({e_blank},{o_blank}),1E+300,{gap}))"


def stock_scale(value: str, cost: str, trades: str) -> str:
    """A stock's scale for its dollar and share differences: the largest |Value| and |Cost| over
    the tracked quarters, or the dollars it invested (the positive Trade $), whichever is more.
    An expression, without the leading "="."""
    return f'MAX(SUMPRODUCT(MAX(ABS({value}),ABS({cost}))),SUMIF({trades},">0"))'


# Orca's fund figures on Model (spec 3.2, the last part): (id, name, kind, in the quarter
# columns, in the year columns). Row o_<id> holds the engine's figure (FundQuarter or FundYear
# field <id>), row d_<id> its difference from the workbook's row <id>.
_ORCA_FUND = (
    ("start", "Start", "money", True, True),
    ("end", "End", "money", True, True),
    ("market_move", "Market move", "money", True, False),
    ("net_buying", "Net buying", "money", True, False),
    ("trade_gains", "Trade gains", "money", True, False),
    ("dividends", "Dividends", "money", True, True),
    ("ret", "Return", "ratio", True, True),
    ("gains", "Gains", "money", False, True),
    ("inflows", "Inflows", "money", False, True),
    ("approx_ret", "Approx. return", "ratio", False, True),
)


def _fund_scale(r: Ref) -> str:
    """A quarter's scale, the bridge check's own; a year's is the largest of its quarters'."""
    f = r.fund
    return f"=MAX(ABS({f('start')}),ABS({f('end')}),{f('buys')}+{f('sells')})"


def _fund_difference(row_id: str, kind: CheckKind) -> Template:
    def template(r: Ref) -> str:
        scale = r.this("scale") if kind == "money" else None
        return difference(kind, r.this(row_id), r.this(f"o_{row_id}"), scale)

    return template


def _bridge_difference(r: Ref) -> str:
    """The engine raises on a quarter whose bridge does not hold, so Orca's figure is 1."""
    return f"=IF({r.this('bridge_ok')}=1,0,1)"


def _s1(r: Ref) -> str:
    return "=" + stock_scale(r.tracked("C16"), r.tracked("C14"), r.tracked("C9"))


def _d1(r: Ref) -> str:
    return difference("ratio", r.this("C20"), r.this("O1"))


def _d2(r: Ref) -> str:
    """A year's P&L of a stock is compared where it has points: the engine lists a stock's
    contribution only for a year it was in the book with a positive denominator."""
    return difference(
        "money", r.this("C13"), r.this("O2"), r.at_latest("S1"), present=r.this("C20")
    )


def _orca_rows() -> tuple[Block, ...]:
    rows = [Block("scale", "Scale", "check", "$", "max", USD, _fund_scale)]
    for row_id, name, kind, quarters, years in _ORCA_FUND:
        number_format = PCT if kind == "ratio" else USD
        units = "%" if kind == "ratio" else "$"
        rows.append(
            Block(f"o_{row_id}", f"Orca: {name}", "orca", units, "blank", number_format, None,
                  source=row_id)
        )  # fmt: skip
        template = _fund_difference(row_id, kind)
        rows.append(
            Block(
                f"d_{row_id}", f"Difference: {name}", "check", "", "own" if years else "blank",
                SCI, template if quarters else None, year_cell=template if years else None,
            )
        )  # fmt: skip
    rows.append(Block("d_bridge", "Difference: bridge", "check", "1/0", "blank", WHOLE,
                      _bridge_difference))  # fmt: skip
    rows += [
        # one cell per stock, in the Latest column: its scale over the tracked quarters
        Block("S1", "Stock scale", "check", "$", "blank", USD, None, latest=_s1),
        Block("O1", "Orca points", "orca", "points", "blank", RATIO, None, source="points"),
        Block("D1", "Points difference", "check", "", "own", SCI, None, year_cell=_d1),
        Block("O2", "Orca P&L", "orca", "$", "blank", USD, None, source="pnl"),
        Block("D2", "P&L difference", "check", "", "own", SCI, None, year_cell=_d2),
    ]
    return tuple(rows)


ORCA_ROWS: tuple[Block, ...] = _orca_rows()

MODEL_ROWS: tuple[Block, ...] = HEADER_ROWS + FUND_INPUTS + BLOCKS + ORCA_ROWS  # the tab's order

BY_ID: dict[str, Block] = {b.id: b for b in MODEL_ROWS}

# The blocks a cut fund ends with an "All other positions" row (spec section 4): the one list
# Rows, the templates and the builder read.
OTHER_ROWS: frozenset[str] = frozenset(b.id for b in MODEL_ROWS if b.other is not None)


# --- the Outputs tab's stock table (spec 3.4) --------------------------------------------------


class OutRef(Protocol):
    """What an Outputs template reads, for one stock's row (`outputs.OutputsRef` places it).
    Model rows are this stock's, over a span of quarter columns: "tracked" (start..end_q),
    "before" (Before..end_q), "all" (start..bound) or "flows" (start..Latest). Every method
    returns an A1 reference or range, with the sheet's name when it is not Outputs."""

    period_q: int  # the latest quarter filed: the site's newest quarter

    def col(self, column_id: str) -> str: ...  # this row's cell of an Outputs column
    def model(self, row_id: str, span: str = "tracked") -> str: ...  # this stock's Model row
    def model_at(self, row_id: str, column: int | str) -> str: ...  # a quarter, "end", "latest"
    def header(self, row_id: str, span: str = "tracked") -> str: ...  # a Model header row
    def header_at(self, row_id: str, column: int | str) -> str: ...
    def fund(self, row_id: str) -> str: ...  # a Model fund input row over start..bound
    def total(self, column_id: str) -> str: ...  # the Total row's cell of a column


OutTemplate = Callable[[OutRef], str]


@dataclass(frozen=True)
class Column:
    """One column of the Outputs stock table. `formula` renders a stock's cell; an Orca column
    has none and holds OrcaStock field `source` (an input), compared as `kind` by the difference
    column beside it."""

    id: str
    name: str
    units: str
    number_format: str
    formula: OutTemplate | None
    source: str | None = None
    kind: CheckKind | None = None


def _last_where(conditions: list[str], quarters: str) -> str:
    """The last quarter whose cells meet every condition, -1 when none (spec 3.1)."""
    factors = "".join(f"({c})*" for c in conditions)
    return f"SUMPRODUCT(MAX({factors}({quarters}+1)))-1"


def _in_quarter(r: OutRef, row_id: str, q_column: str, span: str = "tracked") -> str:
    """This stock's `row_id` in the quarter named by Outputs column `q_column`; over the span
    "before" (one column further left), the quarter before it."""
    return f"INDEX({r.model(row_id, span)},MATCH({r.col(q_column)},{r.header('quarter')},0))"


def _xirr(r: OutRef, row_id: str) -> str:
    """XIRR of this stock's flows in row `row_id` (C17 or C18) against the Mid-quarter dates,
    from its first quarter in the book (its first trade) to Latest, as the site's search finds
    it: blank without an answer or outside -99%..1,000%. The flows start at the first trade: from
    an earlier quarter, leading zero flows let LibreOffice's XIRR stop at a spurious rate where
    every flow is discounted to nearly nothing (and Excel's XIRR wants a nonzero first flow)."""
    first = f"MATCH(1,{r.model('C6')},0)"

    def run(row: str, latest: str) -> str:
        return f"INDEX({row},{first}):{latest}"

    flows = run(r.model(row_id, "flows"), r.model_at(row_id, "latest"))
    dates = run(r.header("mid_quarter", "flows"), r.header_at("mid_quarter", "latest"))
    x = f"XIRR({flows},{dates})"
    return f'IFERROR(IF(AND({x}>=-0.99,{x}<=10),{x},""),"")'


def _if_position(body: Callable[[OutRef], str]) -> OutTemplate:
    """Blank for a stock that never entered the book (no position: the site has no row)."""

    def template(r: OutRef) -> str:
        return f'=IF({r.col("from_q")}="","",{body(r)})'

    return template


def _from_q(r: OutRef) -> str:
    c6, q = r.model("C6"), r.header("quarter")
    return f'=IF(COUNTIF({c6},1)=0,"",INDEX({q},MATCH(1,{c6},0)))'


def _to_q(r: OutRef) -> str:
    """The last exit (shares sold to 0) when nothing is held now."""
    exit_q = _last_where([f"{r.model('C7')}<0", f"{r.model('C5')}=0"], r.header("quarter"))
    return f'=IF(OR({r.col("from_q")}="",{r.col("shares_now")}>0),"",{exit_q})'


def _avg_cost(r: OutRef) -> str:
    bought = r.col("shares_bought")
    return f'IF({bought}>0,{r.col("invested")}/{bought},"")'


def _sold_shares(r: OutRef) -> str:
    """Blank when nothing was sold: the stock has no what-if (exits) row."""
    c7 = r.model("C7")
    return f'IF(COUNTIF({c7},"<0")=0,"",-SUMIF({c7},"<0"))'


def _sold_usd(r: OutRef) -> str:
    return f'=IF({r.col("sold_shares")}="","",-SUMIF({r.model("C9")},"<0"))'


def _avg_exit(r: OutRef) -> str:
    sold, usd = r.col("sold_shares"), r.col("sold_usd")
    return f'=IF({sold}="","",IF({sold}>0,{usd}/{sold},""))'


def _latest_price(r: OutRef) -> str:
    close = r.model_at("I4", "latest")
    return f'=IF({close}="","",{close})'


def _value_now(r: OutRef) -> str:
    now, price = r.col("shares_now"), r.col("latest_price")
    return f'IF({now}=0,0,IF({price}="","",{now}*{price}))'


def _unrealised(r: OutRef) -> str:
    now, value = r.col("shares_now"), r.col("value_now")
    return f'IF({now}=0,0,IF({value}="","",{value}-{r.col("cost_now")}))'


def _total_pnl(r: OutRef) -> str:
    open_ = r.col("unrealised")
    return f'=IF({open_}="","",{r.col("realised")}+{open_}+{r.col("dividends")})'


def _ret(r: OutRef) -> str:
    total, invested = r.col("total_pnl"), r.col("invested")
    return f'=IF({total}="","",IF({invested}>0,{total}/{invested},""))'


def _irr(r: OutRef) -> str:
    """The position's cash flows (C17) at their mid-quarter dates, the holding at the latest
    date; blank while held without a latest price (the site's positionFlows gives none)."""
    return f'IF(AND({r.col("shares_now")}>0,{r.col("latest_price")}=""),"",{_xirr(r, "C17")})'


def _weight(r: OutRef) -> str:
    """Of the whole book at latest prices (the positions beyond a cut included); an unpriced
    holding weighs 0, as on the site."""
    value, total = r.col("value_now"), r.total("value_now")
    return f'IF({total}>0,IF({value}="",0,{value})/{total},0)'


def _lc_now(r: OutRef) -> str:
    return f"={r.model_at('C5', r.period_q)}"


def _lc_before(r: OutRef) -> str:
    return f"={r.model_at('C5', r.period_q - 1)}"  # Before, when period_q is the first quarter


def _lc_value_before(r: OutRef) -> str:
    price = r.col("latest_price")
    return f'=IF({price}="","",{r.col("lc_before")}*{price})'


def _lc_tag(r: OutRef) -> str:
    """positions.buildRows' tag at the newest quarter (period_q against the quarter before)."""
    a, b = r.col("lc_now"), r.col("lc_before")
    return (
        f'=IF(AND({a}<=1E-6,{b}<=1E-6),"",IF({b}<=1E-6,"new",IF({a}<=1E-6,"exit",'
        f'IF({a}>{b}*1.000001,"add",IF({a}<{b}*0.999999,"trim","")))))'
    )


def _lc_dw(r: OutRef) -> str:
    """buildRows' weight change in points: the weight after (A of the book with this stock at
    A, the rest as before) less the weight before (B of the book before, vb), at latest prices.
    Shown only with a tag, as the site's Last change column."""
    price, tag = r.col("latest_price"), r.col("lc_tag")
    big_a, big_b = f"{r.col('lc_now')}*{price}", r.col("lc_value_before")
    vb = r.total("lc_value_before")
    den = f"{vb}-{big_b}+{big_a}"
    return (
        f'=IF(OR({tag}="",{price}=""),"",'
        f"(IF({den}>0,{big_a}/({den}),0)-IF({vb}>0,{big_b}/{vb},0))*100)"
    )


def _last_q(r: OutRef) -> str:
    return _last_where([f"{r.model('C7')}<>0"], r.header("quarter"))


def _if_traded(body: Callable[[OutRef], str]) -> OutTemplate:
    def template(r: OutRef) -> str:
        return f'=IF({r.col("last_q")}="","",{body(r)})'

    return template


def _last_type(r: OutRef) -> str:
    """publish._last_change: new or add for a buy (by the shares before), exit or trim."""
    delta, before = r.col("lt_delta"), r.col("lt_before")
    after = _in_quarter(r, "C5", "last_q")
    return f'IF({delta}>0,IF({before}=0,"new","add"),IF({after}=0,"exit","trim"))'


def _last_pct(r: OutRef) -> str:
    kind, delta, before = r.col("last_type"), r.col("lt_delta"), r.col("lt_before")
    return f'=IF(OR({kind}="add",{kind}="trim"),IF({before}>0,{delta}/{before},""),"")'


def _status(r: OutRef) -> str:
    return f'=IF({r.col("sold_shares")}="","",IF({r.col("shares_now")}=0,"Sold all","Trimmed"))'


def _last_sale_q(r: OutRef) -> str:
    last = _last_where([f"{r.model('C7')}<0"], r.header("quarter"))
    return f'=IF({r.col("sold_shares")}="","",{last})'


def _last_sale_px(r: OutRef) -> str:
    sale = r.col("last_sale_q")
    return f'=IF({sale}="","",{_in_quarter(r, "C8", "last_sale_q")})'


def _year_on(r: OutRef, values: str) -> str:
    """`values` (a row over start..bound) four quarters after the last sale: blank past bound
    (the engine's prices stop there) or in an empty cell."""
    sale, quarters = r.col("last_sale_q"), r.header("quarter", "all")
    cell = f"INDEX({values},MATCH({sale}+4,{quarters},0))"
    return f'=IF({sale}="","",IF({sale}+4>MAX({quarters}),"",IF({cell}="","",{cell})))'


def _later_close(r: OutRef) -> str:
    return _year_on(r, r.model("I4", "all"))


def _one_y(r: OutRef) -> str:
    """whatif._return_after: the close four quarters on over the sale's trade price."""
    later, price = r.col("later_close"), r.col("last_sale_px")
    return f'=IF(OR({later}="",{price}=""),"",IF({price}>0,{later}/{price}-1,""))'


def _spy_at_sale(r: OutRef) -> str:
    sale = r.col("last_sale_q")
    cell = f"INDEX({r.fund('spy_vwap')},MATCH({sale},{r.header('quarter', 'all')},0))"
    return f'=IF({sale}="","",IF({cell}="","",{cell}))'


def _spy_later(r: OutRef) -> str:
    return _year_on(r, r.fund("spy_close"))


def _spy_one_y(r: OutRef) -> str:
    """SPY's close four quarters on over its VWAP in the sale quarter."""
    later, start = r.col("spy_later"), r.col("spy_at_sale")
    return f'=IF(OR({later}="",{start}=""),"",IF({start}>0,{later}/{start}-1,""))'


def _beat_spy(r: OutRef) -> str:
    one_y, spy = r.col("one_y"), r.col("spy_one_y")
    return f'=IF(OR({one_y}="",{spy}=""),"",IF({one_y}>{spy},1,0))'


def _since_sale(r: OutRef) -> str:
    exit_px, price = r.col("avg_exit"), r.col("latest_price")
    return f'=IF(OR({exit_px}="",{price}=""),"",IF({exit_px}>0,{price}/{exit_px}-1,""))'


def _missed(r: OutRef) -> str:
    """Plus: sold too early; minus: a loss dodged."""
    sold, price = r.col("sold_shares"), r.col("latest_price")
    return f'=IF(OR({sold}="",{price}=""),"",{sold}*{price}-{r.col("sold_usd")})'


def _irr_held(r: OutRef) -> str:
    """The buys only (C18), and every share bought valued at the latest date: as if the fund
    had never sold. For a stock with a sale."""
    sold, price = r.col("sold_shares"), r.col("latest_price")
    return f'=IF(OR({sold}="",{price}=""),"",{_xirr(r, "C18")})'


def _hold(r: OutRef) -> str:
    """metrics.hold_lengths: quarters held, ends included, to the exit or to end_q."""
    first, to, end = r.col("from_q"), r.col("to_q"), r.header_at("quarter", "end")
    return f'(IF({to}="",{end},{to})-{first}+1)/4'


def _scale(r: OutRef) -> str:
    return "=" + stock_scale(r.model("C16"), r.model("C14"), r.model("C9"))


def _model_end(row_id: str) -> Callable[[OutRef], str]:
    return lambda r: r.model_at(row_id, "end")


def _model_sum(row_id: str, positive: bool = False) -> Callable[[OutRef], str]:
    if positive:
        return lambda r: f'SUMIF({r.model(row_id)},">0")'
    return lambda r: f"SUM({r.model(row_id)})"


_WORKBOOK_COLUMNS: tuple[Column, ...] = (
    Column("from_q", "From quarter", "q", WHOLE, _from_q),
    Column("to_q", "To quarter", "q", WHOLE, _to_q),
    Column("shares_now", "Shares now", "shares", SHARES, _if_position(_model_end("C5"))),
    Column("cost_now", "Cost now", "$", USD, _if_position(_model_end("C14"))),
    Column("invested", "Invested", "$", USD, _if_position(_model_sum("C9", positive=True))),
    Column(
        "shares_bought", "Shares bought", "shares", SHARES,
        _if_position(_model_sum("C7", positive=True)),
    ),
    Column("avg_cost", "Avg cost", "$/share", PRICE, _if_position(_avg_cost)),
    Column("sold_shares", "Shares sold", "shares", SHARES, _if_position(_sold_shares)),
    Column("sold_usd", "$ sold", "$", USD, _sold_usd),
    Column("avg_exit", "Avg exit", "$/share", PRICE, _avg_exit),
    Column("realised", "Realised", "$", USD, _if_position(_model_sum("C15"))),
    Column("dividends", "Dividends", "$", USD, _if_position(_model_sum("C12"))),
    Column("latest_price", "Latest price", "$/share", PRICE, _latest_price),
    Column("value_now", "Value now", "$", USD, _if_position(_value_now)),
    Column("unrealised", "Unrealised", "$", USD, _if_position(_unrealised)),
    Column("total_pnl", "Total P&L", "$", USD, _total_pnl),
    Column("ret", "Return", "%", PCT, _ret),
    Column("irr", "IRR", "%", PCT, _if_position(_irr)),
    Column("weight", "Weight", "%", PCT, _if_position(_weight)),
    Column("lc_now", "Last change: shares, latest quarter filed", "shares", SHARES, _lc_now),
    Column("lc_before", "Last change: shares, the quarter before", "shares", SHARES, _lc_before),
    Column("lc_value_before", "Last change: before, at latest price", "$", USD, _lc_value_before),
    Column("lc_tag", "Last change", "", GENERAL, _lc_tag),
    Column("lc_dw", "Last change: weight", "points", RATIO, _lc_dw),
    Column("last_q", "Last trade: quarter", "q", WHOLE, _if_position(_last_q)),
    Column(
        "lt_delta", "Last trade: shares", "shares", SHARES,
        _if_traded(lambda r: _in_quarter(r, "C7", "last_q")),
    ),
    Column(
        "lt_before", "Last trade: shares before", "shares", SHARES,
        _if_traded(lambda r: _in_quarter(r, "C5", "last_q", "before")),
    ),
    Column("last_type", "Last trade: type", "", GENERAL, _if_traded(_last_type)),
    Column("last_pct", "Last trade: %", "%", PCT, _last_pct),
    Column(
        "last_usd", "Last trade: $", "$", USD, _if_traded(lambda r: _in_quarter(r, "C9", "last_q"))
    ),
    Column("status", "What-if: status", "", GENERAL, _status),
    Column("last_sale_q", "Last sale quarter", "q", WHOLE, _last_sale_q),
    Column("last_sale_px", "Last sale price", "$/share", PRICE, _last_sale_px),
    Column("later_close", "1 year later", "$/share", PRICE, _later_close),
    Column("one_y", "One-year return", "%", PCT, _one_y),
    Column("spy_at_sale", "SPY at the sale (VWAP)", "$/share", PRICE, _spy_at_sale),
    Column("spy_later", "SPY 1 year later", "$/share", PRICE, _spy_later),
    Column("spy_one_y", "SPY one-year", "%", PCT, _spy_one_y),
    Column("beat_spy", "Beat SPY", "1/0", WHOLE, _beat_spy),
    Column("since_sale", "Since sale", "%", PCT, _since_sale),
    Column("missed", "Missed", "$", USD, _missed),
    Column("irr_held", "IRR if held", "%", PCT, _irr_held),
    Column("hold", "Hold length", "years", RATIO, _if_position(_hold)),
    Column("scale", "Scale (for the checks)", "$", USD, _scale),
)  # fmt: skip

# Orca's stock figures (positions.json and exits.json fields of OrcaStock), each compared with
# the workbook column of the same id.
_ORCA_STOCK: tuple[tuple[str, CheckKind], ...] = (
    ("avg_cost", "ratio"), ("avg_exit", "ratio"), ("invested", "money"), ("realised", "money"),
    ("dividends", "money"), ("shares_now", "money"), ("cost_now", "money"), ("from_q", "exact"),
    ("to_q", "exact"), ("last_q", "exact"), ("last_type", "exact"), ("last_pct", "ratio"),
    ("last_usd", "money"), ("sold_shares", "money"), ("sold_usd", "money"),
    ("last_sale_q", "exact"), ("one_y", "ratio"), ("spy_one_y", "ratio"),
)  # fmt: skip


def _stock_difference(field: str, kind: CheckKind) -> OutTemplate:
    def template(r: OutRef) -> str:
        scale = r.col("scale") if kind == "money" else None
        return difference(kind, r.col(field), r.col(f"orca_{field}"), scale)

    return template


def _orca_columns() -> tuple[Column, ...]:
    own = {c.id: c for c in _WORKBOOK_COLUMNS}
    out: list[Column] = []
    for field, kind in _ORCA_STOCK:
        mine = own[field]
        out.append(
            Column(f"orca_{field}", f"Orca: {mine.name}", mine.units, mine.number_format, None,
                   source=field, kind=kind)
        )  # fmt: skip
        out.append(
            Column(f"diff_{field}", f"Difference: {mine.name}", "", SCI,
                   _stock_difference(field, kind))
        )  # fmt: skip
    return tuple(out)


OUTPUT_COLUMNS: tuple[Column, ...] = _WORKBOOK_COLUMNS + _orca_columns()


# --- the checks table (spec 3.4) -----------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    """One row of the checks table: a measure, how it compares, and where Excel's figures,
    Orca's and their difference cells are. A place is "<tab>:<id>", plus "@q" or "@y" on Model
    for the tracked quarter or the year columns of a row or stock block. Outputs ids are stock
    table columns; Summary ids are items, with ".orca" and ".diff" for the cells beside one.
    `orca_cells` is None for the bridge, which the engine enforces (it raises otherwise)."""

    measure: str
    kind: CheckKind
    excel_cells: str
    orca_cells: str | None
    diff_cells: str


def _fund_check(span: str, row_id: str) -> Check:
    name, kind = next((n, k) for i, n, k, _, _ in _ORCA_FUND if i == row_id)
    where = {"Quarter": "q", "Year": "y"}[span]
    return Check(
        f"{span}: {name.lower()}", kind, f"Model:{row_id}@{where}", f"Model:o_{row_id}@{where}",
        f"Model:d_{row_id}@{where}",
    )  # fmt: skip


def _lower(name: str) -> str:
    """"Avg cost" -> "avg cost"; "SPY one-year" stays."""
    return name if name[:2].isupper() else name[:1].lower() + name[1:]


def _summary_check(measure: str, item: str, kind: CheckKind) -> Check:
    return Check(
        measure, kind, f"Summary:{item}", f"Summary:{item}.orca", f"Summary:{item}.diff"
    )


# Summary's figures that Orca publishes (summary.json metrics, exits.json summary, meta):
# (measure, Summary item, kind), in the checks table's order.
SUMMARY_CHECKED: tuple[tuple[str, str, CheckKind], ...] = (
    ("Annualised return", "ann_return", "ratio"),
    ("Sharpe", "sharpe", "ratio"),
    ("Sortino", "sortino", "ratio"),
    ("Volatility", "vol", "ratio"),
    ("Max drawdown", "max_dd", "ratio"),
    ("Calmar", "calmar", "ratio"),
    ("% quarters positive", "quarters_pos_pct", "ratio"),
    ("Best year", "best_year", "exact"),
    ("Best year return", "best_year_ret", "ratio"),
    ("Worst year", "worst_year", "exact"),
    ("Worst year return", "worst_year_ret", "ratio"),
    ("Years positive", "years_pos", "exact"),
    ("Full years", "years_total", "exact"),
    ("Turnover", "turnover", "ratio"),
    ("Average hold (all)", "hold_all", "ratio"),
    ("Average hold (sold)", "hold_sold", "ratio"),
    ("Buys: return 12 months after", "buys_12m", "ratio"),
    ("Sales: return 12 months after", "sells_12m", "ratio"),
    ("Sales beating SPY", "beat_spy_pct", "ratio"),
    ("Book", "book", "money"),
    ("Holdings now", "n_holdings", "exact"),
    ("% priced", "priced_pct", "ratio"),
)

_WHOLE_PERIOD = 16  # SUMMARY_CHECKED[:16] are the whole-period metrics, then exits and header

CHECKS: tuple[Check, ...] = (
    *(_fund_check("Quarter", i) for i in ("start", "end", "market_move", "net_buying")),
    *(_fund_check("Quarter", i) for i in ("trade_gains", "dividends")),
    Check("Quarter: bridge", "exact", "Model:bridge_ok@q", None, "Model:d_bridge@q"),
    _fund_check("Quarter", "ret"),
    *(_fund_check("Year", i) for i in ("ret", "start", "end", "gains", "inflows", "dividends")),
    _fund_check("Year", "approx_ret"),
    *(_summary_check(*row) for row in SUMMARY_CHECKED[:_WHOLE_PERIOD]),
    Check("What drove: points", "ratio", "Model:C20@y", "Model:O1@y", "Model:D1@y"),
    Check("What drove: P&L", "money", "Model:C13@y", "Model:O2@y", "Model:D2@y"),
    *(
        Check(f"Stock: {_lower(c.name.removeprefix('Orca: '))}", c.kind,
              f"Outputs:{c.source}", f"Outputs:{c.id}", f"Outputs:diff_{c.source}")
        for c in OUTPUT_COLUMNS
        if c.source is not None
    ),
    *(_summary_check(*row) for row in SUMMARY_CHECKED[_WHOLE_PERIOD:]),
)  # fmt: skip
