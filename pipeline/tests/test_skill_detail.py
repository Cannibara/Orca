"""The fund-page detail of the opportunity-cost attribution (`orca/engine/skill_detail.py`), checked by hand."""

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


def label_rows(label, tier, levels, cap=1.0):
    return [{"label": label, "tier": tier, "q": q, "ret": 0.0, "level_avg": la, "level_end": le, "n": 1, "cap": cap, "top_weight": 1.0}
            for q, (la, le) in levels.items()]  # fmt: skip


def every_tier(levels, cap=1.0):
    """The same index for A at every tier."""
    return label_rows(A, 3, levels, cap) + label_rows("Tech > Chips", 2, levels, cap) + label_rows("Tech", 1, levels, cap)


def sq_of(rows):
    """rows: (stock_id, q, close, vwap) without dividends."""
    return pl.DataFrame([{"stock_id": s, "q": q, "close": c, "div": 0.0, "vwap": v} for s, q, c, v in rows])


def detail(t, sq, rows, paths, etfs=None, last_q=12):
    sector = pl.DataFrame(rows, schema=OUT_SCHEMA)
    ser = pl.concat([skill.own_series(sq), skill.label_series(sector)])
    return sd.fund_detail(t, sector, paths, etfs or {}, set(), None, last_q, ser)


FLAT = {q: (1.0, 1.0) for q in (10, 11, 12)}


def test_a_quarter_is_what_the_money_made_over_the_money_at_work_even_with_a_buy_in_the_middle():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 11.0, 10.0), (7, 12, 12.1, 11.0)])  # levels: q11 avg 1.0, end 1.1
    rows = every_tier(FLAT) + label_rows(MARKET, 0, FLAT)
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 11, 10.0, 10.0, 20.0)])  # $100, then $100 more mid q11
    q = {r["q"]: r for r in detail(t, sq, rows, {7: A}).quarters.iter_rows(named=True)}
    # q11: $100 to the average level (it made nothing), then $200 to the end (+10%: $20); $150 at work on average
    assert q[11]["cap"] == pytest.approx(150.0) and q[11]["fund"] == pytest.approx(20 / 150)
    assert q[11]["mkt"] == 0.0 and q[11]["l3"] == 0.0 and q[11]["spy"] == 0.0  # no SPY: the market stands in
    assert q[10]["cap"] == pytest.approx(50.0) and q[10]["fund"] == 0.0  # bought mid q10 at 1.0, still 1.0 at its end


def test_years_split_exactly_into_market_label_and_stock_choice_and_average_to_the_scores():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0), (8, 10, 10.0, 10.0), (8, 11, 9.0, 9.5), (8, 12, 10.0, 9.0)])
    up, down = {10: (1.0, 1.0), 11: (1.05, 1.1), 12: (1.2, 1.3)}, {10: (1.0, 1.0), 11: (1.0, 0.9), 12: (0.9, 1.0)}
    rows = every_tier(up) + label_rows(B, 3, down) + label_rows("Energy > Oil", 2, down) + label_rows("Energy", 1, down)
    rows += label_rows(MARKET, 0, {10: (1.0, 1.0), 11: (1.0, 1.0), 12: (1.05, 1.1)}, cap=4.0)
    t = trades([(1, 7, 11, 10.0, 11.0, 10.0), (1, 8, 11, 10.0, 9.5, 10.0), (1, 8, 12, 5.0, 9.0, 15.0)])
    d = detail(t, sq, rows, {7: A, 8: B})
    years = d.years.rows(named=True)
    assert [y["name"] for y in years] == ["2015 Q4", "2016 Q1"]
    for y in years:
        for tier in (1, 2, 3):
            mkt, label, fund = y["mkt"], y[f"l{tier}"], y["fund"]
            assert mkt + (label - mkt) + (fund - label) == pytest.approx(fund, abs=1e-15)
    # each year's gap × its money at work, summed, is the score × the dollar-years: the years averaged by money
    cap = {r["q"]: r["cap"] for r in d.quarters.iter_rows(named=True)}
    sc = d.scores.filter(pl.col("tier") == 3).row(0, named=True)
    dollar_years = (cap[11] + cap[12]) / 4
    assert sum((y["fund"] - y["l3"]) * c for y, c in zip(years, (cap[11], cap[12]))) == pytest.approx(sc["picking"] * dollar_years)
    assert sum((y["l3"] - y["mkt"]) * c for y, c in zip(years, (cap[11], cap[12]))) == pytest.approx(sc["allocation"] * dollar_years)
    assert d.first_q.rows() == [(1, 11)]
    assert {r["q"]: r["bought"] for r in d.bought.iter_rows(named=True)} == {11: pytest.approx(205.0), 12: pytest.approx(45.0)}


