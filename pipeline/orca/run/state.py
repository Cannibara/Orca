"""The lake's tables and the state runs hand on to each other: table schemas, part scans, the
pending work in state.json, the last publish's files, and the stored fund state codec."""

import json
import os
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, fields, is_dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import polars as pl

from orca.engine.metrics import Performance
from orca.engine.position import Trade
from orca.home import ConvictionQuarter, FundSnapshot
from orca.publish import FundMeta, read_manifest
from orca.sec.live import FILINGS_SCHEMA
from orca.securities import SECURITIES_SCHEMA
from orca.storage import Lake

MAX_FLAGS_PER_KIND = 100  # health lists at most this many findings of one kind

RAW_SCHEMA = pl.Schema(
    {
        "accession": pl.String,
        "cusip": pl.String,
        "issuer": pl.String,
        "title": pl.String,
        "shares": pl.Float64,
        "sh_type": pl.String,
        "put_call": pl.String,
        "value_usd": pl.Float64,
        "source": pl.String,
    }
)
SECURITIES_TABLE_SCHEMA = pl.Schema(
    {
        **SECURITIES_SCHEMA,
        "cik": pl.Int64,
        "sic": pl.Int32,
        "sector": pl.String,
        "shares_out": pl.Float64,
    }
)
# `tried`: when OpenFIGI was last asked about the CUSIP (null in a lake from before it was kept).
CUSIP_MAP_SCHEMA = pl.Schema(
    {"cusip": pl.String, "stock_id": pl.Int32, "method": pl.String, "tried": pl.Date}
)
REPORTS_SCHEMA = FILINGS_SCHEMA
FUND_STATE_SCHEMA = pl.Schema({"cik": pl.Int64, "meta": pl.String, "snap": pl.String})
FUND_STATE_RUN = "fund_state_run"  # this run's fund state, one part per batch, until merged
RF_SCHEMA = pl.Schema({"year": pl.Int32, "rate": pl.Float64})


# --- scans --------------------------------------------------------------------------------


def part_name(q: int) -> str:
    """The part of a per-quarter table that holds quarter `q`."""
    return f"q{q:03d}"


def part_paths(lake: Lake, table: str) -> list[Path]:
    return [lake.root / table / f"{part}.parquet" for part in lake.parts(table)]


def scan_parts(
    lake: Lake, table: str, query: Callable[[pl.LazyFrame], pl.LazyFrame] | None = None
) -> list[pl.DataFrame]:
    """`query` run on each part of `table` in part order, one part at a time and lazily, so only
    what the query keeps is ever read; the parts' results, empty ones included."""
    frames = []
    for path in part_paths(lake, table):
        frame = pl.scan_parquet(path)
        frames.append((frame if query is None else query(frame)).collect())
    return frames


def scan(lake: Lake, table: str, schema: pl.Schema, where: pl.Expr | None = None) -> pl.DataFrame:
    """The rows of every part of `table` that match `where`, in part order."""
    frames = scan_parts(lake, table, None if where is None else lambda f: f.filter(where))
    if not frames:
        return pl.DataFrame(schema=schema)
    return pl.concat(frames, how="vertical_relaxed").cast(schema)


def read_table(lake: Lake, table: str, schema: pl.Schema) -> pl.DataFrame:
    """`table` in `schema`; a column the stored table predates comes back null."""
    frame = lake.read(table)
    if frame.is_empty():
        return pl.DataFrame(schema=schema)
    missing = [
        pl.lit(None, dtype).alias(name)
        for name, dtype in schema.items()
        if name not in frame.columns
    ]
    return frame.with_columns(missing).cast(schema)


def drop_parts(lake: Lake, table: str) -> None:
    """Delete every part of `table`."""
    for path in part_paths(lake, table):
        path.unlink(missing_ok=True)


def chunks(items: list, size: int) -> Iterator[list]:
    """`items` in consecutive lists of `size` (the last one shorter)."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


def write_json_atomic(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def strip_query(url: str) -> str:
    """`url` without its query string or fragment (a FRED url carries the API key)."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


# --- state.json ---------------------------------------------------------------------------


