"""Market data of a run: the security master (CUSIPs mapped, new securities enriched), daily prices
of the stocks that matter, and the T-bill table."""

import csv
import zipfile
from collections.abc import Iterable
from datetime import date, timedelta
from pathlib import Path

import polars as pl

from orca.http import FetchError
from orca.prices import TABLE as PRICES_TABLE
from orca.prices import (
    HISTORY_START,
    drop_stocks,
    compact_prices,
    fetch_heads,
    first_dates,
    last_dates,
    part_stocks,
    price_runs,
    run_parts,
    split_adjust_prices,
    update_prices,
)
from orca.quarters import q_end, q_of_date, q_start
from orca.rf import FIRST_YEAR
from orca.run.budget import Budget
from orca.run.sources import Sources
from orca.run.state import (
    CUSIP_MAP_SCHEMA,
    MAX_FLAGS_PER_KIND,
    RF_SCHEMA,
    SECURITIES_TABLE_SCHEMA,
    State,
    read_table,
    scan_parts,
    strip_query,
)
from orca.securities import (
    ERROR,
    OPENFIGI,
    SEC_TICKERS_SCHEMA,
    UNLISTED,
    UNMAPPED,
    assign_stock_ids,
    map_cusips,
    map_unlisted,
    normalise_name,
    normalise_ticker,
    sector_for_sic,
    tickers_by_name,
    us_tickers,
)
from orca.storage import Lake
from orca.vendor import REJECTS_SCHEMA, REJECTS_TABLE, VENDOR_SCHEMA, VENDOR_TABLE, resolve

BENCHMARK_CUSIP = "78462F103"  # SPY, the benchmark of the what-if figures
EMPTY_FETCH_WARN = 0.25  # share of tickers answering with no rows that is worth a flag
COMPACT_AT_RUNS = 4  # price runs not compacted yet that trigger a compaction into yearly parts
COMPACT_AT_PARTS = 64  # ... or this many run parts (a long backfill flushes many)
UNMAPPED_RETRY_DAYS = 28  # an unmapped CUSIP is asked about again after four weeks
REMAP_DAYS = 28  # a held CUSIP OpenFIGI mapped is asked about again after four weeks ...
REMAP_PER_RUN = 2000  # ... at most this many a run (20 requests with a key)
# Stocks the vendor has under none of their tickers: their US ticker, delisted ones included, is
# asked of OpenFIGI once (lake table US_TICKERS_TABLE), at most this many a run.
US_TICKERS_TABLE = "figi_us_tickers"
US_TICKERS_SCHEMA = pl.Schema({"stock_id": pl.Int32, "ticker": pl.String, "tried": pl.Date})
US_TICKERS_PER_RUN = 10_000  # 100 requests with a key; the pre-2013 history brings thousands
# More stocks than this losing their vendor ticker in one run means the vendor's list is broken,
# not that tickers were corrected: nothing is dropped and the stored table is kept (flagged).
MAX_VENDOR_LOST = 2000
# Hand-checked vendor tickers for big holdings no rule finds (a company renamed or moved under a
# new parent): cusip -> ticker. Tried first among the alternates, and still only over the days
# the vendor lists the ticker.
TICKER_OVERRIDES_CSV = Path(__file__).parent.parent / "ticker_overrides.csv"


def ticker_overrides() -> dict[str, str]:
    with TICKER_OVERRIDES_CSV.open(newline="") as f:
        return {row["cusip"]: normalise_ticker(row["ticker"]) for row in csv.DictReader(f)}
