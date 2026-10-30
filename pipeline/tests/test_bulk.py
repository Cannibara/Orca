import logging
import re
import zipfile
from datetime import date
from pathlib import Path

import httpx
import polars as pl
import pytest

from orca.http import Client
from orca.sec.bulk import COLUMNS, list_bulk_zips, parse_bulk_zip, value_to_usd

# The SEC headers are written out literally here (not taken from COLUMNS) so a wrong
# entry in COLUMNS fails these tests instead of agreeing with itself. The extra columns
# mimic the real files, which carry many fields we never read.

ORIGINAL = "0001111111-22-000001"
RESTATEMENT = "0002222222-24-000002"
NOTICE = "0003333333-23-000003"


def submission(accession, filed, form, cik, period):
    return {
        "ACCESSION_NUMBER": accession,
        "FILING_DATE": filed,
        "SUBMISSIONTYPE": form,
        "CIK": cik,
        "PERIODOFREPORT": period,
    }


def coverpage(accession, amendment_type, name, is_amendment="N"):
    return {
        "ACCESSION_NUMBER": accession,
        "REPORTCALENDARORQUARTER": "30-SEP-2022",
        "ISAMENDMENT": is_amendment,
        "AMENDMENTNO": "",
        "AMENDMENTTYPE": amendment_type,
        "FILINGMANAGER_NAME": name,
    }


def holding(accession, issuer, value, shares, sh_type="SH", put_call="", cusip="037833100"):
    return {
        "ACCESSION_NUMBER": accession,
        "INFOTABLE_SK": "1",
        "NAMEOFISSUER": issuer,
        "TITLEOFCLASS": "COM",
        "CUSIP": cusip,
        "FIGI": "",
        "VALUE": value,
        "SSHPRNAMT": shares,
        "SSHPRNAMTTYPE": sh_type,
        "PUTCALL": put_call,
        "INVESTMENTDISCRETION": "SOLE",
    }


SUBMISSIONS = [
    submission(ORIGINAL, "14-NOV-2022", "13F-HR", "0001111111", "30-SEP-2022"),
    submission(RESTATEMENT, "05-FEB-2024", "13F-HR/A", "0002222222", "31-DEC-2023"),
    submission(NOTICE, "10-MAR-2023", "13F-NT", "0003333333", "31-DEC-2022"),
]
COVERPAGES = [
    coverpage(ORIGINAL, "", "ALPHA CAPITAL LP"),
    coverpage(RESTATEMENT, "RESTATEMENT", "BETA PARTNERS LLC", is_amendment="Y"),
    coverpage(NOTICE, "", "GAMMA ADVISERS"),
]
INFOTABLE = [
    holding(ORIGINAL, "APPLE INC", "1500", "10"),
    holding(ORIGINAL, "TESLA INC", "2000", "20", put_call="Call"),
    holding(NOTICE, "NEVER SHOWN INC", "999", "1"),
    holding(RESTATEMENT, "MICROSOFT CORP", "7", "3", sh_type="PRN"),
]


def tsv(rows: list[dict]) -> str:
    header = list(rows[0])
    lines = ["\t".join(header)] + ["\t".join(r[h] for h in header) for r in rows]
    return "\n".join(lines) + "\n"


def make_zip(
    tmp_path: Path, submissions=None, coverpages=None, infotable=None, infotable_encoding="utf-8"
) -> Path:
    path = tmp_path / "form13f.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("SUBMISSION.tsv", tsv(SUBMISSIONS if submissions is None else submissions))
        z.writestr("COVERPAGE.tsv", tsv(COVERPAGES if coverpages is None else coverpages))
        z.writestr(
            "INFOTABLE.tsv",
            tsv(INFOTABLE if infotable is None else infotable).encode(infotable_encoding),
        )
    return path


def test_value_units_before_and_after_2023():
    assert value_to_usd(5, date(2022, 11, 14)) == 5000
    assert value_to_usd(5, date(2023, 1, 3)) == 5


def test_value_units_change_on_2023_01_03_exactly():
    assert value_to_usd(5, date(2023, 1, 2)) == 5000
    assert value_to_usd(5, date(2023, 1, 3)) == 5


def test_parse_bulk_zip(tmp_path):
    z = make_zip(tmp_path)  # SUBMISSION, COVERPAGE, INFOTABLE TSVs: 1 original, 1 restatement, 1 13F-NT
    filings, rows = parse_bulk_zip(z)
    assert set(filings["form"]) == {"13F-HR", "13F-HR/A"}  # 13F-NT dropped
    assert filings.filter(pl.col("form") == "13F-HR/A")["amendment_type"][0] == "restatement"
    assert rows["value_usd"].to_list() == [1_500_000.0, 2_000_000.0, 7.0]  # 1500 and 2000 (thousands, 2022 filing), 7 (dollars, 2024 filing)
    assert rows.filter(pl.col("put_call") == "CALL").height == 1


