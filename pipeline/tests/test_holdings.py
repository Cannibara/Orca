import zipfile
from datetime import date

import polars as pl
import pytest

from orca.holdings import build_holdings, fill_gaps, select_reports
from orca.sec.bulk import parse_bulk_zip
from orca.sec.live import FILINGS_SCHEMA, parse_infotable_xml

# Same columns and dtypes as parse_bulk_zip / fetch_new_filings produce.
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
    }
)
HOLDINGS_SCHEMA = pl.Schema(
    {
        "cik": pl.Int64,
        "q": pl.Int16,
        "cusip": pl.String,
        "kind": pl.String,
        "shares": pl.Float64,
        "value_usd": pl.Float64,
        "filed": pl.Date,
        "carried": pl.Boolean,
    }
)
SEGMENT = pl.Struct({"start": pl.Int16, "end": pl.Int16})
STATUS_SCHEMA = pl.Schema(
    {
        "cik": pl.Int64,
        "first_q": pl.Int16,
        "last_filed_q": pl.Int16,
        "inactive": pl.Boolean,
        "segments": pl.List(SEGMENT),
    }
)

CIK = 1000001
Q = 43  # Q4 2023


def filings_frame(*rows: dict) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=FILINGS_SCHEMA)


def filing(accession, filed, form="13F-HR", amendment_type=None, cik=CIK, q=Q, source="bulk"):
    return {
        "accession": accession,
        "cik": cik,
        "period": q,
        "filed": filed,
        "form": form,
        "amendment_type": amendment_type,
        "manager_name": "ALPHA CAPITAL LP",
        "source": source,
    }


def restatement(accession, filed, **kw):
    return filing(accession, filed, form="13F-HR/A", amendment_type="restatement", **kw)


def new_holdings(accession, filed, **kw):
    return filing(accession, filed, form="13F-HR/A", amendment_type="new_holdings", **kw)


def raw_frame(*rows: dict) -> pl.DataFrame:
    return pl.DataFrame(list(rows), schema=RAW_SCHEMA)


def raw(accession, cusip, shares, value_usd=None, sh_type="SH", put_call=None):
    return {
        "accession": accession,
        "cusip": cusip,
        "issuer": "ISSUER",
        "title": "COM",
        "shares": shares,
        "sh_type": sh_type,
        "put_call": put_call,
        "value_usd": shares * 10 if value_usd is None else value_usd,
    }


def rows_of(df: pl.DataFrame, *columns: str) -> list[tuple]:
    return sorted(df.select(columns).rows())


A, B, C = "0000000001-24-000001", "0000000001-24-000002", "0000000001-24-000003"


# --- select_reports / build_holdings: which report wins ---------------------------------


def test_restatement_replaces_original_and_new_holdings_append():
    filings = filings_frame(
        filing(A, date(2024, 2, 14)),
        restatement(B, date(2024, 3, 1)),
        new_holdings(C, date(2024, 3, 10)),
    )
    raws = raw_frame(
        raw(A, "AAA", 100),
        raw(A, "BBB", 200),
        raw(A, "CCC", 300),
        raw(B, "AAA", 110),
        raw(B, "BBB", 220),
        raw(C, "DDD", 40),
    )

    assert set(select_reports(filings)["accession"]) == {B, C}

    out = build_holdings(filings, raws)
    assert out.height == 3
    assert rows_of(out, "cusip", "shares") == [("AAA", 110.0), ("BBB", 220.0), ("DDD", 40.0)]
    # the quarter is complete once the last chosen report is filed
    assert out["filed"].to_list() == [date(2024, 3, 10)] * 3


def test_any_restatement_beats_every_original_even_a_later_one():
    filings = filings_frame(
        filing(A, date(2024, 2, 14)),
        restatement(B, date(2024, 3, 1)),
        filing(C, date(2024, 3, 20)),  # refiled original after the restatement
    )
    raws = raw_frame(raw(A, "AAA", 1), raw(B, "BBB", 2), raw(C, "CCC", 3))

    assert rows_of(build_holdings(filings, raws), "cusip") == [("BBB",)]