# Prices of stocks sold out this recently are still refreshed: an exit's `one_y` needs the close
# four quarters after the sale, so the sale's quarter, four more and one to spare.
EXIT_REFRESH_QUARTERS = 6
# The price refresh stops while this much of the budget is left (at most a third of it), so the
# funds are always computed and published; the stocks it did not reach go first next run.
PRICES_RESERVE_MIN = 90.0


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
    # A CUSIP first held before 2013 that OpenFIGI does not find is usually a company gone since:
    # it is asked again with delisted securities included, never matched by name (old General
    # Motors' name is new GM's, and would merge the two).
    before = set(held.filter(pl.col("q") < 0)["cusip"].to_list())
    unlisted_figis: set[str] = set()
    try:
        tickers = sources.sec_tickers()
        issuers = issuer_names(lake, [c for c in new if c not in before])
        mapped = map_cusips(new, issuers, sources.figi, tickers)
        gone = mapped.filter((pl.col("method") == UNMAPPED) & pl.col("cusip").is_in(before))
        if gone.height:
            again = map_unlisted(gone["cusip"].to_list(), sources.figi)
            mapped = pl.concat([mapped.filter(~pl.col("cusip").is_in(gone["cusip"].to_list())), again])
            unlisted_figis = set(again.filter(pl.col("method") == UNLISTED)["figi"].to_list())
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
            enrich(added, sources, tickers, state, flags, budget, unlisted_figis),
        ]
    )

    new_map = cusip_rows(mapped, securities, today)
    newly = new_map.filter(pl.col("stock_id").is_not_null())["cusip"].to_list()
    if newly:
        holders = scan_parts(  # the funds only, a part at a time: a first mapping is most rows
            lake,
            "holdings",
            lambda f: f.filter(pl.col("cusip").is_in(newly)).select("cik").unique(),
        )
        state.pending_funds |= {int(c) for frame in holders for c in frame["cik"].to_list()}
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
    no_cik: frozenset[str] | set[str] = frozenset(),
) -> pl.DataFrame:
    """Company CIK (from the SEC ticker list), SIC code, sector and shares outstanding of new
    securities. A failed lookup is flagged and left empty, and so is every lookup once the time
    budget is spent; those securities go to `state.lookup_retry` for a later run. Securities whose
    FIGI is in `no_cik` (companies gone since: today's holder of their old ticker is someone
    else) get no CIK and so no lookups."""
    cik_of = {t: c for t, c in tickers.select("ticker", "cik").iter_rows()}
    rows = []
    for row in added.iter_rows(named=True):
        known = row["ticker"] and row["figi"] not in no_cik
        cik = cik_of.get(normalise_ticker(row["ticker"])) if known else None
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
    held = pl.Series(
        "cusip",
        sorted(
            {
                c
                for frame in scan_parts(
                    lake,
                    "holdings",
                    lambda f: f.filter((pl.col("q") >= last_q) & (pl.col("kind") == "SH"))
                    .select("cusip")
                    .unique(),
                )
                for c in frame["cusip"].to_list()
            }
        ),
        dtype=pl.String,
    )
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
    """The stocks held (SH rows) in quarter `since_q` or later; `stocks` maps CUSIP -> stock id.
    Reads one part at a time and keeps only its distinct CUSIPs."""
    frames = scan_parts(
        lake,
        "holdings",
        lambda f: f.filter((pl.col("q") >= since_q) & (pl.col("kind") == "SH"))
        .select("cusip")
        .unique(),
    )
    cusips = {c for frame in frames for c in frame["cusip"].to_list()}
    return {stocks[c] for c in cusips if c in stocks}


def held_spans(lake: Lake, stocks: dict[str, int]) -> dict[int, tuple[date, date]]:
    """Each held stock's first and last day held: from the start of the first quarter it was
    held in (SH rows) to the end of the last. A stock also held from 2013 on counts from 2013
    only: the pre-2013 history must not cost a stock today's ticker (a ticker's current line
    often begins after a company's first 13F quarters), and before its line began a stock has
    no vendor prices anyway. A stock held only before 2013 counts over all of it."""
    frames = scan_parts(
        lake,
        "holdings",
        lambda f: f.filter(pl.col("kind") == "SH")
        .group_by("cusip")
        .agg(
            first=pl.col("q").min(),
            first_recent=pl.col("q").filter(pl.col("q") >= 0).min(),
            last=pl.col("q").max(),
        ),
    )
    spans: dict[int, tuple[int, int | None, int]] = {}
    for frame in frames:
        for cusip, first, first_recent, last in frame.iter_rows():
            if (stock_id := stocks.get(cusip)) is None:
                continue
            old = spans.get(stock_id, (first, first_recent, last))
            recent = [q for q in (old[1], first_recent) if q is not None]
            spans[stock_id] = (min(old[0], first), min(recent, default=None), max(old[2], last))
    return {
        sid: (q_start(first if recent is None else recent), q_end(last))
        for sid, (first, recent, last) in spans.items()
    }


