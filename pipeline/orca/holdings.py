"""Holdings: pick one report per fund-quarter, collapse it to positions, fill filing gaps.

Pure functions over the frames the SEC parsers produce (`filings`, `raw_holdings`); no I/O.
"""

import polars as pl

ORIGINAL_FORM = "13F-HR"
AMENDMENT_FORM = "13F-HR/A"
ORIGINAL, RESTATEMENT, NEW_HOLDINGS = "original", "restatement", "new_holdings"
BULK = "bulk"

# One missing quarter in a row is carried forward; two or more end a tracking segment.
MAX_FILLED_GAP = 1

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
    """One row per accession. The same filing can arrive from both sources (live first, bulk
    later), even under a different CIK for a multi-filer accession: the bulk row wins."""
    if "source" not in filings.columns:
        filings = filings.with_columns(source=pl.lit(BULK))
    return (
        filings.with_columns(_not_bulk=(pl.col("source") != BULK))
        .sort("_not_bulk", maintain_order=True)
        .unique(subset="accession", keep="first", maintain_order=True)
        .drop("_not_bulk")
    )


def select_reports(filings: pl.DataFrame) -> pl.DataFrame:
    """The filings that make up each (cik, period): the base report plus the amendments on top.

    Base: the latest original 13F-HR, or, if the fund-quarter has any restatement, the latest
    restatement. On top of it go all new-holdings amendments filed after the base. "Latest" and
    "after" order filings by (filed, accession), so same-day filings are decided
    deterministically. An amendment of unknown type is ignored, and so are new-holdings
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
    classified = filings.with_columns(role=role).filter(pl.col("role").is_in([ORIGINAL, RESTATEMENT, NEW_HOLDINGS]))
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

    `raw_holdings` may carry a `source` column ("bulk" / "live"); only rows whose (accession,
    source) is that of a chosen filing are used. Without the column every row counts as bulk, so
    holdings of live filings must be tagged "live" by the caller.

    `kind` is PUT or CALL when the row has put_call set, else its share type (SH / PRN). Rows
    with shares <= 0 are dropped (counted in stats["nonpositive_shares"] if `stats` is given),
    then rows are summed by key. `filed` is the date the quarter's last chosen report was filed.
    """
    chosen = select_reports(filings)
    if "source" not in raw_holdings.columns:
        raw_holdings = raw_holdings.with_columns(source=pl.lit(BULK))
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


def fill_gaps(holdings: pl.DataFrame, last_q: int) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(filled holdings, fund_status): carry a single missing quarter, split tracking at longer gaps.

    A fund-quarter with no holdings that sits one quarter after a filed quarter and before the
    next one is a single gap: it is copied from the previous quarter with carried=True (filed
    date unchanged). The same goes for `last_q` itself when the fund filed in `last_q - 1`. Two
    or more missing quarters in a row end a segment and are not filled; a later filing starts a
    new segment.

    fund_status has one row per cik: first_q, last_filed_q, inactive (last_filed_q < last_q - 1,
    i.e. nothing filed in the latest two quarters) and segments, the (start, end) of each run of
    filed quarters, ends included, carried quarters inside.
    """
    quarters = holdings.select("cik", "q").unique().sort("cik", "q")
    missing_before = pl.col("q") - pl.col("q").shift(1).over("cik") - 1  # null for a fund's first quarter
    starts_segment = missing_before.is_null() | (missing_before > MAX_FILLED_GAP)
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

    # Quarters to copy forward: (cik, source q, target q).
    missing_after = pl.col("q").shift(-1).over("cik") - pl.col("q") - 1
    interior = quarters.filter(missing_after == MAX_FILLED_GAP).select("cik", source_q="q", q=pl.col("q") + 1)
    tail = status.filter(pl.col("last_filed_q") == last_q - 1).select(
        "cik", source_q="last_filed_q", q=pl.lit(last_q, dtype=pl.Int16)
    )
    carried = (
        holdings.join(pl.concat([interior, tail]), left_on=["cik", "q"], right_on=["cik", "source_q"])
        .drop("q")
        .rename({"q_right": "q"})
        .select(holdings.columns)
    )
    filled = pl.concat(
        [holdings.with_columns(carried=pl.lit(False)), carried.with_columns(carried=pl.lit(True))]
    )
    filled = filled.select(*(pl.col(name).cast(dtype) for name, dtype in FILLED_SCHEMA.items()))
    return filled.sort("cik", "q", "cusip", "kind"), status
