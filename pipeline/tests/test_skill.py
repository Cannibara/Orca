"""Stock picking vs sector allocation scores (`orca/engine/skill.py`), checked by hand."""

import math

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


def flows_of(out):
    return sorted((round(r["t"], 6), round(r["cf"], 6)) for r in out.iter_rows(named=True))


def test_a_buy_puts_the_same_dollars_in_and_a_sell_takes_the_same_fraction_out():
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 12, -5.0, 20.0, 5.0)]).with_columns(key=pl.lit("X"))
    s = series([("X", 10, 1.0, 1.0), ("X", 12, 2.0, 2.0), ("X", 14, 3.0, 3.0)])
    out, dropped = skill.replay(t, s, last_q=14)
    # $100 buys 100 units; selling half the shares sells 50 units at 2.0; 50 units are worth 3.0 at the end
    assert flows_of(out) == [(round(skill.trade_years(10), 6), -100.0), (round(skill.trade_years(12), 6), 100.0), (round(skill.end_years(14), 6), 150.0)]
    assert dropped.height == 0


def test_a_sell_out_ends_an_episode_and_a_later_buy_starts_afresh():
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 7, 11, -10.0, 10.0, 0.0), (1, 7, 12, 4.0, 10.0, 4.0)]).with_columns(key=pl.lit("X"))
    s = series([("X", 10, 1.0, 1.0), ("X", 11, 2.0, 2.0), ("X", 12, 4.0, 4.0), ("X", 13, 5.0, 5.0)])
    out, _ = skill.replay(t, s, last_q=13)
    assert [cf for _, cf in flows_of(out)] == [-100.0, 200.0, -40.0, 50.0]  # 10 units at 4.0, worth 5.0 at the end


def test_a_trade_with_no_level_drops_the_whole_position_and_says_so():
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0), (1, 8, 10, 1.0, 10.0, 1.0)]).with_columns(key=pl.when(pl.col("stock_id") == 7).then(pl.lit("X")).otherwise(pl.lit("Y")))
    out, dropped = skill.replay(t, series([("X", 10, 1.0, 1.0)]), last_q=10)
    assert set(out["stock_id"].to_list()) == {7} and dropped["stock_id"].to_list() == [8]


def test_the_end_value_uses_the_last_level_known_by_the_last_quarter():
    t = trades([(1, 7, 10, 10.0, 10.0, 10.0)]).with_columns(key=pl.lit("X"))
    out, _ = skill.replay(t, series([("X", 10, 1.0, 1.0), ("X", 11, 1.5, 1.5)]), last_q=13)  # delisted after q11: cash
    assert flows_of(out)[-1] == (round(skill.end_years(13), 6), 150.0)


def test_irr_matches_the_browser_bisection_and_is_null_without_a_sign_change():
    f = pl.DataFrame({"g": [1, 1, 2, 2], "t": [0.0, 1.0, 0.0, 1.0], "cf": [-100.0, 110.0, -100.0, -5.0]})
    got = dict(skill.irr_by(f, ["g"]).iter_rows())
    assert got[1] == pytest.approx(0.10, abs=1e-9) and got[2] is None


def test_trade_times_match_the_web_mid_quarter_rule():
    # live.ts midQuarterMs(0): 2013-01-01 + floor(89 / 2) days = 2013-02-14
    assert skill.trade_years(0) == pytest.approx(44 / 365)
    assert skill.end_years(0) == pytest.approx(89 / 365)  # 2013-03-31


def test_own_series_chains_total_return_from_quarter_closes_and_dividends():
    sq = pl.DataFrame({"stock_id": [7, 7, 7], "q": [10, 11, 12], "close": [10.0, 10.0, 11.0], "div": [0.0, 1.0, 0.0], "vwap": [10.0, 12.0, 10.5]})
    s = {r["q"]: r for r in skill.own_series(sq).iter_rows(named=True)}
    assert s[11]["level_end"] == pytest.approx(1.1) and s[11]["level_avg"] == pytest.approx(1.2)
    assert s[12]["level_end"] == pytest.approx(1.21) and s[12]["level_avg"] == pytest.approx(1.1 * 1.05)
    assert s[10]["level_end"] == 1.0 and next(iter(skill.own_series(sq)["key"])) == "s7"


