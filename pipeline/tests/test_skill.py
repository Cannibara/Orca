"""Stock picking vs sector allocation as an opportunity cost (`orca/engine/skill.py`), checked by hand."""

import polars as pl
import pytest

from orca.engine import skill
from orca.engine.sectors import MARKET

A = "Tech > Chips > Memory"


def trades(rows):
    """rows: (cik, stock_id, q, delta, px, shares_after)."""
    cols = ["cik", "stock_id", "q", "delta", "px", "shares_after"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows], schema=skill.TRADES_SCHEMA)


def series(rows):
    """rows: (key, q, level_avg, level_end)."""
    cols = ["key", "q", "level_avg", "level_end"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows], schema=skill.SERIES_SCHEMA)


def units_of(t, s, last_q):
    u, dropped = skill.replay(t.with_columns(key=pl.lit("X")), s, last_q)
    return [(r["q"], round(r["u_prev"], 9), round(r["u"], 9)) for r in u.sort("q").iter_rows(named=True)], dropped


def test_a_buy_puts_the_same_dollars_in_and_a_sell_takes_the_same_fraction_out():
    s = series([("X", 10, 1.0, 1.0), ("X", 12, 2.0, 2.0), ("X", 14, 3.0, 3.0)])
    got, dropped = units_of(trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 12, -5.0, 20.0, 5.0)]), s, last_q=14)
    assert got == [(10, 0.0, 100.0), (12, 100.0, 50.0)]  # $100 buys 100 units at 1.0; selling half the shares sells half
    assert dropped.height == 0


def test_a_sell_out_ends_an_episode_and_a_later_buy_starts_afresh():
    s = series([("X", 10, 1.0, 1.0), ("X", 11, 2.0, 2.0), ("X", 12, 4.0, 4.0), ("X", 13, 5.0, 5.0)])
    got, _ = units_of(trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 11, -10.0, 10.0, 0.0), (1, 7, 12, 4.0, 10.0, 4.0)]), s, last_q=13)
    assert got == [(10, 0.0, 100.0), (11, 100.0, 0.0), (12, 0.0, 10.0)]  # $40 buys 10 units at 4.0


def test_a_trade_with_no_level_drops_the_whole_position_and_says_so():
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 8, 10, 1.0, 10.0, 1.0)]).with_columns(key=pl.when(pl.col("stock_id") == 7).then(pl.lit("X")).otherwise(pl.lit("Y")))
    units, dropped = skill.replay(t, series([("X", 10, 1.0, 1.0)]), last_q=10)
    assert set(units["stock_id"].to_list()) == {7} and dropped["stock_id"].to_list() == [8]


def test_own_series_chains_total_return_from_quarter_closes_and_dividends():
    sq = pl.DataFrame({"stock_id": [7, 7, 7], "q": [10, 11, 12], "close": [10.0, 10.0, 11.0], "div": [0.0, 1.0, 0.0], "vwap": [10.0, 12.0, 10.5]})
    s = {r["q"]: r for r in skill.own_series(sq).iter_rows(named=True)}
    assert s[11]["level_end"] == pytest.approx(1.1) and s[11]["level_avg"] == pytest.approx(1.2)
    assert s[12]["level_end"] == pytest.approx(1.21) and s[12]["level_avg"] == pytest.approx(1.1 * 1.05)
    assert s[10]["level_end"] == 1.0 and next(iter(skill.own_series(sq)["key"])) == "s7"


def test_a_quarter_splits_at_its_average_level_and_a_gap_leaves_the_first_half_without_a_return():
    h = {r["q"]: r for r in skill.half_returns(series([("X", 10, 1.0, 1.1), ("X", 11, 1.21, 1.331), ("X", 13, 2.0, 2.2)])).iter_rows(named=True)}
    assert h[11]["r1"] == pytest.approx(0.1) and h[11]["r2"] == pytest.approx(0.1) and h[11]["e0"] == pytest.approx(1.1)
    assert h[10]["r1"] is None and h[10]["r2"] == pytest.approx(0.1)
    assert h[13]["r1"] is None and h[13]["e0"] is None  # q12 is missing: no return from q11's end


