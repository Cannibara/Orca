"""Publishing a run: the shared files from every fund's snapshot, the CUSIP guard over the staged
files, and the staging folder kept down to what changed."""

import re
import shutil
from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from pathlib import Path

import brotli
import polars as pl

from orca.config import PERIODS
from orca.home import (
    FundSnapshot,
    calls,
    conviction_moves,
    crowded_buys,
    just_filed,
    top_funds,
    wins_losses,
)
from orca.publish import (
    FundMeta,
    HomeLists,
    publish_shared,
    publish_weekly,
    weekly_closes,
)
from orca.run.compute import Context
from orca.run.market import latest_closes
from orca.run.state import MAX_FLAGS_PER_KIND, SECURITIES_TABLE_SCHEMA, read_table
from orca.securities import ETF_SECTOR
from orca.vendor import VENDOR_SCHEMA, VENDOR_TABLE

KEEP_STAGING = 2  # staging folders kept (this run's and the one before)


class CusipLeakError(RuntimeError):
    """A staged file contains a CUSIP of the security master."""


_TOKEN = re.compile(r"(?<![0-9A-Za-z])(?<![0-9]\.)[0-9A-Za-z]{9}(?![0-9A-Za-z])(?!\.[0-9])")
_CUSIP_SPECIALS = {"*": 36, "@": 37, "#": 38}


def cusip_check_digit(base: str) -> str:
    """The check digit of a CUSIP's first eight characters (the standard modulus-10 rule: the
    characters at even positions doubled, letters worth 10 to 35, digits of products summed)."""
    total = 0
    for position, char in enumerate(base.upper()):
        if char.isdigit():
            value = int(char)
        elif "A" <= char <= "Z":
            value = ord(char) - ord("A") + 10
        else:
            value = _CUSIP_SPECIALS[char]
        if position % 2:
            value *= 2
        total += value // 10 + value % 10
    return str((10 - total % 10) % 10)


def is_cusip(text: str) -> bool:
    """Whether `text` is a well-formed CUSIP: nine characters ending in their check digit."""
    if len(text) != 9 or not text.isascii():
        return False
    if not all(c.isalnum() or c in _CUSIP_SPECIALS for c in text[:8]):
        return False
    return cusip_check_digit(text[:8]) == text[8]


def cusip_leaks(staging: Path, cusips: set[str], compressed: bool) -> list[str]:
    """Where staged files contain a CUSIP of `cusips` as a whole token (not inside a longer word
    or number): "path (offset n)" of the first one in each file. The CUSIP itself is not named,
    as the error ends up in a log."""
    leaks = []
    for path in sorted(staging.rglob("*.json")):
        data = path.read_bytes()
        text = (brotli.decompress(data) if compressed else data).decode("ascii", "replace")
        hit = next((m for m in _TOKEN.finditer(text) if m.group().upper() in cusips), None)
        if hit is not None:
            leaks.append(f"{path.relative_to(staging).as_posix()} (offset {hit.start()})")
    return leaks


def capped(flags: list[dict]) -> list:
    """At most MAX_FLAGS_PER_KIND findings of each type, with a count of the rest."""
    kept, extra = [], defaultdict(int)
    seen: dict[str, int] = defaultdict(int)
    for flag in flags:
        kind = flag.get("type", "") if isinstance(flag, dict) else ""
        seen[kind] += 1
        if seen[kind] <= MAX_FLAGS_PER_KIND:
            kept.append(flag)
        else:
            extra[kind] += 1
    kept += [{"type": f"{kind}_more", "count": n} for kind, n in sorted(extra.items())]
    return kept


