"""The data the review page reads for the stocks a set of funds owned (`make_review_page.add_top`)."""

import importlib.util
from pathlib import Path

_PATH = Path(__file__).parents[1] / "orca" / "hierarchy" / "tools" / "make_review_page.py"
_spec = importlib.util.spec_from_file_location("make_review_page", _PATH)
page = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(page)

MEMORY, OTHER, OIL = "Technology > Semiconductors > Memory", "Technology > Semiconductors > Other Semiconductors", "Energy > Oil > Production"


def data():
    return {
        "sec": ["Technology", "Energy"],
        "ind": [[0, "Semiconductors"], [1, "Oil"]],
        "sub": [[0, "Memory", 0], [0, "Other Semiconductors", 0], [1, "Production", 0]],
        "groups": ["Semiconductor", "Oil/Gas (Production and Exploration)"],
        # ticker, name, cap $bn, group, sic, ff48, main, extras, how
        "st": [["MU", "Micron", 100.0, 0, "3674", "Chips", 0, [], 2], ["XOM", "Exxon", 400.0, 1, "2911", "Oil", 2, [], 0]],
    }


def row(sid, ticker, **kw):
    base = {"stock_id": sid, "ticker": ticker, "name": f"NAME {ticker}", "kind": "stock", "tier": "auto", "main": None, "extras": [],
            "src": None, "how": None, "conf": None, "note": "", "invested": 5_000_000}  # fmt: skip
    return base | kw


def ref(ticker, exchange="NYSE", group="Semiconductor"):
    return {"name": "N", "exchange": exchange, "ticker": ticker, "country": "United States", "group": group}


UNIVERSE = {i: {"stock_id": i, "invested": 5_000_000, "n_funds": 2, "funds": [10 + i, 99]} for i in range(1, 8)}
FUNDS = {"period": "max", "eligible": [{"fund_id": 99, "name": "A FUND", "ann_return": 0.2, "book": 1e9, "n_positions": 5}, {"fund_id": 98, "name": "B", "ann_return": 0.1, "book": 1e9, "n_positions": 5}]}


def test_a_listed_stock_gains_the_dollars_and_funds_and_an_unlisted_one_is_appended():
    d = data()
    final = [
        row(1, "MU", main=MEMORY, src="hierarchy", how="placed", conf=3, ref=ref("MU")),  # already on the US list
        row(2, "MU2", main=MEMORY, src="hierarchy", how="placed", conf=3, ref=ref("MU")),  # a second Orca line for it
        row(3, "RY", main=OIL, src="hierarchy", how="default", conf=3, ref=ref("RY", "TSX", "Oil/Gas (Production and Exploration)")),
        row(4, "NEW", main=OTHER, src="model", how="model", conf=2, ref=ref("ZZZ")),
    ]
    page.add_top(d, final, UNIVERSE, FUNDS)
    mu = d["st"][0]
    assert mu[9] == 10.0 and mu[10] == 3 and mu[13] == "MU2"  # $10m, funds {11, 12, 99}, the other Orca ticker
    assert len(d["st"]) == 4 and [r[0] for r in d["st"][2:]] == ["RY", "NEW"]
    ry, new = d["st"][2], d["st"][3]
    assert (ry[2], ry[3], ry[6], ry[8], ry[11]) == (0, 1, 2, 0, 1)  # unlisted, group kept, default, matched elsewhere
    assert (new[3], new[6], new[8], new[11], new[12]) == (-1, 1, 3, 2, 2)  # a model's pick shows none of the wrong match's group
    assert all(len(r) == 15 for r in d["st"])


def test_a_replaced_group_default_changes_the_listed_stock_and_says_what_it_was():
    d = data()
    final = [row(1, "XOM", main=MEMORY, src="model", how="model", conf=3, was=OIL, extras=[OTHER], ref=ref("XOM", group="Oil/Gas (Production and Exploration)"))]
    page.add_top(d, final, UNIVERSE, FUNDS)
    xom = d["st"][1]
    assert (xom[6], xom[7], xom[8], xom[12], xom[14]) == (0, [1], 3, 3, "Oil › Production")
    assert len(d["st"]) == 2  # no second row