def ways(stock, label, market):
    """Series for stock 7 (key s7), its label A and the market, each {q: (level_avg, level_end)}."""
    rows = [("s7", q, *v) for q, v in stock.items()] + [(A, q, *v) for q, v in label.items()] + [(MARKET, q, *v) for q, v in market.items()]
    return series(rows)


def attributed(t, s, last_q):
    rows, dropped = skill.attribute(t, s, skill.half_returns(s), {"l": {7: A}, "mkt": MARKET}, last_q)
    return {r["q"]: r for r in rows.iter_rows(named=True)}, dropped


def test_each_half_puts_the_funds_own_money_in_the_stock_its_label_and_the_market():
    s = ways({10: (1.0, 1.1), 11: (1.2, 1.3)}, {10: (1.0, 1.05), 11: (1.1, 1.2)}, {10: (1.0, 1.0), 11: (1.0, 1.0)})
    r, dropped = attributed(trades([(1, 7, 10, 10.0, 10.0, 10.0)]), s, last_q=11)  # $100 at the q10 average: 100 units
    assert dropped.is_empty()
    # q10: bought mid-quarter, so only the second half, on $100: the stock made $10, the label $5
    assert (r[10]["w1"], r[10]["w2"], r[10]["b"]) == (0.0, pytest.approx(100.0), pytest.approx(50.0))
    assert r[10]["g_fund"] == pytest.approx(10.0) and r[10]["g_l"] == pytest.approx(5.0) and r[10]["g_mkt"] == 0.0
    # q11, held all quarter: $110 from the end of q10 to the average level, then $120 to the end
    assert (r[11]["w1"], r[11]["w2"]) == (pytest.approx(110.0), pytest.approx(120.0))
    assert r[11]["g_fund"] == pytest.approx(20.0)  # 100 units from 1.1 to 1.3: what the fund made
    assert r[11]["g_l"] == pytest.approx(110 * (1.1 / 1.05 - 1) + 120 * (1.2 / 1.1 - 1))


def test_picking_is_the_dollars_the_picks_beat_their_label_by_over_the_dollar_years_at_work():
    # owner 2026-11-28: a stock held one quarter counts that quarter's gap on that money, nothing annualised
    sq = pl.DataFrame({"stock_id": [7] * 4, "q": [10, 11, 12, 13], "close": [10.0, 10.0, 11.0, 11.0], "div": [0.0] * 4, "vwap": [10.0, 10.0, 10.5, 11.0]})
    flat = {q: (1.0, 1.0) for q in (10, 11, 12, 13)}
    rows = [{"label": lab, "tier": tier, "q": q, "level_avg": a, "level_end": e}
            for lab, tier in ((A, 3), ("Tech > Chips", 2), ("Tech", 1), (MARKET, 0)) for q, (a, e) in flat.items()]  # fmt: skip
    t = trades([(1, 7, 11, 10.0, 10.0, 10.0), (1, 7, 13, -10.0, 11.0, 0.0)])  # bought mid q11, sold mid q13
    scores, _ = skill.fund_scores(t, sq, returns_table(rows), {7: A}, {}, set(), None, last_q=13)
    r = scores.filter(pl.col("tier") == 2).row(0, named=True)
    # held from mid q11 to mid q13: four halves with $100, $100, $105 and $110 at work (an eighth of a year each);
    # the stock made $10, the indices nothing
    dollar_years = (100 + 100 + 105 + 110) / 8
    assert r["ret_fund"] == pytest.approx(10.0 / dollar_years) and r["ret_label"] == 0.0 and r["ret_mkt"] == 0.0
    assert r["picking"] == pytest.approx(10.0 / dollar_years) and r["allocation"] == 0.0