def label_rows(label, tier, levels):
    return [{"label": label, "tier": tier, "q": q, "level_avg": la, "level_end": le} for q, (la, le) in levels.items()]


def returns_table(rows):
    return pl.DataFrame(rows, schema={"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "level_avg": pl.Float64, "level_end": pl.Float64})


def test_a_fund_that_owns_its_labels_whole_index_scores_zero_for_picking():
    sq = pl.DataFrame({"stock_id": [7, 7, 7], "q": [10, 11, 12], "close": [10.0, 12.0, 15.0], "div": [0.0, 0.0, 0.0], "vwap": [10.0, 11.0, 14.0]})
    own = {r["q"]: (r["level_avg"], r["level_end"]) for r in skill.own_series(sq).iter_rows(named=True)}
    rows = []
    for label, tier in ((A, 3), ("Tech > Chips", 2), ("Tech", 1)):
        rows += label_rows(label, tier, {q: v for q, v in own.items() if q > 10})
    rows += label_rows(MARKET, 0, {11: (1.0, 1.0), 12: (1.0, 1.0)})  # the market went nowhere
    scores, _ = skill.fund_scores(trades([(1, 7, 11, 10.0, 11.0, 10.0)]), sq, returns_table(rows), {7: A}, {}, set(), None, last_q=12)
    for r in scores.iter_rows(named=True):
        assert r["picking"] == pytest.approx(0.0, abs=1e-9)
        assert r["allocation"] > 0 and r["coverage"] == 1.0 and r["n"] == 1


def test_a_sector_etf_scores_at_its_own_tier_and_neutral_etfs_and_unlabelled_stocks_only_count_in_coverage():
    sq = pl.DataFrame({"stock_id": [5, 5, 6, 6, 8, 8], "q": [10, 11] * 3, "close": [10.0, 12.0, 10.0, 10.0, 10.0, 10.0],
                       "div": [0.0] * 6, "vwap": [10.0, 11.0, 10.0, 10.0, 10.0, 10.0]})  # fmt: skip
    rows = label_rows("Tech > Chips", 2, {11: (1.0, 1.1)}) + label_rows("Tech", 1, {11: (1.0, 1.05)}) + label_rows(MARKET, 0, {11: (1.0, 1.0)})
    etfs = {5: skill.EtfPick("Tech > Chips", 2), 6: None}  # 6 is a broad ETF: neutral
    t = trades([(1, 5, 11, 10.0, 11.0, 10.0), (1, 6, 11, 10.0, 10.0, 10.0), (1, 8, 11, 10.0, 10.0, 10.0)])  # 8 has no label
    scores, _ = skill.fund_scores(t, sq, returns_table(rows), {}, etfs, set(), None, last_q=11)
    by_tier = {r["tier"]: r for r in scores.iter_rows(named=True)}
    assert set(by_tier) == {1, 2, 3}
    assert by_tier[3]["n"] == 1 and by_tier[3]["irr_label"] == by_tier[2]["irr_label"]  # no vertical for SOXX: its own tier
    assert by_tier[1]["irr_label"] < by_tier[2]["irr_label"]
    assert by_tier[2]["coverage"] == pytest.approx(110 / 310)


def test_a_conglomerate_is_compared_with_spy():
    sq = pl.DataFrame({"stock_id": [7, 7, 99, 99], "q": [10, 11, 10, 11], "close": [10.0, 11.0, 10.0, 12.0], "div": [0.0] * 4, "vwap": [10.0, 10.0, 10.0, 10.0]})
    rows = label_rows("Ind > Conglom > Diversified", 3, {11: (1.0, 5.0)}) + label_rows(MARKET, 0, {11: (1.0, 1.0)})
    rows += label_rows("Ind > Conglom", 2, {11: (1.0, 5.0)}) + label_rows("Ind", 1, {11: (1.0, 5.0)})
    scores, _ = skill.fund_scores(trades([(1, 7, 11, 10.0, 10.0, 10.0)]), sq, returns_table(rows), {7: "Ind > Conglom > Diversified"}, {},
                                  {"Ind > Conglom > Diversified"}, 99, last_q=11)  # fmt: skip
    r = scores.filter(pl.col("tier") == 2).row(0, named=True)
    spy = skill.irr_by(pl.DataFrame({"g": [1, 1], "t": [skill.trade_years(11), skill.end_years(11)], "cf": [-100.0, 120.0]}), ["g"])["irr"][0]
    assert r["irr_label"] == pytest.approx(spy) and not math.isclose(r["irr_label"], r["irr_fund"])


def test_an_etf_position_is_ranked_against_every_label_at_its_tier():
    rows = label_rows("Tech > Chips", 2, {10: (1.0, 1.0), 13: (1.2, 1.2)}) + label_rows("Tech > Software", 2, {10: (1.0, 1.0), 13: (1.5, 1.5)})
    rows += label_rows("Energy > Oil", 2, {10: (1.0, 1.0), 13: (0.9, 0.9)})
    ranks = skill.etf_ranks(trades([(1, 5, 10, 10.0, 10.0, 10.0)]), returns_table(rows), {5: skill.EtfPick("Tech > Chips", 2)}, last_q=13)
    r = ranks.row(0, named=True)
    assert (r["cik"], r["stock_id"], r["label"], r["rank"], r["of"], r["best"]) == (1, 5, "Tech > Chips", 2, 3, "Tech > Software")


def test_a_position_held_from_the_start_of_the_data_is_scored_with_flat_series_before_them():
    # Berkshire's Coca-Cola: first reported in 1998 Q4 (q-57), before any price (q-56) or index return (q-55). Both
    # series are flat before they start, so the position is replayed from there instead of dropped. A stock listed
    # later (first quarter q10) gets no flat stretch.
    sq = pl.DataFrame({"stock_id": [25, 25, 25, 9, 9], "q": [-56, -55, -54, 10, 11], "close": [10.0, 11.0, 12.1, 5.0, 6.0],
                       "div": [0.0] * 5, "vwap": [10.0, 10.5, 11.5, 5.0, 5.5]})  # fmt: skip
    own = skill.own_series(sq)
    levels = {(r["key"], r["q"]): r["level_end"] for r in own.iter_rows(named=True)}
    assert levels[("s25", -57)] == 1.0 and levels[("s25", -56)] == 1.0 and levels[("s25", -54)] == pytest.approx(1.21)
    assert ("s9", 9) not in levels and own.filter(pl.col("key") == "s9")["q"].min() == 10
    rets = pl.DataFrame({"label": ["Market", "Market"], "tier": [0, 0], "q": [-55, -54], "ret": [0.1, 0.1], "level_end": [1.1, 1.21],
                         "level_avg": [1.05, 1.15], "n": [1, 1], "cap": [1.0, 1.0], "top_weight": [1.0, 1.0]})  # fmt: skip
    lab = {(r["key"], r["q"]): r["level_avg"] for r in skill.label_series(rets).iter_rows(named=True)}
    assert lab[("Market", -57)] == 1.0 and lab[("Market", -56)] == 1.0
    t = trades([(1, 25, -57, 100.0, 10.0, 100.0)]).with_columns(key=pl.lit("s25"))
    out, dropped = skill.replay(t, own, last_q=-54)
    assert dropped.is_empty() and flows_of(out)[-1][1] == pytest.approx(1000.0 * 1.21)
