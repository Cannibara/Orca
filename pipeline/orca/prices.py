"""Daily prices: Tiingo source, incremental Parquet store, split adjustment.

The lake table `prices_daily` holds raw, unadjusted bars as float32 (volume float64), one row
per (stock_id, date). Each update run appends numbered parts `z<run id>-0001`, `-0002`, ... (a
new one per flush, so a long run never rewrites what it already stored); compaction folds the
run parts into yearly parts `y<year>`. A later part overrides an earlier one, and `z` sorts after
`y`, so `read_prices` keeps the last occurrence of a (stock_id, date) in part order.
"""

import logging
import math
from collections.abc import Callable, Iterable
from datetime import date, timedelta
from typing import Protocol
from urllib.parse import quote

import polars as pl

from orca.http import Client, FetchError
from orca.quarters import q_end, q_of_date, q_start
from orca.storage import Lake

log = logging.getLogger(__name__)

TABLE = "prices_daily"
TIINGO_URL = "https://api.tiingo.com/tiingo/daily/{ticker}/prices"
HISTORY_START = q_start(0)  # first day fetched for a stock with no rows: 2013-01-01
OVERLAP_DAYS = 5  # days before the last stored one that every update fetches again
FLUSH_EVERY = 500  # tickers between writes of the run's part
STOP_STATUSES = frozenset({401, 403, 429})  # a bad key or a rate limit: no ticker will work
MAX_CONSECUTIVE_FAILURES = 25  # failed tickers in a row before the run gives up

_FLOATS = ("open", "high", "low", "close", "volume", "split_factor", "dividend")
# What a PriceSource returns: raw (unadjusted) bars, float64 in memory.
DAILY_SCHEMA = pl.Schema({"date": pl.Date, **{c: pl.Float64 for c in _FLOATS}})
# What the lake stores.
PRICES_SCHEMA = pl.Schema(
    {
        "stock_id": pl.Int32,
        "date": pl.Date,
        "open": pl.Float32,
        "high": pl.Float32,
        "low": pl.Float32,
        "close": pl.Float32,
        "volume": pl.Float64,
        "split_factor": pl.Float32,
        "dividend": pl.Float32,
    }
)
_KEY = ["stock_id", "date"]
_PRICE_COLUMNS = ("open", "high", "low", "close")


class PriceSource(Protocol):
    def daily(self, ticker: str, start: date, end: date) -> pl.DataFrame:
        """Raw daily bars for `ticker` from `start` to `end` inclusive, in DAILY_SCHEMA.
        Empty when the vendor has no data for it."""
        ...


class TiingoSource:
    """Tiingo end-of-day prices. `client` must be built by `tiingo_client()`, which puts the
    TIINGO_KEY in the Authorization header; the key never appears in a URL."""

    def __init__(self, client: Client):
        self._client = client

    def daily(self, ticker: str, start: date, end: date) -> pl.DataFrame:
        url = TIINGO_URL.format(ticker=quote(ticker, safe=""))
        try:
            response = self._client.get(url, startDate=start.isoformat(), endDate=end.isoformat())
        except FetchError as err:
            if err.status == 404:  # unknown or delisted ticker
                return pl.DataFrame(schema=DAILY_SCHEMA)
            raise
        try:
            bars = _parse_tiingo(response.json())
        except (KeyError, TypeError, ValueError, pl.exceptions.PolarsError) as err:
            raise FetchError(url, response.status_code, f"unexpected response: {err!r}") from err
        # A split factor that is missing, not finite or not positive would poison every older
        # price of the stock, so such a bar is dropped (and logged) rather than stored.
        usable = bars.filter(pl.col("split_factor").is_finite() & (pl.col("split_factor") > 0))
        if usable.height < bars.height:
            log.warning(
                "tiingo %s: dropped %d of %d bars with a bad split factor",
                ticker,
                bars.height - usable.height,
                bars.height,
            )
        return usable


def _parse_tiingo(rows: list[dict]) -> pl.DataFrame:
    """Tiingo's raw fields: `date` is "2024-05-10T00:00:00.000Z"; `divCash` and `splitFactor`
    are the dividend and split factor of that day. The adj* fields are ignored."""
    if not isinstance(rows, list):
        raise TypeError(f"expected a list of bars, got {type(rows).__name__}")
    columns = {c: [row[c] for row in rows] for c in ("open", "high", "low", "close", "volume")}
    return pl.DataFrame(
        {
            "date": [row["date"][:10] for row in rows],
            **columns,
            "split_factor": [row["splitFactor"] for row in rows],
            "dividend": [row["divCash"] for row in rows],
        },
        schema={"date": pl.String, **{c: pl.Float64 for c in _FLOATS}},
    ).with_columns(pl.col("date").str.to_date("%Y-%m-%d"))


