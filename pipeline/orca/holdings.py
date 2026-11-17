"""Holdings: pick one report per fund-quarter, collapse it to positions, fill filing gaps.

Pure functions over the frames the SEC parsers produce (`filings`, `raw_holdings`); no I/O.
"""

import polars as pl

ORIGINAL_FORM = "13F-HR"
AMENDMENT_FORM = "13F-HR/A"
ORIGINAL, RESTATEMENT, NEW_HOLDINGS = "original", "restatement", "new_holdings"
BULK, LIVE, LEGACY = "bulk", "live", "legacy"
SOURCE_RANK = {BULK: 0, LIVE: 1, LEGACY: 2}  # who wins when one accession comes from two


HOLDINGS_SCHEMA = pl.Schema(
    {
        "cik": pl.Int64,
        "q": pl.Int16,
        "cusip": pl.String,
        "kind": pl.String,
        "shares": pl.Float64,
        "value_usd": pl.Float64,
        "filed": pl.Date,
    }
)
FILLED_SCHEMA = pl.Schema({**HOLDINGS_SCHEMA, "carried": pl.Boolean})
STATUS_SCHEMA = pl.Schema(
    {
        "cik": pl.Int64,
        "first_q": pl.Int16,
        "last_filed_q": pl.Int16,
        "inactive": pl.Boolean,
        "segments": pl.List(pl.Struct({"start": pl.Int16, "end": pl.Int16})),
    }
)


def _bulk_first_unique(filings: pl.DataFrame) -> pl.DataFrame:
    """One row per accession. The same filing can arrive from two sources (live first, bulk
    later), even under a different CIK for a multi-filer accession: bulk beats live, and live
    beats legacy (a pre-2013 text reading)."""
    if "source" not in filings.columns:
        filings = filings.with_columns(source=pl.lit(BULK))
    rank = pl.col("source").replace_strict(SOURCE_RANK, default=len(SOURCE_RANK), return_dtype=pl.Int8)
    return (
        filings.with_columns(_rank=rank)
        .sort("_rank", maintain_order=True)
        .unique(subset="accession", keep="first", maintain_order=True)
        .drop("_rank")
    )


def select_reports(filings: pl.DataFrame) -> pl.DataFrame:
    """The filings that make up each (cik, period): the base report plus the amendments on top.

    Base: the latest original 13F-HR, or, if the fund-quarter has any restatement, the latest
    restatement. On top of it go all new-holdings amendments filed after the base. "Latest" and
    "after" order filings by (filed, accession), so same-day filings are decided
    deterministically. An amendment of unknown type is ignored, unless its fund-quarter has no
    original or restatement (then it is taken as a restatement), and so are new-holdings
    amendments of a fund-quarter with no base report in the data: a partial set of positions
    would read as a near-total sale.

    Filings are de-duplicated by accession first (bulk beats live, whatever the CIK), so the
    result has one row per chosen accession; the columns are the input's, plus `source` if it
    was missing (then "bulk").
    """
    filings = _bulk_first_unique(filings)
    columns = filings.columns
    role = (
        pl.when(pl.col("form") == ORIGINAL_FORM)
        .then(pl.lit(ORIGINAL))
        .when(pl.col("form") == AMENDMENT_FORM)
        .then(pl.col("amendment_type"))
    )
    filings = filings.with_columns(role=role)
    # Some filers sent every quarterly report as an amendment with neither box checked (Kahn
    # Brothers before 2013): in a fund-quarter with no other report, such an amendment is it.
    based = filings.filter(pl.col("role").is_in([ORIGINAL, RESTATEMENT])).select("cik", "period").unique()
    lone = (pl.col("form") == AMENDMENT_FORM) & pl.col("role").is_null()
    filings = filings.join(based.with_columns(_based=pl.lit(True)), on=["cik", "period"], how="left").with_columns(
        role=pl.when(lone & pl.col("_based").is_null()).then(pl.lit(RESTATEMENT)).otherwise(pl.col("role"))
    ).drop("_based")
    classified = filings.filter(pl.col("role").is_in([ORIGINAL, RESTATEMENT, NEW_HOLDINGS]))
    base = (
        classified.filter(pl.col("role") != NEW_HOLDINGS)
        .with_columns(_restated=(pl.col("role") == RESTATEMENT))
        .sort("cik", "period", "_restated", "filed", "accession")
        .group_by("cik", "period", maintain_order=True)
        .last()
    )
    marks = base.select("cik", "period", base_filed="filed", base_accession="accession")
    appended = (
        classified.filter(pl.col("role") == NEW_HOLDINGS)
        .join(marks, on=["cik", "period"], how="inner")
        .filter(
            (pl.col("filed") > pl.col("base_filed"))
            | ((pl.col("filed") == pl.col("base_filed")) & (pl.col("accession") > pl.col("base_accession")))
        )
    )
    return pl.concat([base.select(columns), appended.select(columns)]).sort("cik", "period", "filed", "accession")