def test_new_holdings_filed_before_the_chosen_base_is_not_appended():
    filings = filings_frame(
        filing(A, date(2024, 2, 14)),
        new_holdings(B, date(2024, 2, 20)),  # superseded by the later restatement
        restatement(C, date(2024, 3, 1)),
    )
    raws = raw_frame(raw(A, "AAA", 1), raw(B, "BBB", 2), raw(C, "CCC", 3))

    assert set(select_reports(filings)["accession"]) == {C}
    assert rows_of(build_holdings(filings, raws), "cusip") == [("CCC",)]


def test_new_holdings_amend_the_original_when_there_is_no_restatement():
    filings = filings_frame(filing(A, date(2024, 2, 14)), new_holdings(B, date(2024, 3, 1)))
    raws = raw_frame(raw(A, "AAA", 1), raw(B, "BBB", 2))

    assert rows_of(build_holdings(filings, raws), "cusip", "shares") == [("AAA", 1.0), ("BBB", 2.0)]


def test_new_holdings_without_a_base_report_are_ignored():
    filings = filings_frame(new_holdings(A, date(2024, 3, 1)))  # original not in our data

    assert select_reports(filings).height == 0
    assert build_holdings(filings, raw_frame(raw(A, "AAA", 1))).height == 0


def test_amendment_of_unknown_type_is_ignored():
    filings = filings_frame(
        filing(A, date(2024, 2, 14)),
        filing(B, date(2024, 3, 1), form="13F-HR/A", amendment_type=None),
    )
    raws = raw_frame(raw(A, "AAA", 1), raw(B, "BBB", 2))

    assert rows_of(build_holdings(filings, raws), "cusip") == [("AAA",)]


@pytest.mark.parametrize("reverse", [False, True])
def test_latest_original_wins_when_refiled(reverse):
    rows = [filing(A, date(2024, 2, 10)), filing(B, date(2024, 2, 20))]
    filings = filings_frame(*(reversed(rows) if reverse else rows))
    raws = raw_frame(raw(A, "AAA", 1), raw(A, "OLD", 9), raw(B, "AAA", 5))

    out = build_holdings(filings, raws)

    assert rows_of(out, "cusip", "shares") == [("AAA", 5.0)]  # B alone; nothing summed from A


def test_same_day_reports_are_ordered_by_accession():
    filings = filings_frame(filing(B, date(2024, 2, 10)), filing(A, date(2024, 2, 10)))
    raws = raw_frame(raw(A, "AAA", 1), raw(B, "AAA", 2))

    assert rows_of(build_holdings(filings, raws), "shares") == [(2.0,)]


def test_each_fund_quarter_is_selected_on_its_own():
    other = "0000000002-24-000001"
    filings = filings_frame(
        filing(A, date(2024, 2, 14)),
        restatement(B, date(2024, 3, 1)),
        filing(other, date(2024, 2, 15), cik=CIK + 1),
        filing("0000000001-24-000009", date(2024, 5, 15), q=Q + 1),
    )
    raws = raw_frame(
        raw(A, "AAA", 1),
        raw(B, "BBB", 2),
        raw(other, "CCC", 3),
        raw("0000000001-24-000009", "DDD", 4),
    )

    out = build_holdings(filings, raws)

    assert rows_of(out, "cik", "q", "cusip") == [
        (CIK, Q, "BBB"),
        (CIK, Q + 1, "DDD"),
        (CIK + 1, Q, "CCC"),
    ]


# --- build_holdings: cleaning, collapsing, classifying ----------------------------------


def test_collapse_keeps_put_call_separate():
    filings = filings_frame(filing(A, date(2024, 2, 14)))
    raws = raw_frame(raw(A, "AAA", 100), raw(A, "AAA", 50, put_call="CALL"))

    out = build_holdings(filings, raws)

    assert out.height == 2
    assert rows_of(out, "cusip", "kind", "shares") == [("AAA", "CALL", 50.0), ("AAA", "SH", 100.0)]


def test_kind_is_put_call_when_set_else_the_share_type():
    filings = filings_frame(filing(A, date(2024, 2, 14)))
    raws = raw_frame(
        raw(A, "SHARES", 1),
        raw(A, "BOND", 1, sh_type="PRN"),
        raw(A, "OPT1", 1, put_call="PUT"),
        raw(A, "OPT2", 1, sh_type="PRN", put_call="CALL"),
    )

    out = build_holdings(filings, raws)

    assert rows_of(out, "cusip", "kind") == [
        ("BOND", "PRN"),
        ("OPT1", "PUT"),
        ("OPT2", "CALL"),
        ("SHARES", "SH"),
    ]


