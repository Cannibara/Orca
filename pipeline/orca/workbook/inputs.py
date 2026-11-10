"""FundInputs: the one input of the fund workbook, taken from exactly what the engine used.

It carries the fund's header, the per-quarter fund inputs (carried flag, T-bill, SPY, total
reported value), per stock the filed shares and values, split factors and prices, and the
engine's own results ("Orca's figures", unrounded) that the workbook's checks compare with.
It is saved as a private brotli JSON file; no CUSIP ever enters it."""

import json
import math
from dataclasses import dataclass, fields, is_dataclass
from datetime import date

import brotli
import polars as pl

from orca.publish import BROTLI_QUALITY, _json_ready, _last_change
from orca.quarter_px import last_close_before
from orca.quarters import BASE_YEAR
from orca.run.compute import Context, FundResult, Prepared
from orca.workbook.cut import OtherInputs, other_inputs, split_top

_QUARTER_FIELDS = ("start", "end", "market_move", "net_buying", "trade_gains", "dividends", "ret")
_YEAR_FIELDS = ("ret", "start", "end", "gains", "inflows", "dividends", "approx_ret")


@dataclass(frozen=True)
class StockInputs:
    """One stock's inputs I1-I6; every list has one entry per quarter column `start..bound`
    (None where the stock has no data that quarter, 0.0 dividends when none)."""

    stock_id: int
    ticker: str
    name: str
    shares_filed: list[float | None]
    value_filed: list[float | None]
    split_factor: list[float]
    close: list[float | None]
    vwap: list[float | None]
    div_ps: list[float]
    close_before: float | None
    close_latest: float | None


@dataclass(frozen=True)
class OrcaStock:
    """The engine's figures for one stock (positions.json and exits.json fields, then its
    contribution by calendar year). None where the stock has no position or no exit row."""

    stock_id: int
    avg_cost: float | None
    avg_exit: float | None
    invested: float | None
    realised: float | None
    dividends: float | None
    shares_now: float | None
    cost_now: float | None
    from_q: int | None
    to_q: int | None
    last_q: int | None
    last_type: str | None
    last_pct: float | None
    last_usd: float | None
    sold_shares: float | None
    sold_usd: float | None
    last_sale_q: int | None
    one_y: float | None
    spy_one_y: float | None
    points: dict[int, float]
    pnl: dict[int, float]


@dataclass(frozen=True)
class OrcaFund:
    """The engine's fund figures: `quarters` aligned to the quarter columns (None after
    `end_q`), `years` aligned to FundInputs.years."""

    quarters: dict[str, list[float | None]]
    years: dict[str, list[float | None]]
    metrics: dict
    exits_summary: dict
    book: float
    n_holdings: int
    priced_pct: float


@dataclass(frozen=True)
class FundInputs:
    fund_id: int
    name: str
    cik: int
    period_q: int
    filed: date
    start: int
    end_q: int
    bound: int
    latest_date: date
    quarters: list[int]
    years: list[int]
    carried: list[int]
    tbill: list[float | None]
    spy_close: list[float | None]
    spy_vwap: list[float | None]
    total_reported: list[float]
    stocks: list[StockInputs]
    orca_stocks: list[OrcaStock]
    orca: OrcaFund
    other: OtherInputs | None = None


