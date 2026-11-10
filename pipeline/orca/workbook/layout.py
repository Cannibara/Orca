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
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from typing import TYPE_CHECKING, Literal

from orca.quarters import BASE_YEAR, q_end, q_start

if TYPE_CHECKING:
    from orca.workbook.inputs import FundInputs

Kind = Literal["header", "input", "calc", "fund", "fund_input", "year_only"]
YearRule = Literal["sum", "year_end", "first_start", "chained", "product", "min", "blank", "none"]

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
    "other.<field>") for single rows. `other` fills the block's "All other positions" row when
    the fund is cut: the name of an OtherInputs list (an input row), or a template rendered with
    that row as the stock (a formula row). Like the block's stock rows, it covers the quarters
    start..bound in an input block (I2) and start..end_q in a calculation block, plus its year
    cells. `cut_only` rows exist only when the fund is cut."""

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

    @property
    def per_stock(self) -> bool:
        """A stock block (I1-I6, C1-C20): one row per stock."""
        return self.id[0] in "IC" and self.id[1:].isdigit()


def year_formula(block: Block, r: Ref) -> str | None:
    """The year cell of `block` in the year column of `r`, by its year rule (spec 3.3). The
    year's quarter columns are contiguous, so each rule reads that range directly: SUM, MIN, or
    the last or first quarter's cell. "product" (the Growth row) and "chained" (the Return row)
    read the Year-to-date growth row at the year's last quarter: a running product, so a quarter
    of -100% or worse still gives the engine's `math.prod` (LN of it would be #NUM!). The year's
    Return is blank without a quarterly return. None for "blank" (no year cell) and "none" (a
    year-only block, whose formula is the year cell)."""
    rule = block.year_rule
    if rule == "sum":
        return f"=SUM({r.year_span(block.id)})"
    if rule == "min":
        return f"=MIN({r.year_span(block.id)})"
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

MODEL_ROWS: tuple[Block, ...] = HEADER_ROWS + FUND_INPUTS + BLOCKS  # in the tab's order

BY_ID: dict[str, Block] = {b.id: b for b in MODEL_ROWS}

# The blocks a cut fund ends with an "All other positions" row (spec section 4): the one list
# Rows, the templates and the builder read.
OTHER_ROWS: frozenset[str] = frozenset(b.id for b in MODEL_ROWS if b.other is not None)
