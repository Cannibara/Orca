"""Market data of a run: the security master (CUSIPs mapped, new securities enriched), daily prices
of the stocks that matter, and the T-bill table."""

from collections.abc import Iterable
from datetime import date, timedelta

import polars as pl

from orca.holdings import HOLDINGS_SCHEMA
from orca.http import FetchError
from orca.prices import TABLE as PRICES_TABLE
from orca.prices import (
    compact_prices,
    part_stocks,
    price_runs,
    run_parts,
    split_adjust_prices,
    update_prices,
)
from orca.quarters import q_end, q_of_date
from orca.run.budget import Budget
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
from orca.securities import (
    ERROR,
    OPENFIGI,
    SEC_TICKERS_SCHEMA,
    assign_stock_ids,
    map_cusips,
    normalise_name,
    normalise_ticker,
    sector_for_sic,
)
from orca.storage import Lake

BENCHMARK_CUSIP = "78462F103"  # SPY, the benchmark of the what-if figures
EMPTY_FETCH_WARN = 0.25  # share of tickers answering with no rows that is worth a flag
COMPACT_AT_RUNS = 4  # price runs not compacted yet that trigger a compaction into yearly parts
COMPACT_AT_PARTS = 64  # ... or this many run parts (a long backfill flushes many)
UNMAPPED_RETRY_DAYS = 28  # an unmapped CUSIP is asked about again after four weeks
REMAP_DAYS = 28  # a held CUSIP OpenFIGI mapped is asked about again after four weeks ...
REMAP_PER_RUN = 2000  # ... at most this many a run (20 requests with a key)
EXIT_REFRESH_QUARTERS = 8  # prices of stocks sold out this recently are still refreshed


# --- securities -------------------------------------------------------------------------------


def stock_of(cusip_map: pl.DataFrame) -> dict[str, int]:
    """CUSIP -> stock id of the mapped rows of `cusip_map`."""
    mapped = cusip_map.filter(pl.col("stock_id").is_not_null())
    return dict(zip(mapped["cusip"].to_list(), mapped["stock_id"].to_list()))


def map_new_cusips(
    lake: Lake, sources: Sources, state: State, today: date, flags: list, budget: Budget
) -> dict | None:
    """Map the share CUSIPs not yet in cusip_map (and the benchmark's), oldest first, and the
    unmapped ones last asked about UNMAPPED_RETRY_DAYS ago or more; give new securities ids,
    sectors and shares outstanding, and mark every fund holding a newly mapped CUSIP for
    recompute. A failed mapping leaves the CUSIPs for the next run, and so does an OpenFIGI job
    answered with an error: such a CUSIP is not recorded (or its old row is kept). Returns the
    counts to log."""
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
    retry_before = today - timedelta(days=UNMAPPED_RETRY_DAYS)
    due = cusip_map.filter(
        pl.col("stock_id").is_null()
        & (pl.col("tried").is_null() | (pl.col("tried") <= retry_before))
    )["cusip"].to_list()
    new += due
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
    errors = mapped.filter(pl.col("method") == ERROR).height
    if errors:
        flags.append({"type": "cusip_mapping_errors", "count": errors})
    mapped = mapped.filter(pl.col("method") != ERROR)

    existing = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    old_max = existing["stock_id"].max() or 0
    securities = assign_stock_ids(mapped, existing).cast(SECURITIES_TABLE_SCHEMA)
    added = securities.filter(pl.col("stock_id") > old_max)
    securities = pl.concat(
        [
            securities.filter(pl.col("stock_id") <= old_max),
            enrich(added, sources, tickers, state, flags, budget),
        ]
    )

    new_map = cusip_rows(mapped, securities, today)
    newly = new_map.filter(pl.col("stock_id").is_not_null())["cusip"].to_list()
    if newly:
        holders = scan(lake, "holdings", HOLDINGS_SCHEMA, pl.col("cusip").is_in(newly))
        state.pending_funds |= {int(c) for c in holders["cik"].unique().to_list()}
    state.save(lake)  # before the map is written, so a crash cannot lose these funds or lookups
    lake.write("securities", securities.sort("stock_id"))
    kept = cusip_map.filter(~pl.col("cusip").is_in(new_map["cusip"].to_list()))
    lake.write("cusip_map", pl.concat([kept, new_map]).sort("cusip"))
    return {"cusips_asked": len(new), "cusips_mapped": len(newly), "securities_added": added.height}


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
    added: pl.DataFrame,
    sources: Sources,
    tickers: pl.DataFrame,
    state: State,
    flags: list,
    budget: Budget,
) -> pl.DataFrame:
    """Company CIK (from the SEC ticker list), SIC code, sector and shares outstanding of new
    securities. A failed lookup is flagged and left empty, and so is every lookup once the time
    budget is spent; those securities go to `state.lookup_retry` for a later run."""
    cik_of = {t: c for t, c in tickers.select("ticker", "cik").iter_rows()}
    rows = []
    for row in added.iter_rows(named=True):
        cik = cik_of.get(normalise_ticker(row["ticker"])) if row["ticker"] else None
        sic = shares = None
        if cik is not None and budget.spent():
            budget.cut("securities")
            state.lookup_retry.add(row["stock_id"])
        elif cik is not None:
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
                state.lookup_retry.add(row["stock_id"])
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