def test_filings_columns_and_values(tmp_path):
    filings, _ = parse_bulk_zip(make_zip(tmp_path))

    assert filings.schema == pl.Schema(
        {
            "accession": pl.String,
            "cik": pl.Int64,
            "period": pl.Int16,
            "filed": pl.Date,
            "form": pl.String,
            "amendment_type": pl.String,
            "manager_name": pl.String,
            "source": pl.String,
        }
    )
    assert filings.rows(named=True) == [
        {
            "accession": ORIGINAL,
            "cik": 1111111,
            "period": 38,  # Q3 2022
            "filed": date(2022, 11, 14),
            "form": "13F-HR",
            "amendment_type": None,
            "manager_name": "ALPHA CAPITAL LP",
            "source": "bulk",
        },
        {
            "accession": RESTATEMENT,
            "cik": 2222222,
            "period": 43,  # Q4 2023
            "filed": date(2024, 2, 5),
            "form": "13F-HR/A",
            "amendment_type": "restatement",
            "manager_name": "BETA PARTNERS LLC",
            "source": "bulk",
        },
    ]


def test_raw_holdings_columns_and_values(tmp_path):
    _, rows = parse_bulk_zip(make_zip(tmp_path))

    assert rows.schema == pl.Schema(
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
    assert rows.height == 3  # the 13F-NT row is gone
    assert rows.row(2, named=True) == {
        "accession": RESTATEMENT,
        "cusip": "037833100",
        "issuer": "MICROSOFT CORP",
        "title": "COM",
        "shares": 3.0,
        "sh_type": "PRN",
        "put_call": None,
        "value_usd": 7.0,
    }


@pytest.mark.parametrize("form", ["13F-NT", "13F-NT/A", "13F-CTR"])
def test_only_13f_hr_forms_are_kept(tmp_path, form):
    submissions = [
        submission(ORIGINAL, "14-NOV-2022", "13F-HR", "1111111", "30-SEP-2022"),
        submission(NOTICE, "10-MAR-2023", form, "3333333", "31-DEC-2022"),
    ]
    infotable = [
        holding(ORIGINAL, "APPLE INC", "1500", "10"),
        holding(NOTICE, "NEVER SHOWN INC", "999", "1"),
    ]
    filings, rows = parse_bulk_zip(make_zip(tmp_path, submissions, COVERPAGES, infotable))

    assert filings["accession"].to_list() == [ORIGINAL]
    assert rows["accession"].to_list() == [ORIGINAL]  # raw holdings of dropped filings are gone
    assert "NEVER SHOWN INC" not in rows["issuer"].to_list()


def test_amendment_types_are_normalised(tmp_path):
    accessions = [f"000000000{i}-23-00000{i}" for i in range(1, 6)]
    types = ["restatement", "NEW HOLDINGS", " New Holdings ", "SOMETHING ELSE", ""]
    submissions = [
        submission(a, "10-MAR-2023", "13F-HR/A", str(i), "31-DEC-2022")
        for i, a in enumerate(accessions, start=1)
    ]
    coverpages = [coverpage(a, t, f"FUND {i}") for i, (a, t) in enumerate(zip(accessions, types), 1)]
    infotable = [holding(accessions[0], "APPLE INC", "1", "1")]

    filings, _ = parse_bulk_zip(make_zip(tmp_path, submissions, coverpages, infotable))

    assert filings["amendment_type"].to_list() == [
        "restatement",
        "new_holdings",
        "new_holdings",
        None,
        None,
    ]


def test_put_call_and_share_type_are_normalised(tmp_path):
    infotable = [
        holding(ORIGINAL, "A", "1", "1", sh_type="sh", put_call="put"),
        holding(ORIGINAL, "B", "1", "1", sh_type="Prn", put_call=" CALL "),
        holding(ORIGINAL, "C", "1", "1", sh_type="SH", put_call=""),
    ]
    _, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable))

    assert rows["put_call"].to_list() == ["PUT", "CALL", None]
    assert rows["sh_type"].to_list() == ["SH", "PRN", "SH"]


@pytest.mark.parametrize("sh_type", ["XX", ""])
def test_holding_with_bad_share_type_is_dropped_and_counted(tmp_path, caplog, sh_type):
    infotable = [
        holding(ORIGINAL, "KEPT INC", "1500", "10"),
        holding(ORIGINAL, "BAD INC", "2000", "20", sh_type=sh_type),
    ]
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        filings, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable), stats=stats)

    assert rows["issuer"].to_list() == ["KEPT INC"]
    assert filings["accession"].to_list() == [ORIGINAL, RESTATEMENT]  # the filing itself stays
    assert stats == {"dropped_holdings": 1, "dropped_filings": 0}
    [record] = caplog.records
    assert "form13f.zip" in record.getMessage() and ORIGINAL in record.getMessage()


