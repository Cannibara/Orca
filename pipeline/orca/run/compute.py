"""Computing funds: one fund's positions, quarters, metrics, home snapshot and data-quality flags
from its holdings and the stocks' prices, checked against the engine's invariants."""

from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date

import polars as pl

from orca.config import (
    CONVICTION_KEEP,
    CONVICTION_LOOKBACK,
    CONVICTION_WINDOW,
    PERIODS,
    PRICE_MISMATCH,
)
from orca.engine.fund import (
    FundQuarter,
    aggregate_fund,
    check_bridge,
    contributions,
    fund_years,
)
from orca.engine.metrics import (
    Performance,
    hold_lengths,
    performance,
    priced_pct,
    turnover,
)
from orca.engine.position import PositionResult, compute_position
from orca.engine.whatif import beat_spy_pct, buys_vs_sells, exit_rows
from orca.holdings import fill_gaps
from orca.home import ConvictionQuarter, FundSnapshot
from orca.prices import ShareFactors, split_factors_by_quarter
from orca.publish import ExitsSummary, FundMeta, FundOutput, build_metrics
from orca.quarter_px import QuarterPx, quarter_px
from orca.quarters import q_end
from orca.run.market import BENCHMARK_CUSIP, load_daily, rf_table, stock_of
from orca.run.state import CUSIP_MAP_SCHEMA, chunks, read_table
from orca.storage import Lake

SPLIT_RATIOS = (2.0, 3.0, 4.0, 5.0, 10.0, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10)
PRICE_LOAD_CHUNK = 500  # stocks whose daily bars are read at once (bounds the transient frame)
SPLITS_SCHEMA = pl.Schema({"stock_id": pl.Int32, "date": pl.Date, "split_factor": pl.Float64})
_BUYS = ("new", "add")


class InvariantError(RuntimeError):
    """A recomputed fund broke an invariant (the AUM bridge, or negative shares)."""


def affected_funds(
    new_filings: pl.DataFrame, changed_stocks: list[int], holdings: pl.DataFrame
) -> set[int]:
    """The funds (CIKs) to recompute: those with new or amended filings (`new_filings` has a
    `cik` column) and those holding a stock whose price history changed (`holdings` has `cik`
    and `stock_id` columns, any quarter)."""
    funds = (
        {int(c) for c in new_filings.get_column("cik").to_list()} if new_filings.height else set()
    )
    if changed_stocks and holdings.height:
        holders = holdings.filter(pl.col("stock_id").is_in(list(changed_stocks)))
        funds |= {int(c) for c in holders.get_column("cik").unique().to_list()}
    return funds


def price_flags(holdings: pl.DataFrame, px: dict[int, dict[int, QuarterPx]], q: int) -> list[dict]:
    """Rows of quarter `q` whose reported value per share is more than PRICE_MISMATCH times away
    from our close (either way). `holdings` has cik, q, stock_id, shares (split-adjusted, on the
    same basis as `px`) and value_usd; `px` is stock_id -> quarter -> QuarterPx. The engine values
    positions at our close whatever the filing says; this only reports the disagreement."""
    flags = []
    rows = holdings.filter(pl.col("q") == q).sort("cik", "stock_id")
    for cik, stock_id, shares, value in rows.select(
        "cik", "stock_id", "shares", "value_usd"
    ).iter_rows():
        quarter = px.get(stock_id, {}).get(q)
        ours = quarter.close if quarter is not None else None
        if not ours or ours <= 0 or not shares or shares <= 0 or value is None or value <= 0:
            continue
        reported = value / shares
        ratio = reported / ours
        if ratio > PRICE_MISMATCH or ratio < 1 / PRICE_MISMATCH:
            flags.append(
                {
                    "type": "price_mismatch",
                    "fund_id": int(cik),
                    "stock_id": int(stock_id),
                    "q": int(q),
                    "reported": float(reported),
                    "ours": float(ours),
                }
            )
    return flags


