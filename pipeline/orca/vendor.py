"""The price vendor's universe: which tickers Tiingo has daily prices for, and over which dates.

Tiingo publishes the list (supported_tickers.zip, public, no key). It lets a run ask only for
tickers the vendor has, repair tickers that came from a foreign listing ("XLNXEUR" for a delisted
Xilinx: OpenFIGI lists no US line once a stock delists), and skip stocks whose stored history
already reaches the vendor's last date (a delisted stock is then never asked again)."""

import io
import zipfile
from collections.abc import Mapping
from datetime import date

import polars as pl

from orca.http import Client
from orca.securities import normalise_ticker

VENDOR_TABLE = "vendor_tickers"  # lake table: each stock's ticker at the vendor, its last day
UNIVERSE_URL = "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip"
UNIVERSE_SCHEMA = pl.Schema({"ticker": pl.String, "start": pl.Date, "end": pl.Date})
VENDOR_SCHEMA = pl.Schema({"stock_id": pl.Int32, "ticker": pl.String, "end": pl.Date})
# A ticker from a non-US listing carries its currency: "XLNXEUR", "TWTRUSD".
CURRENCY_SUFFIXES = ("USD", "EUR", "GBP", "CHF", "CAD", "JPY", "AUD", "HKD", "SEK", "NOK", "DKK")


def load_universe(client: Client) -> pl.DataFrame:
    """The vendor's USD tickers with prices: ticker (SEC style), first and last date. A ticker
    listed more than once (reused by a later company) keeps every line."""
    archive = zipfile.ZipFile(io.BytesIO(client.get(UNIVERSE_URL).content))
    [name] = [n for n in archive.namelist() if n.endswith(".csv")]
    return parse_universe(archive.read(name))


def parse_universe(csv_bytes: bytes) -> pl.DataFrame:
    raw = pl.read_csv(io.BytesIO(csv_bytes), infer_schema=False)
    return (
        raw.filter(
            (pl.col("priceCurrency") == "USD")
            & pl.col("startDate").is_not_null()
            & pl.col("endDate").is_not_null()
        )
        .select(
            pl.col("ticker").map_elements(normalise_ticker, return_dtype=pl.String),
            pl.col("startDate").str.to_date(strict=False).alias("start"),
            pl.col("endDate").str.to_date(strict=False).alias("end"),
        )
        .drop_nulls()
        .cast(UNIVERSE_SCHEMA)
    )


def candidates(ticker: str | None) -> list[str]:
    """The tickers a security may trade under at the vendor: its own, then without a currency
    suffix."""
    if not ticker:
        return []
    found = [ticker]
    for suffix in CURRENCY_SUFFIXES:
        if ticker.endswith(suffix) and len(ticker) > len(suffix):
            found.append(ticker[: -len(suffix)])
    return found


def resolve(
    tickers: Mapping[int, str | None],
    held: Mapping[int, tuple[date, date]],
    universe: pl.DataFrame,
) -> pl.DataFrame:
    """VENDOR_SCHEMA rows: for each stock of `tickers` (stock_id -> ticker), the first of its
    `candidates` the vendor lists over a span that overlaps the stock's held span (`held`:
    stock_id -> first, last day; a stock without one takes any span), and the last day of the
    vendor's prices for it. A stock with no such candidate is left out: the vendor has nothing."""
    spans: dict[str, list[tuple[date, date]]] = {}
    for ticker, start, end in universe.iter_rows():
        spans.setdefault(ticker, []).append((start, end))
    rows = []
    for stock_id, ticker in tickers.items():
        first, last = held.get(stock_id, (date.min, date.max))
        for name in candidates(ticker):
            ends = [end for start, end in spans.get(name, []) if start <= last and end >= first]
            if ends:
                rows.append((stock_id, name, max(ends)))
                break
    return pl.DataFrame(rows, schema=VENDOR_SCHEMA, orient="row")
