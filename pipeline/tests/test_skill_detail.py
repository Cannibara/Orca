"""The fund-page detail of the replays (`orca/engine/skill_detail.py`), checked by hand."""

import polars as pl
import pytest

from orca.engine import skill
from orca.engine import skill_detail as sd
from orca.engine.sectors import MARKET, OUT_SCHEMA

A = "Tech > Chips > Memory"
B = "Energy > Oil > Drillers"


def trades(rows):
    """rows: (cik, stock_id, q, delta, px, shares_after)."""
    cols = ["cik", "stock_id", "q", "delta", "px", "shares_after"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows], schema=skill.TRADES_SCHEMA)


def series(rows):
    """rows: (key, q, level_avg, level_end)."""
    cols = ["key", "q", "level_avg", "level_end"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows], schema=skill.SERIES_SCHEMA)


def replayed(t, s, last_q):
    t = t.with_columns(key=pl.lit("X"), tier=pl.lit(1, pl.Int8), variant=pl.lit("fund"))
    _, _, units = skill.replay(t, s, last_q, by=("tier", "variant"), units=True)
    v = sd.quarter_values(units, s, last_q)
    first = pl.DataFrame({"cik": [1], "first_q": [t["q"].min()]}, schema={"cik": pl.Int64, "first_q": pl.Int32})
    return {r["q"]: r for r in sd.quarter_returns(v, first, last_q).iter_rows(named=True)}


def test_a_held_position_is_worth_its_units_at_each_quarter_end_and_earns_the_series_return():
    s = series([("X", 10, 1.0, 1.1), ("X", 11, 1.2, 1.3), ("X", 12, 1.3, 1.2), ("X", 13, 1.4, 1.5)])
    q = replayed(trades([(1, 7, 10, 10.0, 10.0, 10.0)]), s, last_q=13)  # $100 buys 100 units at 1.0
    assert [round(q[i]["v"], 9) for i in (10, 11, 12, 13)] == [110.0, 130.0, 120.0, 150.0]
    assert q[10]["r"] == pytest.approx(0.1)  # from the buy at 1.0 to the end at 1.1
    assert q[11]["r"] == pytest.approx(1.3 / 1.1 - 1) and q[13]["r"] == pytest.approx(1.5 / 1.2 - 1)


def test_money_in_or_out_never_moves_the_return_even_a_sell_out():
    s = series([("X", 10, 1.0, 1.0), ("X", 11, 1.2, 1.5), ("X", 12, 2.0, 2.0), ("X", 13, 3.0, 3.0)])
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 11, 30.0, 10.0, 40.0), (1, 7, 12, -40.0, 10.0, 0.0)])
    q = replayed(t, s, last_q=13)
    assert q[11]["r"] == pytest.approx(0.5)  # the series' own quarter: 1.0 -> 1.5, whatever was added at 1.2
    assert q[12]["r"] == pytest.approx(2.0 / 1.5 - 1)  # all sold at 2.0: the quarter up to the sale
    assert q[13]["r"] is None and q[13]["v"] == 0.0


def test_a_stock_without_a_price_keeps_its_last_level():
    s = series([("X", 10, 1.0, 1.0), ("X", 11, 1.0, 2.0)])  # no row after q11 (halted)
    q = replayed(trades([(1, 7, 10, 10.0, 10.0, 10.0)]), s, last_q=13)
    assert q[13]["v"] == pytest.approx(200.0) and q[13]["r"] == pytest.approx(0.0)


def test_years_chain_the_quarters_and_take_the_summary_labels():
    rows = [{"cik": 1, "tier": 1, "variant": "fund", "q": q, "v": 1.0, "r": r} for q, r in ((5, 0.1), (6, 0.1), (7, None), (8, 0.5))]
    y = sd.year_returns(pl.DataFrame(rows)).rows(named=True)
    assert [(r["name"], r["ret"]) for r in y] == [("2014 Q2–Q4", pytest.approx(0.21)), ("2015 Q1", pytest.approx(0.5))]


def label_rows(label, tier, levels, cap=1.0):
    return [{"label": label, "tier": tier, "q": q, "ret": 0.0, "level_avg": la, "level_end": le, "n": 1, "cap": cap, "top_weight": 1.0}
            for q, (la, le) in levels.items()]  # fmt: skip