def build_inputs(
    ctx: Context,
    p: Prepared,
    r: FundResult,
    latest: dict[int, tuple[date, float]],
    securities: pl.DataFrame,
    max_positions: int = 500,
) -> FundInputs:
    """The inputs of one fund from its `Prepared` and `FundResult`. A fund with more than
    `max_positions` positions keeps the top ones as stock rows and the rest as `other`; a stock
    without a position (never priced) stays a zero row and is never cut."""
    out = r.output
    fund_id = out.meta.fund_id
    top, rest = split_top(out.positions, max_positions)
    cut = {pos.stock_id for pos in rest}
    peak = {
        pos.stock_id: max((pq.value for pq in pos.quarters), default=0.0) for pos in top
    }
    order = sorted(
        (sid for sid in p.adjusted if sid not in cut), key=lambda sid: (-peak.get(sid, 0.0), sid)
    )
    quarters = list(range(p.start, p.bound + 1))

    names = {
        row["stock_id"]: (row["ticker"] or "", row["name"] or "")
        for row in securities.iter_rows(named=True)
    }
    stocks = []
    for sid in order:
        px, filed, factors = p.px[sid], p.filed.get(sid, {}), ctx.share_factors[sid]
        ticker, name = names.get(sid, ("", ""))
        stocks.append(
            StockInputs(
                stock_id=sid,
                ticker=ticker,
                name=name,
                shares_filed=[filed[q][0] if q in filed else None for q in quarters],
                value_filed=[filed[q][1] if q in filed else None for q in quarters],
                split_factor=[factors.of(q) for q in quarters],
                close=[px[q].close if q in px else None for q in quarters],
                vwap=[px[q].vwap if q in px else None for q in quarters],
                div_ps=[px[q].div_ps if q in px else 0.0 for q in quarters],
                close_before=last_close_before(px, p.start),
                close_latest=latest[sid][1] if sid in latest else None,
            )
        )

    mine = [latest[s][0] for s in [*order, ctx.spy_id] if s in latest]
    if not mine and not latest:
        raise ValueError(f"fund {fund_id}: no latest closes")
    latest_date = max(mine or [d for d, _ in latest.values()])

    rows = p.rows
    carried_q = set(rows.filter(pl.col("carried"))["q"].to_list())
    total = dict(rows.group_by("q").agg(pl.col("value_usd").sum()).iter_rows())
    return FundInputs(
        fund_id=fund_id,
        name=out.meta.name,
        cik=out.meta.cik,
        period_q=out.meta.period_q,
        filed=out.meta.filed,
        start=p.start,
        end_q=p.end_q,
        bound=p.bound,
        latest_date=latest_date,
        quarters=quarters,
        years=[BASE_YEAR + y.qs[0] // 4 for y in out.years],
        carried=[int(q in carried_q) for q in quarters],
        tbill=[ctx.rf.get(BASE_YEAR + q // 4) for q in quarters],
        spy_close=[p.spy_px[q].close if q in p.spy_px else None for q in quarters],
        spy_vwap=[p.spy_px[q].vwap if q in p.spy_px else None for q in quarters],
        total_reported=[float(total.get(q, 0.0)) for q in quarters],
        stocks=stocks,
        orca_stocks=_orca_stocks(r, order),
        orca=_orca_fund(r, quarters),
        other=other_inputs(rest, p, latest, out.meta.period_q) if rest else None,
    )


def _orca_stocks(r: FundResult, order: list[int]) -> list[OrcaStock]:
    out = r.output
    positions = {pos.stock_id: pos for pos in out.positions}
    exits = {row.stock_id: row for row in out.exits}
    year_of = {y.label: BASE_YEAR + y.qs[0] // 4 for y in out.years}
    points: dict[int, dict[int, float]] = {}
    pnl: dict[int, dict[int, float]] = {}
    for label, rows in out.contributions.items():
        for sid, pts, money in rows:
            points.setdefault(sid, {})[year_of[label]] = pts
            pnl.setdefault(sid, {})[year_of[label]] = money
    result = []
    for sid in order:
        pos, ex = positions.get(sid), exits.get(sid)
        last = _last_change(pos) if pos is not None else (None, None, None, None)
        result.append(
            OrcaStock(
                stock_id=sid,
                avg_cost=pos.avg_cost if pos else None,
                avg_exit=pos.avg_exit if pos else None,
                invested=pos.invested if pos else None,
                realised=pos.realised if pos else None,
                dividends=pos.dividends if pos else None,
                shares_now=pos.shares_now if pos else None,
                cost_now=pos.cost_now if pos else None,
                from_q=pos.from_q if pos else None,
                to_q=pos.to_q if pos else None,
                last_q=last[0],
                last_type=last[1],
                last_pct=last[2],
                last_usd=last[3],
                sold_shares=ex.sold_shares if ex else None,
                sold_usd=ex.sold_usd if ex else None,
                last_sale_q=ex.last_sale_q if ex else None,
                one_y=ex.one_y if ex else None,
                spy_one_y=ex.spy_one_y if ex else None,
                points=points.get(sid, {}),
                pnl=pnl.get(sid, {}),
            )
        )
    return result


def _orca_fund(r: FundResult, quarters: list[int]) -> OrcaFund:
    out = r.output
    by_q = {fq.q: fq for fq in out.quarters}
    summary = out.exits_summary
    return OrcaFund(
        quarters={
            name: [getattr(by_q[q], name) if q in by_q else None for q in quarters]
            for name in _QUARTER_FIELDS
        },
        years={name: [getattr(y, name) for y in out.years] for name in _YEAR_FIELDS},
        metrics=dict(out.metrics),
        exits_summary={
            "buys_12m": summary.buys_12m,
            "sells_12m": summary.sells_12m,
            "beat_spy_pct": summary.beat_spy_pct,
        },
        book=out.meta.book,
        n_holdings=out.meta.n_holdings,
        priced_pct=out.meta.priced_pct,
    )


# --- validation and the JSON file -------------------------------------------------------------


def validate(fi: FundInputs) -> None:
    """Raise ValueError (naming the fund and the field) for a non-finite number, a CUSIP key, a
    list that does not match its columns (the cut's `other` lists included)."""

    def fail(field: str, why: str) -> None:
        raise ValueError(f"fund {fi.fund_id}: {field}: {why}")

    def walk(obj: object, path: str) -> None:
        if isinstance(obj, float):
            if not math.isfinite(obj):
                fail(path, f"non-finite value {obj}")
        elif isinstance(obj, dict):
            for key, value in obj.items():
                if isinstance(key, str) and key.lower() in ("cusip", "cusips"):
                    fail(path, f"a CUSIP key ({key!r})")
                walk(value, f"{path}.{key}")
        elif isinstance(obj, (list, tuple)):
            for i, value in enumerate(obj):
                walk(value, f"{path}[{i}]")
        elif is_dataclass(obj):
            for f in fields(obj):
                walk(getattr(obj, f.name), f"{path}.{f.name}" if path else f.name)

    def length(field: str, values: list, n: int) -> None:
        if len(values) != n:
            fail(field, f"has {len(values)} entries, expected {n}")

    walk(fi, "")
    n = len(fi.quarters)
    if fi.quarters != list(range(fi.start, fi.bound + 1)):
        fail("quarters", "is not start..bound")
    for name in ("carried", "tbill", "spy_close", "spy_vwap", "total_reported"):
        length(name, getattr(fi, name), n)
    for st in fi.stocks:
        for name in ("shares_filed", "value_filed", "split_factor", "close", "vwap", "div_ps"):
            length(f"stocks[{st.stock_id}].{name}", getattr(st, name), n)
    length("orca_stocks", fi.orca_stocks, len(fi.stocks))
    for st, o in zip(fi.stocks, fi.orca_stocks, strict=False):
        if st.stock_id != o.stock_id:
            fail("orca_stocks", f"is not aligned to stocks at stock {st.stock_id}")
    if fi.other is not None:
        for f in fields(fi.other):
            values = getattr(fi.other, f.name)
            if isinstance(values, list):
                length(f"other.{f.name}", values, n)
    for name, values in fi.orca.quarters.items():
        length(f"orca.quarters.{name}", values, n)
    for name, values in fi.orca.years.items():
        length(f"orca.years.{name}", values, len(fi.years))


def to_json(fi: FundInputs) -> bytes:
    """`fi` as brotli-compressed JSON. Floats are written with repr, so they read back exactly;
    a CUSIP key is refused and a non-finite number becomes null (`validate` refuses it)."""
    doc = _json_ready(_encode(fi))
    payload = json.dumps(doc, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return brotli.compress(payload.encode("ascii"), quality=BROTLI_QUALITY)


def _encode(obj: object) -> object:
    if is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _encode(getattr(obj, f.name)) for f in fields(obj)}
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _encode(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_encode(v) for v in obj]
    return obj


def from_json(data: bytes) -> FundInputs:
    """The FundInputs `to_json` wrote."""
    d = json.loads(brotli.decompress(data))
    d["filed"] = date.fromisoformat(d["filed"])
    d["latest_date"] = date.fromisoformat(d["latest_date"])
    d["stocks"] = [StockInputs(**s) for s in d["stocks"]]
    d["orca_stocks"] = [
        OrcaStock(
            **{
                **o,
                "points": {int(k): v for k, v in o["points"].items()},
                "pnl": {int(k): v for k, v in o["pnl"].items()},
            }
        )
        for o in d["orca_stocks"]
    ]
    d["orca"] = OrcaFund(**d["orca"])
    if d.get("other") is not None:
        d["other"] = OtherInputs(**d["other"])
    return FundInputs(**d)