class FixtureSource:
    """Serves prepared frames (DAILY_SCHEMA columns) by ticker; no network."""

    def __init__(self, frames: dict[str, pl.DataFrame]):
        self._frames = frames

    def daily(self, ticker: str, start: date, end: date) -> pl.DataFrame:
        frame = self._frames.get(ticker)
        if frame is None:
            return pl.DataFrame(schema=DAILY_SCHEMA)
        return frame.filter(pl.col("date").is_between(start, end))


# --- store ------------------------------------------------------------------------------


def read_prices(lake: Lake) -> pl.DataFrame:
    """All stored bars, one row per (stock_id, date), sorted by stock_id, date. Where a day was
    stored more than once the last occurrence in part order wins (later runs override earlier).

    Loads, de-duplicates and sorts the whole table: for 6,000 stocks over 13 years that is some
    16 million rows and several GB at peak. For consumers that need all of it; `update_prices`
    does not use it."""
    prices = lake.read(TABLE)
    if prices.is_empty():
        return pl.DataFrame(schema=PRICES_SCHEMA)
    return prices.unique(subset=_KEY, keep="last", maintain_order=True).sort(_KEY)


def _part_path(lake: Lake, part: str):
    return lake.root / TABLE / f"{part}.parquet"


def _run_of(part: str) -> str | None:
    """The run id of a run part (`z<run>-NNNN`, or an older single `z<run>`), else None."""
    if not part.startswith("z"):
        return None
    run, dash, number = part[1:].rpartition("-")
    return run if dash and len(number) == 4 and number.isdigit() else part[1:]


def run_parts(lake: Lake, run_id: str) -> list[str]:
    """The parts the price run `run_id` wrote, in part order."""
    return [p for p in lake.parts(TABLE) if _run_of(p) == run_id]


def price_runs(lake: Lake) -> set[str]:
    """The ids of the runs whose parts are not compacted yet."""
    return {run for p in lake.parts(TABLE) if (run := _run_of(p)) is not None}


def part_stocks(lake: Lake, parts: list[str]) -> set[int]:
    """The stock ids stored in `parts`, read from their stock_id column alone."""
    frames = [
        pl.scan_parquet(_part_path(lake, p)).select("stock_id").unique().collect() for p in parts
    ]
    return set(pl.concat(frames)["stock_id"].to_list()) if frames else set()


def _stored_tail(lake: Lake) -> tuple[dict[int, date], dict[tuple, pl.DataFrame]]:
    """The last stored date of each stock, and its stored bars from 5 days before that date on
    (one row per day, the last occurrence in part order), keyed by (stock_id,). The part files
    are scanned lazily, so only two columns and the small recent window are ever in memory."""
    paths = [_part_path(lake, part) for part in lake.parts(TABLE)]
    if not paths:
        return {}, {}
    last = (
        pl.scan_parquet(paths)
        .group_by("stock_id")
        .agg(pl.col("date").max().alias("last"))
        .collect(engine="streaming")
    )
    windows = [  # in part order, which is the order in which later rows override earlier
        pl.scan_parquet(path)
        .join(last.lazy(), on="stock_id", maintain_order="left")  # keep the file's row order
        .filter(pl.col("date") >= pl.col("last").dt.offset_by(f"-{OVERLAP_DAYS}d"))
        .drop("last")
        .collect()
        for path in paths
    ]
    recent = (
        pl.concat(windows)
        .unique(subset=_KEY, keep="last", maintain_order=True)
        .partition_by("stock_id", as_dict=True)
    )
    return dict(last.iter_rows()), recent