def test_a_pick_that_is_its_labels_whole_index_scores_zero_and_adds_nothing():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0)])
    own = {r["q"]: (r["level_avg"], r["level_end"]) for r in skill.own_series(sq).iter_rows(named=True)}
    d = detail(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, every_tier(own) + label_rows(MARKET, 0, FLAT), {7: A})
    p = d.picks.filter(pl.col("tier") == 3).row(0, named=True)
    assert (p["stock_id"], p["label"], p["bought"]) == (7, A, pytest.approx(110.0))
    assert p["ret_own"] == pytest.approx(p["ret_label"], abs=1e-12) and p["adds"] == pytest.approx(0.0, abs=1e-12)


def test_the_decisions_add_up_to_the_scores_and_only_the_30_biggest_picks_are_listed_one_by_one():
    n = 33
    sq = sq_of([(s, q, 10.0 + s * (q - 10) / 10, 10.0) for s in range(1, n + 1) for q in (10, 11, 12)])
    rows = every_tier({10: (1.0, 1.0), 11: (1.01, 1.02), 12: (1.03, 1.04)}) + label_rows(MARKET, 0, FLAT)
    t = trades([(1, s, 11, float(s), 10.0, float(s)) for s in range(1, n + 1)])
    d = detail(t, sq, rows, {s: A for s in range(1, n + 1)})
    p = d.picks.filter(pl.col("tier") == 1)
    assert p.height == sd.PICKS + 1 and p["stock_id"].to_list()[:2] == [33, 32]
    rest = p.row(-1, named=True)
    assert rest["stock_id"] == sd.OTHERS and rest["label"] is None and rest["bought"] == pytest.approx(10.0 * (1 + 2 + 3))
    sc = d.scores.filter(pl.col("tier") == 1).row(0, named=True)
    assert p["adds"].sum() == pytest.approx(sc["picking"]) and sc["picking"] > 0
    assert d.bets.filter(pl.col("tier") == 1)["adds"].drop_nulls().sum() == pytest.approx(sc["allocation"])


def test_a_bet_is_its_labels_index_against_the_market_on_its_own_money_with_the_market_share_when_bought():
    sq = sq_of([(7, 10, 10.0, 10.0), (7, 11, 12.0, 11.0), (7, 12, 15.0, 14.0)])
    rows = every_tier({10: (1.0, 1.0), 11: (1.0, 1.2), 12: (1.2, 1.44)}) + label_rows("Energy", 1, FLAT, cap=3.0)
    rows += label_rows(MARKET, 0, {10: (1.0, 1.0), 11: (1.0, 1.1), 12: (1.1, 1.21)}, cap=4.0)
    d = detail(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, rows, {7: A})
    b = {(r["tier"], r["label"]): r for r in d.bets.iter_rows(named=True)}
    tech = b[(1, "Tech")]
    assert tech["mkt_share"] == pytest.approx(0.25) and tech["bought"] == pytest.approx(110.0)
    # the fund's money in the stock: $110 at the q11 average, $120 (110 × 12/11) by its end, $168 at the q12 average
    money = [(110.0, 0.2, 0.1), (120.0, 0.0, 0.0), (120 * 14 / 12, 0.2, 0.1)]  # (dollars, Tech's half, the market's)
    dollar_years = sum(m for m, _, _ in money) / 8
    assert tech["ret"] == pytest.approx(sum(m * r for m, r, _ in money) / dollar_years)
    assert tech["ret_mkt"] == pytest.approx(sum(m * r for m, _, r in money) / dollar_years)
    energy = b[(1, "Energy")]  # never bought: listed, with the market's share when the fund was buying
    assert energy["bought"] == 0.0 and energy["ret"] is None and energy["adds"] is None and energy["mkt_share"] == pytest.approx(0.75)
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


def test_dollar_amounts_never_print_as_a_bare_nine_digit_number(tmp_path):
    # Run 38: whole-dollar amounts that equal an all-digit CUSIP (Microsoft's is 594918104) tripped the guard
    from orca.publish import write_json
    from orca.run.publish_step import cusip_leaks
    from orca.run.sectors_step import _dollars

    write_json(tmp_path / "bare.json", {"v": [594918104]}, compress=False)
    assert cusip_leaks(tmp_path, {"594918104"}, compressed=False)  # the guard sees a bare number
    (tmp_path / "bare.json").unlink()
    write_json(tmp_path / "fund.json", {"v": [_dollars(594918104.0), _dollars(594918103.996)]}, compress=False)
    assert cusip_leaks(tmp_path, {"594918104"}, compressed=False) == []
