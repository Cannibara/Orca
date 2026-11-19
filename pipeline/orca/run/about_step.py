"""Run step for the About tab: keep lake table `fund_about` (one row per CIK, `sec.about.SCHEMA`) up to date.

Modelled on `sectors_step.update_share_history`. Funds with no row come first, then those whose row is out of
date: the lake holds a 13F-HR(/A) of the fund filed after the one the row was read from (a 13F filed the same
day as it is no newer). Within each group active funds come before inactive ones and bigger books first. A
fund costs two SEC calls (`sec.about.fetch_about`); `max_calls` caps a run and the step stops while
`reserve` minutes of the time budget are left. A fund whose lookup fails keeps its old row, is counted in an
`about_failed` flag and is asked again next run; the step never stops the run.

A first fill of ~16,000 funds is ~32,000 calls: at the SEC's 8 calls a second about 67 minutes, so it is spread
over three runs. After a filing deadline ~9,000 active funds have a new 13F, which two runs catch up.
"""

import logging
from collections.abc import Callable, Iterable
from dataclasses import replace
from datetime import date

import polars as pl

from orca.http import FetchError
from orca.publish import about_json
from orca.run.budget import Budget
from orca.run.state import read_table, scan_parts
from orca.sec.about import SCHEMA, TABLE, About, table_row
from orca.storage import Lake

log = logging.getLogger(__name__)
MAX_CALLS = 12_000  # ~25 minutes at the SEC's 8 calls a second (two per fund: 6,000 funds)
RESERVE_MIN = 30.0  # budget left for the health check, the manifest and the lake merges after the step
CALLS_PER_FUND = 2


def latest_13f(lake: Lake) -> dict[int, tuple[date, frozenset[str]]]:
    """Per CIK, the filing date of its newest 13F-HR or 13F-HR/A in the lake and the accessions filed that
    day (the lake's `filings` keeps no other forms). Read a quarter's part at a time."""
    frames = [
        frame
        for frame in scan_parts(lake, "filings", lambda f: f.select("cik", "filed", "accession"))
        if frame.height
    ]
    if not frames:
        return {}
    filings = pl.concat(frames, how="vertical_relaxed").drop_nulls()
    newest = filings.filter(pl.col("filed") == pl.col("filed").max().over("cik"))
    grouped = newest.group_by("cik").agg(pl.col("filed").first(), pl.col("accession").unique())
    return {
        int(cik): (filed, frozenset(accessions))
        for cik, filed, accessions in grouped.iter_rows()
    }


def update_fund_about(
    lake: Lake,
    fetch: Callable[[int], About | None],
    funds: Iterable[tuple[int, float, bool]],
    flags: list,
    budget: Budget,
    today: date,
    max_calls: int = MAX_CALLS,
    reserve: float = RESERVE_MIN,
) -> tuple[dict, dict[int, dict | None]]:
    """Look up the funds of `funds` (cik, book, inactive) that have no row or an out-of-date one, and store
    what the SEC says. Returns (counts, the funds whose published `about` changed -> the new one)."""
    table = read_table(lake, TABLE, SCHEMA)
    stored = {row["cik"]: row for row in table.iter_rows(named=True)}
    latest = latest_13f(lake)

    def out_of_date(cik: int) -> bool:
        row, newest = stored[cik], latest.get(cik)
        if newest is None or row["accession"] in newest[1]:
            return False
        return row["filed"] is None or newest[0] > row["filed"]

    queue = sorted(
        (cik in stored, inactive, -book, cik)
        for cik, book, inactive in funds
        if cik not in stored or out_of_date(cik)
    )
    fresh: dict[int, dict] = {}
    changed: dict[int, dict | None] = {}
    asked = failed = 0
    for _, _, _, cik in queue:
        if asked + CALLS_PER_FUND > max_calls or budget.minutes_left() <= reserve:
            break
        asked += CALLS_PER_FUND
        try:
            about = fetch(cik)
        except (FetchError, ValueError, KeyError, TypeError) as err:  # a bad answer is a failed lookup
            log.warning("fund_about: CIK %d skipped: %s", cik, type(err).__name__)
            failed += 1
            continue
        about = about if about is not None else About()
        if about.accession is None and cik in latest:  # no record, or no 13F in it: the lake's
            filed, accessions = latest[cik]
            about = replace(about, accession=min(accessions), filed=filed)
        row = table_row(cik, about, today)
        fresh[cik] = row
        if about_json(stored.get(cik)) != (published := about_json(row)):
            changed[cik] = published
    if fresh:
        kept = table.filter(~pl.col("cik").is_in(list(fresh)))
        rows = pl.DataFrame(list(fresh.values()), schema=SCHEMA, orient="row")
        lake.write(TABLE, pl.concat([kept, rows]).sort("cik"))
    if failed:
        flags.append({"type": "about_failed", "count": failed})
    stats = {"funds": len(fresh), "failed": failed, "owed": len(queue) - len(fresh) - failed}
    log.info("fund_about: %s", stats)
    return stats, changed
