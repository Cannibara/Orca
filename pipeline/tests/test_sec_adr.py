"""Ordinary shares per ADS from a 20-F (`orca/sec/adr.py`) and the run step that keeps them (`adr_ratios`)."""

from datetime import date

import polars as pl
import pytest

from orca.http import FetchError
from orca.run.budget import Budget
from orca.run.sectors_step import adr_ratios, update_adr_ratios
from orca.sec.adr import SCHEMA, Adr, fetch_adr, ratio_in, ratios, text_of
from orca.storage import Lake


def title(text: str) -> str:
    return f'<ix:nonNumeric contextRef="c" name="dei:Security12bTitle" id="t"><span>{text}</span></ix:nonNumeric>'


@pytest.mark.parametrize(
    ("doc", "want", "source"),
    [
        # Ecopetrol's cover: "Depository", and a parenthesis before the ratio
        (title("American Depository Shares (as evidenced by American Depository Receipts), each representing 20 common shares par value COP&#160;609 per share"), 20.0, "cover"),
        (title("ADS, each representing the right to receive 400 Shares of Common Stock without par value"), 400.0, "cover"),  # Banco Santander-Chile
        (title("American Depositary Shares, each three representing one Class A common share"), 0.3333, "cover"),  # TAL
        ("<p>Each ADS represents four ordinary shares.</p>", 4.0, "text"),  # Lloyds states it only in its text
        ("<p>The ADSs, each representing one-half of one ordinary share, trade on NYSE.</p>", 0.5, "text"),
        ("<p>Three American Depositary Shares represent one Class A common share.</p>", 0.3333, "text"),
        ("<p>the American Depositary Shares, each American Depositary Share representing 3/5 of one share of the registrant’s common stock</p>", 0.6, "text"),  # SMFG
    ],
)  # fmt: skip
def test_the_ratio_is_read_from_the_cover_titles_or_the_text(doc, want, source):
    assert ratio_in(doc) == (pytest.approx(want), source)


def test_a_share_of_capital_or_an_old_ratio_is_not_taken_for_the_ratio():
    # AstraZeneca: "holders of ADSs, representing 18.3% of the issued share capital" is no ratio
    assert ratio_in("<p>4,598 registered holders of ADSs, representing 18.3% of the issued share capital.</p>") == (None, None)
    # TAL: the old ratio is stated once, the current one more often
    text = text_of(
        "<p>On August 16, 2017, the ratio was changed from one ADS representing two Class A common shares to three ADSs "
        "representing one Class A common share.</p><p>Our ADSs, each three representing one Class A common share, are listed.</p>"
    )
    assert ratios(text).most_common(1)[0][0] == pytest.approx(0.3333)


class FakeSec:
    def __init__(self, pages: dict[str, object]):
        self.pages, self.asked = pages, []

    def get(self, url):
        self.asked.append(url)
        page = self.pages.get(url)
        if page is None:
            raise FetchError(url, 404)
        return type("R", (), {"json": lambda _self: page, "text": page if isinstance(page, str) else ""})()


SUB = "https://data.sec.gov/submissions/CIK0000000042.json"
FOLDER = "https://www.sec.gov/Archives/edgar/data/42/000004226000001"
RECENT = {"filings": {"recent": {"form": ["6-K", "20-F", "20-F"], "accessionNumber": ["x", "0000042-26-000001", "0000042-25-000001"],
                                 "filingDate": ["2026-05-01", "2026-03-01", "2025-03-01"], "primaryDocument": ["a.htm", "f20.htm", "old.htm"]}}}  # fmt: skip


def test_the_lookup_reads_the_newest_20f_cover_first_then_the_document():
    sec = FakeSec({SUB: RECENT, f"{FOLDER}/R1.htm": "<td>American Depositary Shares, each representing 5 ordinary shares</td>"})
    assert fetch_adr(sec, 42) == Adr("20-F", date(2026, 3, 1), 5.0, "cover")
    sec = FakeSec({SUB: RECENT, f"{FOLDER}/f20.htm": "<p>Each ADS represents ten ordinary shares.</p>"})  # no rendered cover
    assert fetch_adr(sec, 42) == Adr("20-F", date(2026, 3, 1), 10.0, "text") and len(sec.asked) == 3
    no_20f = {"filings": {"recent": {"form": ["10-K"], "accessionNumber": ["a"], "filingDate": ["2026-02-01"], "primaryDocument": ["k.htm"]}}}
    assert fetch_adr(FakeSec({SUB: no_20f}), 42) == Adr(None, None, None, None)
    assert fetch_adr(FakeSec({}), 42) == Adr(None, None, None, None)  # the SEC does not know the CIK


def test_the_step_asks_the_biggest_first_keeps_a_year_and_the_csv_wins(tmp_path):
    lake = Lake(tmp_path / "lake")
    securities = pl.DataFrame({"stock_id": [1, 2, 3, 4], "ticker": ["BSAC", "AAPL", "TINY", "SOXX"], "cik": [100, 200, 300, 400],
                               "sector": ["Financials", "Tech", "Tech", "ETF/Fund"], "shares_out": [188e9, 15e9, 1e6, 1e8]})  # fmt: skip
    lake.write("stock_quarters", pl.DataFrame({"stock_id": [1, 2, 3], "q": [54, 54, 54], "close": [25.0, 200.0, 1.0]}))
    asked = []

    def fetch(cik):
        asked.append(cik)
        if cik == 300:
            raise FetchError("u", 500)
        return Adr("20-F", date(2026, 3, 1), 400.0, "cover") if cik == 100 else Adr(None, None, None, None)

    flags: list = []
    stats = update_adr_ratios(lake, fetch, securities, flags, Budget(60), today=date(2026, 11, 24), max_calls=10)
    assert asked == [100, 200, 300]  # biggest by count x close (an ADR's ordinary count ranks it high); no ETF
    assert stats == {"companies": 2, "owed": 0, "filers": 1, "ratios": 1} and flags == [{"type": "adr_lookup_failed", "count": 1}]
    assert lake.read("adr_ratios").cast(SCHEMA).height == 2
    asked.clear()
    update_adr_ratios(lake, fetch, securities, [], Budget(60), today=date(2026, 12, 1), max_calls=10)
    assert asked == [300]  # the others are fresh for a year; the failed one is asked again
    assert adr_ratios(lake, securities, {"TSM": 5.0}) == {"BSAC": 400.0, "TSM": 5.0}
    assert adr_ratios(lake, securities, {"BSAC": 1039.0})["BSAC"] == 1039.0  # a hand correction wins