@dataclass
class State:
    """What runs hand on to each other (lake/state.json). The pending sets (and `pending_all`, a
    recompute of every fund owed by a rebuild or a new T-bill table) are added to before the work
    that needs them is attempted and cleared only after a successful publish. `prices_in_flight`
    names a price run that has not finished: its parts may hold changes nobody has recorded.
    `lookup_retry` holds securities whose SIC code or shares outstanding are still to be fetched
    (a lookup that failed or that the time budget cut off); `price_refetch` the stocks whose
    whole price history is to be fetched again (their ticker changed)."""

    live_watermark: date | None = None
    last_q: int | None = None
    pending_funds: set[int] = field(default_factory=set)
    pending_stocks: set[int] = field(default_factory=set)
    pending_weekly: set[int] = field(default_factory=set)
    price_tried: set[int] = field(default_factory=set)
    rf_stale: bool = False
    pending_all: bool = False
    prices_in_flight: str | None = None
    lookup_retry: set[int] = field(default_factory=set)
    price_refetch: set[int] = field(default_factory=set)

    @staticmethod
    def path(lake: Lake) -> Path:
        return lake.root / "state.json"

    @classmethod
    def load(cls, lake: Lake) -> "State":
        path = cls.path(lake)
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text())
        watermark = raw.get("live_watermark")
        return cls(
            live_watermark=date.fromisoformat(watermark) if watermark else None,
            last_q=raw.get("last_q"),
            pending_funds=set(raw.get("pending_funds", [])),
            pending_stocks=set(raw.get("pending_stocks", [])),
            pending_weekly=set(raw.get("pending_weekly", [])),
            price_tried=set(raw.get("price_tried", [])),
            rf_stale=bool(raw.get("rf_stale", False)),
            pending_all=bool(raw.get("pending_all", False)),
            prices_in_flight=raw.get("prices_in_flight"),
            lookup_retry=set(raw.get("lookup_retry", [])),
            price_refetch=set(raw.get("price_refetch", [])),
        )

    def save(self, lake: Lake) -> None:
        write_json_atomic(
            self.path(lake),
            {
                "live_watermark": self.live_watermark.isoformat() if self.live_watermark else None,
                "last_q": self.last_q,
                "pending_funds": sorted(self.pending_funds),
                "pending_stocks": sorted(self.pending_stocks),
                "pending_weekly": sorted(self.pending_weekly),
                "price_tried": sorted(self.price_tried),
                "rf_stale": self.rf_stale,
                "pending_all": self.pending_all,
                "prices_in_flight": self.prices_in_flight,
                "lookup_retry": sorted(self.lookup_retry),
                "price_refetch": sorted(self.price_refetch),
            },
        )


def published_path(lake: Lake) -> Path:
    return lake.root / "published.json"


def load_published(lake: Lake, out_root: Path, compressed: bool = True) -> dict[str, str]:
    """The files of the last successful publish: the lake's copy (it travels with the lake; a
    weekly run first makes it match the site's manifest, so an upload that never happened is not
    taken as done), else the manifest in `out_root`."""
    path = published_path(lake)
    if path.exists():
        return json.loads(path.read_text())
    return (
        read_manifest(out_root, compressed) if (Path(out_root) / "manifest.json").exists() else {}
    )


# --- stored fund state (what unchanged funds contribute to the shared files) ---------------------


# The stored fund state is JSON written field by field from the dataclasses, so a field added to
# FundMeta or FundSnapshot (or Trade, Performance) is kept, and a removed one fails loudly.
_STORED_TYPES = {
    cls.__name__: cls for cls in (FundMeta, FundSnapshot, ConvictionQuarter, Trade, Performance)
}
# Fields stored snapshots may still hold that the dataclasses no longer have: dropped on decode
# (a rebuild cut short by the time budget leaves some funds stored the old way).
_RETIRED = {"FundSnapshot": {"book_prev", "prev_filed", "usual_move"}}


def encode(value: object) -> object:
    """`value` as JSON-ready data that `decode` turns back into an equal value: dataclasses,
    dates, tuples and dicts (with any keys) are tagged; floats round-trip exactly."""
    if isinstance(value, date):
        return {"__date__": value.isoformat()}
    if is_dataclass(value) and not isinstance(value, type):
        return {
            "__type__": type(value).__name__,
            **{f.name: encode(getattr(value, f.name)) for f in fields(value)},
        }
    if isinstance(value, dict):
        return {"__dict__": [[encode(k), encode(v)] for k, v in value.items()]}
    if isinstance(value, tuple):
        return {"__tuple__": [encode(v) for v in value]}
    if isinstance(value, list):
        return [encode(v) for v in value]
    return value


def decode(value: object) -> object:
    if isinstance(value, list):
        return [decode(v) for v in value]
    if not isinstance(value, dict):
        return value
    if "__date__" in value:
        return date.fromisoformat(value["__date__"])
    if "__tuple__" in value:
        return tuple(decode(v) for v in value["__tuple__"])
    if "__dict__" in value:
        return {decode(k): decode(v) for k, v in value["__dict__"]}
    name = value["__type__"]
    retired = _RETIRED.get(name, set())
    return _STORED_TYPES[name](
        **{k: decode(v) for k, v in value.items() if k != "__type__" and k not in retired}
    )


def dump(value: object) -> str:
    return json.dumps(encode(value), sort_keys=True)


def undump(text: str) -> object:
    return decode(json.loads(text))