def retry_lookups(
    lake: Lake, sources: Sources, state: State, flags: list, budget: Budget
) -> dict | None:
    """Fetch what earlier runs did not get for the securities of `state.lookup_retry`: the SIC
    code (and so the sector) of a stock without one, and the shares outstanding. A security
    leaves the list once its lookups answer; a failed one is flagged and stays."""
    if not state.lookup_retry:
        return
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    state.lookup_retry &= set(securities["stock_id"].to_list())
    found: dict[int, tuple[int | None, float | None]] = {}
    for row in securities.filter(pl.col("stock_id").is_in(sorted(state.lookup_retry))).iter_rows(
        named=True
    ):
        if budget.spent():
            budget.cut("securities")
            break
        sid, cik = row["stock_id"], row["cik"]
        try:
            needs_sic = row["sic"] is None and not row["is_etf"]
            sic = sources.sic(cik) if needs_sic and cik is not None else row["sic"]
            shares = sources.shares_outstanding(cik) if cik is not None else None
        except FetchError as err:
            flags.append({"type": "security_lookup_failed", "stock_id": sid, "status": err.status})
            continue
        found[sid] = (sic, shares)
    if not found:
        state.save(lake)
        return
    update = pl.DataFrame(
        [(sid, sic, shares) for sid, (sic, shares) in found.items()],
        schema={"stock_id": pl.Int32, "_sic": pl.Int32, "_shares": pl.Float64},
        orient="row",
    )
    securities = (
        securities.join(update, on="stock_id", how="left")
        .with_columns(
            sic=pl.coalesce("_sic", "sic"),
            shares_out=pl.coalesce("_shares", "shares_out"),
        )
        .drop("_sic", "_shares")
    )
    sectors = [
        sector_for_sic(sic, bool(etf))
        for sic, etf in securities.select("sic", "is_etf").iter_rows()
    ]
    securities = securities.with_columns(
        sector=pl.when(pl.col("stock_id").is_in(list(found)))
        .then(pl.Series(sectors, dtype=pl.String))
        .otherwise(pl.col("sector"))
    )
    lake.write("securities", securities.cast(SECURITIES_TABLE_SCHEMA).sort("stock_id"))
    state.lookup_retry -= set(found)  # only once the answers are stored
    state.save(lake)
    return {"lookups_retried": len(found)}