@pytest.mark.parametrize(
    "value, shares",
    [
        ("n/a", "20"),  # non-numeric VALUE
        ("", "20"),  # empty VALUE
        ("2000", ""),  # empty SSHPRNAMT
        ("2000", "1,000"),  # non-numeric SSHPRNAMT
    ],
    ids=["value-non-numeric", "value-empty", "shares-empty", "shares-non-numeric"],
)
def test_holding_with_unusable_value_or_shares_is_dropped_and_counted(
    tmp_path, caplog, value, shares
):
    infotable = [
        holding(ORIGINAL, "KEPT INC", "1500", "10"),
        holding(ORIGINAL, "BAD INC", value, shares),
        holding(RESTATEMENT, "ALSO KEPT INC", "7", "3"),
    ]
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        filings, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable), stats=stats)

    assert rows["issuer"].to_list() == ["KEPT INC", "ALSO KEPT INC"]
    assert rows["value_usd"].to_list() == [1_500_000.0, 7.0]
    assert filings["accession"].to_list() == [ORIGINAL, RESTATEMENT]  # the filing itself stays
    assert stats == {"dropped_holdings": 1, "dropped_filings": 0}
    [record] = caplog.records
    assert "form13f.zip" in record.getMessage() and ORIGINAL in record.getMessage()


def test_every_kind_of_bad_holding_is_counted_in_one_warning(tmp_path, caplog):
    infotable = [
        holding(ORIGINAL, "KEPT INC", "1500", "10"),
        holding(ORIGINAL, "BAD TYPE", "1", "1", sh_type="XX"),
        holding(ORIGINAL, "BAD VALUE", "n/a", "1"),
        holding(RESTATEMENT, "BAD SHARES", "1", ""),
    ]
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        _, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable), stats=stats)

    assert rows["issuer"].to_list() == ["KEPT INC"]
    assert stats == {"dropped_holdings": 3, "dropped_filings": 0}
    [record] = caplog.records
    assert ORIGINAL in record.getMessage() and RESTATEMENT in record.getMessage()


@pytest.mark.parametrize(
    "field, bad_value",
    [
        ("CIK", ""),
        ("FILING_DATE", ""),
        ("PERIODOFREPORT", ""),
        ("PERIODOFREPORT", "2022-09-30"),  # not DD-MON-YYYY
        ("CIK", "not-a-number"),
    ],
)
def test_filing_missing_cik_date_or_period_is_dropped_with_its_holdings(
    tmp_path, caplog, field, bad_value
):
    submissions = [{**SUBMISSIONS[0], field: bad_value}, SUBMISSIONS[1]]
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        filings, rows = parse_bulk_zip(
            make_zip(tmp_path, submissions, COVERPAGES, INFOTABLE), stats=stats
        )

    assert filings["accession"].to_list() == [RESTATEMENT]
    assert rows["accession"].to_list() == [RESTATEMENT]  # the two ORIGINAL holdings went too
    assert stats == {"dropped_holdings": 2, "dropped_filings": 1}
    [record] = caplog.records
    assert "form13f.zip" in record.getMessage() and ORIGINAL in record.getMessage()


def test_warning_names_at_most_five_accessions_but_stats_count_all(tmp_path, caplog):
    accessions = [f"0000000000-23-00000{i}" for i in range(7)]
    submissions = [
        submission(a, "10-MAR-2023", "13F-HR", "", "31-DEC-2022") for a in accessions  # no CIK
    ]
    infotable = [holding(a, "SOME INC", "1", "1") for a in accessions]
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        filings, rows = parse_bulk_zip(
            make_zip(tmp_path, submissions, COVERPAGES, infotable), stats=stats
        )

    assert filings.height == 0 and rows.height == 0
    assert stats == {"dropped_holdings": 7, "dropped_filings": 7}
    [record] = caplog.records  # one warning per ZIP
    assert len(re.findall(r"\d{10}-\d{2}-\d{6}", record.getMessage())) == 5


def test_clean_zip_reports_no_drops_and_logs_nothing(tmp_path, caplog):
    stats = {}
    with caplog.at_level(logging.WARNING, logger="orca.sec.bulk"):
        parse_bulk_zip(make_zip(tmp_path), stats=stats)

    assert stats == {"dropped_holdings": 0, "dropped_filings": 0}
    assert caplog.records == []  # 13F-NT filings are expected, not bad input


