"""Sector, industry and industry-vertical indices (`orca/engine/sectors.py`), checked by hand."""

from datetime import date

import polars as pl
import pytest

from orca.engine import sectors
from orca.quarters import q_end

A = "Tech > Chips > Memory"
B = "Tech > Chips > Logic"
C = "Energy > Oil > Production"


def quarters(rows):
    """rows: (stock_id, q, close, div, vwap, cap, stale)."""
    cols = ["stock_id", "q", "close", "div", "vwap", "cap", "stale"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows], schema=sectors.QUARTER_SCHEMA)


def series(out, label):
    return {r["q"]: r for r in out.filter(pl.col("label") == label).iter_rows(named=True)}


def test_returns_are_weighted_by_the_market_cap_at_the_start_of_the_quarter_with_no_cap():
    sq = quarters([(1, 10, 10.0, 0, 10.0, 100.0, False), (1, 11, 11.0, 0, 10.5, 110.0, False),
                   (2, 10, 20.0, 0, 20.0, 300.0, False), (2, 11, 20.0, 0, 20.0, 300.0, False)])  # fmt: skip
    out = sectors.index_returns(sq, {1: A, 2: A}, last_q=11)
    q11 = series(out, A)[11]
    assert q11["ret"] == pytest.approx(0.25 * 0.10)  # weights 100 : 300 at the end of q10
    assert q11["level_end"] == pytest.approx(1.025) and q11["n"] == 2 and q11["top_weight"] == pytest.approx(0.75)
    assert q11["level_avg"] == pytest.approx(0.25 * 1.05 + 0.75 * 1.0)  # the quarter's VWAP over the start close


def test_dividends_count_in_the_return():
    sq = quarters([(1, 10, 10.0, 0, 10.0, 100.0, False), (1, 11, 10.0, 1.0, 10.0, 100.0, False)])
    assert series(sectors.index_returns(sq, {1: A}, last_q=11), A)[11]["ret"] == pytest.approx(0.10)


def test_industries_sectors_and_the_market_are_cap_weighted_sums_of_their_stocks():
    sq = quarters([(1, 10, 10.0, 0, 10.0, 100.0, False), (1, 11, 12.0, 0, 11.0, 0, False),
                   (2, 10, 10.0, 0, 10.0, 100.0, False), (2, 11, 10.0, 0, 10.0, 0, False),
                   (3, 10, 10.0, 0, 10.0, 200.0, False), (3, 11, 9.0, 0, 9.0, 0, False)])  # fmt: skip
    out = sectors.index_returns(sq, {1: A, 2: B, 3: C}, last_q=11)
    assert series(out, A)[11]["ret"] == pytest.approx(0.2) and series(out, B)[11]["ret"] == pytest.approx(0.0)
    assert series(out, "Tech > Chips")[11]["ret"] == pytest.approx(0.1)
    assert series(out, "Tech")[11]["ret"] == pytest.approx(0.1)
    assert series(out, sectors.MARKET)[11]["ret"] == pytest.approx((100 * 0.2 + 200 * -0.1) / 400)
    tiers = dict(out.select("label", "tier").unique().iter_rows())
    assert (tiers[A], tiers["Tech > Chips"], tiers["Tech"], tiers[sectors.MARKET]) == (3, 2, 1, 0)


def test_a_stale_price_is_left_out_unless_the_stock_never_trades_again():
    sq = quarters([(1, 10, 10.0, 0, 10.0, 100.0, False), (1, 11, 5.0, 0, 5.0, 50.0, True), (1, 12, 10.0, 0, 10.0, 100.0, False),
                   (2, 10, 10.0, 0, 10.0, 100.0, False), (2, 11, 10.0, 0, 10.0, 100.0, False), (2, 12, 11.0, 0, 11.0, 110.0, False),
                   (3, 10, 10.0, 0, 10.0, 100.0, False), (3, 11, 2.0, 0, 6.0, 20.0, True)])  # fmt: skip
    s = series(sectors.index_returns(sq, {1: A, 2: A, 3: A}, last_q=12), A)
    # q11: stock 1 is stale but trades again, so it sits out; stock 3 delisted and earns -80% to its last close
    assert s[11]["n"] == 2 and s[11]["ret"] == pytest.approx((0.0 - 0.8) / 2)
    assert s[12]["n"] == 1 and s[12]["ret"] == pytest.approx(0.10)  # stock 1 has no clean start close; stock 3 is gone