def remap_held_cusips(
    lake: Lake,
    sources: Sources,
    state: State,
    today: date,
    last_q: int,
    flags: list,
    budget: Budget,
) -> dict | None:
    """Ask OpenFIGI again about the CUSIPs held in the latest quarter that it mapped REMAP_DAYS
    ago or more, the longest unasked first, at most REMAP_PER_RUN. A security whose FIGI has a
    new ticker now takes it (stock id and FIGI unchanged) and its whole price history is fetched
    again under it (`state.price_refetch`); one whose FIGI now names another company, or whose
    CUSIP maps to another FIGI now, is flagged and left as it is. A CUSIP OpenFIGI no longer
    knows keeps its mapping; one answered with an error is asked again next run."""
    cusip_map = read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    held = scan(
        lake, "holdings", HOLDINGS_SCHEMA, (pl.col("q") >= last_q) & (pl.col("kind") == "SH")
    )["cusip"].unique()
    due = (
        cusip_map.filter(
            (pl.col("method") == OPENFIGI)
            & pl.col("stock_id").is_not_null()
            & pl.col("cusip").is_in(held.to_list())
            & (pl.col("tried").is_null() | (pl.col("tried") <= today - timedelta(days=REMAP_DAYS)))
        )
        .sort("tried", "cusip", nulls_last=False)
        .head(REMAP_PER_RUN)
    )
    if due.is_empty():
        return
    if budget.spent():
        budget.cut("securities")
        return
    try:
        answers = map_cusips(
            due["cusip"].to_list(), {}, sources.figi, pl.DataFrame(schema=SEC_TICKERS_SCHEMA)
        )
    except FetchError as err:
        flags.append(
            {"type": "cusip_remap_failed", "url": strip_query(err.url), "status": err.status}
        )
        return
    except ValueError as err:
        flags.append({"type": "cusip_remap_failed", "detail": str(err)[:200]})
        return

    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    row_of = {row["stock_id"]: row for row in securities.iter_rows(named=True)}
    stock_of_cusip = dict(due.select("cusip", "stock_id").iter_rows())
    new_tickers: dict[int, str] = {}
    asked = []
    for cusip, figi, ticker, name, method in answers.select(
        "cusip", "figi", "ticker", "name", "method"
    ).iter_rows():
        if method == ERROR:
            continue
        asked.append(cusip)
        stock_id = stock_of_cusip[cusip]
        row = row_of.get(stock_id)
        if method != OPENFIGI or row is None:
            continue
        if figi != row["figi"]:
            flags.append({"type": "figi_changed", "stock_id": stock_id})
            continue
        if ticker and ticker != row["ticker"] and stock_id not in new_tickers:
            new_tickers[stock_id] = ticker
            flags.append(
                {
                    "type": "ticker_changed",
                    "stock_id": stock_id,
                    "old": row["ticker"],
                    "new": ticker,
                }
            )
        if name and row["name"] and normalise_name(name) != normalise_name(row["name"]):
            flags.append({"type": "security_renamed", "stock_id": stock_id, "name": name})
    if new_tickers:
        state.price_refetch |= set(new_tickers)
        state.save(lake)  # before the tickers change, so the history is never left unfetched
        update = pl.DataFrame(
            {"stock_id": list(new_tickers), "_ticker": list(new_tickers.values())},
            schema={"stock_id": pl.Int32, "_ticker": pl.String},
        )
        securities = (
            securities.join(update, on="stock_id", how="left")
            .with_columns(ticker=pl.coalesce("_ticker", "ticker"))
            .drop("_ticker")
        )
        lake.write("securities", securities.cast(SECURITIES_TABLE_SCHEMA).sort("stock_id"))
    cusip_map = cusip_map.with_columns(
        tried=pl.when(pl.col("cusip").is_in(asked)).then(pl.lit(today)).otherwise(pl.col("tried"))
    )
    lake.write("cusip_map", cusip_map.sort("cusip"))
    return {"cusips_remapped": len(asked), "tickers_changed": len(new_tickers)}


def cusip_rows(mapped: pl.DataFrame, securities: pl.DataFrame, tried: date) -> pl.DataFrame:
    """cusip_map rows of `mapped`, asked about on `tried`: each CUSIP's stock id found by the
    security's key, its FIGI, or (without one) the FIGI of a security with its ticker, else its
    ticker, as assign_stock_ids identifies securities."""
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
        rows.append((cusip, stock_id, method, tried))
    return pl.DataFrame(rows, schema=CUSIP_MAP_SCHEMA, orient="row")


# --- prices -------------------------------------------------------------------------------


def held_stocks(lake: Lake, stocks: dict[str, int], since_q: int) -> set[int]:
    """The stocks held (SH rows) in quarter `since_q` or later; `stocks` maps CUSIP -> stock id."""
    rows = scan(
        lake, "holdings", HOLDINGS_SCHEMA, (pl.col("q") >= since_q) & (pl.col("kind") == "SH")
    )
    return {stocks[c] for c in rows["cusip"].unique().to_list() if c in stocks}