def sq_of(rows):
    """rows: (stock_id, q, close, vwap) without dividends."""
    return pl.DataFrame([{"stock_id": s, "q": q, "close": c, "div": 0.0, "vwap": v} for s, q, c, v in rows])


def detail(t, sq, rows, paths, etfs=None, last_q=12):
    sector = pl.DataFrame(rows, schema=OUT_SCHEMA)
    ser = pl.concat([skill.own_series(sq), skill.label_series(sector)])
    return sd.fund_detail(t, sector, paths, etfs or {}, set(), None, last_q, ser)


def test_two_labels_split_exactly_into_market_label_and_stock_choice_every_year():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0), (8, 10, 10.0, 10.0), (8, 11, 9.0, 9.5), (8, 12, 10.0, 9.0)])
    rows = label_rows(A, 3, {11: (1.05, 1.1), 12: (1.2, 1.3)}) + label_rows("Tech > Chips", 2, {11: (1.05, 1.1), 12: (1.2, 1.3)})
    rows += label_rows("Tech", 1, {11: (1.05, 1.1), 12: (1.2, 1.3)}) + label_rows(B, 3, {11: (1.0, 0.9), 12: (0.9, 1.0)})
    rows += label_rows("Energy > Oil", 2, {11: (1.0, 0.9), 12: (0.9, 1.0)}) + label_rows("Energy", 1, {11: (1.0, 0.9), 12: (0.9, 1.0)})
    rows += label_rows(MARKET, 0, {11: (1.0, 1.0), 12: (1.05, 1.1)}, cap=4.0)
    t = trades([(1, 7, 11, 10.0, 11.0, 10.0), (1, 8, 11, 10.0, 9.5, 10.0), (1, 8, 12, 5.0, 9.0, 15.0)])
    d = detail(t, sq, rows, {7: A, 8: B})
    y = {(r["tier"], r["variant"]): r["ret"] for r in d.years.iter_rows(named=True)}
    for tier in (1, 2, 3):
        mkt, label, fund = y[(1, "mkt")], y[(tier, "label")], y[(1, "fund")]
        assert mkt + (label - mkt) + (fund - label) == pytest.approx(fund, abs=1e-15)
    # the fund replays each stock in its own series: its quarters are the stocks' own value-weighted moves
    q = {(r["variant"], r["q"]): r for r in d.quarters.filter(pl.col("tier") == 1).iter_rows(named=True)}
    v11 = 110 / 11 * 12 + 95 / 9.5 * 9
    assert q[("fund", 11)]["v"] == pytest.approx(v11)
    assert d.first_q.rows() == [(1, 11)]
    assert {r["q"]: r["bought"] for r in d.bought.iter_rows(named=True)} == {11: pytest.approx(205.0), 12: pytest.approx(45.0)}


def test_a_pick_that_is_its_labels_whole_index_scores_zero_and_the_rest_is_one_row():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0)])
    own = {r["q"]: (r["level_avg"], r["level_end"]) for r in skill.own_series(sq).iter_rows(named=True) if r["q"] > 10}
    rows = label_rows(A, 3, own) + label_rows("Tech > Chips", 2, own) + label_rows("Tech", 1, own) + label_rows(MARKET, 0, {11: (1.0, 1.0), 12: (1.0, 1.0)})
    d = detail(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, rows, {7: A})
    p = d.picks.filter(pl.col("tier") == 3).row(0, named=True)
    assert (p["stock_id"], p["label"], p["bought"]) == (7, A, pytest.approx(110.0))
    assert p["irr_own"] == pytest.approx(p["irr_label"], abs=1e-12)


def test_only_the_30_biggest_picks_are_listed_one_by_one():
    n = 33
    sq = sq_of([(s, q, 10.0, 10.0) for s in range(1, n + 1) for q in (10, 11, 12)])
    rows = label_rows(A, 3, {11: (1.0, 1.0), 12: (1.0, 1.0)}) + label_rows("Tech > Chips", 2, {11: (1.0, 1.0), 12: (1.0, 1.0)})
    rows += label_rows("Tech", 1, {11: (1.0, 1.0), 12: (1.0, 1.0)}) + label_rows(MARKET, 0, {11: (1.0, 1.0), 12: (1.0, 1.0)})
    t = trades([(1, s, 11, float(s), 10.0, float(s)) for s in range(1, n + 1)])
    p = detail(t, sq, rows, {s: A for s in range(1, n + 1)}).picks.filter(pl.col("tier") == 1)
    assert p.height == sd.PICKS + 1 and p["stock_id"].to_list()[:2] == [33, 32]
    rest = p.row(-1, named=True)
    assert rest["stock_id"] == sd.OTHERS and rest["label"] is None and rest["bought"] == pytest.approx(10.0 * (1 + 2 + 3))