def test_a_new_listing_joins_the_quarter_after_its_first_close_and_quarters_past_the_last_are_dropped():
    sq = quarters([(1, 10, 10.0, 0, 10.0, 100.0, False), (1, 11, 11.0, 0, 11.0, 110.0, False), (1, 12, 11.0, 0, 11.0, 110.0, False),
                   (2, 11, 50.0, 0, 50.0, 900.0, False), (2, 12, 55.0, 0, 55.0, 990.0, False)])  # fmt: skip
    s = series(sectors.index_returns(sq, {1: A, 2: A}, last_q=12), A)
    assert s[11]["n"] == 1 and s[12]["n"] == 2
    assert set(series(sectors.index_returns(sq, {1: A, 2: A}, last_q=11), A)) == {11}


def test_moving_one_stock_changes_only_its_old_and_new_labels_and_their_parents():
    sq = quarters([(i, q, 10.0 + i * (q - 10), 0, 10.0, 100.0, False) for i in (1, 2, 3) for q in (10, 11)])
    before = sectors.index_returns(sq, {1: A, 2: B, 3: C}, last_q=11)
    after = sectors.index_returns(sq, {1: A, 2: A, 3: C}, last_q=11)
    changed = set(before.join(after, on=["label", "q"], how="full", suffix="_new")
                  .filter(pl.col("ret").ne_missing(pl.col("ret_new"))).select(pl.coalesce("label", "label_new"))
                  .to_series().to_list())  # fmt: skip
    assert changed == {A, B}  # Tech > Chips, Tech and the market hold the same stocks either way


def test_stock_quarters_take_the_last_close_its_date_raw_close_and_dividends():
    daily = pl.DataFrame({
        "stock_id": [1, 1, 1, 1], "date": [date(2015, 1, 5), date(2015, 3, 31), date(2015, 4, 1), date(2015, 6, 10)],
        "open": [10.0, 11.0, 5.0, 6.0], "high": [11.0, 12.0, 6.0, 7.0], "low": [9.0, 10.0, 5.0, 5.0], "close": [10.0, 11.0, 5.5, 6.0],
        "volume": [100.0, 100.0, 200.0, 200.0], "dividend": [0.0, 0.5, 0.0, 0.0], "split_factor": [1.0, 1.0, 2.0, 1.0],
    })  # fmt: skip
    from orca.prices import split_adjust_prices

    sq = sectors.stock_quarters(split_adjust_prices(daily))
    q8, q9 = (r for r in sq.sort("q").iter_rows(named=True))
    assert (q8["q"], q8["close"], q8["raw_close"], q8["div"]) == (8, 5.5, 11.0, 0.25)  # halved by the April split
    assert q8["last"] == date(2015, 3, 31) and not q8["stale"]
    assert q9["last"] == date(2015, 6, 10) and q9["stale"]  # 20 days before the quarter end
    assert q9["vwap"] == pytest.approx(((6 + 5 + 5.5) / 3 + (7 + 5 + 6) / 3) / 2)


def test_market_caps_use_the_count_filed_by_then_and_fall_back_to_todays_count():
    sq = pl.DataFrame({"stock_id": [1, 1, 2, 3], "q": [10, 11, 11, 11], "close": [5.0, 6.0, 20.0, 7.0], "raw_close": [10.0, 12.0, 20.0, 7.0]})
    hist = pl.DataFrame({"stock_id": [1, 1], "end": [date(2015, 6, 30), date(2015, 9, 30)],
                         "filed": [date(2015, 8, 1), date(2015, 11, 1)], "shares": [100.0, 90.0]}, schema=sectors.SHARES_SCHEMA)  # fmt: skip
    securities = pl.DataFrame({"stock_id": [1, 2, 3], "ticker": ["AAA", "TSM", "CCC"], "cik": [9, 8, 9], "shares_out": [50.0, 500.0, 7.0]})
    caps, fallback = sectors.market_caps(sq, hist, securities, {"TSM": 5.0})
    got = {(r["stock_id"], r["q"]): r["cap"] for r in caps.iter_rows(named=True)}
    assert got[(1, 10)] == 10.0 * 100  # filed 2015-08-01, before q10's end (2015-09-30)
    assert got[(1, 11)] == 12.0 * 90  # the 2015-11-01 filing is known by 2015-12-31
    assert got[(2, 11)] == 20.0 * 500 / 5  # no history: today's count, per ADR
    assert (3, 11) not in got  # company 9's other share class: counted once, on its lowest stock id
    assert fallback == {2}
    assert q_end(10) == date(2015, 9, 30)