def test_unlabelled_stocks_go_to_the_not_labelled_list_biggest_first_and_the_funds_are_listed():
    d = data()
    final = [row(1, "SPY", kind="etf", tier="etf"), row(2, "BND", kind="fund", note="bond fund"), row(3, "MU", main=MEMORY, src="hierarchy", how="placed", conf=3, ref=ref("MU"))]
    final[1]["invested"] = 9_000_000
    uni = UNIVERSE | {2: UNIVERSE[2] | {"invested": 9_000_000}}
    page.add_top(d, final, uni, FUNDS)
    assert [r[1] for r in d["nl"]] == ["BND", "SPY"] and d["nl"][0][5] == "fund" and d["nl"][0][3] == 9.0
    assert len(d["st"]) == 2  # the unlabelled ones never become rows
    assert d["top"]["period"] == "by return since start" and [f[0] for f in d["top"]["funds"]] == [99, 98][: len({f for u in uni.values() for f in u["funds"]})]


def test_a_ticker_that_is_already_taken_gets_the_stock_id_added():
    d = data()
    final = [row(5, "MU", main=OIL, src="model", how="model", conf=3)]  # another company with the same ticker: no ref, so not matched
    page.add_top(d, final, UNIVERSE, FUNDS)
    assert d["st"][-1][0] == "MU~5" and d["st"][0][9] == 0


def test_etfs_show_what_a_model_made_of_them_and_are_counted_by_class():
    d = data()
    etf = {"k": "sector", "label": "sector ETF", "c": 3, "note": "", "lv": "industry", "path": "Technology > Semiconductors", "lev": "3x"}
    final = [row(1, "SOXL", kind="etf", tier="etf", etf=etf), row(2, "SPY", kind="etf", tier="etf", etf={"k": "broad", "label": "US stocks, broad", "c": 3, "note": ""}), row(3, "ZZZ", kind="etf", tier="etf")]
    page.add_top(d, final, UNIVERSE, FUNDS)
    notes = {r[1]: r[7] for r in d["nl"]}
    assert notes == {"SOXL": "sector ETF → Technology › Semiconductors (industry), 3x", "SPY": "US stocks, broad", "ZZZ": ""}
    assert d["etf"] == {"sector ETF": [1, 5.0], "US stocks, broad": [1, 5.0]}  # an unclassified ETF is in neither count
    rule = next(r for r in page.rules(d | {"L3": "x"}) if r["id"] == "R12")
    assert "Classified so far" in rule["ev"] and "sector ETF 1" in rule["ev"]


def test_the_csv_has_one_row_per_stock_in_the_column_order():
    spec = importlib.util.spec_from_file_location("export_labels", Path(__file__).parents[1] / "orca" / "hierarchy" / "tools" / "export_labels.py")
    export = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(export)
    etf = {"k": "sector", "label": "sector ETF", "lv": "industry", "path": "Technology > Semiconductors", "lev": "3x"}
    final = [
        row(1, "MU", main=MEMORY, extras=[OTHER], src="hierarchy", how="placed", conf=3, ref=ref("MU")),
        row(2, "SOXL", kind="etf", tier="etf", etf=etf, invested=9_000_000),
    ]
    rows = export.csv_rows(final, UNIVERSE)
    assert [r[1] for r in rows] == ["SOXL", "MU"]  # biggest dollars first
    by = dict(zip(export.COLUMNS, rows[1]))
    assert (by["sector"], by["industry"], by["industry_vertical"], by["extra_labels"], by["source"], by["n_top_funds"]) == ("Technology", "Semiconductors", "Memory", OTHER, "hierarchy", 2)
    etf_row_ = dict(zip(export.COLUMNS, rows[0]))
    assert (etf_row_["source"], etf_row_["etf_label"], etf_row_["etf_level"], etf_row_["etf_leverage"], etf_row_["sector"]) == ("ETF", "Technology › Semiconductors", "industry", "3x", "")
    assert all(len(r) == len(export.COLUMNS) for r in rows)