def test_a_half_counts_only_where_every_way_has_a_return():
    # the label has no q11: q11's halves leave every way, so the stock is not credited with the label's gap
    s = ways({10: (1.0, 1.0), 11: (1.0, 2.0), 12: (2.0, 2.2)}, {10: (1.0, 1.0), 12: (1.0, 1.1)}, {10: (1.0, 1.0), 11: (1.0, 1.0), 12: (1.0, 1.0)})
    r, _ = attributed(trades([(1, 7, 10, 10.0, 10.0, 10.0)]), s, last_q=12)
    assert r[11]["b"] == 0.0 and r[11]["g_fund"] == 0.0
    assert r[12]["w1"] == 0.0 and r[12]["w2"] == pytest.approx(200.0)  # q12's first half needs q11's level too
    assert r[12]["g_fund"] == pytest.approx(20.0) and r[12]["g_l"] == pytest.approx(200 * 0.1)


def label_rows(label, tier, levels):
    return [{"label": label, "tier": tier, "q": q, "level_avg": la, "level_end": le} for q, (la, le) in levels.items()]


def returns_table(rows):
    return pl.DataFrame(rows, schema={"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64})


def test_a_fund_that_owns_its_labels_whole_index_scores_zero_for_picking():
    sq = pl.DataFrame({"stock_id": [7, 7, 7], "q": [10, 11, 12], "close": [10.0, 12.0, 15.0], "div": [0.0, 0.0, 0.0], "vwap": [10.0, 11.0, 14.0]})
    own = {r["q"]: (r["level_avg"], r["level_end"]) for r in skill.own_series(sq).iter_rows(named=True)}
    rows = []
    for label, tier in ((A, 3), ("Tech > Chips", 2), ("Tech", 1)):
        rows += label_rows(label, tier, own)
    rows += label_rows(MARKET, 0, {10: (1.0, 1.0), 11: (1.0, 1.0), 12: (1.0, 1.0)})  # the market went nowhere
    scores, _ = skill.fund_scores(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, returns_table(rows), {7: A}, {}, set(), None, last_q=12)
    for r in scores.iter_rows(named=True):
        assert r["picking"] == pytest.approx(0.0, abs=1e-12)
        assert r["allocation"] > 0 and r["coverage"] == 1.0 and r["n"] == 1


def test_a_sector_etf_scores_at_its_own_tier_and_neutral_etfs_and_unlabelled_stocks_only_count_in_coverage():
    sq = pl.DataFrame({"stock_id": [5, 5, 6, 6, 8, 8], "q": [10, 11] * 3, "close": [10.0, 12.0, 10.0, 10.0, 10.0, 10.0],
                       "div": [0.0] * 6, "vwap": [10.0, 11.0, 10.0, 10.0, 10.0, 10.0]})  # fmt: skip
    rows = label_rows("Tech > Chips", 2, {10: (1.0, 1.0), 11: (1.0, 1.1)}) + label_rows("Tech", 1, {10: (1.0, 1.0), 11: (1.0, 1.05)})
    rows += label_rows(MARKET, 0, {10: (1.0, 1.0), 11: (1.0, 1.0)})
    etfs = {5: skill.EtfPick("Tech > Chips", 2), 6: None}  # 6 is a broad ETF: neutral
    t = trades([(1, 5, 11, 10.0, 11.0, 10.0), (1, 6, 11, 10.0, 10.0, 10.0), (1, 8, 11, 10.0, 10.0, 10.0)])  # 8 has no label
    scores, _ = skill.fund_scores(t, sq, returns_table(rows), {}, etfs, set(), None, last_q=11)
    by_tier = {r["tier"]: r for r in scores.iter_rows(named=True)}
    assert set(by_tier) == {1, 2, 3}
    assert by_tier[3]["n"] == 1 and by_tier[3]["ret_label"] == by_tier[2]["ret_label"]  # no vertical for SOXX: its own tier
    assert by_tier[1]["ret_label"] < by_tier[2]["ret_label"]
    assert by_tier[2]["coverage"] == pytest.approx(110 / 310)


def test_a_conglomerate_is_compared_with_spy():
    sq = pl.DataFrame({"stock_id": [7, 7, 99, 99], "q": [10, 11, 10, 11], "close": [10.0, 11.0, 10.0, 12.0], "div": [0.0] * 4, "vwap": [10.0, 10.0, 10.0, 10.0]})
    lv = {10: (1.0, 1.0), 11: (1.0, 5.0)}
    rows = label_rows("Ind > Conglom > Diversified", 3, lv) + label_rows("Ind > Conglom", 2, lv) + label_rows("Ind", 1, lv)
    rows += label_rows(MARKET, 0, {10: (1.0, 1.0), 11: (1.0, 1.0)})
    scores, _ = skill.fund_scores(trades([(1, 7, 11, 10.0, 10.0, 10.0)]), sq, returns_table(rows), {7: "Ind > Conglom > Diversified"}, {},
                                  {"Ind > Conglom > Diversified"}, 99, last_q=11)  # fmt: skip
    r = scores.filter(pl.col("tier") == 2).row(0, named=True)
    assert r["ret_label"] == pytest.approx(r["ret_spy"]) and r["ret_label"] == pytest.approx(0.2 / 0.125)  # SPY +20% on $100, half a quarter
    assert r["ret_fund"] == pytest.approx(0.1 / 0.125)


def test_an_etf_position_is_ranked_against_every_label_at_its_tier_on_its_own_money():
    sq = pl.DataFrame({"stock_id": [5] * 4, "q": [10, 11, 12, 13], "close": [10.0] * 4, "div": [0.0] * 4, "vwap": [10.0] * 4})
    def grow(end):
        return {10: (1.0, 1.0), 11: (1.0, 1.0), 12: (1.0, 1.0), 13: (1.0, end)}
    rows = label_rows("Tech > Chips", 2, grow(1.2)) + label_rows("Tech > Software", 2, grow(1.5)) + label_rows("Energy > Oil", 2, grow(0.9))
    s = pl.concat([skill.own_series(sq), skill.label_series(returns_table(rows))])
    ranks = skill.etf_ranks(trades([(1, 5, 10, 10.0, 10.0, 10.0)]), returns_table(rows), {5: skill.EtfPick("Tech > Chips", 2)}, 13, s, skill.half_returns(s))
    r = ranks.row(0, named=True)
    assert (r["cik"], r["stock_id"], r["label"], r["rank"], r["of"], r["best"]) == (1, 5, "Tech > Chips", 2, 3, "Tech > Software")
    assert r["ret"] == pytest.approx(100 * 0.2 / (100 * 3.5 / 4))  # $20 over $100 held three and a half quarters


def test_a_position_held_from_the_start_of_the_data_is_scored_with_flat_series_before_them():
    # Berkshire's Coca-Cola: first reported in 1998 Q4 (q-57), before any price (q-56) or index return (q-55). Both
    # series are flat before they start, so the position is scored from there instead of dropped. A stock listed
    # later (first quarter q10) gets no flat stretch.
    sq = pl.DataFrame({"stock_id": [25, 25, 25, 9, 9], "q": [-56, -55, -54, 10, 11], "close": [10.0, 11.0, 12.1, 5.0, 6.0],
                       "div": [0.0] * 5, "vwap": [10.0, 10.5, 11.5, 5.0, 5.5]})  # fmt: skip
    own = skill.own_series(sq)
    levels = {(r["key"], r["q"]): r["level_end"] for r in own.iter_rows(named=True)}
    assert levels[("s25", -57)] == 1.0 and levels[("s25", -56)] == 1.0 and levels[("s25", -54)] == pytest.approx(1.21)
    assert ("s9", 9) not in levels and own.filter(pl.col("key") == "s9")["q"].min() == 10
    rets = pl.DataFrame({"label": ["Market", "Market"], "tier": [0, 0], "q": [-55, -54], "ret": [0.1, 0.1], "level_end": [1.1, 1.21],
                         "level_avg": [1.05, 1.15], "n": [1, 1], "cap": [1.0, 1.0], "top_weight": [1.0, 1.0]})  # fmt: skip
    lab = skill.label_series(rets)
    assert {(r["key"], r["q"]): r["level_avg"] for r in lab.iter_rows(named=True)}[("Market", -57)] == 1.0
    s = pl.concat([own, lab])
    rows, dropped = skill.attribute(trades([(1, 25, -57, 100.0, 10.0, 100.0)]), s, skill.half_returns(s), {"mkt": MARKET}, last_q=-54)
    assert dropped.is_empty() and rows["g_fund"].sum() == pytest.approx(1000.0 * 0.21)  # $1,000 grew to $1,210