def test_a_bet_is_its_labels_index_against_the_market_with_the_market_share_when_bought():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0)])
    lv = {11: (1.0, 1.2), 12: (1.2, 1.44)}
    rows = label_rows(A, 3, lv, cap=1.0) + label_rows("Tech > Chips", 2, lv, cap=1.0) + label_rows("Tech", 1, lv, cap=1.0)
    rows += label_rows("Energy", 1, {11: (1.0, 1.0), 12: (1.0, 1.0)}, cap=3.0)
    rows += label_rows(MARKET, 0, {11: (1.0, 1.1), 12: (1.1, 1.21)}, cap=4.0)
    d = detail(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, rows, {7: A})
    b = {(r["tier"], r["label"]): r for r in d.bets.iter_rows(named=True)}
    tech = b[(1, "Tech")]
    assert tech["mkt_share"] == pytest.approx(0.25) and tech["bought"] == pytest.approx(110.0)
    flows = pl.DataFrame({"g": [1, 1], "t": [skill.trade_years(11), skill.end_years(12)], "cf": [-110.0, 110 * 1.44 / 1.0]})
    assert tech["irr"] == pytest.approx(skill.irr_by(flows, ["g"])["irr"][0])
    flows = flows.with_columns(cf=pl.Series([-110.0, 110 * 1.21 / 1.0]))
    assert tech["irr_mkt"] == pytest.approx(skill.irr_by(flows, ["g"])["irr"][0])
    energy = b[(1, "Energy")]  # never bought: listed, with the market's share when the fund was buying
    assert energy["bought"] == 0.0 and energy["irr"] is None and energy["mkt_share"] == pytest.approx(0.75)
    assert (2, "Energy") not in b and b[(3, A)]["mkt_share"] == pytest.approx(0.25)


def test_the_mix_sums_to_one_and_groups_etfs_unlabelled_and_small_holdings():
    sq = sq_of([(s, q, 10.0, 10.0) for s in (1, 2, 3, 4, 5) for q in (10, 11)])
    paths = sd.mix_paths({1: A, 2: B, 3: "Energy > Oil > Refiners"}, {4: skill.EtfPick("Tech", 1), 5: None})
    assert paths[4] == "Tech > (ETFs) > (ETFs)" and 5 not in paths
    t = trades([(1, 1, 10, 600.0, 10.0, 600.0), (1, 2, 10, 300.0, 10.0, 300.0), (1, 3, 10, 1.0, 10.0, 1.0),
                (1, 4, 10, 50.0, 10.0, 50.0), (1, 5, 10, 49.0, 10.0, 49.0), (1, 2, 11, -300.0, 10.0, 0.0)])  # fmt: skip
    m = sd.fund_mix(t, sq, paths, last_q=11)
    by = {(r["q"], r["label"]): r["share"] for r in m.iter_rows(named=True)}
    assert by[(10, A)] == pytest.approx(0.6) and by[(10, sd.NOT_CLASSIFIED)] == pytest.approx(0.049)
    assert by[(10, "Energy > (Smaller holdings) > (Smaller holdings)")] == pytest.approx(0.001)
    assert (11, B) not in by and by[(11, A)] == pytest.approx(0.6 / 0.7, abs=1e-4)
    for q in (10, 11):
        assert sum(v for (qq, _), v in by.items() if qq == q) == pytest.approx(1.0, abs=1e-3)


def test_the_label_list_names_each_labels_parent():
    rows = label_rows(A, 3, {12: (1.0, 1.0)}) + label_rows("Tech > Chips", 2, {12: (1.0, 1.0)}) + label_rows("Tech", 1, {12: (1.0, 1.0)})
    rows += label_rows(MARKET, 0, {12: (1.0, 1.0)}) + label_rows("Old", 1, {11: (1.0, 1.0)})
    got = sd.label_list(pl.DataFrame(rows, schema=OUT_SCHEMA), 12).select("label", "parent", "name").rows()
    assert got == [("Tech", None, "Tech"), ("Tech > Chips", "Tech", "Chips"), (A, "Tech > Chips", "Memory")]