def publish_shared_files(
    ctx: Context,
    staging: Path,
    metas: list[FundMeta],
    snaps: list[FundSnapshot],
    weekly_ids: set[int] | None,
    today: date,
    compress: bool,
) -> dict[str, str]:
    """funds.json, securities.json, latest_prices.json, the home lists and the weekly files of
    `weekly_ids` (every stock when None); the weekly files are built a chunk of stocks at a time
    (`Context.iter_closes`), so no more than a chunk's daily closes are ever held."""
    lake, last_q = ctx.lake, ctx.last_q
    securities = read_table(lake, "securities", SECURITIES_TABLE_SCHEMA).sort("stock_id")
    vendor = read_table(lake, VENDOR_TABLE, VENDOR_SCHEMA)
    if vendor.height:  # the ticker the stock trades under ("XLNX", not a foreign "XLNXEUR")
        securities = (
            securities.join(vendor.select("stock_id", vt="ticker"), on="stock_id", how="left")
            .with_columns(ticker=pl.coalesce("vt", "ticker"))
            .drop("vt")
        )
    # ETFs are no stock pick: the conviction lists leave them out.
    etfs = frozenset(
        securities.filter(pl.col("is_etf").fill_null(False) | (pl.col("sector") == ETF_SECTOR))[
            "stock_id"
        ].to_list()
    )
    latest = latest_closes(lake)
    asof = max((day for day, _ in latest.values()), default=today)
    latest_prices = {sid: latest.get(sid) for sid in securities["stock_id"].to_list()}

    # The calls lists are ranked on prices as of the deadline quarter's end, not this week's, so
    # the home files change with filings only (the browser shows moves to the latest price).
    candidates = sorted({sid for s in snaps for sid, *_ in s.buys_recent})
    ctx.load(candidates)
    q_close = {
        sid: ctx.px[sid][last_q].close
        for sid in candidates
        if last_q in ctx.px[sid] and ctx.px[sid][last_q].close
    }
    shares_out = dict(securities.select("stock_id", "shares_out").iter_rows())
    mcap = {sid: shares_out[sid] * px for sid, px in q_close.items() if shares_out.get(sid)}
    on_filed = ctx.closes_on((sid, filed) for s in snaps for sid, _, _, _, filed in s.buys_recent)

    def px_on_filed(stock_id: int, filed: date) -> float | None:
        return on_filed.get((stock_id, filed))

    home = HomeLists(
        latest_q=last_q,
        top={period: top_funds(snaps, period) for period in PERIODS},
        conviction_q=conviction_moves(snaps, "q", latest_q=last_q, not_stocks=etfs),
        conviction_y=conviction_moves(snaps, "y", latest_q=last_q, not_stocks=etfs),
        wins_losses=wins_losses(snaps, latest_q=last_q),
        just_filed=just_filed(snaps),
        crowded=crowded_buys(snaps, latest_q=last_q),
        calls_q=calls(snaps, mcap, q_close, px_on_filed, "q", latest_q=last_q),
        calls_y=calls(snaps, mcap, q_close, px_on_filed, "y", latest_q=last_q),
    )

    table = securities.with_columns(
        name=pl.coalesce("name", "ticker"), sector=pl.col("sector").fill_null("Other")
    )
    files = publish_shared(
        staging,
        funds=metas,
        securities=table,
        asof=asof,
        latest_prices=latest_prices,
        home=home,
        compress=compress,
    )
    weekly_ids = set(securities["stock_id"].to_list()) if weekly_ids is None else weekly_ids
    for closes in ctx.iter_closes(weekly_ids):
        weekly = {sid: weekly_closes(frame) for sid, frame in closes.items()}
        files.update(publish_weekly(staging, weekly, compress))
    return files


def prune_staging(out_root: Path) -> None:
    runs = sorted(p for p in (Path(out_root) / "staging").iterdir() if p.is_dir())
    for old in runs[:-KEEP_STAGING]:
        shutil.rmtree(old, ignore_errors=True)


def keep_only(staging: Path, keep: set[str]) -> None:
    """Delete the staged files not in `keep` (unchanged since the last publish), then empty
    folders, so the staging folder holds exactly what is to be uploaded."""
    for path in sorted(staging.rglob("*"), reverse=True):
        rel = path.relative_to(staging).as_posix()
        if path.is_file() and rel not in keep:
            path.unlink()
        elif path.is_dir() and not any(path.iterdir()):
            path.rmdir()


def is_fund_path(path: str, ciks: Iterable[int]) -> bool:
    parts = path.split("/")
    return len(parts) == 3 and parts[0] == "fund" and parts[1].isdigit() and int(parts[1]) in ciks


def copy_published(staging: Path, out_root: Path, dest: Path) -> None:
    """Do what the upload does, into a local folder: copy the staged *.json files to `dest`
    under their paths, then the manifest last."""
    dest = Path(dest)
    for path in sorted(Path(staging).rglob("*.json")):
        target = dest / path.relative_to(staging)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(out_root) / "manifest.json", dest / "manifest.json")
