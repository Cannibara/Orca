"""The sector → industry → industry vertical hierarchy source (`orca/hierarchy/labels.txt`)."""

import pytest

from orca.hierarchy import Hierarchy, HierarchyError, Node, load, parse

# Every industry group in Damodaran's US file (Jan 2026). Each needs a default main label.
DAMODARAN_GROUPS = (
    "Advertising",
    "Aerospace/Defense",
    "Air Transport",
    "Apparel",
    "Auto & Truck",
    "Auto Parts",
    "Bank (Money Center)",
    "Banks (Regional)",
    "Beverage (Alcoholic)",
    "Beverage (Soft)",
    "Broadcasting",
    "Brokerage & Investment Banking",
    "Building Materials",
    "Business & Consumer Services",
    "Cable TV",
    "Chemical (Basic)",
    "Chemical (Diversified)",
    "Chemical (Specialty)",
    "Coal & Related Energy",
    "Computer Services",
    "Computers/Peripherals",
    "Construction Supplies",
    "Diversified",
    "Drugs (Biotechnology)",
    "Drugs (Pharmaceutical)",
    "Education",
    "Electrical Equipment",
    "Electronics (Consumer & Office)",
    "Electronics (General)",
    "Engineering/Construction",
    "Entertainment",
    "Environmental & Waste Services",
    "Farming/Agriculture",
    "Financial Svcs. (Non-bank & Insurance)",
    "Food Processing",
    "Food Wholesalers",
    "Furn/Home Furnishings",
    "Green & Renewable Energy",
    "Healthcare Products",
    "Healthcare Support Services",
    "Heathcare Information and Technology",
    "Homebuilding",
    "Hospitals/Healthcare Facilities",
    "Hotel/Gaming",
    "Household Products",
    "Information Services",
    "Insurance (General)",
    "Insurance (Life)",
    "Insurance (Prop/Cas.)",
    "Investments & Asset Management",
    "Machinery",
    "Metals & Mining",
    "Office Equipment & Services",
    "Oil/Gas (Integrated)",
    "Oil/Gas (Production and Exploration)",
    "Oil/Gas Distribution",
    "Oilfield Svcs/Equip.",
    "Packaging & Container",
    "Paper/Forest Products",
    "Power",
    "Precious Metals",
    "Publishing & Newspapers",
    "R.E.I.T.",
    "Real Estate (Development)",
    "Real Estate (General/Diversified)",
    "Real Estate (Operations & Services)",
    "Recreation",
    "Reinsurance",
    "Restaurant/Dining",
    "Retail (Automotive)",
    "Retail (Building Supply)",
    "Retail (Distributors)",
    "Retail (General)",
    "Retail (Grocery and Food)",
    "Retail (REITs)",
    "Retail (Special Lines)",
    "Rubber& Tires",
    "Semiconductor",
    "Semiconductor Equip",
    "Shipbuilding & Marine",
    "Shoe",
    "Software (Entertainment)",
    "Software (Internet)",
    "Software (System & Application)",
    "Steel",
    "Telecom (Wireless)",
    "Telecom. Equipment",
    "Telecom. Services",
    "Tobacco",
    "Transportation",
    "Transportation (Railroads)",
    "Trucking",
    "Utility (General)",
    "Utility (Water)",
)
SECTORS = [
    "Technology", "Communication", "Consumer", "Healthcare", "Financials", "Business Services",
    "Industrials", "Defence", "Materials", "Energy", "Utilities", "Property",
]  # fmt: skip


@pytest.fixture(scope="module")
def hierarchy() -> Hierarchy:
    return load()


def paths(nodes) -> list[str]:
    return [n.path for n in nodes]


def test_the_file_parses_and_has_the_owner_approved_sectors(hierarchy):
    assert hierarchy.sectors == SECTORS


def test_every_damodaran_group_has_a_default(hierarchy):
    assert sorted(hierarchy.defaults) == sorted(DAMODARAN_GROUPS)


def test_no_vertical_is_unused(hierarchy):
    """A vertical must have a stock placed in it, be a default or rule target, or be an umbrella."""
    used = set(hierarchy.main.values()) | set(hierarchy.defaults.values())
    used |= {n for nodes in hierarchy.extra.values() for n in nodes}
    used |= {n for _, _, n in hierarchy.rules} | {parent for parent, _ in hierarchy.umbrellas}
    assert [n.path for n in hierarchy.nodes if n not in used] == []


def test_every_industry_has_at_least_two_words_of_description_in_consumer_and_industrials(hierarchy):
    """The owner is least familiar with these two sectors, so each industry says what it is."""
    missing = [
        f"{s} > {i}"
        for s, i in hierarchy.industries
        if s in ("Consumer", "Industrials") and len(hierarchy.descriptions.get((s, i), "").split()) < 2
    ]
    assert missing == []


