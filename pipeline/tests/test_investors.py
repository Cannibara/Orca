from pathlib import Path

import pytest

from orca.famous import Famous, load_famous
from orca.investors import (
    ADV_CSV,
    BY_KEY,
    HAND_CSV,
    LEAVES,
    TYPES,
    Classifier,
    famous_types,
    from_name,
    from_sic,
    load_types,
)


def test_the_hierarchy_has_known_parents_and_two_levels_at_most():
    keys = [t.key for t in TYPES]
    assert len(keys) == len(set(keys))
    for t in TYPES:
        if t.parent is not None:
            assert BY_KEY[t.parent].parent is None  # a group's children are leaves
    assert "hedge" not in LEAVES and "hedge.macro" in LEAVES and "bank" in LEAVES and "other" in LEAVES


def test_the_kept_files_load():
    # a bad edit (a type that is no leaf, a fund twice) fails here rather than in a run
    hand, adv = load_types(HAND_CSV), load_types(ADV_CSV)
    assert len(hand) > 200 and len(adv) > 5000
    assert hand[2012383] == "am.etf" and hand[19617] == "bank"  # BlackRock, JPMorgan


def test_a_type_that_is_no_leaf_or_a_fund_twice_is_an_error(tmp_path: Path):
    bad = tmp_path / "t.csv"
    bad.write_text("fund_id,type,name\n1,hedge,X\n")
    with pytest.raises(ValueError, match="not a leaf"):
        load_types(bad)
    bad.write_text("fund_id,type,name\n1,bank,X\n1,ins,X\n")
    with pytest.raises(ValueError, match="twice"):
        load_types(bad)
    bad.write_text("fund_id,type,name\n# a comment,,\n2,bank,X\n")
    assert load_types(bad) == {2: "bank"}
    assert load_types(tmp_path / "missing.csv") == {}


@pytest.mark.parametrize(
    "name, kind",
    [
        ("California Public Employees Retirement System", "pension"),
        ("CANADA PENSION PLAN INVESTMENT BOARD", "pension"),
        ("Swiss National Bank", "swf"),  # a central bank before a bank
        ("NATIONAL BANK OF CANADA /FI/", "bank"),
        ("Teachers Insurance & Annuity Association", "ins"),  # an insurer before a pension
        ("YALE UNIVERSITY", "endow"),
        ("Smith Family Office LLC", "family"),
        ("ZIONS BANCORPORATION", "bank"),
        ("Cullen/Frost Bankers, Inc.", "bank"),
        ("Acme Wealth Partners", "am.wealth"),
        ("Acme Ventures III", "pevc.vc"),
        ("DRIFTBANK CAPITAL", None),  # a word must start where the listed one does
        ("Alpha Capital LLC", None),
    ],
)
def test_name_words(name, kind):
    assert from_name(name) == kind


@pytest.mark.parametrize(
    "sic, kind",
    [
        ("State Commercial Banks", "bank"),
        ("Security Brokers, Dealers & Flotation Companies", "bank"),
        ("Fire, Marine & Casualty Insurance", "ins"),
        ("Semiconductors & Related Devices", "corp"),  # Nvidia
        ("Services-Computer Programming, Data Processing, Etc.", "corp"),  # Alphabet
        ("Investment Advice", None),
        ("Real Estate Investment Trusts", None),
        ("", None),
        (None, None),
    ],
)
def test_industry_codes(sic, kind):
    assert from_sic(sic) == kind


def test_the_steps_in_order():
    famous = (
        Famous(1, "ONE", "", "Macro"),
        Famous(2, "TWO", "", "Value"),  # the register says mutual funds: that stands
        Famous(3, "THREE", "", "Tiger cubs"),  # the register says private equity: the style stands
        Famous(4, "FOUR", "", "Sovereign & pension funds"),
        Famous(5, "FIVE", "", "Sovereign & pension funds"),
        Famous(6, "SIX", "", "Big companies"),
        Famous(10, "PGGM", "Dutch healthcare workers' pension", "Sovereign & pension funds"),
        Famous(11, "TEMASEK", "Singapore's state investor", "Sovereign & pension funds"),
        Famous(1, "ONE", "", "Activists"),  # a second list: the first one counts
    )
    adv = {2: "am.mutual", 3: "pevc.pe", 7: "hedge.other", 8: "am.mutual"}
    c = Classifier(hand={7: "hedge.quant"}, famous=famous_types(famous, adv), adv=adv)
    assert c.type_of(1, "ONE LP") == ("hedge.macro", "famous")
    assert c.type_of(2, "TWO LP") == ("am.mutual", "adv")
    assert c.type_of(3, "THREE LP") == ("hedge.tiger", "famous")
    assert c.type_of(4, "Ohio Public Employees Retirement System") == ("pension", "famous")
    assert c.type_of(5, "Norges Bank") == ("swf", "famous")
    assert c.type_of(6, "SIX INC") == ("corp", "famous")
    assert c.type_of(10, "PGGM Investments") == ("pension", "famous")  # the list says pension; the name does not
    assert c.type_of(11, "Temasek Holdings (Private) Ltd") == ("swf", "famous")
    assert c.type_of(7, "SEVEN LP") == ("hedge.quant", "hand")
    assert c.type_of(8, "Defiance ETFs, LLC") == ("am.etf", "name")  # before the register
    assert c.type_of(9, "Nine Corp", "Semiconductors & Related Devices") == ("corp", "sic")
    assert c.type_of(9, "Nine Bancorp", "Investment Advice") == ("bank", "name")
    assert c.type_of(9, "Nine Capital") == ("other", "none")


def test_every_famous_list_maps_to_a_type():
    c = Classifier(hand={}, famous=famous_types(load_famous(), {}), adv={})
    for f in load_famous():
        kind, how = c.type_of(f.fund_id, f.manager or "x")
        assert how == "famous" and kind in LEAVES


def test_the_parent_firms_load_and_bad_lines_fail(tmp_path: Path):
    from orca.investors import PARENTS_CSV, load_parents

    parents = load_parents(PARENTS_CSV)
    assert parents[2100119] == parents[933478] == "Vanguard"
    bad = tmp_path / "p.csv"
    bad.write_text("fund_id,parent\n1,\n")
    with pytest.raises(ValueError, match="no parent"):
        load_parents(bad)
    bad.write_text("fund_id,parent\n1,A\n1,B\n")
    with pytest.raises(ValueError, match="twice"):
        load_parents(bad)
