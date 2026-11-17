"""Each security's hierarchy label as the pipeline reads it (`orca/hierarchy/assign.py`)."""

import csv
import io

import pytest

from orca.hierarchy import HierarchyError, assign, load, parse

TEXT = """## Tech > Chips
Memory: MU
Logic: INTC
## Tech > Software
Apps: MSFT
@default Semis => Tech > Chips > Logic
@default Software => Tech > Software > Apps
"""

HEADER = "stock_id,ticker,kind,vertical,extras,how,conf\n"


def rows(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(HEADER + text)))


def test_rows_resolve_to_hierarchy_labels_and_a_move_in_labels_txt_wins_for_placed_rows():
    h = parse(TEXT)
    labels = assign.resolve(rows("1,MU,stock,Tech > Chips > Logic,,placed,3\n2,ADBE,stock,Tech > Software > Apps,,default,\n"), h)
    assert labels[1].node.path == "Tech > Chips > Memory" and labels[1].how == "placed"  # MU was moved in labels.txt
    assert labels[2].node.path == "Tech > Software > Apps" and labels[2].how == "default"


def test_a_reused_ticker_does_not_drag_another_company_into_a_placement():
    # Orca keeps delisted tickers: stock 611 "AMT" is TD Ameritrade, not American Tower
    labels = assign.resolve(rows("611,MU,stock,Tech > Software > Apps,,model,3\n"), parse(TEXT))
    assert labels[611].node.path == "Tech > Software > Apps" and labels[611].how == "model"


def test_an_owner_edit_beats_labels_txt():
    h = parse(TEXT)
    labels = assign.resolve(rows("1,MU,stock,Tech > Software > Apps,,owner,\n"), h)
    assert labels[1].node.path == "Tech > Software > Apps" and labels[1].how == "owner"


def test_a_vertical_missing_from_labels_txt_is_an_error_listing_every_bad_row():
    with pytest.raises(HierarchyError) as err:
        assign.resolve(rows("1,AA,stock,Tech > Chips > Nope,,model,3\n2,BB,stock,Bad path,,model,3\n"), parse(TEXT))
    assert "1 AA" in str(err.value) and "2 BB" in str(err.value)


def test_regenerating_the_csv_keeps_owner_rows():
    old = rows("1,MU,stock,Tech > Software > Apps,,owner,\n2,ADBE,stock,Tech > Software > Apps,,default,\n")
    new = rows("1,MU,stock,Tech > Chips > Memory,,placed,3\n2,ADBE,stock,Tech > Chips > Logic,,model,3\n3,X,stock,Tech > Chips > Logic,,default,\n")
    merged = {r["stock_id"]: r for r in assign.merge_rows(old, new)}
    assert merged["1"]["how"] == "owner" and merged["1"]["vertical"] == "Tech > Software > Apps"
    assert merged["2"]["how"] == "model" and set(merged) == {"1", "2", "3"}


def test_the_ticker_guard_flags_ids_whose_ticker_changed():
    labels = assign.resolve(rows("1,MU,stock,Tech > Chips > Memory,,placed,3\n2,ADBE,stock,Tech > Software > Apps,,default,\n"), parse(TEXT))
    assert assign.ticker_mismatches(labels, {1: "MU", 2: "XYZ", 3: "NEW"}) == [(2, "ADBE", "XYZ")]


def test_sic_fallback_tries_four_then_three_then_two_digits():
    h = parse(TEXT)
    table = assign.SicTable({"3674": h.nodes[0], "737": h.nodes[2], "36": h.nodes[1]})
    assert table.label(3674).path == "Tech > Chips > Memory"
    assert table.label(7372).path == "Tech > Software > Apps"
    assert table.label(3600).path == "Tech > Chips > Logic"
    assert table.label(1000) is None and table.label(None) is None