def refresh_prices(
    lake: Lake,
    sources: Sources,
    state: State,
    today: date,
    last_q: int,
    run_id: str,
    flags: list,
    budget: Budget,
) -> list[int]:
    """Fetch the prices of the stocks held in the latest quarter, the benchmark, the stocks sold
    out within the last EXIT_REFRESH_QUARTERS quarters (held in one of them), any stock never
    fetched and, from the start of their history, the stocks of `state.price_refetch`. Never
    fetched and refetched stocks come first (so a backfill the time budget cut short goes on
    where it stopped), then the latest quarter's and the benchmark, then the recent exits, so a
    short budget drops those first. Older exits keep their last close. Record the stocks whose
    history changed (and those with new rows, for their weekly file) in the state before anything
    is recomputed from them. Returns the counts to log.

    A price run writes its parts as it goes but reports the changed stocks only at the end, so
    the run is marked in flight while it works. If it dies, the next run takes every stock of its
    parts as changed: more recomputing than needed, but no change is lost."""
    recover_prices_in_flight(lake, state)
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    stocks = stock_of(read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
    known = set(securities["stock_id"].to_list())
    untried = known - state.price_tried
    refetch = state.price_refetch & known
    first = untried | refetch
    latest = held_stocks(lake, stocks, last_q)
    if BENCHMARK_CUSIP in stocks:
        latest.add(stocks[BENCHMARK_CUSIP])
    exits = held_stocks(lake, stocks, last_q - EXIT_REFRESH_QUARTERS) - latest
    ticker_of = dict(securities.select("stock_id", "ticker").iter_rows())
    ordered = sorted(first) + sorted(latest - first) + sorted(exits - first)
    tickers = {sid: ticker_of[sid] for sid in ordered if ticker_of.get(sid)}
    run_part_count = sum(p.startswith("z") for p in lake.parts(PRICES_TABLE))
    if len(price_runs(lake)) >= COMPACT_AT_RUNS or run_part_count >= COMPACT_AT_PARTS:
        compact_prices(lake)
    stats: dict = {}
    state.prices_in_flight = run_id
    state.save(lake)
    changed = update_prices(
        lake,
        sources.prices,
        tickers,
        today,
        run_id=run_id,
        stats=stats,
        should_stop=budget.spent,
        history_until=q_end(q_of_date(today) - 1),  # the open quarter's bars move no fund file
        refetch=refetch,
    )
    if stats["stopped"] == "time budget":
        budget.cut("prices")
    touched = part_stocks(lake, run_parts(lake, run_id))
    failed = {sid for sid, _, _ in stats["failed"]}
    state.pending_stocks |= set(changed)
    state.pending_weekly |= touched | set(changed)
    if stats["stopped"] is None:
        state.price_tried |= set(tickers) - failed
        state.price_refetch -= set(tickers) - failed
    else:  # the run broke off: only stocks that have rows are known to have been fetched
        state.price_tried |= touched
        state.price_refetch -= touched
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
        refresh_shares_outstanding(lake, sources, securities, changed, state, flags, budget)
    return {
        "tickers": len(tickers),
        "fetched": stats["fetched"],
        "empty": stats["empty"],
        "failed": len(failed),
        "changed": len(changed),
    }


def recover_prices_in_flight(lake: Lake, state: State) -> None:
    if state.prices_in_flight is None:
        return
    stocks = part_stocks(lake, run_parts(lake, state.prices_in_flight))
    state.pending_stocks |= stocks
    state.pending_weekly |= stocks
    state.prices_in_flight = None
    state.save(lake)


def refresh_shares_outstanding(
    lake: Lake,
    sources: Sources,
    securities: pl.DataFrame,
    stock_ids: list[int],
    state: State,
    flags: list,
    budget: Budget,
) -> None:
    """A split changes the share count: refetch it for the stocks whose history changed. A failed
    lookup, and every one once the time budget is spent, waits in `state.lookup_retry`."""
    fresh = {}
    for stock_id, cik in (
        securities.filter(pl.col("stock_id").is_in(stock_ids)).select("stock_id", "cik").iter_rows()
    ):
        if cik is None:
            continue
        if budget.spent():
            budget.cut("prices")
            state.lookup_retry.add(stock_id)
            continue
        try:
            shares = sources.shares_outstanding(cik)
        except FetchError as err:
            flags.append(
                {"type": "security_lookup_failed", "stock_id": stock_id, "status": err.status}
            )
            state.lookup_retry.add(stock_id)
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
    state.save(lake)


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