@pytest.mark.parametrize(
    ("ticker", "group", "main", "extras"),
    [
        # The owner's examples (chat, 2026-11-15/16).
        ("MU", "Semiconductor", "Technology > Semiconductors > Memory", []),
        ("VST", "Power", "Energy > Natural Gas > Power Producers", ["Energy > Nuclear > Power Producers"]),
        ("PLTR", "Software (System & Application)", "Technology > Software > Defence Systems Software", []),
        ("LDOS", "Business & Consumer Services", "Defence > Technology > Autonomous Systems", []),
        ("BAH", "Business & Consumer Services", "Business Services > Professional Services > Consulting & Advisory", []),
        ("TSLA", "Auto & Truck", "Industrials > Manufacturing > Carmakers", ["Industrials > Manufacturing > Automotive"]),
        ("COP", "Oil/Gas (Production and Exploration)", "Energy > Oil > Production", []),
    ],
)
def test_the_owners_examples(hierarchy, ticker, group, main, extras):
    got_main, got_extras, _ = hierarchy.label(ticker, group, "")
    assert got_main.path == main
    assert paths(got_extras) == extras


def test_alphabet_carries_all_five_labels(hierarchy):
    main, extras, how = hierarchy.label("GOOGL", "Software (Entertainment)", "Alphabet")
    assert main.path == "Technology > Software > Search & Advertising"
    assert how == "placed"
    assert sorted(paths(extras)) == sorted(
        [
            "Technology > Software > Cloud Infrastructure Provider",
            "Technology > Software > Consumer Services",
            "Technology > Software > Entertainment",
            "Communication > Entertainment > Streaming & Studios",
        ]
    )


def test_cvs_is_a_pharmacy_with_insurer_and_benefit_manager_extras(hierarchy):
    main, extras, _ = hierarchy.label("CVS", "Healthcare Support Services", "CVS Health")
    assert main.path == "Consumer > Retail > Pharmacies"
    assert sorted(paths(extras)) == [
        "Healthcare > Managed Care > Health Insurers",
        "Healthcare > Managed Care > Pharmacy Benefit Managers",
    ]


def test_shipbuilding_is_an_extra_label_only(hierarchy):
    shipbuilding = Node("Industrials", "Manufacturing", "Shipbuilding")
    assert shipbuilding not in set(hierarchy.main.values())
    assert shipbuilding in hierarchy.extra["HII"]
    assert hierarchy.label("HII", "Aerospace/Defense", "")[0].sector == "Defence"


def test_conglomerates_have_no_sector(hierarchy):
    main, _, _ = hierarchy.label("BRK.A", "Diversified", "Berkshire")
    assert main in hierarchy.nosector


def test_placed_beats_rule_beats_default(hierarchy):
    reit = "R.E.I.T."
    assert hierarchy.label("WELL", reit, "Welltower Inc.")[2] == "placed"
    main, _, how = hierarchy.label("ZZZZ", reit, "Example Apartment Trust")
    assert (main.path, how) == ("Property > REITs > Residential REITs", "rule")
    main, _, how = hierarchy.label("ZZZZ", reit, "Example Holdings")
    assert (main.path, how) == ("Property > REITs > Specialty & Diversified REITs", "default")


def test_a_group_without_a_default_is_a_key_error(hierarchy):
    with pytest.raises(KeyError):
        hierarchy.label("ZZZZ", "No Such Group", "")


def test_parse_reports_every_problem_at_once():
    text = """\
## Tech > Chips
Memory: MU AA
Logic: MU
+Memory: not-a-ticker
@default Semiconductor => Tech > Chips > Nowhere
@umbrella Tech > Chips > All <= Tech > Chips > Memory
+ Tech > Chips > Missing: AA
"""
    with pytest.raises(HierarchyError) as err:
        parse(text)
    message = str(err.value)
    assert "MU already has the main label Tech > Chips > Memory" in message
    assert "'not-a-ticker' is not a ticker" in message
    assert "Tech > Chips > Nowhere is not declared" in message
    assert "Tech > Chips > All is not declared" in message
    assert "Tech > Chips > Missing is not declared" in message


def test_a_line_before_any_header_is_an_error():
    with pytest.raises(HierarchyError, match="before the first"):
        parse("Memory: MU\n")


def test_umbrella_parent_is_added_to_members_of_each_child_only():
    h = parse(
        """\
## S > I
Parent:
Child A: AA
Child B: BB
Other: CC
@default G => S > I > Other
@umbrella S > I > Parent <= S > I > Child A ; S > I > Child B
"""
    )
    assert paths(h.label("AA", "G", "")[1]) == ["S > I > Parent"]
    assert paths(h.label("BB", "G", "")[1]) == ["S > I > Parent"]
    assert h.label("CC", "G", "")[1] == []