def resolve_vendor_tickers(
    lake: Lake, sources: Sources, state: State, today: date, flags: list, budget: Budget
) -> dict | None:
    """Rewrite VENDOR_TABLE from the vendor's universe: each stock's ticker there if the vendor
    lists it over the days the stock was held, and the vendor's last day. Tried in order: the
    security's own ticker and its repairs (`vendor.candidates`), then, for a stock still without
    one, the SEC ticker of the same company name and the US ticker OpenFIGI gives its CUSIP
    with delisted listings included (`alternate_tickers`). A stock missing from the table is not
    asked for. A stock whose vendor ticker differs from the one its prices were fetched under has
    its history fetched again (`state.price_refetch`). Without a universe (none configured, or
    the download failed: flagged) the stored table stays as it is."""
    if sources.price_universe is None:
        return None
    try:
        universe = sources.price_universe()
    except FetchError as err:
        flags.append(
            {"type": "price_universe_failed", "url": strip_query(err.url), "status": err.status}
        )
        return None
    except (zipfile.BadZipFile, ValueError, KeyError, pl.exceptions.PolarsError) as err:
        flags.append({"type": "price_universe_failed", "detail": str(err)[:200]})  # keep the table
        return None
    if universe.is_empty():
        flags.append({"type": "price_universe_failed", "detail": "the universe is empty"})
        return None
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA)
    cusip_map = read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA)
    stocks = stock_of(cusip_map)
    tickers = dict(securities.select("stock_id", "ticker").iter_rows())
    spans = held_spans(lake, stocks)
    gone = set(cusip_map.filter(pl.col("method") == UNLISTED)["stock_id"].drop_nulls().to_list())
    rejected: dict[int, set[str]] = {}
    for sid, ticker in read_table(lake, REJECTS_TABLE, REJECTS_SCHEMA).select("stock_id", "ticker").iter_rows():
        rejected.setdefault(sid, set()).add(ticker)
    resolved = resolve(tickers, spans, universe, gone=gone, rejected=rejected)
    missing = set(tickers) - set(resolved["stock_id"].to_list())
    old_only = {sid for sid, (_, last) in spans.items() if last < q_start(0)}
    alternates, counts = alternate_tickers(
        lake, sources, securities, cusip_map, missing, today, flags, budget, old_only
    )
    if alternates:
        resolved = resolve(tickers, spans, universe, alternates, gone=gone, rejected=rejected)
    # The ticker each stock's stored prices were fetched under: its vendor ticker of the last
    # run, else (a stock new to the table, or the first run with one) the security's own.
    stored = read_table(lake, VENDOR_TABLE, VENDOR_SCHEMA)
    before = dict(stored.select("stock_id", "ticker").iter_rows())
    moved = {
        sid
        for sid, ticker in resolved.select("stock_id", "ticker").iter_rows()
        if ticker != before.get(sid, tickers.get(sid))
    }
    # Stocks the vendor no longer has under any ticker for their held days: what was stored
    # came under a ticker that is not theirs (an older line of a reused ticker), and goes.
    lost = set(before) - set(resolved["stock_id"].to_list())
    if len(lost) > MAX_VENDOR_LOST:  # a broken universe, not a correction: keep everything
        flags.append({"type": "vendor_tickers_lost", "count": len(lost)})
        return None
    if moved or lost:
        # The stored bars of a moved or lost stock are another ticker's: drop them all, so a
        # day the new ticker does not cover keeps no stale bar. Owed first, then dropped.
        state.price_refetch |= moved
        state.pending_stocks |= moved | lost
        state.pending_weekly |= moved | lost
        state.save(lake)  # before the table, so a history under the old ticker is never kept
        dropped = drop_stocks(lake, moved | lost)
        counts["vendor_bars_dropped"] = dropped
    lake.write(VENDOR_TABLE, resolved.sort("stock_id"))
    return {
        "vendor_tickers": resolved.height,
        "no_vendor": len(tickers) - resolved.height,
        "vendor_ticker_changed": len(moved),
        "vendor_ticker_lost": len(lost),
        **counts,
    }


