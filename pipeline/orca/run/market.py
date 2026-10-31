"""Market data of a run: the security master (CUSIPs mapped, new securities enriched), daily prices
of the stocks that matter, and the T-bill table."""

from collections.abc import Iterable
from datetime import date

import polars as pl

from orca.holdings import HOLDINGS_SCHEMA
from orca.http import FetchError
from orca.prices import TABLE as PRICES_TABLE
from orca.prices import compact_prices, split_adjust_prices, update_prices
from orca.run.sources import Sources
from orca.run.state import (
    CUSIP_MAP_SCHEMA,
    MAX_FLAGS_PER_KIND,
    RF_SCHEMA,
    SECURITIES_TABLE_SCHEMA,
    State,
    read_table,
    scan,
    scan_parts,
    strip_query,
)
from orca.securities import assign_stock_ids, map_cusips, normalise_ticker, sector_for_sic
from orca.storage import Lake

BENCHMARK_CUSIP = "78462F103"  # SPY, the benchmark of the what-if figures
EMPTY_FETCH_WARN = 0.25  # share of tickers answering with no rows that is worth a flag
COMPACT_AT_RUN_PARTS = 4  # price run parts that trigger a compaction into yearly parts


# --- securities -------------------------------------------------------------------------------


def stock_of(cusip_map: pl.DataFrame) -> dict[str, int]:
    """CUSIP -> stock id of the mapped rows of `cusip_map`."""
    mapped = cusip_map.filter(pl.col("stock_id").is_not_null())
    return dict(zip(mapped["cusip"].to_list(), mapped["stock_id"].to_list()))


def map_new_cusips(lake: Lake, sources: Sources, state: State, flags: list) -> None:
    """Map the share CUSIPs not yet in cusip_map (and the benchmark's), oldest first, give new
    securities ids, sectors and shares outstanding, and mark every fund holding a newly mapped
    CUSIP for recompute. A failed mapping leaves the CUSIPs for the next run."""
    cusip_map = read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    known = set(cusip_map["cusip"].to_list())
    firsts = scan_parts(
        lake,
        "holdings",
        lambda f: f.filter(pl.col("kind") == "SH").group_by("cusip").agg(pl.col("q").min()),
    )
    held = (
        pl.concat(firsts).group_by("cusip").agg(pl.col("q").min()).sort("q", "cusip")
        if firsts
        else pl.DataFrame(schema={"cusip": pl.String, "q": pl.Int16})
    )
    new = [c for c in held["cusip"].to_list() if c not in known]
    if BENCHMARK_CUSIP not in known and BENCHMARK_CUSIP not in new:
        new.append(BENCHMARK_CUSIP)
    if not new:
        return
    try:
        tickers = sources.sec_tickers()
        issuers = issuer_names(lake, new)
        mapped = map_cusips(new, issuers, sources.figi, tickers)
    except FetchError as err:
        flags.append(
            {
                "type": "cusip_mapping_failed",
                "count": len(new),
                "url": strip_query(err.url),
                "status": err.status,
            }
        )
        return
    except ValueError as err:  # an OpenFIGI answer that does not line up with the jobs
        flags.append({"type": "cusip_mapping_failed", "count": len(new), "detail": str(err)[:200]})
        return

    existing = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    old_max = existing["stock_id"].max() or 0
    securities = assign_stock_ids(mapped, existing).cast(SECURITIES_TABLE_SCHEMA)
    added = securities.filter(pl.col("stock_id") > old_max)
    securities = pl.concat(
        [securities.filter(pl.col("stock_id") <= old_max), enrich(added, sources, tickers, flags)]
    )

    new_map = cusip_rows(mapped, securities)
    newly = new_map.filter(pl.col("stock_id").is_not_null())["cusip"].to_list()
    if newly:
        holders = scan(lake, "holdings", HOLDINGS_SCHEMA, pl.col("cusip").is_in(newly))
        state.pending_funds |= {int(c) for c in holders["cik"].unique().to_list()}
        state.save(lake)  # before the map is written, so a crash cannot lose these funds
    lake.write("securities", securities.sort("stock_id"))
    lake.write("cusip_map", pl.concat([cusip_map, new_map]).sort("cusip"))


def issuer_names(lake: Lake, cusips: list[str]) -> dict[str, str]:
    """An issuer name per CUSIP as the 13Fs spell it (the alphabetically first, for a stable
    choice), for the name fallback of the mapping."""
    clean = pl.col("cusip").str.strip_chars().str.to_uppercase()
    frames = scan_parts(
        lake,
        "raw_holdings",
        lambda f: (
            f.select(clean.alias("cusip"), "issuer")
            .filter(pl.col("cusip").is_in(cusips) & pl.col("issuer").is_not_null())
            .group_by("cusip")
            .agg(pl.col("issuer").min())
        ),
    )
    if not frames:
        return {}
    names = pl.concat(frames).group_by("cusip").agg(pl.col("issuer").min())
    return dict(names.iter_rows())


