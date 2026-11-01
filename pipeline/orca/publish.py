"""Publisher: turns the engine's results into the JSON files the website reads.

The files and their fields are specified in `pipeline/contract.md`, which is the one source of
truth; this module writes exactly that. Every file is minified JSON with sorted keys, brotli
compressed (quality 9) and stored under its plain public path, so the same bytes can be
served with `Content-Encoding: br`.

Public paths are stable. A run writes its files into a local staging folder (`new_version`),
compares their checksums with the previous run's manifest (`changed_files`) so that only
what changed is uploaded, and writes the manifest last (`write_manifest`): a reader that sees
the new manifest finds every file it lists already in place.

Nothing here knows a CUSIP: funds and stocks are identified by `fund_id` and `stock_id`, the
security table is cut down to its contract columns, and `write_json` refuses a `cusip` key.
"""

import hashlib
import json
import math
import os
import re
import shutil
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import brotli
import polars as pl

from orca.config import PERIODS
from orca.engine.fund import FundQuarter, FundYear, full_years
from orca.engine.metrics import Performance
from orca.engine.position import PositionResult
from orca.engine.whatif import ExitRow

METRIC_KEYS = (
    "ann_return", "sharpe", "sortino", "vol", "max_dd", "calmar", "best_year", "worst_year",
    "years_pos", "years_total", "quarters_pos_pct", "turnover", "hold_all", "hold_sold",
    "first_year", "last_year",
)  # fmt: skip
_YEAR_COLUMNS = ("label", "ret", "start", "end", "gains", "inflows", "dividends", "approx_ret")
_QUARTER_COLUMNS = (
    "q", "ret", "start", "end", "market_move", "net_buying", "trade_gains", "dividends"
)  # fmt: skip
_POSITION_COLUMNS = (
    "stock_id", "from_q", "to_q", "avg_cost", "avg_exit", "invested", "realised", "dividends",
    "shares_now", "cost_now",
)  # fmt: skip
_EXIT_COLUMNS = (
    "stock_id", "status", "sold_shares", "sold_usd", "avg_exit", "last_sale_q", "one_y",
    "spy_one_y",
)  # fmt: skip
HEALTH_KEYS = ("filings_parsed", "unmapped_cusips", "coverage_median", "funds_recomputed", "flags")

_PRICE_DECIMALS = 4  # prices are published to the hundredth of a cent
BROTLI_QUALITY = 9  # 11 compresses a few percent better at many times the cost (~10k funds a run)
_CUSIP_KEYS = frozenset({"cusip", "cusips"})
_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


# --- what one fund needs ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FundMeta:
    """A fund's header. `period_q` is the latest quarter the fund filed, `filed` the date of
    that filing, `tracked_since_q` the first quarter of its current tracking segment and
    `n_holdings` the number of positions held now."""

    fund_id: int
    name: str
    cik: int
    period_q: int
    filed: date
    book: float
    n_holdings: int
    priced_pct: float
    tracked_since_q: int
    inactive: bool


@dataclass(frozen=True, slots=True)
class ExitsSummary:
    """The mean one-year-after return of the fund's buys and of its sales, and the share of its
    sold positions that beat SPY; each None when there is nothing to average."""

    buys_12m: float | None
    sells_12m: float | None
    beat_spy_pct: float | None


@dataclass(frozen=True, slots=True)
class FundOutput:
    """Everything the four files of one fund are made from. `metrics` is `build_metrics`'s
    result; `contributions` is `engine.fund.contributions`'s."""

    meta: FundMeta
    years: list[FundYear]
    quarters: list[FundQuarter]
    positions: list[PositionResult]
    contributions: dict[str, list[tuple[int, float, float]]]
    exits: list[ExitRow]
    exits_summary: ExitsSummary
    metrics: dict


@dataclass(frozen=True, slots=True)
class HomeLists:
    """The home page lists as the Task 12 functions return them, for the quarter `latest_q`.
    `top` maps every period of `config.PERIODS` to `top_funds(snaps, period)`."""

    latest_q: int
    top: dict[str, dict[str, list[dict]]]
    conviction: list[dict]
    wins_losses: dict[str, list[dict]]
    just_filed: list[dict]
    crowded: list[dict]
    calls_q: list[dict]
    calls_y: list[dict]


