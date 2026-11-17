"""The price vendor's universe: which tickers Tiingo has daily prices for, and over which dates.

Tiingo publishes the list (supported_tickers.zip, public, no key). It lets a run ask only for
tickers the vendor has, repair tickers that came from a foreign listing ("XLNXEUR" for a delisted
Xilinx: OpenFIGI lists no US line once a stock delists), and skip stocks whose stored history
already reaches the vendor's last date (a delisted stock is then never asked again)."""

import io
import re
import zipfile
from collections.abc import Mapping, Sequence
from datetime import date

import polars as pl

from orca.http import Client
from orca.securities import normalise_ticker

VENDOR_TABLE = "vendor_tickers"  # lake table: each stock's ticker at the vendor, its last day
UNIVERSE_URL = "https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip"
UNIVERSE_SCHEMA = pl.Schema({"ticker": pl.String, "start": pl.Date, "end": pl.Date})
VENDOR_SCHEMA = pl.Schema({"stock_id": pl.Int32, "ticker": pl.String, "end": pl.Date})
# A ticker from a non-US listing carries its currency: "XLNXEUR", "TWTRUSD", "PXGBX" (pence).
CURRENCY_SUFFIXES = (
    "USD", "EUR", "GBP", "GBX", "CHF", "CAD", "JPY", "AUD", "HKD", "SEK", "NOK", "DKK",
)
# A Mexican listing of a US stock ends in "*" ("EA*" for Electronic Arts).
LISTING_MARK = "*"


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


def candidates(ticker: str | None, alternates: Sequence[str] = ()) -> list[str]:
    """The tickers a security may trade under at the vendor, most likely first: its own; without
    a currency suffix or a trailing "*" (OpenFIGI's foreign listings of a delisted US stock);
    either of those without trailing digits ("RTN1USD", "APC3EUR", "LEG1*"); then `alternates`
    (other tickers found for the same security). Each appears once."""
    found = [ticker] if ticker else []
    if ticker:
        stripped = [
            ticker[: -len(suffix)]
            for suffix in CURRENCY_SUFFIXES
            if ticker.endswith(suffix) and len(ticker) > len(suffix)
        ]
        if ticker.endswith(LISTING_MARK) and len(ticker) > 1:
            stripped.append(ticker[:-1])
        found += stripped
        # Digits only go together with a suffix or mark: a plain "HN9" is not cut to "HN".
        found += [base for t in stripped if (base := re.sub(r"\d+$", "", t)) and base != t]
    found += [t for t in alternates if t]
    return list(dict.fromkeys(found))


def resolve(
    tickers: Mapping[int, str | None],
    held: Mapping[int, tuple[date, date]],
    universe: pl.DataFrame,
    alternates: Mapping[int, Sequence[str]] | None = None,
) -> pl.DataFrame:
    """VENDOR_SCHEMA rows: for each stock of `tickers` (stock_id -> ticker), the first of its
    `candidates` (with its `alternates`, stock_id -> other tickers) whose current line at the
    vendor (the one that ends last) overlaps the stock's held span (`held`: stock_id -> first,
    last day; a stock without one takes any span), and that line's last day. Only the current
    line counts: the vendor serves a ticker's prices for whoever trades under it today, so an
    older line of a reused ticker ("APC" for Anadarko, 1986-2019, now another company) would
    bring another company's prices. A stock with no such candidate is left out."""
    alternates = alternates or {}
    current: dict[str, tuple[date, date]] = {}
    for ticker, start, end in universe.iter_rows():
        old = current.get(ticker)
        # The line that ends last; of two ending the same day, the longer (a one-day line on a
        # listing's last day is the same listing).
        if old is None or end > old[1] or (end == old[1] and start < old[0]):
            current[ticker] = (start, end)
    rows = []
    for stock_id, ticker in tickers.items():
        first, last = held.get(stock_id, (date.min, date.max))
        for name in candidates(ticker, alternates.get(stock_id, ())):
            line = current.get(name)
            if line is not None and line[0] <= last and line[1] >= first:
                rows.append((stock_id, name, line[1]))
                break
    return pl.DataFrame(rows, schema=VENDOR_SCHEMA, orient="row")