def enrich(
    added: pl.DataFrame, sources: Sources, tickers: pl.DataFrame, flags: list
) -> pl.DataFrame:
    """Company CIK (from the SEC ticker list), SIC code, sector and shares outstanding of new
    securities. A failed lookup is flagged and left empty."""
    cik_of = {t: c for t, c in tickers.select("ticker", "cik").iter_rows()}
    rows = []
    for row in added.iter_rows(named=True):
        cik = cik_of.get(normalise_ticker(row["ticker"])) if row["ticker"] else None
        sic = shares = None
        if cik is not None:
            try:
                sic = None if row["is_etf"] else sources.sic(cik)
                shares = sources.shares_outstanding(cik)
            except FetchError as err:
                flags.append(
                    {
                        "type": "security_lookup_failed",
                        "stock_id": row["stock_id"],
                        "status": err.status,
                    }
                )
        rows.append(
            {
                **row,
                "cik": cik,
                "sic": sic,
                "sector": sector_for_sic(sic, bool(row["is_etf"])),
                "shares_out": shares,
            }
        )
    return pl.DataFrame(rows, schema=SECURITIES_TABLE_SCHEMA)


def cusip_rows(mapped: pl.DataFrame, securities: pl.DataFrame) -> pl.DataFrame:
    """cusip_map rows of `mapped`: each CUSIP's stock id found by the security's key, its FIGI,
    or (without one) the FIGI of a security with its ticker, else its ticker, as
    assign_stock_ids identifies securities."""
    by_figi, by_ticker, figi_of_ticker = {}, {}, {}
    for stock_id, figi, ticker in securities.select("stock_id", "figi", "ticker").iter_rows():
        if figi:
            by_figi[figi] = stock_id
            if ticker:
                figi_of_ticker.setdefault(ticker, figi)
        elif ticker:
            by_ticker.setdefault(ticker, stock_id)
    rows = []
    for cusip, figi, ticker, method in mapped.select(
        "cusip", "figi", "ticker", "method"
    ).iter_rows():
        figi = figi or figi_of_ticker.get(ticker)
        stock_id = by_figi.get(figi) if figi else by_ticker.get(ticker)
        rows.append((cusip, stock_id, method))
    return pl.DataFrame(rows, schema=CUSIP_MAP_SCHEMA, orient="row")


# --- prices -------------------------------------------------------------------------------


def held_stocks(lake: Lake, stocks: dict[str, int], since_q: int) -> set[int]:
    """The stocks held (SH rows) in quarter `since_q` or later; `stocks` maps CUSIP -> stock id."""
    rows = scan(
        lake, "holdings", HOLDINGS_SCHEMA, (pl.col("q") >= since_q) & (pl.col("kind") == "SH")
    )
    return {stocks[c] for c in rows["cusip"].unique().to_list() if c in stocks}