def _plain(ticker: str | None) -> bool:
    """A share's ticker; OpenFIGI names a bond or an option with spaces ("ORCL 6-5 01-15-29 D"),
    and those must never borrow a share's prices."""
    return bool(ticker) and " " not in ticker


def alternate_tickers(
    lake: Lake,
    sources: Sources,
    securities: pl.DataFrame,
    cusip_map: pl.DataFrame,
    missing: set[int],
    today: date,
    flags: list,
    budget: Budget,
    old_only: set[int] = frozenset(),
) -> tuple[dict[int, list[str]], dict]:
    """Other tickers for the `missing` stocks (no vendor ticker from their own): the hand-checked
    `ticker_overrides`, then, for those that look like shares: stock_id -> [SEC ticker of the same normalised name (exactly one SEC row; not for
    a ticker with "-"), OpenFIGI US ticker]. OpenFIGI is asked (`securities.us_tickers`) only about a stock it has not been
    asked about, by the first of its CUSIPs, at most US_TICKERS_PER_RUN a run, and the answer
    (a ticker, or none) is kept in US_TICKERS_TABLE. A failed SEC or OpenFIGI call is flagged and
    leaves that source out this run. Returns the alternates and counts to log."""
    rows = securities.filter(pl.col("stock_id").is_in(list(missing)))
    tickers_of = {
        sid: ticker
        for sid, ticker in rows.select("stock_id", "ticker").iter_rows()
        if _plain(ticker)
    }
    shares = {
        sid: name
        for sid, name in rows.select("stock_id", "name").iter_rows()
        if sid in tickers_of
    }
    alternates: dict[int, list[str]] = {}
    counts = {"alt_by_name": 0, "alt_us_asked": 0}
    stock_of_cusip = stock_of(cusip_map)
    for cusip, ticker in ticker_overrides().items():
        if (sid := stock_of_cusip.get(cusip)) in missing:
            alternates.setdefault(sid, []).append(ticker)
    if not shares:
        return alternates, counts
    # By name only for a plain common share: a warrant, unit or preferred ("XYZ-WS", "XYZ-PA")
    # carries its company's name too, and would take the common stock's prices. Never for a
    # company gone since (UNLISTED) or one held only before 2013 (`old_only`): its name may be
    # today's namesake's (old GM and new GM; "AT&T Corp" and "AT&T Inc" both read "AT T").
    gone = set(cusip_map.filter(pl.col("method") == UNLISTED)["stock_id"].drop_nulls().to_list())
    gone |= old_only
    named = {
        sid: name for sid, name in shares.items() if "-" not in tickers_of[sid] and sid not in gone
    }
    try:
        by_name = tickers_by_name(named, sources.sec_tickers()) if named else {}
    except FetchError as err:
        flags.append({"type": "sec_tickers_failed", "url": strip_query(err.url), "status": err.status})
        by_name = {}
    for sid, ticker in by_name.items():
        alternates.setdefault(sid, []).append(ticker)
    counts["alt_by_name"] = len(by_name)

    asked = read_table(lake, US_TICKERS_TABLE, US_TICKERS_SCHEMA)
    known = set(asked["stock_id"].to_list())
    cusip_of: dict[int, str] = {}
    for cusip, sid, method in cusip_map.sort("cusip").select("cusip", "stock_id", "method").iter_rows():
        if sid is not None and method in (OPENFIGI, UNLISTED):
            cusip_of.setdefault(sid, cusip)
    due = sorted(sid for sid in shares if sid not in known and sid in cusip_of)[:US_TICKERS_PER_RUN]
    if due and not budget.spent():
        try:
            answers = us_tickers(sources.figi, [cusip_of[sid] for sid in due])
        except FetchError as err:
            flags.append({"type": "us_tickers_failed", "url": strip_query(err.url), "status": err.status})
            answers = None
        except ValueError as err:
            flags.append({"type": "us_tickers_failed", "detail": str(err)[:200]})
            answers = None
        if answers is not None:
            new = [(sid, answers[cusip_of[sid]], today) for sid in due if cusip_of[sid] in answers]
            asked = pl.concat(
                [asked, pl.DataFrame(new, schema=US_TICKERS_SCHEMA, orient="row")]
            ).cast(US_TICKERS_SCHEMA)
            lake.write(US_TICKERS_TABLE, asked.sort("stock_id"))
            counts["alt_us_asked"] = len(new)
    for sid, ticker in asked.select("stock_id", "ticker").iter_rows():
        if sid in shares and ticker:
            alternates.setdefault(sid, []).append(ticker)
    return alternates, counts