# --- writing files ----------------------------------------------------------------------------


def write_json(path: Path, obj: object, compress: bool = True) -> str:
    """Write `obj` as minified JSON with sorted keys, brotli compressed (quality 9) unless
    `compress` is False, and return the sha256 of the bytes written. NaN and infinity become
    null. The file appears whole or not at all; a `cusip` key anywhere in `obj` is a ValueError
    and nothing is written."""
    payload = json.dumps(
        _json_ready(obj), separators=(",", ":"), sort_keys=True, allow_nan=False
    ).encode("ascii")  # ensure_ascii: any string, even a lone surrogate, encodes
    if compress:
        payload = brotli.compress(payload, quality=BROTLI_QUALITY)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".tmp")
    partial.write_bytes(payload)
    os.replace(partial, path)
    return hashlib.sha256(payload).hexdigest()


def read_json(path: Path, compressed: bool = True) -> object:
    """The object `write_json` wrote to `path`."""
    data = Path(path).read_bytes()
    return json.loads(brotli.decompress(data) if compressed else data)


def _json_ready(obj: object) -> object:
    """`obj` with non-finite floats as None and tuples as lists; a CUSIP key is refused."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        for key in obj:
            if isinstance(key, str) and key.lower() in _CUSIP_KEYS:
                raise ValueError(f"a CUSIP key ({key!r}) must never be published")
        return {key: _json_ready(value) for key, value in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_ready(value) for value in obj]
    return obj


def _write_all(out: Path, docs: Mapping[str, object], compress: bool) -> dict[str, str]:
    """Write every document under `out` at its public path; path -> checksum."""
    return {rel: write_json(Path(out) / rel, doc, compress) for rel, doc in docs.items()}


# --- one fund's files -------------------------------------------------------------------------


def publish_fund(out: Path, fund: FundOutput, compress: bool = True) -> dict[str, str]:
    """Write fund/{id}/summary.json, positions.json, contrib.json and exits.json under `out`;
    path -> checksum. Rows are ordered by stock_id (and years and quarters by time), so the
    same fund gives the same bytes whatever the order it was computed in. Trade prices (px,
    low, high) are rounded to 4 places. Nothing is written (ValueError) when the fund's metrics
    do not have exactly the contract's keys or `meta.n_holdings` is not the number of positions
    with shares now."""
    _check_keys("metrics", fund.metrics, METRIC_KEYS)
    held = sum(p.shares_now > 0 for p in fund.positions)
    if fund.meta.n_holdings != held:
        raise ValueError(
            f"fund {fund.meta.fund_id}: n_holdings is {fund.meta.n_holdings} "
            f"but {held} positions have shares now"
        )
    base = f"fund/{fund.meta.fund_id}"
    years = sorted(fund.years, key=lambda y: y.qs[0])
    positions = sorted(fund.positions, key=lambda p: p.stock_id)
    docs = {
        f"{base}/summary.json": _summary(fund, years, positions),
        f"{base}/positions.json": _positions(positions),
        f"{base}/contrib.json": _contrib(fund.contributions, years),
        f"{base}/exits.json": _exits(fund),
    }
    return _write_all(out, docs, compress)


def _summary(fund: FundOutput, years: list[FundYear], positions: list[PositionResult]) -> dict:
    meta = fund.meta
    held = [p for p in positions if p.shares_now > 0]
    return {
        "id": meta.fund_id,
        "name": meta.name,
        "cik": meta.cik,
        "period_q": meta.period_q,
        "filed": meta.filed.isoformat(),
        "book": meta.book,
        "n_holdings": meta.n_holdings,
        "priced_pct": meta.priced_pct,
        "tracked_since_q": meta.tracked_since_q,
        "inactive": meta.inactive,
        "metrics": fund.metrics,
        "years": _columns(years, *_YEAR_COLUMNS),
        "quarters": _columns(sorted(fund.quarters, key=lambda fq: fq.q), *_QUARTER_COLUMNS),
        "holdings_now": {
            "stock_id": [p.stock_id for p in held],
            "shares": [p.shares_now for p in held],
            "cost": [p.cost_now for p in held],
        },
    }


def _positions(positions: list[PositionResult]) -> dict:
    columns = _columns(positions, *_POSITION_COLUMNS)
    last = [_last_change(p) for p in positions]
    columns["last_q"] = [q for q, _, _, _ in last]
    columns["last_type"] = [kind for _, kind, _, _ in last]
    columns["last_pct"] = [pct for _, _, pct, _ in last]
    columns["last_usd"] = [usd for _, _, _, usd in last]
    columns["trades"] = [
        [
            [t.q, t.delta, _price(t.px), _price(t.low), _price(t.high), t.shares_after]
            for t in p.trades
        ]
        for p in positions
    ]
    return columns


def _last_change(
    position: PositionResult,
) -> tuple[int | None, str | None, float | None, float | None]:
    """(quarter, type, delta / shares before, delta x price) of the position's last trade. The
    percentage is None for a first purchase and for an exit (nothing held before, or all of it
    sold); the dollars are signed, buys positive."""
    if not position.trades:
        return None, None, None, None
    trade = position.trades[-1]
    before = trade.shares_after - trade.delta
    pct = trade.delta / before if trade.type in ("add", "trim") and before > 0 else None
    return trade.q, trade.type, pct, trade.delta * trade.px


def _contrib(
    contributions: dict[str, list[tuple[int, float, float]]], years: list[FundYear]
) -> dict:
    by_year = {}
    for year in years:
        rows = sorted(contributions.get(year.label, []), key=lambda r: (-r[1], r[0]))
        by_year[year.label] = {
            "stock_id": [stock_id for stock_id, _, _ in rows],
            "points": [points for _, points, _ in rows],
            "pnl": [pnl for _, _, pnl in rows],
        }
    return {"years": [year.label for year in years], "by_year": by_year}


def _exits(fund: FundOutput) -> dict:
    rows = sorted(fund.exits, key=lambda r: r.stock_id)
    summary = fund.exits_summary
    return {
        "rows": _columns(rows, *_EXIT_COLUMNS),
        "summary": {
            "buys_12m": summary.buys_12m,
            "sells_12m": summary.sells_12m,
            "beat_spy_pct": summary.beat_spy_pct,
        },
    }


def _price(price: float | None) -> float | None:
    """`price` rounded to `_PRICE_DECIMALS` places (prices come from float32 bars, so the digits
    beyond are noise); None stays None."""
    return None if price is None else round(price, _PRICE_DECIMALS)


def _columns(rows: Sequence[object], *fields: str) -> dict[str, list]:
    """Column-oriented view of `rows`: {field: [row.field, ...]}."""
    return {name: [getattr(row, name) for row in rows] for name in fields}


def _check_keys(what: str, mapping: Mapping, expected: Sequence[str]) -> None:
    missing = sorted(set(expected) - set(mapping))
    extra = sorted(set(mapping) - set(expected))
    if missing or extra:
        raise ValueError(
            f"{what} must have exactly the contract keys; missing {missing}, extra {extra}"
        )


# --- the summary's metrics ----------------------------------------------------------------------


def build_metrics(
    perf: Performance | None,
    years: list[FundYear],
    quarters: list[FundQuarter],
    *,
    turnover: float | None,
    hold_all: float | None,
    hold_sold: float | None,
) -> dict:
    """The summary's `metrics` object. The performance figures are None without a `perf`.

    Best and worst year, the years with a gain (`years_pos`) out of `years_total`, and
    `first_year` / `last_year` (as numbers) count the full years of `engine.fund.full_years`
    only, the same years the turnover is taken over: a partial year, or the year holding the
    segment's first quarter (which has no return), would rank on fewer than four quarters of
    return. They are all None when there is no full year; ties go to the earlier year."""
    full = full_years(years, quarters)

    def of_perf(name: str) -> float | None:
        return None if perf is None else getattr(perf, name)

    def year_ret(year: FundYear | None) -> dict | None:
        return None if year is None else {"label": year.label, "ret": year.ret}

    return {
        "ann_return": of_perf("ann_return"),
        "sharpe": of_perf("sharpe"),
        "sortino": of_perf("sortino"),
        "vol": of_perf("vol"),
        "max_dd": of_perf("max_dd"),
        "calmar": of_perf("calmar"),
        "best_year": year_ret(max(full, key=lambda y: y.ret, default=None)),
        "worst_year": year_ret(min(full, key=lambda y: y.ret, default=None)),
        "years_pos": sum(y.ret > 0 for y in full) if full else None,
        "years_total": len(full) if full else None,
        "quarters_pos_pct": of_perf("quarters_pos_pct"),
        "turnover": turnover,
        "hold_all": hold_all,
        "hold_sold": hold_sold,
        "first_year": int(full[0].label) if full else None,
        "last_year": int(full[-1].label) if full else None,
    }


# --- weekly closes ------------------------------------------------------------------------------


def weekly_closes(daily: pl.DataFrame) -> dict:
    """{"start": ISO date, "close": [...]}: one entry per calendar week from the first week with
    a priced day to the last, the entry `i` being the last close of the week (Monday to Sunday)
    that ends on Friday `start + 7 i` days, from one stock's split-adjusted daily rows (`date`
    and `close` are used). A day without a close is not priced; a week without a priced day
    in between gets None (not the previous close). A stock without any priced day gives
    {"start": None, "close": []}."""
    weeks = (
        daily.filter(pl.col("close").is_finite())
        .sort("date")
        .group_by(pl.col("date").dt.truncate("1w").alias("week"), maintain_order=True)
        .agg(pl.col("close").last())
    )
    if weeks.is_empty():
        return {"start": None, "close": []}
    close_of = dict(zip(weeks["week"].to_list(), weeks["close"].to_list()))
    first, last = weeks["week"][0], weeks["week"][-1]  # Mondays, oldest first
    count = (last - first).days // 7 + 1
    return {
        "start": (first + timedelta(days=4)).isoformat(),
        "close": [close_of.get(first + timedelta(weeks=i)) for i in range(count)],
    }


# --- files shared by all funds ------------------------------------------------------------------


def publish_shared(
    out: Path,
    *,
    funds: Iterable[FundMeta],
    securities: pl.DataFrame,
    asof: date,
    latest_prices: Mapping[int, tuple[date, float] | None],
    home: HomeLists,
    weekly: Mapping[int, dict] | None = None,
    compress: bool = True,
) -> dict[str, str]:
    """Write funds.json, securities.json, latest_prices.json, the home lists and the given
    stocks' stock/{id}/weekly.json under `out`; path -> checksum.

    `funds` is every fund (the search index), `securities` has the columns stock_id, ticker,
    name and sector (any others, such as figi or cusip, are not published), `latest_prices` maps
    stock_id to (day, close) of its latest close, or None (a close that is not a finite number
    counts as none: price and date null), `asof` is the latest of those days, and `weekly` maps
    stock_id to `weekly_closes`'s result for the stocks whose file is to be written; a stock
    without closes gets no file. Prices (latest and weekly) are rounded to 4 places.
    Nothing is written when `home.top` does not have exactly the periods of `config.PERIODS`."""
    _check_keys("home.top periods", home.top, tuple(PERIODS))
    funds = sorted(funds, key=lambda f: f.fund_id)
    table = securities.select("stock_id", "ticker", "name", "sector").sort("stock_id")
    closes = {}
    for stock_id in sorted(latest_prices):
        day, close = latest_prices[stock_id] or (None, None)
        known = close is not None and math.isfinite(close)
        closes[stock_id] = (day.isoformat(), _price(close)) if known else (None, None)
    docs: dict[str, object] = {
        "funds.json": {
            "v": 1,
            "id": [f.fund_id for f in funds],
            "name": [f.name for f in funds],
            "book": [f.book for f in funds],
            "n": [f.n_holdings for f in funds],
        },
        "securities.json": {name: table[name].to_list() for name in table.columns},
        "latest_prices.json": {
            "asof": asof.isoformat(),
            "stock_id": list(closes),
            "price": [close for _, close in closes.values()],
            "date": [day for day, _ in closes.values()],
        },
    }
    latest_q = home.latest_q
    for period in PERIODS:
        top = home.top[period]
        docs[f"home/top_{period}.json"] = {
            "latest_q": latest_q,
            "period": period,
            "eligible": top["eligible"],
            "giants": top["giants"],
        }
    docs["home/wins_losses.json"] = {
        "latest_q": latest_q,
        "wins": home.wins_losses["wins"],
        "losses": home.wins_losses["losses"],
    }
    for name, rows in (
        ("conviction", home.conviction),
        ("just_filed", home.just_filed),
        ("crowded", home.crowded),
        ("calls_q", home.calls_q),
        ("calls_y", home.calls_y),
    ):
        docs[f"home/{name}.json"] = {"latest_q": latest_q, "rows": rows}
    files = _write_all(out, docs, compress)
    files.update(publish_weekly(out, weekly or {}, compress))
    return files


def publish_weekly(out: Path, weekly: Mapping[int, dict], compress: bool = True) -> dict[str, str]:
    """Write stock/{id}/weekly.json under `out` for each stock of `weekly` (stock_id ->
    `weekly_closes`'s result) that has closes, prices rounded to 4 places; path -> checksum."""
    docs = {
        f"stock/{stock_id}/weekly.json": {
            "start": closes["start"],
            "close": [_price(close) for close in closes["close"]],
        }
        for stock_id, closes in sorted(weekly.items())
        if closes["close"]
    }
    return _write_all(out, docs, compress)


# --- versions, manifest, health -----------------------------------------------------------------


def new_version(out_root: Path, run_id: str) -> Path:
    """An empty local staging folder `out_root/staging/{run_id}` for this run's files (an earlier
    run with the same id is cleared; other runs are left alone). `run_id` must be a plain folder
    name."""
    if not _RUN_ID.fullmatch(run_id):
        raise ValueError(f"run_id must be a plain folder name, got {run_id!r}")
    staging = Path(out_root) / "staging" / run_id
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    return staging


def changed_files(new: Mapping[str, str], previous: Mapping[str, str]) -> list[str]:
    """The paths of `new` (path -> checksum) whose checksum is not the one in `previous`,
    sorted. A path only in `previous` was not rebuilt this run and is not listed."""
    return sorted(path for path, checksum in new.items() if previous.get(path) != checksum)


def write_manifest(
    out_root: Path,
    version: str,
    files: Mapping[str, str],
    compress: bool = True,
    built: datetime | None = None,
) -> None:
    """Write `out_root/manifest.json`: {"version", "built" (UTC), "files": {path: sha256}}.
    `files` is every published file, not only this run's; call this after every other file of
    the run is written, so that the manifest is the newest file. `built` is the build time, now
    unless given (a fixed time makes a seeded demo build byte for byte repeatable)."""
    stamp = (built or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {"version": version, "built": stamp, "files": dict(files)}
    write_json(Path(out_root) / "manifest.json", manifest, compress)


def read_manifest(out_root: Path, compressed: bool = True) -> dict[str, str]:
    """The file checksums of `out_root/manifest.json`; empty when there is none (first run).

    The site's manifest is stored brotli compressed with Content-Encoding: br, and R2 decodes
    it for a client that does not accept br (rclone): the restored copy is then plain JSON. So
    a `compressed` manifest that is not brotli is read as plain JSON."""
    path = Path(out_root) / "manifest.json"
    if not path.exists():
        return {}
    data = path.read_bytes()
    if compressed:
        try:
            data = brotli.decompress(data)
        except brotli.error:
            pass
    return json.loads(data)["files"]


def write_health(out: Path, stats: Mapping, compress: bool = True) -> dict[str, str]:
    """Write `out/health.json` from the run's `stats`, which must have exactly the keys
    filings_parsed, unmapped_cusips (a count; the CUSIPs themselves are never published),
    coverage_median (None when unknown), funds_recomputed and flags (a list of dicts or
    strings, carrying stock_id and fund_id, never a CUSIP). Returns {"health.json": checksum}."""
    _check_keys("health stats", stats, HEALTH_KEYS)
    unmapped = stats["unmapped_cusips"]
    if isinstance(unmapped, bool) or not isinstance(unmapped, int):
        raise TypeError("unmapped_cusips is a count, not the CUSIPs")
    coverage = stats["coverage_median"]
    health = {
        "filings_parsed": int(stats["filings_parsed"]),
        "unmapped_cusips": unmapped,
        "coverage_median": None if coverage is None else float(coverage),
        "funds_recomputed": int(stats["funds_recomputed"]),
        "flags": list(stats["flags"]),
    }
    return _write_all(out, {"health.json": health}, compress)