def refresh_prices(
    lake: Lake, sources: Sources, state: State, today: date, last_q: int, run_id: str, flags: list
) -> list[int]:
    """Fetch the prices of the stocks held in the latest quarter, the benchmark and any stock
    never fetched; record the stocks whose history changed (and those with new rows, for their
    weekly file) in the state before anything is recomputed from them. Returns the changed ids.

    A price run writes its part as it goes but reports the changed stocks only at the end, so the
    run is marked in flight while it works. If it dies, the next run takes every stock of its part
    as changed: more recomputing than needed, but no change is lost."""
    recover_prices_in_flight(lake, state)
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    stocks = stock_of(read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
    wanted = held_stocks(lake, stocks, last_q) | (
        set(securities["stock_id"].to_list()) - state.price_tried
    )
    if BENCHMARK_CUSIP in stocks:
        wanted.add(stocks[BENCHMARK_CUSIP])
    ticker_of = dict(securities.select("stock_id", "ticker").iter_rows())
    tickers = {sid: ticker_of[sid] for sid in sorted(wanted) if ticker_of.get(sid)}
    if sum(p.startswith("z") for p in lake.parts(PRICES_TABLE)) >= COMPACT_AT_RUN_PARTS:
        compact_prices(lake)
    stats: dict = {}
    state.prices_in_flight = run_id
    state.save(lake)
    changed = update_prices(lake, sources.prices, tickers, today, run_id=run_id, stats=stats)
    part = f"z{run_id}"
    touched = set()
    if part in lake.parts(PRICES_TABLE):
        touched = set(lake.read(PRICES_TABLE, part=part)["stock_id"].unique().to_list())
    failed = {sid for sid, _, _ in stats["failed"]}
    state.pending_stocks |= set(changed)
    state.pending_weekly |= touched | set(changed)
    if stats["stopped"] is None:
        state.price_tried |= set(tickers) - failed
    else:  # the run broke off: only stocks that have rows are known to have been fetched
        state.price_tried |= touched
    state.prices_in_flight = None
    state.save(lake)

    asked = stats["fetched"] + stats["empty"]
    empty_ratio = stats["empty"] / asked if asked else 0.0
    if failed or stats["stopped"] or empty_ratio > EMPTY_FETCH_WARN:
        flags.append(
            {
                "type": "prices",
                "fetched": stats["fetched"],
                "empty": stats["empty"],
                "empty_ratio": empty_ratio,
                "failed": sorted(failed)[:MAX_FLAGS_PER_KIND],
                "failed_count": len(failed),
                "stopped": stats["stopped"],
            }
        )
    if changed:
        refresh_shares_outstanding(lake, sources, securities, changed, flags)
    return changed


def recover_prices_in_flight(lake: Lake, state: State) -> None:
    if state.prices_in_flight is None:
        return
    part = f"z{state.prices_in_flight}"
    if part in lake.parts(PRICES_TABLE):
        stocks = set(lake.read(PRICES_TABLE, part=part)["stock_id"].unique().to_list())
        state.pending_stocks |= stocks
        state.pending_weekly |= stocks
    state.prices_in_flight = None
    state.save(lake)


def refresh_shares_outstanding(
    lake: Lake, sources: Sources, securities: pl.DataFrame, stock_ids: list[int], flags: list
) -> None:
    """A split changes the share count: refetch it for the stocks whose history changed."""
    fresh = {}
    for stock_id, cik in (
        securities.filter(pl.col("stock_id").is_in(stock_ids)).select("stock_id", "cik").iter_rows()
    ):
        if cik is None:
            continue
        try:
            shares = sources.shares_outstanding(cik)
        except FetchError as err:
            flags.append(
                {"type": "security_lookup_failed", "stock_id": stock_id, "status": err.status}
            )
            continue
        if shares is not None:
            fresh[stock_id] = shares
    if fresh:
        update = pl.DataFrame(
            {"stock_id": list(fresh), "_fresh": list(fresh.values())},
            schema={"stock_id": pl.Int32, "_fresh": pl.Float64},
        )
        securities = (
            securities.join(update, on="stock_id", how="left")
            .with_columns(shares_out=pl.coalesce("_fresh", "shares_out"))
            .drop("_fresh")
        )
        lake.write("securities", securities.cast(SECURITIES_TABLE_SCHEMA).sort("stock_id"))


def load_daily(
    lake: Lake, stock_ids: Iterable[int] | None = None, since: date | None = None
) -> pl.DataFrame:
    """Stored bars of `stock_ids` (all stocks when None) from `since` on (all days when None),
    split-adjusted to today's share basis; of a day stored more than once the last copy in part
    order wins. Cutting the days off before `since` changes no adjusted value: a day's factor
    comes from the splits after it."""
    where = pl.lit(True)
    if stock_ids is not None:
        where &= pl.col("stock_id").is_in(sorted(stock_ids))
    if since is not None:
        where &= pl.col("date") >= since
    frames = scan_parts(lake, PRICES_TABLE, lambda f: f.filter(where))
    if not frames:
        return pl.DataFrame()
    raw = pl.concat(frames, how="vertical_relaxed").unique(
        subset=["stock_id", "date"], keep="last", maintain_order=True
    )
    return split_adjust_prices(raw)


def latest_closes(lake: Lake) -> dict[int, tuple[date, float]]:
    """Each stock's latest stored close and its date (raw = today's basis: no split after it)."""
    frames = scan_parts(lake, PRICES_TABLE, lambda f: f.select("stock_id", "date", "close"))
    if not frames:
        return {}
    rows = (
        pl.concat(frames)
        .unique(subset=["stock_id", "date"], keep="last", maintain_order=True)
        .filter(pl.col("close").is_not_null() & pl.col("close").is_finite())
        .sort("stock_id", "date")
        .group_by("stock_id", maintain_order=True)
        .agg(pl.col("date").last(), pl.col("close").last())
    )
    return {sid: (day, float(close)) for sid, day, close in rows.iter_rows()}


# --- T-bill -------------------------------------------------------------------------------


def update_rf(
    lake: Lake, sources: Sources, state: State, last_q: int, full: bool, flags: list
) -> None:
    """The T-bill table, refetched when the latest quarter moves on (or on a full run, or after a
    failure): Sharpe and Sortino of every fund depend on it, so a new table is written only
    after a recompute of every fund is recorded as owed (`pending_all`)."""
    stored = rf_table(lake)
    if stored and not (full or state.rf_stale or state.last_q != last_q):
        return
    try:
        fetched = sources.tbill()
    except FetchError as err:
        flags.append({"type": "tbill_failed", "url": strip_query(err.url), "status": err.status})
        state.rf_stale = True
        return
    fetched = {int(y): float(r) for y, r in fetched.items()}
    if fetched == stored:
        state.rf_stale = False
        return
    state.pending_all = True
    state.save(lake)  # rf_stale stays set: a crash before the write must fetch the rates again
    years = sorted(fetched)
    lake.write("rf", pl.DataFrame({"year": years, "rate": [fetched[y] for y in years]}, RF_SCHEMA))
    state.rf_stale = False


def rf_table(lake: Lake) -> dict[int, float]:
    return {int(y): float(r) for y, r in read_table(lake, "rf", RF_SCHEMA).iter_rows()}