def refresh_prices(
    lake: Lake,
    sources: Sources,
    state: State,
    today: date,
    last_q: int,
    run_id: str,
    flags: list,
    budget: Budget,
) -> dict:
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
    vendor = read_table(lake, VENDOR_TABLE, VENDOR_SCHEMA)
    if vendor.height:  # only what the vendor has, under its ticker
        ticker_of = dict(vendor.select("stock_id", "ticker").iter_rows())
        vendor_end = dict(vendor.select("stock_id", "end").iter_rows())
    else:
        ticker_of = dict(securities.select("stock_id", "ticker").iter_rows())
        vendor_end = {}
    last = last_dates(lake)

    def complete(sid: int) -> bool:
        # Stored up to the vendor's last day (a delisted stock, or one already fetched this week).
        return sid not in refetch and sid in last and last[sid] >= vendor_end.get(sid, date.max)

    def stalest_first(ids: set[int]) -> list[int]:
        # Those whose prices are oldest first (so a refresh cut short goes on with what it
        # missed), then those the vendor had no rows for.
        return sorted(ids, key=lambda sid: (sid not in last, last.get(sid, date.max), sid))

    ordered = sorted(first) + stalest_first(latest - first) + stalest_first(exits - first)
    wanted = [sid for sid in ordered if ticker_of.get(sid)]
    tickers = {sid: ticker_of[sid] for sid in wanted if not complete(sid)}
    run_part_count = sum(p.startswith("z") for p in lake.parts(PRICES_TABLE))
    if len(price_runs(lake)) >= COMPACT_AT_RUNS or run_part_count >= COMPACT_AT_PARTS:
        compact_prices(lake)
    reserve = min(PRICES_RESERVE_MIN, budget.minutes / 3)
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
        should_stop=lambda: budget.minutes_left() <= reserve,
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
    else:  # the run broke off: the stocks that answered (with rows or none) were fetched
        done = touched | set(stats["answered"])
        state.price_tried |= done
        state.price_refetch -= done
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
        "complete": len(wanted) - len(tickers),
        "no_vendor": len(set(ordered)) - len(wanted),
        "fetched": stats["fetched"],
        "empty": stats["empty"],
        "failed": len(failed),
        "changed": len(changed),
    }


