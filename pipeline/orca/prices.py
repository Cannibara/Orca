"""Daily prices: Tiingo source, incremental Parquet store, split adjustment.

The lake table `prices_daily` holds raw, unadjusted bars as float32 (volume float64), one row
per (stock_id, date). Each update run appends one part `z<run id>`; compaction folds the run
parts into yearly parts `y<year>`. A later part overrides an earlier one, and `z` sorts after
`y`, so `read_prices` keeps the last occurrence of a (stock_id, date) in part order.
"""

import logging
import math
from datetime import date, timedelta
from typing import Protocol
from urllib.parse import quote

import polars as pl

from orca.http import Client, FetchError
from orca.quarters import q_end, q_start
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
) -> list[int]:
    """Fetch each stock's prices through `today` and append the new and revised bars to the
    part `z<run_id>` (default: today as YYYYMMDD; a part of that name already in the lake is
    extended, never replaced).

    A stock is fetched from 5 days before its last stored date, or from 2013-01-01 when it has no
    rows. Returns the sorted stock_ids whose history changed: stocks that got their first rows,
    stocks whose stored bars were revised (a price correction, or a split recorded late) or
    back-filled, and stocks with a new split day, which re-bases every older price. Plain new days
    are not a change.

    A ticker whose fetch raises FetchError is logged and skipped; nothing is stored for it, so
    its last stored date stays put and the next run fetches it again. The run stops early, keeping
    what it has, on a 401, 403 or 429 (the key or the rate limit: every later ticker would fail
    too) or after 25 failed tickers in a row. The part is written every `flush_every` tickers,
    so a run that is killed keeps what it fetched so far (but the stocks it had flagged as
    changed are then lost: the next run finds them unchanged).

    `stats`, if given, is reset and filled: "fetched" (tickers that returned rows), "empty"
    (tickers that returned none), "failed" (a (stock_id, ticker, HTTP status or None) per failed
    ticker) and "stopped" (why the run stopped early, else None).
    """
    stats = {} if stats is None else stats
    failed: list[tuple[int, str, int | None]] = []
    stats.update(fetched=0, empty=0, failed=failed, stopped=None)
    last_by_id, recent = _stored_tail(lake)
    part = f"z{run_id or today.strftime('%Y%m%d')}"
    changed: list[int] = []
    pending: list[pl.DataFrame] = []

    def flush() -> None:
        if not pending:
            return
        rows = pl.concat(pending)
        pending.clear()
        if part in lake.parts(TABLE):
            rows = pl.concat([lake.read(TABLE, part=part), rows])
        lake.write(TABLE, rows, part=part)

    in_a_row = 0
    for done, (stock_id, ticker) in enumerate(sorted(tickers.items()), start=1):
        last_date = last_by_id.get(stock_id)
        start = HISTORY_START if last_date is None else last_date - timedelta(days=OVERLAP_DAYS)
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
            rows, history_changed = _new_rows(fetched, last_date, recent.get((stock_id,)))
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
    fetched: pl.DataFrame, last_date: date | None, recent: pl.DataFrame | None
) -> tuple[pl.DataFrame, bool]:
    """The fetched rows to append (those not already stored as they are), and whether they change
    the stock's history: it has no stored rows yet, a stored day differs or was missing, or a new
    day carries a split. `last_date` and `recent` are the stock's `_stored_tail` entries."""
    if fetched.is_empty():
        return fetched, False
    if last_date is None or recent is None:
        return fetched, True
    rows = _not_yet_stored(fetched, recent)
    behind_or_split = (pl.col("date") <= last_date) | (pl.col("split_factor") != 1.0)
    return rows, not rows.filter(behind_or_split).is_empty()


def _not_yet_stored(fetched: pl.DataFrame, recent: pl.DataFrame) -> pl.DataFrame:
    """The fetched rows that are not already stored as they are: new days, and days whose stored
    row differs in any field or is missing."""
    values = [c for c in PRICES_SCHEMA.names() if c not in _KEY]
    old = recent.select("date", *[pl.col(c).alias(f"{c}_old") for c in values]).with_columns(
        stored=pl.lit(True)
    )
    differs = pl.col("stored").is_null() | pl.any_horizontal(
        pl.col(c).ne_missing(pl.col(f"{c}_old")) for c in values
    )
    return fetched.join(old, on="date", how="left").filter(differs).select(PRICES_SCHEMA.names())


def compact_prices(lake: Lake) -> None:
    """Fold all run parts (`z...`) into yearly parts `y<year>` and delete them. Years the runs
    touch are rewritten with the run rows overriding the old ones; other years are left alone.
    The yearly parts are written before any run part is deleted, so an interrupted compaction
    loses nothing."""
    run_parts = [p for p in lake.parts(TABLE) if p.startswith("z")]
    if not run_parts:
        return
    runs = pl.concat([lake.read(TABLE, part=p) for p in run_parts])  # oldest run first
    by_year = runs.with_columns(year=pl.col("date").dt.year()).partition_by(
        "year", as_dict=True, include_key=False
    )
    for (year,), rows in sorted(by_year.items()):
        part = f"y{year}"
        if part in lake.parts(TABLE):
            rows = pl.concat([lake.read(TABLE, part=part), rows])
        merged = rows.unique(subset=_KEY, keep="last", maintain_order=True).sort(_KEY)
        lake.write(TABLE, merged, part=part)
    for part in run_parts:
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