def test_collapse_sums_shares_and_value_of_repeated_rows():
    filings = filings_frame(filing(A, date(2024, 2, 14)))
    raws = raw_frame(raw(A, "AAA", 100, value_usd=1000.0), raw(A, "AAA", 25, value_usd=300.0))

    out = build_holdings(filings, raws)

    assert out.height == 1
    assert out["shares"].to_list() == [125.0]
    assert out["value_usd"].to_list() == [1300.0]


def test_cusip_case_and_padding_do_not_split_a_position():
    filings = filings_frame(filing(A, date(2024, 2, 14)))
    raws = raw_frame(raw(A, "g1151c101", 1), raw(A, " G1151C101 ", 2))

    out = build_holdings(filings, raws)

    assert rows_of(out, "cusip", "shares") == [("G1151C101", 3.0)]


def test_nonpositive_shares_dropped():
    filings = filings_frame(filing(A, date(2024, 2, 14)))
    raws = raw_frame(raw(A, "AAA", 100), raw(A, "ZERO", 0), raw(A, "NEG", -5))
    stats: dict = {}

    out = build_holdings(filings, raws, stats)

    assert rows_of(out, "cusip") == [("AAA",)]
    assert stats["nonpositive_shares"] == 2


def test_nonpositive_shares_counts_only_rows_of_the_chosen_reports():
    filings = filings_frame(filing(A, date(2024, 2, 10)), filing(B, date(2024, 2, 20)))
    raws = raw_frame(raw(A, "OLD", 0), raw(B, "AAA", 7))
    stats: dict = {}

    build_holdings(filings, raws, stats)

    assert stats["nonpositive_shares"] == 0


def test_stats_are_optional():
    filings = filings_frame(filing(A, date(2024, 2, 14)))

    assert build_holdings(filings, raw_frame(raw(A, "AAA", 0))).height == 0


def test_build_holdings_output_schema():
    out = build_holdings(filings_frame(filing(A, date(2024, 2, 14))), raw_frame(raw(A, "AAA", 1)))

    assert out.schema == pl.Schema({k: v for k, v in HOLDINGS_SCHEMA.items() if k != "carried"})


def test_build_holdings_of_nothing_has_the_usual_schema():
    out = build_holdings(filings_frame(), raw_frame())

    assert out.height == 0
    assert out.schema == pl.Schema({k: v for k, v in HOLDINGS_SCHEMA.items() if k != "carried"})


# --- live vs bulk -----------------------------------------------------------------------


def with_source(df: pl.DataFrame, source: str) -> pl.DataFrame:
    return df.with_columns(source=pl.lit(source))


@pytest.mark.parametrize("live_first", [True, False])
def test_same_accession_from_both_sources_keeps_only_the_bulk_filing(live_first):
    # Live saw the accession under one filer's CIK, bulk lists it under another's.
    live_filing = filing(A, date(2024, 2, 14), cik=111, source="live")
    bulk_filing = filing(A, date(2024, 2, 14), cik=222, source="bulk")
    live_rows = with_source(raw_frame(raw(A, "AAA", 100), raw(A, "BBB", 200)), "live")
    bulk_rows = with_source(raw_frame(raw(A, "AAA", 101), raw(A, "BBB", 201)), "bulk")
    order = [(live_filing, live_rows), (bulk_filing, bulk_rows)]
    if not live_first:
        order.reverse()
    filings = filings_frame(*(f for f, _ in order))
    raws = pl.concat([r for _, r in order])

    out = build_holdings(filings, raws)

    assert out["cik"].unique().to_list() == [222]
    assert rows_of(out, "cusip", "shares") == [("AAA", 101.0), ("BBB", 201.0)]  # no duplicates


def test_live_filing_is_used_until_bulk_has_it():
    live_filing = filing(A, date(2024, 2, 14), source="live")
    raws = with_source(raw_frame(raw(A, "AAA", 100)), "live")

    out = build_holdings(filings_frame(live_filing), raws)

    assert rows_of(out, "cusip", "shares") == [("AAA", 100.0)]