def build_holdings(filings: pl.DataFrame, raw_holdings: pl.DataFrame, stats: dict | None = None) -> pl.DataFrame:
    """Positions per (cik, q, cusip, kind) from the chosen report of every fund-quarter.

    `raw_holdings` may carry a `source` column ("bulk" / "live" / "legacy"); only rows whose (accession,
    source) is that of a chosen filing are used. Without the column every row counts as bulk, so
    ValueError is raised if `filings` has a live row: untagged live holdings would be dropped.

    `kind` is PUT or CALL when the row has put_call set, else its share type (SH / PRN). Rows
    with shares <= 0 are dropped (counted in stats["nonpositive_shares"] if `stats` is given),
    then rows are summed by key. `filed` is the date the quarter's last chosen report was filed.
    """
    if "source" not in raw_holdings.columns:
        if "source" in filings.columns and (filings["source"] != BULK).any():
            raise ValueError('filings has non-bulk rows but raw_holdings has no "source" column to match them')
        raw_holdings = raw_holdings.with_columns(source=pl.lit(BULK))
    chosen = select_reports(filings)
    quarter_filed = chosen.group_by("cik", "period").agg(filed=pl.col("filed").max())
    keys = chosen.select("accession", "source", "cik", "period").join(quarter_filed, on=["cik", "period"])
    rows = raw_holdings.join(keys, on=["accession", "source"], how="inner")
    positive = rows.filter(pl.col("shares") > 0)
    if stats is not None:
        stats["nonpositive_shares"] = rows.height - positive.height
    return (
        positive.with_columns(
            q=pl.col("period"),
            cusip=pl.col("cusip").str.strip_chars().str.to_uppercase(),
            kind=pl.coalesce("put_call", "sh_type"),
        )
        .group_by("cik", "q", "cusip", "kind")
        .agg(pl.col("shares").sum(), pl.col("value_usd").sum(), pl.col("filed").first())
        .select(*(pl.col(name).cast(dtype) for name, dtype in HOLDINGS_SCHEMA.items()))
        .sort("cik", "q", "cusip", "kind")
    )


MAX_BRIDGED = 2  # unreadable filings in a row carried over before a fund's history is cut