def backfill_price_heads(
    lake: Lake,
    sources: Sources,
    state: State,
    run_id: str,
    flags: list,
    budget: Budget,
    reserve: float | None = None,
) -> dict | None:
    """Fetch the older bars of the stocks held before 2013 whose stored history begins after
    they were first held (histories began in 2013 until the 13F history reached back to 1999):
    only the missing range, each stock once (`state.price_backfilled`), until `reserve` minutes
    of the budget are left (default: the price stage's). Their funds and weekly files are owed a
    recompute; today's share counts are unchanged (a split before 2013 is in them already).
    Returns the counts to log."""
    recover_prices_in_flight(lake, state)  # a run that died mid-fetch: its stocks are owed first
    stocks = stock_of(read_table(lake, "cusip_map", CUSIP_MAP_SCHEMA))
    firsts = scan_parts(
        lake,
        "holdings",
        lambda f: f.filter((pl.col("kind") == "SH") & (pl.col("q") < 0))
        .group_by("cusip")
        .agg(pl.col("q").min()),
    )
    first_held: dict[int, int] = {}
    for frame in firsts:
        for cusip, q in frame.iter_rows():
            if (sid := stocks.get(cusip)) is not None:
                first_held[sid] = min(q, first_held.get(sid, q))
    vendor = read_table(lake, VENDOR_TABLE, VENDOR_SCHEMA)
    ticker_of = dict(vendor.select("stock_id", "ticker").iter_rows())
    stored = first_dates(lake)
    slack = timedelta(days=7)  # a quarter's first trading day can be a few days in
    heads = {
        sid: (ticker_of[sid], stored[sid])
        for sid in sorted(first_held)
        if sid in ticker_of
        and sid in stored
        and sid not in state.price_backfilled
        and stored[sid] > max(HISTORY_START, q_start(first_held[sid])) + slack
    }
    if not heads:
        return None
    if reserve is None:
        reserve = min(PRICES_RESERVE_MIN, budget.minutes / 3)
    stats: dict = {}
    state.prices_in_flight = run_id  # its parts hold changes until they are recorded below
    state.save(lake)
    changed = fetch_heads(
        lake,
        sources.prices,
        heads,
        run_id,
        stats=stats,
        should_stop=lambda: budget.minutes_left() <= reserve,
    )
    if stats["stopped"] == "time budget":
        budget.cut("price history")
    state.pending_stocks |= set(changed)
    state.pending_weekly |= set(changed)
    state.price_backfilled |= set(stats["answered"])
    state.prices_in_flight = None
    state.save(lake)
    if stats["failed"] or (stats["stopped"] and stats["stopped"] != "time budget"):
        flags.append(
            {
                "type": "price_history",
                "failed": sorted(sid for sid, _, _ in stats["failed"])[:MAX_FLAGS_PER_KIND],
                "failed_count": len(stats["failed"]),
                "stopped": stats["stopped"],
            }
        )
    return {
        "owed": len(heads),
        "fetched": stats["fetched"],
        "empty": stats["empty"],
        "failed": len(stats["failed"]),
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


LATEST_CLOSE_WINDOW_DAYS = 14  # a stock's latest close is looked for this close to its last bar


def latest_closes(lake: Lake) -> dict[int, tuple[date, float]]:
    """Each stock's latest stored close and its date (raw = today's basis: no split after it),
    among its bars of the last LATEST_CLOSE_WINDOW_DAYS before its last stored day. Only those
    bars are read, a part at a time: the whole table (tens of millions of bars) does not fit in
    the runner's memory next to the funds' results."""
    lasts = scan_parts(
        lake, PRICES_TABLE, lambda f: f.group_by("stock_id").agg(last=pl.col("date").max())
    )
    if not lasts:
        return {}
    last = pl.concat(lasts).group_by("stock_id").agg(pl.col("last").max())
    frames = scan_parts(
        lake,
        PRICES_TABLE,
        lambda f: f.select("stock_id", "date", "close")
        .join(last.lazy(), on="stock_id", maintain_order="left")  # keep the part's row order
        .filter(pl.col("date") >= pl.col("last").dt.offset_by(f"-{LATEST_CLOSE_WINDOW_DAYS}d"))
        .drop("last"),
    )
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
    """The T-bill table, refetched when the latest quarter moves on (or on a full run, after a
    failure, or when the stored table starts after `rf.FIRST_YEAR`): Sharpe and Sortino of every
    fund depend on it, so a new table is written only after a recompute of every fund is recorded
    as owed (`pending_all`)."""
    stored = rf_table(lake)
    short = bool(stored) and min(stored) > FIRST_YEAR  # a table from before the history began in 1999
    if stored and not (full or short or state.rf_stale or state.last_q != last_q):
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