def test_live_copy_of_a_bulk_accession_does_not_create_a_fund_quarter():
    # The live copy of A (cik 111) must not make cik 111 a fund with its own quarter.
    filings = filings_frame(
        filing(A, date(2024, 2, 14), cik=111, source="live"),
        filing(A, date(2024, 2, 14), cik=222, source="bulk"),
    )

    assert select_reports(filings)["cik"].to_list() == [222]


def test_raw_holdings_without_a_source_column_count_as_bulk():
    filings = filings_frame(filing(A, date(2024, 2, 14)))

    out = build_holdings(filings, raw_frame(raw(A, "AAA", 1)))

    assert out.height == 1


def make_bulk_zip(path, accession: str) -> None:
    submission = (
        "ACCESSION_NUMBER\tFILING_DATE\tSUBMISSIONTYPE\tCIK\tPERIODOFREPORT\n"
        f"{accession}\t14-FEB-2024\t13F-HR\t0001000001\t31-DEC-2023\n"
    )
    coverpage = f"ACCESSION_NUMBER\tAMENDMENTTYPE\tFILINGMANAGER_NAME\n{accession}\t\tALPHA CAPITAL LP\n"
    infotable = (
        "ACCESSION_NUMBER\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tVALUE\tSSHPRNAMT\tSSHPRNAMTTYPE\tPUTCALL\n"
        f"{accession}\tAPPLE INC\tCOM\t037833100\t1500\t10\tSH\t\n"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("SUBMISSION.tsv", submission)
        z.writestr("COVERPAGE.tsv", coverpage)
        z.writestr("INFOTABLE.tsv", infotable)


def test_bulk_and_live_frames_concatenate_and_build(tmp_path):
    bulk_acc, live_acc = "0000000001-24-000001", "0000000001-24-000002"
    zip_path = tmp_path / "form13f.zip"
    make_bulk_zip(zip_path, bulk_acc)
    bulk_filings, bulk_raw = parse_bulk_zip(zip_path)

    info = (
        '<informationTable xmlns="urn:test"><infoTable><nameOfIssuer>MSFT</nameOfIssuer>'
        "<titleOfClass>COM</titleOfClass><cusip>594918104</cusip><value>7</value>"
        "<shrsOrPrnAmt><sshPrnamt>3</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>"
        "</infoTable></informationTable>"
    ).encode()
    live_raw = parse_infotable_xml(info, live_acc, date(2024, 5, 15))
    live_filings = filings_frame(filing(live_acc, date(2024, 5, 15), q=Q + 1, source="live"))

    assert bulk_filings.schema == live_filings.schema
    assert bulk_raw.schema == live_raw.schema

    filings = pl.concat([bulk_filings, live_filings])
    raws = pl.concat([with_source(bulk_raw, "bulk"), with_source(live_raw, "live")])
    out = build_holdings(filings, raws)

    assert rows_of(out, "cik", "q", "cusip", "kind", "shares", "value_usd") == [
        (CIK, Q, "037833100", "SH", 10.0, 1500.0),  # filed 2024: VALUE already in dollars
        (CIK, Q + 1, "594918104", "SH", 3.0, 7.0),
    ]


# --- fill_gaps --------------------------------------------------------------------------


def held(cik, q, cusip="AAA", shares=100.0, filed=None, kind="SH"):
    return {
        "cik": cik,
        "q": q,
        "cusip": cusip,
        "kind": kind,
        "shares": shares,
        "value_usd": shares * 10,
        "filed": filed or date(2020, 1, 1),
    }


def held_frame(*rows: dict) -> pl.DataFrame:
    schema = pl.Schema({k: v for k, v in HOLDINGS_SCHEMA.items() if k != "carried"})
    return pl.DataFrame(list(rows), schema=schema)


def segments_of(status: pl.DataFrame, cik: int = CIK) -> list[tuple[int, int]]:
    row = status.filter(pl.col("cik") == cik).row(0, named=True)
    return [(s["start"], s["end"]) for s in row["segments"]]


def test_single_gap_carried_forward():
    holdings = held_frame(
        held(CIK, 10, "AAA", 100.0, filed=date(2020, 2, 14)),
        held(CIK, 10, "BBB", 50.0, filed=date(2020, 2, 14)),
        held(CIK, 12, "AAA", 120.0, filed=date(2020, 8, 14)),
    )

    filled, status = fill_gaps(holdings, last_q=12)

    q10 = filled.filter(pl.col("q") == 10).sort("cusip")
    q11 = filled.filter(pl.col("q") == 11).sort("cusip")
    assert q11.height == 2
    assert q11.drop("q", "carried").equals(q10.drop("q", "carried"))  # incl. the previous filed date
    assert q11["carried"].to_list() == [True, True]
    assert filled.filter(pl.col("q") != 11)["carried"].to_list() == [False, False, False]
    assert segments_of(status) == [(10, 12)]


def test_two_quarter_gap_starts_new_segment():
    holdings = held_frame(held(CIK, 10), held(CIK, 13))

    filled, status = fill_gaps(holdings, last_q=13)

    assert segments_of(status) == [(10, 10), (13, 13)]
    assert sorted(filled["q"].to_list()) == [10, 13]  # nothing for q11-q12
    assert not filled["carried"].any()


def test_three_single_gaps_in_a_row_are_each_filled_from_a_filed_quarter():
    holdings = held_frame(held(CIK, 10, shares=1.0), held(CIK, 12, shares=2.0), held(CIK, 14, shares=3.0))

    filled, status = fill_gaps(holdings, last_q=14)

    by_q = {q: (shares, carried) for q, shares, carried in filled.select("q", "shares", "carried").rows()}
    assert by_q == {10: (1.0, False), 11: (1.0, True), 12: (2.0, False), 13: (2.0, True), 14: (3.0, False)}
    assert segments_of(status) == [(10, 14)]


def test_fund_status_spans_segments():
    holdings = held_frame(held(CIK, 5), held(CIK, 6), held(CIK, 10), held(CIK, 11))

    _, status = fill_gaps(holdings, last_q=11)

    row = status.row(0, named=True)
    assert (row["first_q"], row["last_filed_q"], row["inactive"]) == (5, 11, False)
    assert segments_of(status) == [(5, 6), (10, 11)]


def test_latest_quarter_not_filed_yet_is_carried_and_the_fund_stays_active():
    holdings = held_frame(held(CIK, 10), held(CIK, 11, shares=7.0))

    filled, status = fill_gaps(holdings, last_q=12)

    q12 = filled.filter(pl.col("q") == 12)
    assert q12["shares"].to_list() == [7.0]
    assert q12["carried"].to_list() == [True]
    row = status.row(0, named=True)
    assert (row["last_filed_q"], row["inactive"]) == (11, False)
    assert segments_of(status) == [(10, 11)]


def test_no_filing_in_the_latest_two_quarters_is_inactive_and_not_carried():
    holdings = held_frame(held(CIK, 10))

    filled, status = fill_gaps(holdings, last_q=12)

    assert filled["q"].to_list() == [10]
    row = status.row(0, named=True)
    assert (row["last_filed_q"], row["inactive"]) == (10, True)
    assert segments_of(status) == [(10, 10)]


def test_fund_filed_in_the_latest_quarter_is_active():
    _, status = fill_gaps(held_frame(held(CIK, 12)), last_q=12)

    assert status["inactive"].to_list() == [False]


def test_funds_are_filled_independently():
    other = CIK + 1
    holdings = held_frame(held(CIK, 10), held(CIK, 12), held(other, 10), held(other, 11), held(other, 12))

    filled, status = fill_gaps(holdings, last_q=12)

    assert filled.filter(pl.col("cik") == other)["carried"].sum() == 0
    assert filled.filter(pl.col("cik") == CIK)["carried"].sum() == 1
    assert status["cik"].to_list() == [CIK, other]
    assert segments_of(status, other) == [(10, 12)]


def test_fill_gaps_output_schemas():
    filled, status = fill_gaps(held_frame(held(CIK, 10), held(CIK, 12)), last_q=12)

    assert filled.schema == HOLDINGS_SCHEMA
    assert status.schema == STATUS_SCHEMA


def test_fill_gaps_of_nothing_has_the_usual_schemas():
    filled, status = fill_gaps(held_frame(), last_q=12)

    assert (filled.height, status.height) == (0, 0)
    assert filled.schema == HOLDINGS_SCHEMA
    assert status.schema == STATUS_SCHEMA