def test_an_outsized_cap_sits_out_and_is_reported_but_a_small_universe_is_left_alone():
    # 120 stocks of $10bn each and one read as $21tn (LATAM in run 39: ordinary shares, not ADRs)
    rows = []
    for sid in range(1, 121):
        rows += [(sid, 10, 10.0, 0, 10.0, 1e10, False), (sid, 11, 11.0, 0, 10.5, 1.1e10, False)]
    rows += [(999, 10, 30.0, 0, 30.0, 2.1e13, False), (999, 11, 6.0, 0, 20.0, 4.2e12, False)]
    labels = {sid: A for sid in range(1, 121)} | {999: C}
    gone: list = []
    out = sectors.index_returns(quarters(rows), labels, last_q=11, set_aside=gone)
    assert series(out, sectors.MARKET)[11]["ret"] == pytest.approx(0.10)  # the giant's −80% does not move the market
    assert 11 not in series(out, "Energy")  # its sector has no other stock that quarter
    assert pl.concat(gone)["stock_id"].to_list() == [999]
    report = sectors.cap_report(quarters(rows), labels, last_q=11)
    assert report["market"]["stock_id"][0] == 999 and report["jumps"].is_empty()  # the close fell with the cap
    # the same giant among two stocks is not set aside: the share means nothing in a universe that small
    few = [r for r in rows if r[0] in (1, 999)]
    out = sectors.index_returns(quarters(few), {1: A, 999: C}, last_q=11, set_aside=(none := []))
    assert none == [] and series(out, sectors.MARKET)[11]["ret"] == pytest.approx((1e10 * 0.10 + 2.1e13 * -0.8) / (1e10 + 2.1e13))


def test_the_cap_report_names_a_share_count_slip():
    rows = [(sid, q, 10.0, 0, 10.0, 1e9, False) for sid in range(1, 12) for q in (10, 11)]
    rows += [(50, 10, 10.0, 0, 10.0, 1e9, False), (50, 11, 10.5, 0, 10.0, 1e12, False)]  # count x1000, price flat
    labels = {sid: A for sid in range(1, 12)} | {50: A}
    r = sectors.cap_report(quarters(rows), labels, last_q=11)
    assert r["jumps"]["stock_id"].to_list() == [50]
    assert r["sector"]["stock_id"].to_list() == [50]  # half or more of a sector of 12


def test_a_share_count_slip_and_a_price_jump_sit_out_and_are_reported():
    # stock 2's count reads a million times too big in q11 only (Oracle in run 40); stock 3 "returns" +900% in q11
    rows = [(1, q, 10.0, 0, 10.0, 1e10, False) for q in (10, 11, 12)]
    rows += [(2, 10, 10.0, 0, 10.0, 1e10, False), (2, 11, 10.0, 0, 10.0, 1e16, False), (2, 12, 11.0, 0, 10.5, 1.1e10, False)]
    rows += [(3, 10, 1.0, 0, 1.0, 1e9, False), (3, 11, 10.0, 0, 5.0, 1e10, False), (3, 12, 10.0, 0, 10.0, 1e10, False)]
    labels = {1: A, 2: A, 3: A}
    gone: list = []
    movers: list = []
    out = sectors.index_returns(quarters(rows), labels, last_q=12, set_aside=gone, movers=movers)
    m = series(out, sectors.MARKET)
    assert m[11]["ret"] == pytest.approx(0.0)  # stock 3's +900% is left out
    assert m[12]["n"] == 2 and m[12]["ret"] == pytest.approx(0.0)  # stock 2 sits out q12: its q11 weight was a slip
    why = {(r["stock_id"], r["why"]) for r in pl.concat(gone).iter_rows(named=True)}
    assert (2, "count jump") in why and (3, "price jump") in why
    assert pl.concat(movers).is_empty()  # nothing left that moved the market 3 points