def split_suspects(holdings: pl.DataFrame, splits: pl.DataFrame) -> list[dict]:
    """Share counts that change by exactly 2, 3, 4, 5 or 10 times (or a half ... a tenth) from one
    quarter to the next with no vendor split of the stock in between: perhaps a split the vendor
    has not recorded. `holdings` has cik, q, stock_id and shares as reported (not adjusted);
    `splits` has stock_id, date and split_factor (rows with factor 1 are ignored)."""
    split_days: dict[int, list[date]] = defaultdict(list)
    for stock_id, day, factor in splits.select("stock_id", "date", "split_factor").iter_rows():
        if factor is not None and factor != 1.0:
            split_days[int(stock_id)].append(day)
    by_key: dict[tuple[int, int], dict[int, float]] = defaultdict(dict)
    for cik, q, stock_id, shares in holdings.select("cik", "q", "stock_id", "shares").iter_rows():
        by_key[(int(cik), int(stock_id))][int(q)] = float(shares)
    flags = []
    for (cik, stock_id), series in sorted(by_key.items()):
        for q in sorted(series):
            before, after = series.get(q - 1), series[q]
            if not before or before <= 0 or after <= 0:
                continue
            ratio = after / before
            if not any(abs(ratio / r - 1) < 1e-9 for r in SPLIT_RATIOS):
                continue
            start, end = q_end(q - 1), q_end(q)
            if any(start < day <= end for day in split_days.get(stock_id, [])):
                continue
            flags.append(
                {
                    "type": "split_suspect",
                    "fund_id": cik,
                    "stock_id": stock_id,
                    "q": q,
                    "ratio": ratio,
                }
            )
    return flags


# --- what computing a fund needs --------------------------------------------------------------