def test_label_of_prefers_the_csv_then_the_sic_table():
    h = parse(TEXT)
    labels = assign.resolve(rows("1,MU,stock,Tech > Chips > Memory,,placed,3\n"), h)
    sic = assign.SicTable({"7372": h.nodes[2]})
    assert assign.label_of(1, 7372, labels, sic) == (h.nodes[0], "placed")
    assert assign.label_of(2, 7372, labels, sic) == (h.nodes[2], "sic")
    assert assign.label_of(3, None, labels, sic) == (None, "")


def test_etf_rows_give_a_tier_and_a_label_path_or_neutral():
    h = parse(TEXT)
    text = "stock_id,ticker,class,level,node,leverage,conf\n7,SOXX,sector,industry,Tech > Chips,,3\n8,SPY,broad,,,,3\n9,BAD,sector,industry,Nope > X,,3\n"
    etfs, problems = assign.read_etf_labels(io.StringIO(text), h)
    assert etfs[7] == assign.EtfLabel("sector", "industry", "Tech > Chips", "SOXX")
    assert etfs[8] == assign.EtfLabel("broad", "", "", "SPY")
    assert 9 not in etfs and problems == ["9 BAD: no hierarchy label 'Nope > X' at tier industry"]


def test_the_committed_files_load_cleanly_against_labels_txt():
    h = load()
    labels = assign.load_stock_labels(h=h)
    assert len(labels) > 5000
    etfs, problems = assign.read_etf_labels(open(assign.ETF_FILE, newline=""), h)
    assert problems == [] and sum(e.cls == "sector" for e in etfs.values()) >= 90
    assert labels[246].node.vertical == "Memory"  # Micron
    assert assign.SicTable.load(h=h).label(3674).industry == "Semiconductors"


def test_committed_placed_rows_agree_with_labels_txt():
    h = load()
    with open(assign.STOCK_FILE, newline="") as f:
        placed = [r for r in csv.DictReader(f) if r["how"] == "placed" and r["ticker"] in h.main]
    assert [r["stock_id"] for r in placed if h.main[r["ticker"]].path != r["vertical"]] == []


def test_the_sic_table_takes_the_most_common_vertical_per_code_and_prefix():
    h = parse(TEXT)
    memory, logic, apps = h.nodes
    firms = [("3674", memory), ("3674", memory), ("3674", logic), ("3672", logic), ("3672", logic), ("7372", apps)]
    table = assign.build_sic_table(firms, min_firms=2)
    assert table["3674"] == memory and table["3672"] == logic
    assert table["367"] == logic and table["36"] == logic  # 3 logic vs 2 memory
    assert "7372" not in table and "73" not in table  # one firm is too few to trust


def test_a_leveraged_sector_etf_is_neutral():
    text = "stock_id,ticker,class,level,node,leverage,conf\n2905,SOXL,sector,industry,Tech > Chips,3x,3\n"
    etfs, problems = assign.read_etf_labels(io.StringIO(text), parse(TEXT))
    assert etfs[2905] == assign.EtfLabel("leveraged", "", "", "SOXL") and problems == []


def test_moves_lists_each_relabelled_stock_and_the_hierarchy_labels_it_touches():
    h = parse(TEXT)
    before = assign.resolve(rows("1,AA,stock,Tech > Chips > Logic,,model,3\n2,BB,stock,Tech > Software > Apps,,model,3\n"), h)
    after = assign.resolve(rows("1,AA,stock,Tech > Chips > Memory,,owner,\n2,BB,stock,Tech > Software > Apps,,model,3\n3,CC,stock,Tech > Software > Apps,,default,\n"), h)
    moved, touched = assign.moves(before, after)
    assert moved == [(1, "AA", "Tech > Chips > Logic", "Tech > Chips > Memory"), (3, "CC", "", "Tech > Software > Apps")]
    assert touched == ["Tech", "Tech > Chips", "Tech > Chips > Logic", "Tech > Chips > Memory", "Tech > Software", "Tech > Software > Apps"]