def update_prices(
    lake: Lake,
    source: PriceSource,
    tickers: dict[int, str],
    today: date,
    run_id: str | None = None,
    stats: dict | None = None,
    flush_every: int = FLUSH_EVERY,
    should_stop: Callable[[], bool] | None = None,
    history_until: date | None = None,
    refetch: Iterable[int] = (),
) -> list[int]:
    """Fetch each stock's prices through `today`, in the order of `tickers`, and append the new
    and revised bars to new parts `z<run_id>-0001`, `-0002`, ... (run_id default: today as
    YYYYMMDD; a run id already in the lake goes on from its last part number).

    A stock is fetched from 5 days before its last stored date, or from 2013-01-01 when it has no
    rows or is in `refetch` (its ticker changed: the whole history is fetched again, and counts as
    changed). Returns the sorted stock_ids whose history changed: stocks that got their first rows,
    stocks whose stored bars were revised (a price correction, or a split recorded late) or
    back-filled, and stocks with a new or changed split factor, which re-bases every older price.
    Plain new days are not a change. With `history_until` (the last closed quarter's end), a
    revised or back-filled day after it is not a change either: no fund's files use the open
    quarter's prices (the bars are stored all the same).

    A ticker whose fetch raises FetchError is logged and skipped; nothing is stored for it, so
    its last stored date stays put and the next run fetches it again. The run stops early, keeping
    what it has, on a 401, 403 or 429 (the key or the rate limit: every later ticker would fail
    too), after 25 failed tickers in a row, or when `should_stop()` (asked before each ticker)
    says so: a time budget is spent. A new part is written every `flush_every` tickers, so a run
    that is killed keeps what it fetched so far (but the stocks it had flagged as changed are then
    lost: the next run finds them unchanged).

    `stats`, if given, is reset and filled: "fetched" (tickers that returned rows), "empty"
    (tickers that returned none), "failed" (a (stock_id, ticker, HTTP status or None) per failed
    ticker) and "stopped" (why the run stopped early, else None).
    """
    stats = {} if stats is None else stats
    failed: list[tuple[int, str, int | None]] = []
    stats.update(fetched=0, empty=0, failed=failed, stopped=None)
    last_by_id, recent = _stored_tail(lake)
    refetch = set(refetch)
    run_id = run_id or today.strftime("%Y%m%d")
    numbers = [int(p.rpartition("-")[2]) for p in run_parts(lake, run_id) if p != f"z{run_id}"]
    next_number = max(numbers, default=0) + 1
    changed: list[int] = []
    pending: list[pl.DataFrame] = []

    def flush() -> None:
        nonlocal next_number
        if not pending:
            return
        rows = pl.concat(pending)
        pending.clear()
        lake.write(TABLE, rows, part=f"z{run_id}-{next_number:04d}")
        next_number += 1

    in_a_row = 0
    for done, (stock_id, ticker) in enumerate(tickers.items(), start=1):
        if should_stop is not None and should_stop():
            stats["stopped"] = "time budget"
            log.warning("prices: stopping the run: the time budget is spent")
            break
        last_date = last_by_id.get(stock_id)
        if last_date is None or stock_id in refetch:
            start = HISTORY_START
        else:
            start = last_date - timedelta(days=OVERLAP_DAYS)
        try:
            bars = source.daily(ticker, start, today)
        except FetchError as err:
            log.warning("prices: %s (stock %d) skipped: %s", ticker, stock_id, err)
            failed.append((stock_id, ticker, err.status))
            in_a_row += 1
            if err.status in STOP_STATUSES:
                stats["stopped"] = f"HTTP {err.status} on {ticker}"
            elif in_a_row >= MAX_CONSECUTIVE_FAILURES:
                stats["stopped"] = f"{in_a_row} consecutive failures"
            if stats["stopped"]:
                log.error("prices: stopping the run: %s", stats["stopped"])
                break
        else:
            in_a_row = 0
            fetched = _as_stored(bars, stock_id)
            stats["empty" if fetched.is_empty() else "fetched"] += 1
            rows, history_changed = _new_rows(
                fetched, last_date, recent.get((stock_id,)), history_until
            )
            if not rows.is_empty():
                pending.append(rows)
            if history_changed:
                changed.append(stock_id)
        if done % flush_every == 0:
            flush()
    flush()
    return sorted(changed)


def _as_stored(daily: pl.DataFrame, stock_id: int) -> pl.DataFrame:
    """A source frame as stored rows: stock_id added, columns in storage order and types."""
    return (
        daily.select(PRICES_SCHEMA.names()[1:])
        .with_columns(stock_id=pl.lit(stock_id))
        .select(PRICES_SCHEMA.names())
        .cast(PRICES_SCHEMA)
        .sort("date")
    )


def _new_rows(
    fetched: pl.DataFrame,
    last_date: date | None,
    recent: pl.DataFrame | None,
    history_until: date | None = None,
) -> tuple[pl.DataFrame, bool]:
    """The fetched rows to append (those not already stored as they are), and whether they change
    the stock's history: it has no stored rows yet, a stored day up to `history_until` differs or
    was missing, or a day's split factor is new or changed. `last_date` and `recent` are the
    stock's `_stored_tail` entries."""
    if fetched.is_empty():
        return fetched, False
    if last_date is None or recent is None:
        return fetched, True
    rows = _not_yet_stored(fetched, recent)
    behind = last_date if history_until is None else min(last_date, history_until)
    counts = (pl.col("date") <= behind) | (pl.col("split_factor") != 1.0) | pl.col("_split_changed")
    return rows.drop("_split_changed"), not rows.filter(counts).is_empty()