@dataclass
class Context:
    """What computing a fund needs beyond its own rows: the security master, the risk-free rate
    and each loaded stock's quarter prices, split days and per-quarter share factors (today's
    share basis).

    Only these small summaries are kept between batches; a stock's daily bars are read when it is
    first needed, PRICE_LOAD_CHUNK stocks at a time, and dropped once summarised. `iter_closes`
    and `closes_on` read daily closes for the shared files the same way, without keeping them."""

    lake: Lake
    last_q: int
    stock_of: dict[str, int]
    rf: dict[int, float]
    spy_id: int | None
    px: dict[int, dict[int, QuarterPx]] = field(default_factory=dict)
    splits: dict[int, pl.DataFrame] = field(default_factory=dict)
    share_factors: dict[int, ShareFactors] = field(default_factory=dict)

    @classmethod
    def build(cls, lake: Lake, last_q: int) -> "Context":
        stocks = stock_of(read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
        return cls(lake, last_q, stocks, rf_table(lake), stocks.get(BENCHMARK_CUSIP))

    def load(self, stock_ids: Iterable[int]) -> None:
        """Quarter prices and split days of the stocks of `stock_ids` not loaded yet."""
        missing = sorted(set(stock_ids) - self.px.keys())
        no_splits = pl.DataFrame(schema={"date": pl.Date, "split_factor": pl.Float64})
        for chunk in chunks(missing, PRICE_LOAD_CHUNK):
            daily = load_daily(self.lake, chunk)
            by_stock = daily.partition_by("stock_id", as_dict=True) if daily.height else {}
            del daily
            for stock_id in chunk:
                rows = by_stock.pop((stock_id,), None)
                if rows is None:
                    self.px[stock_id], self.splits[stock_id] = {}, no_splits
                    self.share_factors[stock_id] = ShareFactors()
                    continue
                self.px[stock_id] = quarter_px(rows)
                splits = rows.filter(pl.col("split_factor") != 1.0).select("date", "split_factor")
                self.splits[stock_id] = splits
                self.share_factors[stock_id] = split_factors_by_quarter(splits)

    def iter_closes(self, stock_ids: Iterable[int]) -> Iterator[dict[int, pl.DataFrame]]:
        """The stocks' daily (date, close) on today's share basis, PRICE_LOAD_CHUNK stocks at a
        time: one dict per chunk, stock_id -> closes (a stock without bars has an empty frame).
        Nothing is kept."""
        empty = pl.DataFrame(schema={"date": pl.Date, "close": pl.Float64})
        for chunk in chunks(sorted(set(stock_ids)), PRICE_LOAD_CHUNK):
            daily = load_daily(self.lake, chunk)
            found = daily.partition_by("stock_id", as_dict=True) if daily.height else {}
            yield {
                sid: found[(sid,)].select("date", "close") if (sid,) in found else empty
                for sid in chunk
            }

    def closes_on(self, wanted: Iterable[tuple[int, date]]) -> dict[tuple[int, date], float]:
        """For each (stock_id, day) of `wanted`, the close of the latest day on or before it that
        has one (`quarter_px.close_on`, for many days at once); pairs without one are absent."""
        pairs = pl.DataFrame(
            sorted(set(wanted)), schema={"stock_id": pl.Int32, "day": pl.Date}, orient="row"
        )
        found: dict[tuple[int, date], float] = {}
        for chunk in chunks(pairs["stock_id"].unique().sort().to_list(), PRICE_LOAD_CHUNK):
            daily = load_daily(self.lake, chunk)
            if not daily.height:
                continue
            closes = (
                daily.filter(pl.col("close").is_not_null())
                .select(pl.col("stock_id").cast(pl.Int32), "date", "close")
                .sort("date")
            )
            matched = (
                pairs.filter(pl.col("stock_id").is_in(chunk))
                .sort("day")
                .join_asof(
                    closes, left_on="day", right_on="date", by="stock_id", check_sortedness=False
                )
                .filter(pl.col("close").is_not_null())
            )
            found.update(
                ((sid, day), close)
                for sid, day, close in matched.select("stock_id", "day", "close").iter_rows()
            )
        return found


@dataclass(frozen=True)
class FundResult:
    output: FundOutput
    snapshot: FundSnapshot
    flags: list


def _bounded(px: dict[int, QuarterPx], bound: int) -> dict[int, QuarterPx]:
    return {q: v for q, v in px.items() if q <= bound}


def _stock_ids(ctx: Context, rows: pl.DataFrame) -> pl.Series:
    return (
        rows.filter(pl.col("kind") == "SH")
        .get_column("cusip")
        .unique()
        .replace_strict(ctx.stock_of, default=None, return_dtype=pl.Int32)
        .drop_nulls()
    )


def compute_batch(
    ctx: Context, holdings: pl.DataFrame, reports: pl.DataFrame
) -> Iterator[FundResult]:
    """Compute every fund of `holdings` / `reports` (the rows of a set of CIKs), one at a time:
    the prices of every stock the batch holds are loaded first, then each fund's result is
    yielded in CIK order, so only one fund's full output is alive at a time."""
    for _, result in prepare_batch(ctx, holdings, reports):
        yield result


@dataclass(frozen=True)
class Prepared:
    """What the engine reads for one fund, before any arithmetic of its own: the tracking segment,
    the filled holdings, and per stock and quarter the shares as filed (share classes summed), the
    split-adjusted series, the implied prices and the quarter prices (bounded). The fund workbook
    reads this, so it shows exactly the engine's inputs. `px` covers every mapped stock of
    `adjusted` (a stock without prices maps to {}); `spy_px` is the benchmark's."""

    cik: int
    status: dict
    start: int
    end_q: int
    bound: int
    rows: pl.DataFrame
    reports: pl.DataFrame
    filed: dict[int, dict[int, tuple[float, float]]]
    adjusted: dict[int, dict[int, tuple[float, float]]]
    implied: dict[int, dict[int, float]]
    px: dict[int, dict[int, QuarterPx]]
    spy_px: dict[int, QuarterPx]


def prepare_fund(
    ctx: Context, status: dict, rows: pl.DataFrame, reports: pl.DataFrame
) -> Prepared:
    """The fund's inputs over its latest tracking segment, through its last held quarter: the
    carried deadline quarter after a late filing, or the last filed quarter (an early filer's next
    quarter; a fund gone inactive stays frozen there). Prices count up to that quarter or the
    deadline quarter, whichever is later, so a fund's files do not move with the week's prices."""
    cik, last_q = int(status["cik"]), ctx.last_q
    segment = status["segments"][-1]
    start, end = int(segment["start"]), int(segment["end"])
    end_q = last_q if end == last_q - 1 else end
    bound = max(last_q, end_q)
    rows = rows.filter(pl.col("q").is_between(start, end_q))

    shares_rows = (
        rows.filter(pl.col("kind") == "SH")
        .with_columns(
            stock_id=pl.col("cusip").replace_strict(
                ctx.stock_of, default=None, return_dtype=pl.Int32
            )
        )
        .filter(pl.col("stock_id").is_not_null())
    )
    ctx.load(
        shares_rows["stock_id"].unique().to_list()
        + ([ctx.spy_id] if ctx.spy_id is not None else [])
    )
    adjusted, summed = _share_series(ctx, shares_rows)
    filed: dict[int, dict[int, tuple[float, float]]] = defaultdict(dict)
    for q, stock_id, shares, value in summed.select(
        "q", "stock_id", "shares", "value_usd"
    ).iter_rows():
        filed[stock_id][q] = (float(shares), value)
    implied = {
        stock_id: {
            q: value / shares for q, (shares, value) in series.items() if shares > 0 and value > 0
        }
        for stock_id, series in adjusted.items()
    }
    px = {stock_id: _bounded(ctx.px[stock_id], bound) for stock_id in adjusted}
    spy_px = _bounded(ctx.px.get(ctx.spy_id, {}), bound) if ctx.spy_id is not None else {}
    return Prepared(
        cik, status, start, end_q, bound, rows, reports, dict(filed), adjusted, implied, px, spy_px
    )


def compute_fund(
    ctx: Context, status: dict, rows: pl.DataFrame, reports: pl.DataFrame
) -> FundResult:
    """One fund over its latest tracking segment (see `prepare_fund`)."""
    return compute_prepared(ctx, prepare_fund(ctx, status, rows, reports))


def prepare_batch(
    ctx: Context, holdings: pl.DataFrame, reports: pl.DataFrame
) -> Iterator[tuple[Prepared, FundResult]]:
    """`compute_batch`, also yielding each fund's inputs."""
    filed_quarters = reports.select("cik", q="period").unique()
    filled, status = fill_gaps(holdings, ctx.last_q, filed_quarters)
    ctx.load(_stock_ids(ctx, filled).to_list() + ([ctx.spy_id] if ctx.spy_id is not None else []))
    rows_of = filled.partition_by("cik", as_dict=True) if filled.height else {}
    reports_of = reports.partition_by("cik", as_dict=True) if reports.height else {}
    empty = filled.clear()
    for row in status.sort("cik").iter_rows(named=True):
        prepared = prepare_fund(
            ctx, row, rows_of.pop((row["cik"],), empty), reports_of[(row["cik"],)]
        )
        yield prepared, compute_prepared(ctx, prepared)


def compute_prepared(ctx: Context, p: Prepared) -> FundResult:
    """One fund's positions, quarters, metrics, home snapshot and flags from its `Prepared`."""
    cik, start, end_q, status, rows, reports = p.cik, p.start, p.end_q, p.status, p.rows, p.reports
    adjusted = p.adjusted
    end = int(status["segments"][-1]["end"])
    # the split check reads the shares as filed, so rebuild that frame from `filed`
    reported = pl.DataFrame(
        [(cik, q, sid, sh) for sid, series in p.filed.items() for q, (sh, _) in series.items()],
        schema={"cik": pl.Int64, "q": pl.Int64, "stock_id": pl.Int64, "shares": pl.Float64},
        orient="row",
    )

    positions = []
    for stock_id in sorted(adjusted):
        shares_by_q = {q: shares for q, (shares, _) in adjusted[stock_id].items()}
        result = compute_position(
            stock_id, shares_by_q, p.px[stock_id], start, end_q, p.implied[stock_id]
        )
        if result is not None:
            positions.append(result)
    quarters = aggregate_fund(positions, start, end_q)
    check_invariants(cik, positions, quarters)

    px_by_stock = {pos.stock_id: p.px[pos.stock_id] for pos in positions}
    spy_px = p.spy_px
    years = fund_years(quarters)
    rets = [(fq.q, fq.ret) for fq in quarters if fq.ret is not None]
    hold_all, hold_sold = hold_lengths(positions, end_q)
    metrics = build_metrics(
        performance(rets, ctx.rf),
        years,
        quarters,
        turnover=turnover(years, quarters),
        hold_all=hold_all,
        hold_sold=hold_sold,
    )
    exits = exit_rows(positions, px_by_stock, spy_px)
    exits_summary = ExitsSummary(*buys_vs_sells(positions, px_by_stock), beat_spy_pct(exits))

    period_q = int(status["last_filed_q"])
    latest_reports = reports.filter(pl.col("period") == period_q)
    filed = latest_reports["filed"].max()
    named = reports.filter(pl.col("manager_name").is_not_null()).sort(
        "period", "filed", "accession"
    )
    name = named["manager_name"][-1].strip() if named.height else f"CIK {cik}"
    latest_rows = rows.filter(pl.col("q") == end_q)
    priced = priced_pct(
        latest_rows.select("cusip", "kind", "value_usd"),
        {c for c in latest_rows["cusip"].to_list() if c in ctx.stock_of},
    )
    held = [pos for pos in positions if pos.shares_now > 0]
    meta = FundMeta(
        fund_id=cik,
        name=name,
        cik=cik,
        period_q=period_q,
        filed=filed,
        book=quarters[-1].end if quarters else 0.0,
        n_holdings=len(held),
        priced_pct=priced,
        tracked_since_q=start,
        inactive=bool(status["inactive"]),
    )
    output = FundOutput(
        meta=meta,
        years=years,
        quarters=quarters,
        positions=positions,
        contributions=contributions(positions, years),
        exits=exits,
        exits_summary=exits_summary,
        metrics=metrics,
    )
    filed_quarters = set(reports["period"].to_list())
    snapshot = _snapshot(
        ctx,
        meta,
        positions,
        quarters,
        rows,
        rets,
        end_q,
        sum(start <= q <= end for q in filed_quarters),
        filed_quarters,
    )

    engine_rows = pl.DataFrame(
        [
            (cik, q, sid, shares, value)
            for sid, series in adjusted.items()
            for q, (shares, value) in series.items()
        ],
        schema={
            "cik": pl.Int64,
            "q": pl.Int64,
            "stock_id": pl.Int64,
            "shares": pl.Float64,
            "value_usd": pl.Float64,
        },
        orient="row",
    )
    latest_two = reported.filter(pl.col("q").is_in([period_q - 1, period_q]))
    splits = pl.DataFrame(
        [
            (sid, day, factor)
            for sid in sorted(set(latest_two["stock_id"].to_list()))
            for day, factor in ctx.splits[sid].iter_rows()
        ],
        schema=SPLITS_SCHEMA,
        orient="row",
    )
    flags = price_flags(engine_rows, ctx.px, period_q) + split_suspects(latest_two, splits)
    return FundResult(output, snapshot, flags)


def _share_series(
    ctx: Context, shares_rows: pl.DataFrame
) -> tuple[dict[int, dict[int, tuple[float, float]]], pl.DataFrame]:
    """Per stock and quarter the split-adjusted shares (`split_adjust_shares`, from the stock's
    precomputed factors) and reported value (share classes of one stock summed), and the
    summed frame (cik, q, stock_id, shares as filed, value_usd)."""
    summed = (
        shares_rows.group_by("cik", "q", "stock_id")
        .agg(pl.col("shares").sum(), pl.col("value_usd").sum())
        .sort("stock_id", "q")
    )
    adjusted: dict[int, dict[int, tuple[float, float]]] = defaultdict(dict)
    for q, stock_id, shares, value in summed.select(
        "q", "stock_id", "shares", "value_usd"
    ).iter_rows():
        adjusted[stock_id][q] = (float(shares) * ctx.share_factors[stock_id].of(q), value)
    return dict(adjusted), summed


def check_invariants(
    cik: int, positions: list[PositionResult], quarters: list[FundQuarter]
) -> None:
    for fq in quarters:
        if not check_bridge(fq):
            raise InvariantError(
                f"fund {cik}, quarter {fq.q}: the AUM bridge does not add up: end {fq.end} != "
                f"start {fq.start} + market move "
                f"{fq.market_move} + net buying {fq.net_buying} + trade gains {fq.trade_gains}"
            )
    for position in positions:
        for pq in position.quarters:
            if pq.shares < 0:
                raise InvariantError(
                    f"fund {cik}, stock {position.stock_id}, quarter {pq.q}: negative shares"
                )


def _snapshot(
    ctx: Context,
    meta: FundMeta,
    positions: list[PositionResult],
    quarters: list[FundQuarter],
    rows: pl.DataFrame,
    rets: list[tuple[int, float]],
    end_q: int,
    quarters_filed: int,
    filed_quarters: set[int],
) -> FundSnapshot:
    last_q = ctx.last_q
    value_at: dict[int, dict[int, float]] = defaultdict(dict)
    for p in positions:
        for pq in p.quarters:
            value_at[pq.q][p.stock_id] = pq.value
    end_of = {fq.q: fq.end for fq in quarters}

    def weights(q: int) -> dict[int, float]:
        book = end_of.get(q, 0.0)
        if book <= 0:
            return {}
        return {sid: v / book for sid, v in sorted(value_at.get(q, {}).items()) if v > 0}

    filed_at = (
        dict(rows.group_by("q").agg(pl.col("filed").max()).iter_rows()) if rows.height else {}
    )
    # Entry trades (a first report, a holding priced for the first time) are no move of the
    # quarter: the lists of moves, crowded buys and calls leave them out.
    buys_recent = [
        (
            p.stock_id,
            t.q,
            t.px,
            value_at[t.q].get(p.stock_id, 0.0) / end_of[t.q] if end_of.get(t.q, 0.0) > 0 else 0.0,
            filed_at.get(t.q, meta.filed),
        )
        for p in positions
        for t in p.trades
        if t.type in _BUYS and last_q - 3 <= t.q <= last_q and not t.entry
    ]
    conviction_quarters = _conviction_quarters(positions, end_of, weights, end_q, filed_quarters)
    until_last = [(q, r) for q, r in rets if q <= last_q]
    perf: dict[str, Performance | None] = {}
    for period, n in PERIODS.items():
        window = until_last if n is None else [(q, r) for q, r in until_last if q > last_q - n]
        perf[period] = performance(window, ctx.rf) if n is None or len(window) == n else None
    return FundSnapshot(
        fund_id=meta.fund_id,
        name=meta.name,
        book=meta.book,
        n_priced=meta.n_holdings,
        priced_pct=meta.priced_pct,
        quarters_filed=quarters_filed,
        excluded=meta.inactive,
        weights_now=weights(end_q),
        weights_prev=weights(end_q - 1),
        trades_latest=[
            (p.stock_id, t) for p in positions for t in p.trades if t.q == last_q and not t.entry
        ],
        pnl_latest={
            p.stock_id: pq.market_move + pq.trade_gain + pq.dividends
            for p in positions
            for pq in p.quarters
            if pq.q == last_q
        },
        buys_recent=buys_recent,
        perf=perf,
        filed=meta.filed,
        period_q=meta.period_q,
        conviction_quarters=conviction_quarters,
    )


def _conviction_quarters(
    positions: list[PositionResult],
    end_of: dict[int, float],
    weights,
    end_q: int,
    filed_quarters: set[int],
) -> tuple[ConvictionQuarter, ...]:
    """The fund's last CONVICTION_LOOKBACK + CONVICTION_WINDOW quarters through `end_q` that end
    with a book, as the conviction lists need them (`ConvictionQuarter`): the net flow of the
    quarter's trades and its moves of CONVICTION_KEEP or more of the smaller of its start and end
    AUM (a move is sized on one of the two), entries left out."""
    first = end_q - CONVICTION_LOOKBACK - CONVICTION_WINDOW + 1
    weight_at = {q: weights(q) for q in range(first - 1, end_q + 1)}
    out = []
    for q in range(first, end_q + 1):
        end = end_of.get(q, 0.0)
        if end <= 0:
            continue
        prev, now = weight_at[q - 1], weight_at[q]
        start = end_of.get(q - 1, 0.0)
        floor = CONVICTION_KEEP * (min(start, end) if start > 0 else end)
        trades = [(p, t) for p in positions for t in p.trades if t.q == q and not t.entry]
        moves = tuple(
            (
                p.stock_id,
                t.type,
                t.delta * t.px,
                prev.get(p.stock_id, 0.0),
                now.get(p.stock_id, 0.0),
                t.px,
            )
            for p, t in trades
            if abs(t.delta * t.px) >= floor
        )
        out.append(
            ConvictionQuarter(
                q=q,
                start=start,
                end=end,
                top_prev=max(prev.values(), default=0.0),
                n_held=len(now),
                filed_pair=q in filed_quarters and q - 1 in filed_quarters,
                moves=moves,
                flow=sum(t.delta * t.px for _, t in trades),
            )
        )
    return tuple(out)