def fill_gaps(
    holdings: pl.DataFrame,
    last_q: int,
    filed_quarters: pl.DataFrame | None = None,
    unreadable: pl.DataFrame | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(filled holdings, fund_status): carry a single missing quarter, split tracking at longer gaps.

    A quarter the fund did not file, one quarter after a filed quarter and before the next
    filed one, is a single gap: it is copied from the previous quarter with carried=True (filed
    date unchanged). The same goes for `last_q` itself when the fund filed in `last_q - 1`. Two
    or more unfiled quarters in a row end a segment and are not filled; a later filing starts a
    new segment. Only quarters that have rows are copied from.

    `filed_quarters` (cik, q) says which fund-quarters were filed; default: those with rows in
    `holdings`. Pass the chosen reports of select_reports (period as q) so that a filed report
    with no usable rows (a liquidated fund, all shares <= 0) counts as filed, not as a gap.

    `unreadable` (cik, q) lists fund-quarters the fund did file but whose table could not be read
    (pre-2013 text filings, `sec.legacy`). Between two readable quarters, up to MAX_BRIDGED of
    them in a row are carried like a single gap (copied from the last readable quarter) instead
    of ending the segment: the fund kept filing, so its history goes on.

    fund_status has one row per cik: first_q, last_filed_q, inactive (last_filed_q < last_q - 1,
    i.e. nothing filed in the latest two quarters) and segments, the (start, end) of each run of
    filed quarters, ends included, carried quarters inside.
    """
    filed = holdings if filed_quarters is None else filed_quarters
    readable = (
        filed.select(pl.col("cik").cast(pl.Int64), pl.col("q").cast(pl.Int16)).unique().sort("cik", "q")
    )
    bridged = _bridged(readable, unreadable)
    quarters = pl.concat([readable, bridged]).unique().sort("cik", "q")
    # One unfiled quarter in a row is carried forward (not tunable); two or more end a segment.
    missing_before = pl.col("q") - pl.col("q").shift(1).over("cik") - 1  # null for a fund's first quarter
    starts_segment = missing_before.is_null() | (missing_before > 1)
    spans = (
        quarters.with_columns(segment=starts_segment.cum_sum().over("cik"))
        .group_by("cik", "segment", maintain_order=True)
        .agg(start=pl.col("q").min(), end=pl.col("q").max())
    )
    status = (
        spans.group_by("cik", maintain_order=True)
        .agg(
            first_q=pl.col("start").min(),
            last_filed_q=pl.col("end").max(),
            segments=pl.struct("start", "end"),
        )
        .with_columns(inactive=pl.col("last_filed_q") < last_q - 1)
        .select(*(pl.col(name).cast(dtype) for name, dtype in STATUS_SCHEMA.items()))
        .sort("cik")
    )

    # Quarters to copy forward: (cik, target q), each from the last readable quarter before it.
    # A source without rows copies nothing.
    missing_after = pl.col("q").shift(-1).over("cik") - pl.col("q") - 1
    interior = quarters.filter(missing_after == 1).select("cik", q=pl.col("q") + 1)
    tail = status.filter(pl.col("last_filed_q") == last_q - 1).select(
        "cik", q=pl.lit(last_q, dtype=pl.Int16)
    )
    targets = pl.concat([interior, tail, bridged]).unique().sort("cik", "q")
    sources = (
        targets.join_asof(
            readable.with_columns(source_q=pl.col("q")).sort("cik", "q"),
            on="q",
            by="cik",
            strategy="backward",
            allow_exact_matches=False,
            check_sortedness=False,
        )
        .filter(pl.col("source_q").is_not_null())
        .select("cik", "source_q", "q")
    )
    carried = (
        holdings.join(sources, left_on=["cik", "q"], right_on=["cik", "source_q"])
        .drop("q")
        .rename({"q_right": "q"})
        .select(holdings.columns)
    )
    filled = pl.concat(
        [holdings.with_columns(carried=pl.lit(False)), carried.with_columns(carried=pl.lit(True))]
    )
    filled = filled.select(*(pl.col(name).cast(dtype) for name, dtype in FILLED_SCHEMA.items()))
    return filled.sort("cik", "q", "cusip", "kind"), status


def _bridged(readable: pl.DataFrame, unreadable: pl.DataFrame | None) -> pl.DataFrame:
    """The unreadable fund-quarters that are carried: between two readable quarters of the fund,
    in runs of at most MAX_BRIDGED."""
    if unreadable is None or unreadable.is_empty():
        return readable.clear()
    span = readable.group_by("cik").agg(lo=pl.col("q").min(), hi=pl.col("q").max())
    inside = (
        unreadable.select(pl.col("cik").cast(pl.Int64), pl.col("q").cast(pl.Int16))
        .unique()
        .join(readable, on=["cik", "q"], how="anti")
        .join(span, on="cik")
        .filter((pl.col("q") > pl.col("lo")) & (pl.col("q") < pl.col("hi")))
        .sort("cik", "q")
    )
    run = (pl.col("q") - pl.col("q").shift(1).over("cik") != 1).fill_null(True).cum_sum().over("cik")
    return (
        inside.with_columns(run=run)
        .with_columns(length=pl.len().over("cik", "run"))
        .filter(pl.col("length") <= MAX_BRIDGED)
        .select("cik", "q")
    )
