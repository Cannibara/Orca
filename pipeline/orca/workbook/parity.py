"""The site-parity fixture (spec 7, item 2): per fund, the inputs in the site's shapes (positions
with their trades, latest prices, summary, contrib, exits) and what the recalculated workbook
says for the figures only the site computes (IRR, value now, unrealised, total P&L, return,
weight, last-change dw and tag, since sale, missed, IRR if held, % profitable, the range tiles,
the AUM parts). web/tests/workbook-parity.test.ts runs the site's own functions on the inputs
and compares them with `expected`.

Pure serialisers: the caller builds the workbooks and recalculates them (the pytest test, with
LibreOffice) and hands over the computed cells, `lo_values` ((tab, "A1") -> value, as
tests/lo.py `values` reads them; a missing key is a blank cell).

The positions' trades are read from the computed Model tab (Shares traded, Trade price, Shares
held), unrounded: FundInputs holds the engine's per-position totals, not its trade list, and
positions.json rounds the prices to 4 decimals. The in-file checks already prove those cells
equal the engine's totals."""

import json

from orca.workbook.build import workbook_map
from orca.workbook.inputs import FundInputs, OrcaStock

VERSION = 1

# Outputs columns whose value the site computes: expected name -> column id.
_STOCK_FIGURES = {
    "irr": "irr",
    "value_now": "value_now",
    "unrealised": "unrealised",
    "total": "total_pnl",
    "ret": "ret",
    "weight": "weight",
    "dw": "lc_dw",
    "tag": "lc_tag",
    "since_sale": "since_sale",
    "missed": "missed",
    "irr_held": "irr_held",
}
_RANGE_TILES = ("r_ann", "r_growth", "r_years_pos", "r_full_years", "r_qpos", "r_mdd", "r_vol",
                "r_n")  # fmt: skip
_AUM = ("aum_carried", "aum_inflows", "aum_gains", "aum_losses", "aum_outflows")


def parity_cases(cases: list[tuple[str, FundInputs, dict]]) -> dict:
    """The fixture document of `cases` (name, inputs, computed cells of its workbook)."""
    return {"version": VERSION, "cases": [parity_case(fi, v, name) for name, fi, v in cases]}


def dumps(doc: dict) -> bytes:
    """The fixture file: one case a line, floats as repr (they read back exactly)."""
    lines = [json.dumps(c, separators=(",", ":"), allow_nan=False) for c in doc["cases"]]
    head = json.dumps(doc["version"])
    return (f'{{"version":{head},"cases":[\n' + ",\n".join(lines) + "\n]}\n").encode("ascii")


def parity_case(fi: FundInputs, lo_values: dict, name: str = "") -> dict:
    wm = workbook_map(fi)

    def model(block: str, stock_id: int | None, column: int | str) -> object:
        return lo_values.get(("Model", wm.model.cell(block, stock_id, column)))

    def out(column: str, stock_id: int) -> object:
        return lo_values.get(("Outputs", wm.outputs.cell(column, stock_id)))

    def summary(item: str) -> object:
        return lo_values.get(("Summary", wm.summary.cell(item)))

    pairs = zip(fi.stocks, fi.orca_stocks, strict=True)
    mine = [(st, o) for st, o in pairs if o.from_q is not None]
    positions, expected_stocks = [], {}
    for st, o in mine:
        trades = []
        for q in range(fi.start, fi.end_q + 1):
            delta = model("C7", st.stock_id, q)
            if delta:  # blank or 0: no trade
                trades.append([q, delta, model("C8", st.stock_id, q), None, None,
                               model("C5", st.stock_id, q)])  # fmt: skip
        positions.append(_position(o, trades))
        figures = {}
        for key, column in _STOCK_FIGURES.items():
            value = out(column, st.stock_id)
            figures[key] = None if value == "" else value
        expected_stocks[str(st.stock_id)] = figures

    first_year = lo_values.get(("Summary", wm.summary.cell("from_year")))
    last_year = lo_values.get(("Summary", wm.summary.cell("to_year")))
    return {
        "name": name,
        "fund_id": fi.fund_id,
        "positions": positions,
        "prices": {
            str(st.stock_id): st.close_latest for st in fi.stocks if st.close_latest is not None
        },
        "asof": fi.latest_date.isoformat(),
        "summary": {
            "period_q": fi.period_q,
            "tracked_since_q": fi.start,
            "quarters": _quarters(fi),
            "years": _years(fi),
        },
        "contrib": _contrib(fi, [o for _, o in mine]),
        "exits": _exits([o for _, o in mine], fi.orca.exits_summary),
        "from_year": first_year,
        "to_year": last_year,
        "expected": {
            "stocks": expected_stocks,
            "profitable": summary("profitable"),
            "range": {item: summary(item) for item in _RANGE_TILES},
            "aum": {
                str(year): {item: model(item, None, str(year)) for item in _AUM}
                for year in fi.years
            },
            "points": {
                str(st.stock_id): sum(
                    model("C20", st.stock_id, str(year)) or 0.0 for year in fi.years
                )
                for st, _ in mine
            },
        },
    }


def _position(o: OrcaStock, trades: list[list]) -> dict:
    return {
        "stock_id": o.stock_id,
        "from_q": o.from_q,
        "to_q": o.to_q,
        "avg_cost": o.avg_cost,
        "avg_exit": o.avg_exit,
        "invested": o.invested,
        "realised": o.realised,
        "dividends": o.dividends,
        "shares_now": o.shares_now,
        "cost_now": o.cost_now,
        "last_q": o.last_q,
        "last_type": o.last_type,
        "last_pct": o.last_pct,
        "last_usd": o.last_usd,
        "trades": trades,
    }


def _quarters(fi: FundInputs) -> dict:
    rets = fi.orca.quarters["ret"]
    pairs = [(q, r) for q, r in zip(fi.quarters, rets, strict=True) if r is not None]
    return {"q": [q for q, _ in pairs], "ret": [r for _, r in pairs]}


def _years(fi: FundInputs) -> dict:
    y = fi.orca.years
    return {
        "label": [str(year) for year in fi.years],
        "ret": y["ret"],
        "start": y["start"],
        "end": y["end"],
        "gains": y["gains"],
        "inflows": y["inflows"],
    }


def _contrib(fi: FundInputs, stocks: list[OrcaStock]) -> dict:
    by_year = {}
    for year in fi.years:
        rows = sorted(
            ((o.stock_id, o.points[year], o.pnl[year]) for o in stocks if year in o.points),
            key=lambda r: (-r[1], r[0]),
        )
        by_year[str(year)] = {
            "stock_id": [r[0] for r in rows],
            "points": [r[1] for r in rows],
            "pnl": [r[2] for r in rows],
        }
    return {"years": [str(year) for year in fi.years], "by_year": by_year}


def _exits(stocks: list[OrcaStock], summary: dict) -> dict:
    sold = [o for o in stocks if o.sold_shares is not None]
    return {
        "rows": {
            "stock_id": [o.stock_id for o in sold],
            "status": ["sold_all" if o.shares_now == 0 else "trimmed" for o in sold],
            "sold_shares": [o.sold_shares for o in sold],
            "sold_usd": [o.sold_usd for o in sold],
            "avg_exit": [o.avg_exit for o in sold],
            "last_sale_q": [o.last_sale_q for o in sold],
            "one_y": [o.one_y for o in sold],
            "spy_one_y": [o.spy_one_y for o in sold],
        },
        "summary": dict(summary),
    }
