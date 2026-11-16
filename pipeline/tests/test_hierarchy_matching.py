"""Name matching of Orca's securities to a reference list of companies (`orca/hierarchy/matching.py`)."""

import pytest

from orca.hierarchy.matching import Matcher, Ref, abbreviates, kind, tier, tokens

REFS = [
    Ref("Alphabet Inc.", "NasdaqGS", "GOOGL", "United States", "Software (Entertainment)"),
    Ref("Taiwan Semiconductor Co., Ltd.", "TPEX", "5425", "Taiwan", "Semiconductor"),
    Ref("Taiwan Semiconductor Manufacturing Company Limited", "TWSE", "2330", "Taiwan", "Semiconductor"),
    Ref("Enbridge Inc.", "TSX", "ENB", "Canada", "Oil/Gas Distribution"),
    Ref("NBT Bancorp Inc.", "NasdaqGS", "NBTB", "United States", "Banks (Regional)"),
    Ref("S&T Bancorp, Inc.", "NasdaqGS", "STBA", "United States", "Banks (Regional)"),
    Ref("The Estée Lauder Companies Inc.", "NYSE", "EL", "United States", "Household Products"),
    Ref("Intercontinental Exchange, Inc.", "NYSE", "ICE", "United States", "Brokerage & Investment Banking"),
    Ref("Cadence Design Systems, Inc.", "NasdaqGS", "CDNS", "United States", "Software (System & Application)"),
    Ref("BP p.l.c.", "LSE", "BP.", "United Kingdom", "Oil/Gas (Integrated)"),
    Ref("B&P Co.,Ltd.", "TSE", "7804", "Japan", "Construction Supplies"),
    Ref("First Bancorp", "NasdaqGS", "FBNC", "United States", "Banks (Regional)"),
    Ref("Roku, Inc.", "NasdaqGS", "ROKU", "United States", "Entertainment"),
    *[Ref(f"Filler {i} Bancorp Inc.", "NYSE", f"FB{i}", "United States", "Banks (Regional)") for i in range(30)],
]


@pytest.fixture(scope="module")
def matcher() -> Matcher:
    return Matcher(REFS)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ALPHABET INC-CL C", ["ALPHABET"]),
        ("N B T BANCORP INC", ["NBT", "BANCORP"]),  # initials stay one word
        ("S&T Bancorp, Inc.", ["ST", "BANCORP"]),
        ("BP p.l.c.", ["BP"]),  # the legal form is noise even when it is spelled with dots
        ("The Estée Lauder Companies Inc.", ["ESTEE", "LAUDER", "COMPANIES"]),
        ("TAIWAN SEMICONDUCTOR-SP ADR", ["TAIWAN", "SEMICONDUCTOR"]),
        ("SHERWIN-WILLIAMS CO/THE", ["SHERWIN", "WILLIAMS"]),
        ("INC CORP LTD", []),
    ],
)
def test_tokens(name, expected):
    assert tokens(name) == expected


def test_a_name_cut_at_28_characters_loses_its_cut_legal_form():
    assert tokens("INTERCONTINENTAL EXCHANGE IN", truncated=True) == ["INTERCONTINENTAL", "EXCHANGE"]
    assert tokens("INTERCONTINENTAL EXCHANGE IN") == ["INTERCONTINENTAL", "EXCHANGE", "IN"]


@pytest.mark.parametrize(
    ("a", "b", "yes"),
    [
        ("INTL", "INTERNATIONAL", True),
        ("HLDGS", "HOLDINGS", True),
        ("MACHIN", "MACHINES", True),
        ("SYS", "SYSTEMS", True),
        ("MACHINES", "MACHINES", True),
        ("ABD", "ABC", False),
        ("TEC", "ATEC", False),  # the first letters must agree
        ("SYSTEMS", "SYS", False),  # only the shorter word can be the abbreviation
        ("AB", "ABC", False),  # two letters say nothing
    ],
)
def test_abbreviates(a, b, yes):
    assert abbreviates(a, b) is yes


def test_the_same_company_under_a_bloomberg_name_is_an_auto_match(matcher):
    best = matcher.match("ALPHABET INC-CL C", "GOOG")[0]
    assert best.ref.ticker == "GOOGL" and best.strong
    assert tier(best) == "auto"


def test_accents_and_abbreviations_do_not_stop_a_match(matcher):
    assert matcher.match("ESTEE LAUDER COMPANIES-CL A", "EL")[0].ref.ticker == "EL"
    assert matcher.match("CADENCE DESIGN SYS INC", "CDNS")[0].ref.ticker == "CDNS"


def test_a_truncated_name_still_matches(matcher):
    best = matcher.match("INTERCONTINENTAL EXCHANGE IN", "ICE")[0]
    assert best.ref.ticker == "ICE" and tier(best) == "auto"


def test_initials_are_not_mistaken_for_another_bank(matcher):
    best = matcher.match("N B T BANCORP INC", "NBTB")[0]
    assert best.ref.ticker == "NBTB"
    assert all(c.ref.ticker != "STBA" for c in matcher.match("N B T BANCORP INC", "NBTB")[:1])


def test_one_common_word_is_not_a_match(matcher):
    best = matcher.match("ZZZ BANCORP INC", "ZZZ")
    assert not best or not best[0].strong
    assert not best or tier(best[0]) != "auto"


def test_a_cross_listing_under_the_same_ticker_is_auto_but_an_adr_under_another_is_verify(matcher):
    enb = matcher.match("ENBRIDGE INC", "ENB")[0]
    assert not enb.ref.us and enb.ticker_equal and tier(enb) == "auto"
    tsm = matcher.match("TAIWAN SEMICONDUCTOR-SP ADR", "TSM")
    assert tier(tsm[0]) == "verify"  # two Taiwanese companies share the name: a person must pick


def test_p_l_c_does_not_pull_a_name_toward_another_company(matcher):
    best = matcher.match("BP PLC-SPONS ADR", "BP")[0]
    assert best.ref.name == "BP p.l.c."  # not B&P Co., whose initials also read BP
    assert tier(best) == "auto"  # same ticker as the London line


def test_a_name_with_nothing_close_is_none(matcher):
    assert tier(None) == "none"
    cands = matcher.match("COMPLETELY UNKNOWN BIOTHERAPEUTICS", "XXXX")
    assert not cands or tier(cands[0]) == "none"
    assert matcher.match("INC CORP", "") == []


@pytest.mark.parametrize(
    ("ticker", "sector", "expected"),
    [
        ("SPY", "ETF/Fund", "etf"),
        ("D 6 07-01-16 B", "Other", "bond"),
        ("T 3-375 11-30-27", "Other", "bond"),
        ("FMMMX", "Other", "fund"),
        ("AAPL", "Tech", "stock"),
        ("EA*", "Other", "stock"),
        ("BRK-B", "Financials", "stock"),
    ],
)
def test_kind(ticker, sector, expected):
    assert kind(ticker, sector) == expected