def _not_yet_stored(fetched: pl.DataFrame, recent: pl.DataFrame) -> pl.DataFrame:
    """The fetched rows that are not already stored as they are: new days, and days whose stored
    row differs in any field or is missing; `_split_changed` marks a stored day whose split
    factor is no longer the stored one."""
    values = [c for c in PRICES_SCHEMA.names() if c not in _KEY]
    old = recent.select("date", *[pl.col(c).alias(f"{c}_old") for c in values]).with_columns(
        stored=pl.lit(True)
    )
    differs = pl.col("stored").is_null() | pl.any_horizontal(
        pl.col(c).ne_missing(pl.col(f"{c}_old")) for c in values
    )
    split_changed = pl.col("stored").is_not_null() & pl.col("split_factor").ne_missing(
        pl.col("split_factor_old")
    )
    return (
        fetched.join(old, on="date", how="left")
        .filter(differs)
        .select(*PRICES_SCHEMA.names(), _split_changed=split_changed)
    )


def compact_prices(lake: Lake) -> None:
    """Fold all run parts (`z...`) into yearly parts `y<year>` and delete them. Years the runs
    touch are rewritten with the run rows overriding the old ones; other years are left alone.
    One year is read at a time (a first backfill holds every year). The yearly parts are written
    before any run part is deleted, so an interrupted compaction loses nothing."""
    parts = [p for p in lake.parts(TABLE) if p.startswith("z")]
    if not parts:
        return
    paths = [_part_path(lake, p) for p in parts]  # oldest run first
    year = pl.col("date").dt.year()
    years = pl.concat(
        [pl.scan_parquet(path).select(year.unique().alias("year")).collect() for path in paths]
    )
    for y in sorted(years["year"].unique().to_list()):
        part = f"y{y}"
        frames = [lake.read(TABLE, part=part)] if part in lake.parts(TABLE) else []
        frames += [pl.scan_parquet(path).filter(year == y).collect() for path in paths]
        merged = pl.concat(frames).unique(subset=_KEY, keep="last", maintain_order=True).sort(_KEY)
        lake.write(TABLE, merged, part=part)
    for part in parts:
        _part_path(lake, part).unlink()


# --- split adjustment -------------------------------------------------------------------


def split_adjust_prices(df: pl.DataFrame) -> pl.DataFrame:
    """Put every bar on today's share basis. Per stock, the factor of a day is the product of the
    split factors of the days after it; open/high/low/close/dividend are divided by it and
    volume multiplied. A split day's own bar is already post-split, so its own factor is not
    applied to it. `df` is read_prices output (one row per stock_id, date); the result is sorted
    by stock_id, date with every numeric column float64 and the raw split_factor kept."""
    later_splits = (
        pl.col("split_factor")
        .fill_null(1.0)
        .reverse()
        .cum_prod()
        .reverse()  # product of the split factors from this day on
        .shift(-1, fill_value=1.0)  # ... from the next day on
        .over("stock_id")
    )
    adjusted = [pl.col(c) / pl.col("_factor") for c in (*_PRICE_COLUMNS, "dividend")]
    return (
        df.sort(_KEY)
        .cast({c: pl.Float64 for c in _FLOATS})
        .with_columns(_factor=later_splits)
        .with_columns(*adjusted, pl.col("volume") * pl.col("_factor"))
        .drop("_factor")
    )


def split_factors_by_quarter(splits: pl.DataFrame) -> dict[int, float]:
    """The factor `split_adjust_shares` applies to a share count of quarter q, for every quarter
    from 0 up to the last split's: the product of the split factors dated after q's end, in the
    rows' (date) order, so `shares * factors.get(q, 1.0)` gives exactly the same float. The
    quarter of the last split and later ones are absent (factor 1). `splits` has one stock's
    (date, split_factor)."""
    days = [
        (day, factor)
        for day, factor in splits.select("date", "split_factor").iter_rows()
        if factor is not None
    ]
    if not days:
        return {}
    last_q = q_of_date(max(day for day, _ in days))
    return {q: math.prod(factor for day, factor in days if day > q_end(q)) for q in range(last_q)}


def split_adjust_shares(shares: float, q: int, splits: pl.DataFrame) -> float:
    """A share count reported for quarter `q` on today's share basis: multiplied by the split
    factors of the splits dated after the quarter's end. `splits` has the (date, split_factor)
    rows of one stock; rows with factor 1.0 are harmless."""
    if splits.is_empty():
        return float(shares)
    cutoff = q_end(q)
    later = (
        factor
        for day, factor in splits.select("date", "split_factor").iter_rows()
        if day > cutoff and factor is not None
    )
    return float(shares) * math.prod(later)
