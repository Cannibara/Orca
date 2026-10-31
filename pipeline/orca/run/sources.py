"""Everything a run fetches, as one injectable bundle (tests and the demo never touch the network)."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import polars as pl

from orca.http import FigiClient
from orca.prices import PriceSource


@dataclass(frozen=True)
class Sources:
    """Everything a run fetches, injectable so tests and the demo never touch the network.

    `download_bulk_zip(url, dest)` writes the ZIP to `dest`; `live_filings(since, until, stats)`
    is `sec.live.fetch_new_filings` on the shared SEC client (it fills stats, including
    `no_index_days`); `figi` is a FigiClient for `securities.map_cusips`; `sic` and
    `shares_outstanding` take a company CIK; `tbill()` is `rf.fetch_tbill`."""

    list_bulk_zips: Callable[[], list[str]]
    download_bulk_zip: Callable[[str, Path], None]
    live_filings: Callable[[date, date, dict], tuple[pl.DataFrame, pl.DataFrame]]
    figi: FigiClient
    sec_tickers: Callable[[], pl.DataFrame]
    sic: Callable[[int], int | None]
    shares_outstanding: Callable[[int], float | None]
    prices: PriceSource
    tbill: Callable[[], dict[int, float]]


def production_sources() -> Sources:
    """Sources on the real services: one shared SEC client (www.sec.gov and data.sec.gov share
    one rate limit), OpenFIGI, Tiingo and FRED. Needs ORCA_CONTACT, TIINGO_KEY and FRED_KEY."""
    from orca.http import figi_client, fred_client, sec_client, tiingo_client
    from orca.prices import TiingoSource
    from orca.rf import fetch_tbill
    from orca.sec.bulk import list_bulk_zips
    from orca.sec.live import fetch_new_filings
    from orca.securities import fetch_shares_outstanding, fetch_sic, load_sec_tickers

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
        prices=TiingoSource(tiingo_client()),
        tbill=lambda: fetch_tbill(fred),
    )
