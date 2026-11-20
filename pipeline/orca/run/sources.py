"""Everything a run fetches, in one injectable bundle (tests and the demo use no network)."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import polars as pl

from orca.famous import Famous, SearchScores, load_ranked_famous, load_search
from orca.http import FigiClient
from orca.prices import PriceSource
from orca.sec.about import About


@dataclass(frozen=True)
class Sources:
    """Everything a run fetches, injectable so tests and the demo never touch the network.

    `download_bulk_zip(url, dest)` writes the ZIP to `dest`; `live_filings(since, until, stats)`
    is `sec.live.fetch_new_filings` on the shared SEC client (it fills stats, including
    `no_index_days`); `figi` is a FigiClient for `securities.map_cusips`; `sic` and
    `shares_outstanding` take a company CIK; `tbill()` is `rf.fetch_tbill`; `price_universe()`
    is `vendor.load_universe` (None: no universe, every held stock is asked for); `famous()` is
the Famous funds list (famous.csv in the order of famous_rank.csv; the demo lists its own funds) and `search()` their Google
Trends scores (famous_search.csv, a snapshot; the demo has its own). `legacy_quarter(key, skip,
stats)` is `sec.legacy.fetch_quarter` on the shared SEC client (None: no pre-2013 source);
`fund_about(cik)` is `sec.about.fetch_about` on it (the demo serves its own fictional records)."""

    list_bulk_zips: Callable[[], list[str]]
    download_bulk_zip: Callable[[str, Path], None]
    live_filings: Callable[[date, date, dict], tuple[pl.DataFrame, pl.DataFrame]]
    figi: FigiClient
    sec_tickers: Callable[[], pl.DataFrame]
    sic: Callable[[int], int | None]
    shares_outstanding: Callable[[int], float | None]
    prices: PriceSource
    tbill: Callable[[], dict[int, float]]
    price_universe: Callable[[], pl.DataFrame] | None = None
    famous: Callable[[], tuple[Famous, ...]] = load_ranked_famous
    search: Callable[[], SearchScores] = load_search
    legacy_quarter: (
        Callable[[str, set[str], dict], tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]] | None
    ) = None
    shares_history: Callable[[int], list] | None = None  # None: the share-count history is not kept
    # A fund's SEC facts for the About tab (`sec.about.fetch_about`); None: not looked up.
    fund_about: Callable[[int], About | None] | None = None


def production_sources() -> Sources:
    """Sources on the real services: one shared SEC client (www.sec.gov and data.sec.gov share
    one rate limit), OpenFIGI, Tiingo and FRED. Needs ORCA_CONTACT, TIINGO_KEY and FRED_KEY."""
    from orca.http import Client, figi_client, fred_client, sec_client, tiingo_client
    from orca.prices import TiingoSource
    from orca.rf import fetch_tbill
    from orca.sec.about import fetch_about
    from orca.sec.bulk import list_bulk_zips
    from orca.sec.legacy import fetch_quarter
    from orca.sec.live import fetch_new_filings
    from orca.securities import (
        fetch_shares_history,
        fetch_shares_outstanding,
        fetch_sic,
        load_sec_tickers,
    )
    from orca.vendor import load_universe

    sec, fred = sec_client(), fred_client()

    def download(url: str, dest: Path) -> None:
        Path(dest).write_bytes(sec.get(url).content)

    return Sources(
        list_bulk_zips=lambda: list_bulk_zips(sec),
        download_bulk_zip=download,
        live_filings=lambda since, until, stats: fetch_new_filings(sec, since, until, stats),
        figi=figi_client(),
        sec_tickers=lambda: load_sec_tickers(sec),
        sic=lambda cik: fetch_sic(sec, cik),
        shares_outstanding=lambda cik: fetch_shares_outstanding(sec, cik),
        shares_history=lambda cik: fetch_shares_history(sec, cik),
        fund_about=lambda cik: fetch_about(sec, cik),
        prices=TiingoSource(tiingo_client()),
        tbill=lambda: fetch_tbill(fred),
        price_universe=lambda: load_universe(Client(1.0, {})),  # a public file: no key
        legacy_quarter=lambda key, skip, stats: fetch_quarter(sec, key, skip, stats),
    )