def test_value_unit_follows_filing_date_not_period(tmp_path):
    # Period Q4 2022, but filed after the switch to dollars.
    submissions = [submission(ORIGINAL, "14-FEB-2023", "13F-HR", "1111111", "31-DEC-2022")]
    infotable = [holding(ORIGINAL, "APPLE INC", "100", "10")]

    filings, rows = parse_bulk_zip(make_zip(tmp_path, submissions, COVERPAGES, infotable))

    assert filings["period"].to_list() == [39]  # Q4 2022
    assert rows["value_usd"].to_list() == [100.0]


def test_duplicate_coverpage_rows_do_not_duplicate_filings_or_holdings(tmp_path):
    coverpages = [*COVERPAGES, coverpage(ORIGINAL, "", "ALPHA CAPITAL LP (DUPLICATE ROW)")]

    filings, rows = parse_bulk_zip(make_zip(tmp_path, coverpages=coverpages))

    assert filings["accession"].to_list() == [ORIGINAL, RESTATEMENT]
    assert filings["manager_name"].to_list() == ["ALPHA CAPITAL LP", "BETA PARTNERS LLC"]  # first wins
    assert rows["value_usd"].to_list() == [1_500_000.0, 2_000_000.0, 7.0]


def test_non_utf8_byte_in_issuer_name_does_not_abort_the_parse(tmp_path):
    infotable = [
        holding(ORIGINAL, "CAF\u00e9 INC", "1500", "10"),
        holding(ORIGINAL, "PLAIN INC", "2000", "20"),
    ]

    _, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable, infotable_encoding="latin-1"))

    assert rows["issuer"].to_list() == ["CAF\ufffd INC", "PLAIN INC"]  # bad byte replaced
    assert rows["value_usd"].to_list() == [1_500_000.0, 2_000_000.0]


def test_zip_with_only_notices_gives_empty_frames_with_the_usual_columns(tmp_path):
    full_filings, full_rows = parse_bulk_zip(make_zip(tmp_path))
    only_notice = [SUBMISSIONS[2]]

    filings, rows = parse_bulk_zip(make_zip(tmp_path, only_notice))

    assert filings.height == 0 and rows.height == 0
    assert filings.schema == full_filings.schema
    assert rows.schema == full_rows.schema


def test_issuer_names_with_quotes_and_commas_survive(tmp_path):
    names = ['"A" HOLDINGS, INC', 'MAC 5" PIPE CO', 'TRAILING "']
    infotable = [holding(ORIGINAL, n, "1", "1") for n in names]
    _, rows = parse_bulk_zip(make_zip(tmp_path, infotable=infotable))

    assert rows["issuer"].to_list() == names


def test_missing_sec_header_is_reported(tmp_path):
    infotable = [{k: v for k, v in holding(ORIGINAL, "A", "1", "1").items() if k != "CUSIP"}]
    with pytest.raises(ValueError, match="INFOTABLE.*CUSIP"):
        parse_bulk_zip(make_zip(tmp_path, infotable=infotable))


def test_columns_map_our_names_to_sec_headers():
    assert COLUMNS["accession"] == "ACCESSION_NUMBER"
    assert COLUMNS["amendment_type"] == "AMENDMENTTYPE"
    assert COLUMNS["value"] == "VALUE"


DATASETS_PAGE = """
<html><body>
  <a href="/files/structureddata/data/form-13f-data-sets/01dec2022-28feb2023_form13f.zip">Q4</a>
  <a href="https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01mar2023-31may2023_form13f.zip">Q1</a>
  <a href="/files/structureddata/data/form-13f-data-sets/2022q3_FORM13F.ZIP">uppercase</a>
  <a href="/files/structureddata/data/form-13f-data-sets/01dec2022-28feb2023_form13f.zip">duplicate</a>
  <a href="/files/structureddata/data/form-13f-data-sets/form13f_readme.htm">readme</a>
  <a href="/files/structureddata/data/form-13f-data-sets/13f_list.pdf">pdf</a>
  <a href="https://elsewhere.example/stolen_form13f.zip">other host</a>
  <a>no href</a>
</body></html>
"""


def test_list_bulk_zips_returns_sorted_absolute_urls():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, text=DATASETS_PAGE)

    client = Client(10, {}, transport=httpx.MockTransport(handler), sleep=lambda s: None)

    urls = list_bulk_zips(client)

    base = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/"
    assert seen == ["https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"]
    assert urls == [
        base + "01dec2022-28feb2023_form13f.zip",
        base + "01mar2023-31may2023_form13f.zip",
        base + "2022q3_FORM13F.ZIP",
    ]
