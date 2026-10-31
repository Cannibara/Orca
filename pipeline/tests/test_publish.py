import hashlib
import json
import re
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import brotli
import polars as pl
import pytest

from orca.config import PERIODS
from orca.engine.fund import (
    FundQuarter,
    FundYear,
    aggregate_fund,
    contributions,
    full_years,
    fund_years,
)
from orca.engine.metrics import Performance, hold_lengths, performance, turnover
from orca.engine.position import PositionResult, Trade, compute_position
from orca.engine.whatif import ExitRow, beat_spy_pct, buys_vs_sells, exit_rows
from orca.publish import (
    ExitsSummary,
    FundMeta,
    FundOutput,
    HomeLists,
    build_metrics,
    changed_files,
    new_version,
    publish_fund,
    publish_shared,
    read_json,
    read_manifest,
    weekly_closes,
    write_health,
    write_json,
    write_manifest,
)
from orca.quarter_px import QuarterPx

CUSIP = "037833100"  # the join key of stock 1; it must never reach a published file


def qpx(close, vwap=None, low=None, high=None, div_ps=0.0) -> QuarterPx:
    return QuarterPx(
        close if vwap is None else vwap,
        close * 0.9 if low is None else low,
        close * 1.1 if high is None else high,
        close,
        div_ps,
        (None,) * 3,
    )


def build_engine_fund(fund_id=7, book=1.5e9) -> FundOutput:
    """A fund run through the real engine: its holdings are keyed by CUSIP, which the lake maps
    to stock ids before any engine code runs. Stock 1 is bought, added to, trimmed and sold out;
    stock 2 is held throughout. Tracked from Q1 2014 (q 4) to Q4 2015 (q 11)."""
    holdings = pl.DataFrame(
        {
            "cik": [1234] * 16,
            "q": [*range(4, 12)] * 2,
            "cusip": [CUSIP] * 8 + ["594918104"] * 8,
            "shares": [100.0, 100.0, 150.0, 150.0, 100.0, 100.0, 0.0, 0.0] + [50.0] * 8,
        }
    )
    stock_of = {CUSIP: 1, "594918104": 2}
    px = {
        1: {q: qpx(100.0 + 10 * (q - 4), div_ps=0.5 if q == 6 else 0.0) for q in range(4, 12)},
        2: {q: qpx(50.0 + 2 * (q - 4)) for q in range(4, 12)},
    }
    positions = []
    for cusip, stock_id in stock_of.items():
        rows = holdings.filter(pl.col("cusip") == cusip)
        shares_by_q = dict(zip(rows["q"].to_list(), rows["shares"].to_list()))
        positions.append(compute_position(stock_id, shares_by_q, px[stock_id], 4, 11, {}))
    quarters = aggregate_fund(positions, 4, 11)
    years = fund_years(quarters)
    spy = {q: qpx(400.0 + 5 * q) for q in range(4, 16)}
    rows = exit_rows(positions, px, spy)
    buys, sells = buys_vs_sells(positions, px)
    perf = performance([(fq.q, fq.ret) for fq in quarters if fq.ret is not None], {2014: 0.02})
    hold_all, hold_sold = hold_lengths(positions, 11)
    return FundOutput(
        meta=FundMeta(
            fund_id=fund_id,
            name="ALPHA CAPITAL",
            cik=1234,
            period_q=11,
            filed=date(2016, 2, 12),
            book=book,
            n_holdings=1,
            priced_pct=0.97,
            tracked_since_q=4,
            inactive=False,
        ),
        years=years,
        quarters=quarters,
        positions=positions,
        contributions=contributions(positions, years),
        exits=rows,
        exits_summary=ExitsSummary(buys_12m=buys, sells_12m=sells, beat_spy_pct=beat_spy_pct(rows)),
        metrics=build_metrics(
            perf,
            years,
            quarters,
            turnover=turnover(years, quarters),
            hold_all=hold_all,
            hold_sold=hold_sold,
        ),
    )


def position(stock_id, trades, **kw) -> PositionResult:
    fields = dict(
        stock_id=stock_id,
        from_q=trades[0].q,
        to_q=None,
        quarters=[],
        trades=trades,
        invested=1000.0,
        realised=0.0,
        dividends=0.0,
        shares_now=trades[-1].shares_after,
        cost_now=500.0,
        avg_cost=10.0,
        avg_exit=None,
        sold_shares=0.0,
        sold_usd=0.0,
    )
    fields.update(kw)
    return PositionResult(**fields)


def trade(q, kind, delta, px, shares_after, low=None, high=None) -> Trade:
    return Trade(q=q, type=kind, delta=delta, px=px, low=low, high=high, shares_after=shares_after)


def with_positions(fund, positions, **kw) -> FundOutput:
    """`fund` with other positions and the n_holdings that goes with them."""
    held = sum(p.shares_now > 0 for p in positions)
    return replace(fund, positions=positions, meta=replace(fund.meta, n_holdings=held), **kw)


def fund_with(positions, **kw) -> FundOutput:
    return with_positions(build_engine_fund(), positions, **kw)


def fquarter(q, ret, start=100.0, end=110.0) -> FundQuarter:
    return FundQuarter(
        q=q,
        start=start,
        end=end,
        net_buying=0.0,
        buys=0.0,
        sells=0.0,
        market_move=0.0,
        trade_gains=0.0,
        dividends=0.0,
        ret=ret,
    )


def fyear(label, qs, ret) -> FundYear:
    return FundYear(
        label=label,
        qs=qs,
        ret=ret,
        start=100.0,
        end=110.0,
        gains=10.0,
        inflows=0.0,
        dividends=0.0,
        approx_ret=ret,
    )


def decoded(root, rel):
    return read_json(root / rel)


def sha256(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- write_json -----------------------------------------------------------------------------


def test_brotli_roundtrip(tmp_path):
    obj = {"b": [1, 2.5, None], "a": {"label": "2014 Q2–Q4", "ok": True}}
    path = tmp_path / "sub" / "x.json"
    checksum = write_json(path, obj)
    raw = path.read_bytes()
    assert json.loads(brotli.decompress(raw)) == obj
    assert checksum == hashlib.sha256(raw).hexdigest()
    assert read_json(path) == obj


def test_write_json_plain_when_not_compressed(tmp_path):
    path = tmp_path / "x.json"
    checksum = write_json(path, {"a": [1, 2]}, compress=False)
    assert path.read_bytes() == b'{"a":[1,2]}'
    assert checksum == sha256(path)
    assert read_json(path, compressed=False) == {"a": [1, 2]}


def test_write_json_is_minified_sorted_and_deterministic(tmp_path):
    write_json(tmp_path / "a.json", {"z": 1, "a": {"y": [1, 2], "b": None}}, compress=False)
    write_json(tmp_path / "b.json", {"a": {"b": None, "y": [1, 2]}, "z": 1}, compress=False)
    assert (tmp_path / "a.json").read_bytes() == b'{"a":{"b":null,"y":[1,2]},"z":1}'
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()
    first = write_json(tmp_path / "c.json", {"k": list(range(100))})
    assert write_json(tmp_path / "d.json", {"k": list(range(100))}) == first


def test_write_json_turns_nan_and_inf_into_null(tmp_path):
    nan, inf = float("nan"), float("inf")
    path = tmp_path / "x.json"
    write_json(path, {"a": nan, "b": [1.0, inf, -inf], "c": {"d": (nan, 2.0)}}, compress=False)
    assert path.read_bytes() == b'{"a":null,"b":[1.0,null,null],"c":{"d":[null,2.0]}}'


def test_write_json_leaves_no_temp_file_and_replaces_an_existing_file(tmp_path):
    path = tmp_path / "x.json"
    write_json(path, {"v": 1})
    write_json(path, {"v": 2})
    assert read_json(path) == {"v": 2}
    assert [p.name for p in tmp_path.iterdir()] == ["x.json"]


@pytest.mark.parametrize("key", ["cusip", "CUSIP", "cusips"])
def test_write_json_refuses_a_cusip_key_anywhere(tmp_path, key):
    with pytest.raises(ValueError, match="CUSIP"):
        write_json(tmp_path / "x.json", {"flags": [{"stock_id": 1, key: CUSIP}]})
    assert not (tmp_path / "x.json").exists()


# --- publish_fund ---------------------------------------------------------------------------


def test_publish_fund_writes_the_four_fund_files_and_returns_their_checksums(tmp_path):
    files = publish_fund(tmp_path, build_engine_fund(fund_id=7))
    assert sorted(files) == [
        f"fund/7/{n}.json" for n in ("contrib", "exits", "positions", "summary")
    ]
    for rel, checksum in files.items():
        assert sha256(tmp_path / rel) == checksum


def test_summary_has_the_contract_keys(tmp_path):
    publish_fund(tmp_path, build_engine_fund(fund_id=7))
    s = decoded(tmp_path, "fund/7/summary.json")
    assert set(s) == {
        "id",
        "name",
        "cik",
        "period_q",
        "filed",
        "book",
        "n_holdings",
        "priced_pct",
        "tracked_since_q",
        "inactive",
        "metrics",
        "years",
        "quarters",
        "holdings_now",
    }
    assert set(s["metrics"]) == {
        "ann_return",
        "sharpe",
        "sortino",
        "vol",
        "max_dd",
        "calmar",
        "best_year",
        "worst_year",
        "years_pos",
        "years_total",
        "quarters_pos_pct",
        "turnover",
        "hold_all",
        "hold_sold",
        "first_year",
        "last_year",
    }
    assert set(s["years"]) == {
        "label",
        "ret",
        "start",
        "end",
        "gains",
        "inflows",
        "dividends",
        "approx_ret",
    }
    assert set(s["quarters"]) == {
        "q",
        "ret",
        "start",
        "end",
        "market_move",
        "net_buying",
        "trade_gains",
        "dividends",
    }
    assert set(s["holdings_now"]) == {"stock_id", "shares", "cost"}


def test_summary_values(tmp_path):
    fund = build_engine_fund(fund_id=7, book=1.5e9)
    publish_fund(tmp_path, fund)
    s = decoded(tmp_path, "fund/7/summary.json")
    assert (s["id"], s["name"], s["cik"], s["period_q"], s["filed"]) == (
        7,
        "ALPHA CAPITAL",
        1234,
        11,
        "2016-02-12",
    )
    assert (s["book"], s["n_holdings"], s["priced_pct"]) == (1.5e9, 1, 0.97)
    assert (s["tracked_since_q"], s["inactive"]) == (4, False)
    assert s["quarters"]["q"] == list(range(4, 12))
    assert s["quarters"]["ret"][0] is None  # the segment's first quarter has no return
    assert s["quarters"]["end"] == [fq.end for fq in fund.quarters]
    assert s["years"]["label"] == ["2014", "2015"]
    assert s["years"]["ret"] == [y.ret for y in fund.years]
    assert s["metrics"]["ann_return"] == fund.metrics["ann_return"]
    for block in ("years", "quarters", "holdings_now"):
        assert len({len(col) for col in s[block].values()}) == 1  # columns are aligned


def test_holdings_now_lists_open_positions_only(tmp_path):
    publish_fund(tmp_path, build_engine_fund(fund_id=7))
    held = decoded(tmp_path, "fund/7/summary.json")["holdings_now"]
    assert held["stock_id"] == [2]  # stock 1 was sold out
    assert held["shares"] == [50.0]
    assert held["cost"] == [pytest.approx(50.0 * 50.0)]  # bought at the first report's close


def test_positions_file_columns_and_trades(tmp_path):
    fund = build_engine_fund(fund_id=7)
    publish_fund(tmp_path, fund)
    p = decoded(tmp_path, "fund/7/positions.json")
    assert set(p) == {
        "stock_id",
        "from_q",
        "to_q",
        "avg_cost",
        "avg_exit",
        "invested",
        "realised",
        "dividends",
        "shares_now",
        "cost_now",
        "last_q",
        "last_type",
        "last_pct",
        "last_usd",
        "trades",
    }
    assert p["stock_id"] == [1, 2]
    assert p["from_q"] == [4, 4]
    assert p["to_q"] == [10, None]
    assert p["avg_exit"][1] is None  # stock 2 was never sold
    assert p["shares_now"] == [0.0, 50.0]
    assert len({len(col) for col in p.values()}) == 1
    first = fund.positions[0]
    assert p["trades"][0] == [
        [t.q, t.delta, round(t.px, 4), round(t.low, 4), round(t.high, 4), t.shares_after]
        for t in first.trades
    ]
    assert [row[0] for row in p["trades"][0]] == [4, 6, 8, 10]  # new, add, trim, exit
    assert len(p["trades"][1]) == 1


@pytest.mark.parametrize(
    "trades, last_type, last_pct, last_usd",
    [
        ([trade(9, "new", 100.0, 10.0, 100.0)], "new", None, 1000.0),
        # +50 on the 100 held before
        (
            [trade(3, "new", 100.0, 10.0, 100.0), trade(9, "add", 50.0, 10.0, 150.0)],
            "add",
            0.5,
            500.0,
        ),
        # -50 on the 150 held before
        (
            [trade(3, "new", 150.0, 10.0, 150.0), trade(9, "trim", -50.0, 10.0, 100.0)],
            "trim",
            -1 / 3,
            -500.0,
        ),
        (
            [trade(3, "new", 100.0, 10.0, 100.0), trade(9, "exit", -100.0, 10.0, 0.0)],
            "exit",
            None,
            -1000.0,
        ),
    ],
)
def test_last_change_fields(tmp_path, trades, last_type, last_pct, last_usd):
    publish_fund(tmp_path, fund_with([position(1, trades)]))
    p = decoded(tmp_path, "fund/7/positions.json")
    assert (p["last_q"], p["last_type"]) == ([9], [last_type])
    assert p["last_usd"] == [pytest.approx(last_usd)]
    assert p["last_pct"] == ([None] if last_pct is None else [pytest.approx(last_pct)])


def test_last_pct_is_null_when_nothing_was_held_before_the_trade(tmp_path):
    odd = position(1, [trade(9, "add", 10.0, 10.0, 10.0)])  # an "add" from zero: malformed input
    publish_fund(tmp_path, fund_with([odd]))
    assert decoded(tmp_path, "fund/7/positions.json")["last_pct"] == [None]


def test_positions_are_sorted_by_stock_id_whatever_the_input_order(tmp_path):
    a = position(5, [trade(3, "new", 10.0, 1.0, 10.0)])
    b = position(2, [trade(3, "new", 10.0, 1.0, 10.0)])
    fund = build_engine_fund()
    one = publish_fund(tmp_path / "one", with_positions(fund, [a, b], exits=[]))
    two = publish_fund(tmp_path / "two", with_positions(fund, [b, a], exits=[]))
    assert one == two
    assert decoded(tmp_path / "one", "fund/7/positions.json")["stock_id"] == [2, 5]


def test_trade_prices_are_rounded_to_four_places_and_nothing_else(tmp_path):
    noisy = trade(9, "new", 100.123456789, 189.9499969482422, 100.123456789)
    noisy = replace(noisy, low=0.123449999, high=1234.56785001)  # float32 noise below the 4th place
    pos = position(
        1, [noisy], invested=1234.5678912345, avg_cost=12.3456789, cost_now=500.123456789
    )
    publish_fund(tmp_path, fund_with([pos]))
    p = decoded(tmp_path, "fund/7/positions.json")
    assert p["trades"] == [[[9, 100.123456789, 189.95, 0.1234, 1234.5679, 100.123456789]]]
    # money, shares and per-share averages keep every digit
    assert (p["invested"], p["avg_cost"], p["cost_now"]) == (
        [1234.5678912345],
        [12.3456789],
        [500.123456789],
    )
    assert p["last_usd"] == [100.123456789 * 189.9499969482422]  # from the unrounded price


def test_a_missing_trade_price_range_stays_null(tmp_path):
    publish_fund(tmp_path, fund_with([position(1, [trade(9, "new", 10.0, 5.5, 10.0)])]))
    assert decoded(tmp_path, "fund/7/positions.json")["trades"] == [
        [[9, 10.0, 5.5, None, None, 10.0]]
    ]


def test_publish_fund_rejects_an_n_holdings_that_is_not_the_positions_held(tmp_path):
    fund = build_engine_fund()  # one position held (stock 2)
    bad = replace(fund, meta=replace(fund.meta, n_holdings=2))
    with pytest.raises(ValueError, match="n_holdings"):
        publish_fund(tmp_path, bad)
    assert not list(tmp_path.rglob("*.json"))


def test_contrib_file(tmp_path):
    fund = build_engine_fund(fund_id=7)
    publish_fund(tmp_path, fund)
    c = decoded(tmp_path, "fund/7/contrib.json")
    assert c["years"] == ["2014", "2015"]
    assert set(c["by_year"]) == {"2014", "2015"}
    for label, rows in fund.contributions.items():
        year = c["by_year"][label]
        assert set(year) == {"stock_id", "points", "pnl"}
        assert year["stock_id"] == [r[0] for r in rows]
        assert year["points"] == [r[1] for r in rows]
        assert year["pnl"] == [r[2] for r in rows]


def test_contrib_rows_with_equal_points_are_ordered_by_stock_id(tmp_path):
    fund = replace(
        build_engine_fund(),
        years=[fyear("2014", [4, 5, 6, 7], 0.1)],
        contributions={"2014": [(9, 2.0, 20.0), (3, 2.0, 20.0), (5, 3.0, 30.0)]},
    )
    publish_fund(tmp_path, fund)
    year = decoded(tmp_path, "fund/7/contrib.json")["by_year"]["2014"]
    assert year["stock_id"] == [5, 3, 9]


def test_a_year_without_contributions_is_an_empty_set_of_columns(tmp_path):
    fund = replace(build_engine_fund(), contributions={"2014": [], "2015": []})
    publish_fund(tmp_path, fund)
    assert decoded(tmp_path, "fund/7/contrib.json")["by_year"]["2014"] == {
        "stock_id": [],
        "points": [],
        "pnl": [],
    }


def test_exits_file(tmp_path):
    fund = build_engine_fund(fund_id=7)
    publish_fund(tmp_path, fund)
    e = decoded(tmp_path, "fund/7/exits.json")
    assert set(e) == {"rows", "summary"}
    assert set(e["rows"]) == {
        "stock_id",
        "status",
        "sold_shares",
        "sold_usd",
        "avg_exit",
        "last_sale_q",
        "one_y",
        "spy_one_y",
    }
    assert e["rows"]["stock_id"] == [r.stock_id for r in fund.exits] == [1]
    assert e["rows"]["status"] == ["sold_all"]
    assert e["rows"]["last_sale_q"] == [10]
    assert e["rows"]["one_y"] == [fund.exits[0].one_y]
    assert e["summary"] == {
        "buys_12m": fund.exits_summary.buys_12m,
        "sells_12m": fund.exits_summary.sells_12m,
        "beat_spy_pct": fund.exits_summary.beat_spy_pct,
    }


def test_exit_rows_with_missing_returns_publish_null(tmp_path):
    row = ExitRow(
        stock_id=3,
        status="trimmed",
        sold_shares=5.0,
        sold_usd=50.0,
        avg_exit=10.0,
        last_sale_q=11,
        one_y=None,
        spy_one_y=None,
    )
    fund = replace(
        build_engine_fund(),
        exits=[row],
        exits_summary=ExitsSummary(buys_12m=None, sells_12m=None, beat_spy_pct=None),
    )
    publish_fund(tmp_path, fund)
    e = decoded(tmp_path, "fund/7/exits.json")
    assert (e["rows"]["one_y"], e["rows"]["spy_one_y"]) == ([None], [None])
    assert e["summary"] == {"buys_12m": None, "sells_12m": None, "beat_spy_pct": None}


def test_publish_fund_uncompressed(tmp_path):
    files = publish_fund(tmp_path, build_engine_fund(fund_id=7), compress=False)
    raw = (tmp_path / "fund/7/summary.json").read_bytes()
    assert json.loads(raw)["id"] == 7
    assert files["fund/7/summary.json"] == hashlib.sha256(raw).hexdigest()


def test_same_fund_gives_the_same_bytes(tmp_path):
    one = publish_fund(tmp_path / "one", build_engine_fund())
    two = publish_fund(tmp_path / "two", build_engine_fund())
    assert one == two


# --- metrics --------------------------------------------------------------------------------


def perf_obj(**kw) -> Performance:
    fields = dict(
        ann_return=0.1,
        sharpe=0.9,
        sortino=1.2,
        vol=0.15,
        max_dd=-0.2,
        calmar=0.5,
        quarters_pos_pct=0.6,
    )
    fields.update(kw)
    return Performance(**fields)


def test_metrics_count_full_years_only():
    # 2013 H2 starts the segment (partial); 2014-2016 are full; 2017 Q1 is partial
    quarters = [fquarter(q, 0.01 if q > 2 else None) for q in range(2, 17)]
    years = [
        fyear("2013 H2", [2, 3], 0.50),  # a big partial year must not be "best"
        fyear("2014", [4, 5, 6, 7], 0.10),
        fyear("2015", [8, 9, 10, 11], -0.20),
        fyear("2016", [12, 13, 14, 15], 0.30),
        fyear("2017 Q1", [16], -0.90),  # nor "worst"
    ]
    m = build_metrics(perf_obj(), years, quarters, turnover=0.4, hold_all=2.5, hold_sold=1.5)
    assert m["best_year"] == {"label": "2016", "ret": 0.30}
    assert m["worst_year"] == {"label": "2015", "ret": -0.20}
    assert (m["years_pos"], m["years_total"]) == (2, 3)
    assert (m["first_year"], m["last_year"]) == (2014, 2016)
    assert (m["turnover"], m["hold_all"], m["hold_sold"]) == (0.4, 2.5, 1.5)
    assert (m["ann_return"], m["sharpe"], m["sortino"], m["vol"]) == (0.1, 0.9, 1.2, 0.15)
    assert (m["max_dd"], m["calmar"], m["quarters_pos_pct"]) == (-0.2, 0.5, 0.6)


def test_a_year_holding_the_segments_first_quarter_is_not_a_full_year():
    # tracking starts in Q1 2014: that quarter has no return, so 2014's return covers 9 months
    quarters = [fquarter(q, None if q == 4 else 0.02) for q in range(4, 12)]
    years = [fyear("2014", [4, 5, 6, 7], 0.06), fyear("2015", [8, 9, 10, 11], 0.08)]
    m = build_metrics(perf_obj(), years, quarters, turnover=None, hold_all=1.0, hold_sold=None)
    assert m["best_year"] == m["worst_year"] == {"label": "2015", "ret": 0.08}
    assert (m["years_pos"], m["years_total"], m["first_year"], m["last_year"]) == (1, 1, 2015, 2015)


def test_year_figures_and_turnover_cover_the_same_years():
    # 2014 holds the segment's first quarter; in 2015 one quarter has no return; 2016 is full
    quarters = [fquarter(q, None if q in (4, 9) else 0.02) for q in range(4, 16)]
    years = [
        fyear("2014", [4, 5, 6, 7], 0.08),
        fyear("2015", [8, 9, 10, 11], 0.06),
        fyear("2016", [12, 13, 14, 15], 0.09),
    ]
    m = build_metrics(perf_obj(), years, quarters, turnover=None, hold_all=1.0, hold_sold=None)
    assert (m["first_year"], m["last_year"], m["years_total"]) == (2016, 2016, 1)
    assert [y.label for y in full_years(years, quarters)] == ["2016"]


def test_metrics_without_performance_or_full_years_are_null():
    quarters = [fquarter(5, None), fquarter(6, 0.01)]
    years = [fyear("2014 Q2–Q3", [5, 6], 0.01)]
    m = build_metrics(None, years, quarters, turnover=None, hold_all=0.5, hold_sold=None)
    assert m == {
        "ann_return": None,
        "sharpe": None,
        "sortino": None,
        "vol": None,
        "max_dd": None,
        "calmar": None,
        "best_year": None,
        "worst_year": None,
        "years_pos": None,
        "years_total": None,
        "quarters_pos_pct": None,
        "turnover": None,
        "hold_all": 0.5,
        "hold_sold": None,
        "first_year": None,
        "last_year": None,
    }


def test_metric_ties_pick_the_earliest_year():
    quarters = [fquarter(q, 0.01) for q in range(3, 12)]
    years = [fyear("2014", [4, 5, 6, 7], 0.10), fyear("2015", [8, 9, 10, 11], 0.10)]
    m = build_metrics(perf_obj(), years, quarters, turnover=None, hold_all=1.0, hold_sold=None)
    assert m["best_year"]["label"] == m["worst_year"]["label"] == "2014"


def test_publish_fund_rejects_metrics_with_the_wrong_keys(tmp_path):
    fund = build_engine_fund()
    bad = {k: v for k, v in fund.metrics.items() if k != "vol"} | {"sharp": 1.0}
    with pytest.raises(ValueError, match="metrics"):
        publish_fund(tmp_path, replace(fund, metrics=bad))
    assert not list(tmp_path.rglob("*.json"))


# --- weekly closes --------------------------------------------------------------------------


def daily(rows) -> pl.DataFrame:
    return pl.DataFrame(
        {"date": [r[0] for r in rows], "close": [r[1] for r in rows]},
        schema={"date": pl.Date, "close": pl.Float64},
    )


def test_weekly_closes_last_close_of_each_week():
    df = daily(
        [
            (date(2024, 1, 2), 10.0),  # Tue
            (date(2024, 1, 3), 11.0),
            (date(2024, 1, 5), 12.0),  # Fri: week 1 closes at 12
            (date(2024, 1, 8), 13.0),
            (date(2024, 1, 11), 14.0),  # Thu, Fri is a holiday: week 2 closes at 14
            (date(2024, 1, 16), 15.0),  # Tue of week 3, the last row
        ]
    )
    assert weekly_closes(df) == {"start": "2024-01-05", "close": [12.0, 14.0, 15.0]}


def test_weekly_closes_start_is_the_first_weeks_friday():
    df = daily([(date(2024, 1, 3), 11.0), (date(2024, 1, 4), 12.0), (date(2024, 1, 9), 13.0)])
    assert weekly_closes(df) == {"start": "2024-01-05", "close": [12.0, 13.0]}
    only_monday = daily([(date(2024, 1, 8), 5.0)])
    assert weekly_closes(only_monday) == {"start": "2024-01-12", "close": [5.0]}


def test_weekly_closes_keep_an_empty_week_as_null_and_never_forward_fill():
    rows = [
        (date(2024, 1, 5), 12.0),
        (date(2024, 1, 3), 11.0),
        (date(2024, 1, 12), None),  # unpriced: not a close, week 2 has no priced day
        (date(2024, 1, 26), 20.0),  # week 3 has no rows at all; week 4 closes at 20
        (date(2024, 1, 4), None),  # a missing close does not hide Wed's or Fri's
    ]
    assert weekly_closes(daily(rows)) == {"start": "2024-01-05", "close": [12.0, None, None, 20.0]}


def test_weekly_close_i_is_the_week_ending_start_plus_7i_days():
    days = [(1, 5), (1, 8), (1, 10), (1, 22), (1, 25), (2, 16), (2, 20)]  # trading days of 2024
    rows = [(date(2024, month, day), 100.0 + n) for n, (month, day) in enumerate(days)]
    result = weekly_closes(daily(rows))
    friday = date.fromisoformat(result["start"])
    assert friday == date(2024, 1, 5) and friday.weekday() == 4
    assert len(result["close"]) == 8  # up to the week of Feb 19-23, the last with a priced day
    for i, close in enumerate(result["close"]):
        week_end = friday + timedelta(days=7 * i)
        in_week = [px for d, px in rows if 0 <= (week_end - d).days <= 4]  # Monday to Friday
        assert close == (in_week[-1] if in_week else None)
    assert result["close"].count(None) == 3 and result["close"][-1] == 106.0


def test_weekly_closes_of_nothing():
    assert weekly_closes(daily([])) == {"start": None, "close": []}
    assert weekly_closes(daily([(date(2024, 1, 5), None)])) == {"start": None, "close": []}


def test_weekly_closes_ignore_other_columns():
    df = daily([(date(2024, 1, 5), 12.0)]).with_columns(
        volume=pl.lit(5.0), high=pl.lit(99.0), stock_id=pl.lit(1)
    )
    assert weekly_closes(df) == {"start": "2024-01-05", "close": [12.0]}


# --- publish_shared -------------------------------------------------------------------------


def home_lists(latest_q=53) -> HomeLists:
    top_row = {
        "fund_id": 7,
        "name": "ALPHA CAPITAL",
        "book": 2e9,
        "n_positions": 30,
        "ann_return": 0.12,
        "max_dd": -0.2,
        "sharpe": 0.8,
    }
    return HomeLists(
        latest_q=latest_q,
        top={p: {"eligible": [top_row], "giants": []} for p in PERIODS},
        conviction=[{"fund_id": 7, "stock_id": 1, "move": "new"}],
        wins_losses={"wins": [{"fund_id": 7, "stock_id": 1, "pnl": 5.0}], "losses": []},
        just_filed=[{"fund_id": 7, "filed": "2026-08-14"}],
        crowded=[{"stock_id": 1, "funds_buying": 3}],
        calls_q=[{"stock_id": 1, "fund_id": 7, "q": 53}],
        calls_y=[],
    )


def securities_frame() -> pl.DataFrame:
    return pl.DataFrame(
        {
            "stock_id": [2, 1],
            "ticker": ["MSFT", "AAPL"],
            "name": ["MICROSOFT", "APPLE"],
            "sector": ["Technology", "Technology"],
            "figi": ["BBG000BPH459", "BBG000B9XRY4"],
            "cusip": ["594918104", CUSIP],
            "is_etf": [False, False],
        }
    )


def shared(out, **kw) -> dict[str, str]:
    args = dict(
        funds=[build_engine_fund(7).meta, replace(build_engine_fund(3).meta, name="BETA FUND")],
        securities=securities_frame(),
        asof=date(2026, 10, 29),
        latest_prices={2: 410.5, 1: 189.95},
        home=home_lists(),
    )
    args.update(kw)
    return publish_shared(out, **args)


def test_shared_files_follow_the_contract(tmp_path):
    files = shared(tmp_path, weekly={1: {"start": "2024-01-05", "close": [1.0, 2.0]}})
    assert sorted(files) == sorted(
        [
            "funds.json",
            "securities.json",
            "latest_prices.json",
            "stock/1/weekly.json",
            *(f"home/top_{p}.json" for p in PERIODS),
            *(f"home/{n}.json" for n in ("conviction", "wins_losses", "just_filed", "crowded")),
            "home/calls_q.json",
            "home/calls_y.json",
        ]
    )
    for rel, checksum in files.items():
        assert sha256(tmp_path / rel) == checksum
    assert decoded(tmp_path, "funds.json") == {
        "v": 1,
        "id": [3, 7],
        "name": ["BETA FUND", "ALPHA CAPITAL"],
        "book": [1.5e9, 1.5e9],
        "n": [1, 1],
    }
    assert decoded(tmp_path, "securities.json") == {
        "stock_id": [1, 2],
        "ticker": ["AAPL", "MSFT"],
        "name": ["APPLE", "MICROSOFT"],
        "sector": ["Technology", "Technology"],
    }
    assert decoded(tmp_path, "latest_prices.json") == {
        "asof": "2026-10-29",
        "stock_id": [1, 2],
        "price": [189.95, 410.5],
    }
    assert decoded(tmp_path, "stock/1/weekly.json") == {"start": "2024-01-05", "close": [1.0, 2.0]}


def test_home_files_carry_latest_q_and_the_lists(tmp_path):
    shared(tmp_path)
    top = decoded(tmp_path, "home/top_3y.json")
    assert set(top) == {"latest_q", "period", "eligible", "giants"}
    assert (top["latest_q"], top["period"], top["giants"]) == (53, "3y", [])
    assert top["eligible"][0]["fund_id"] == 7
    assert decoded(tmp_path, "home/conviction.json") == {
        "latest_q": 53,
        "rows": [{"fund_id": 7, "stock_id": 1, "move": "new"}],
    }
    assert decoded(tmp_path, "home/wins_losses.json") == {
        "latest_q": 53,
        "wins": [{"fund_id": 7, "stock_id": 1, "pnl": 5.0}],
        "losses": [],
    }
    assert decoded(tmp_path, "home/just_filed.json")["rows"] == [
        {"fund_id": 7, "filed": "2026-08-14"}
    ]
    assert decoded(tmp_path, "home/crowded.json")["rows"][0]["funds_buying"] == 3
    assert decoded(tmp_path, "home/calls_q.json")["rows"] == [
        {"stock_id": 1, "fund_id": 7, "q": 53}
    ]
    assert decoded(tmp_path, "home/calls_y.json") == {"latest_q": 53, "rows": []}


def test_securities_publish_only_the_contract_columns(tmp_path):
    shared(tmp_path)
    assert set(decoded(tmp_path, "securities.json")) == {"stock_id", "ticker", "name", "sector"}


def test_securities_missing_a_column_is_an_error(tmp_path):
    with pytest.raises(pl.exceptions.ColumnNotFoundError):
        shared(tmp_path, securities=securities_frame().drop("sector"))


def test_latest_prices_missing_become_null(tmp_path):
    shared(tmp_path, latest_prices={1: float("nan"), 2: None, 3: 5.0})
    assert decoded(tmp_path, "latest_prices.json")["price"] == [None, None, 5.0]


def test_prices_are_published_to_four_places(tmp_path):
    files = shared(
        tmp_path,
        latest_prices={1: 189.9499969482422, 2: 0.00004999},
        weekly={1: {"start": "2024-01-05", "close": [47.48749923706055, None, 0.1 + 0.2]}},
    )
    assert decoded(tmp_path, "latest_prices.json")["price"] == [189.95, 0.0]
    assert decoded(tmp_path, "stock/1/weekly.json")["close"] == [47.4875, None, 0.3]
    assert "stock/1/weekly.json" in files


def test_weekly_without_closes_is_not_published(tmp_path):
    files = shared(tmp_path, weekly={4: {"start": None, "close": []}})
    assert "stock/4/weekly.json" not in files
    assert not (tmp_path / "stock").exists()


def test_home_needs_every_period(tmp_path):
    home = home_lists()
    bad = replace(home, top={p: v for p, v in home.top.items() if p != "5y"})
    with pytest.raises(ValueError, match="period"):
        shared(tmp_path, home=bad)
    assert not list(tmp_path.rglob("*.json"))


def test_shared_uncompressed(tmp_path):
    shared(tmp_path, compress=False)
    assert json.loads((tmp_path / "funds.json").read_bytes())["v"] == 1


# --- versions, manifest, health -------------------------------------------------------------


def test_new_version_creates_a_clean_staging_folder(tmp_path):
    staging = new_version(tmp_path, "2026-10-30")
    assert staging == tmp_path / "staging" / "2026-10-30"
    assert staging.is_dir() and not any(staging.iterdir())
    (staging / "stale.json").write_text("{}")
    again = new_version(tmp_path, "2026-10-30")  # a re-run starts from nothing
    assert again == staging and not any(again.iterdir())


def test_new_version_keeps_other_runs(tmp_path):
    old = new_version(tmp_path, "run1")
    (old / "keep.json").write_text("{}")
    new_version(tmp_path, "run2")
    assert (old / "keep.json").exists()


@pytest.mark.parametrize("run_id", ["", ".", "..", "a/b", "../x", "a\\b", "/abs"])
def test_new_version_rejects_run_ids_that_are_not_a_folder_name(tmp_path, run_id):
    with pytest.raises(ValueError, match="run_id"):
        new_version(tmp_path, run_id)


def test_changed_files_only(tmp_path):
    fund = build_engine_fund()
    first = publish_fund(new_version(tmp_path, "w1"), fund)
    write_manifest(tmp_path, "w1", first)
    previous = read_manifest(tmp_path)
    same = publish_fund(new_version(tmp_path, "w2"), fund)
    assert changed_files(same, previous) == []  # same content twice
    richer = replace(fund, meta=replace(fund.meta, book=2e9))
    edited = publish_fund(new_version(tmp_path, "w3"), richer)
    assert changed_files(edited, previous) == ["fund/7/summary.json"]


def test_changed_files_lists_new_files_sorted_and_ignores_files_not_rebuilt():
    previous = {"a.json": "1", "b.json": "2", "gone.json": "3"}
    new = {"c.json": "9", "b.json": "2", "a.json": "changed", "0.json": "7"}
    assert changed_files(new, previous) == ["0.json", "a.json", "c.json"]
    assert changed_files(new, {}) == ["0.json", "a.json", "b.json", "c.json"]


def test_manifest_written_last(tmp_path):
    staging = new_version(tmp_path, "run1")
    files = publish_fund(staging, build_engine_fund())
    files |= shared(staging)
    files |= write_health(staging, health_stats())
    write_manifest(tmp_path, "run1", files)
    manifest = tmp_path / "manifest.json"
    newest = max(p.stat().st_mtime_ns for p in staging.rglob("*") if p.is_file())
    assert manifest.stat().st_mtime_ns >= newest


def test_manifest_content(tmp_path):
    staging = new_version(tmp_path, "run1")
    files = publish_fund(staging, build_engine_fund())
    write_manifest(tmp_path, "run1", files)
    m = read_json(tmp_path / "manifest.json")
    assert set(m) == {"version", "built", "files"}
    assert m["version"] == "run1"
    assert m["files"] == files == read_manifest(tmp_path)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", m["built"])
    for rel, checksum in m["files"].items():
        assert sha256(staging / rel) == checksum


def test_manifest_uncompressed_roundtrip(tmp_path):
    write_manifest(tmp_path, "v", {"a.json": "abc"}, compress=False)
    assert json.loads((tmp_path / "manifest.json").read_bytes())["files"] == {"a.json": "abc"}
    assert read_manifest(tmp_path, compressed=False) == {"a.json": "abc"}


def test_read_manifest_is_empty_on_the_first_run(tmp_path):
    assert read_manifest(tmp_path) == {}


def health_stats(**kw) -> dict:
    stats = dict(
        filings_parsed=1200,
        unmapped_cusips=42,
        coverage_median=0.93,
        funds_recomputed=17,
        flags=[
            {"kind": "price_mismatch", "fund_id": 7, "stock_id": 1, "q": 53},
            "bulk fetch failed",
        ],
    )
    stats.update(kw)
    return stats


def test_write_health_follows_the_contract(tmp_path):
    files = write_health(tmp_path, health_stats())
    assert files == {"health.json": sha256(tmp_path / "health.json")}
    assert decoded(tmp_path, "health.json") == health_stats()


def test_write_health_allows_no_coverage_and_no_flags(tmp_path):
    write_health(tmp_path, health_stats(coverage_median=None, flags=[]))
    h = decoded(tmp_path, "health.json")
    assert (h["coverage_median"], h["flags"]) == (None, [])


def test_write_health_publishes_a_count_of_unmapped_cusips_never_the_cusips(tmp_path):
    with pytest.raises(TypeError, match="count"):
        write_health(tmp_path, health_stats(unmapped_cusips=[CUSIP]))
    with pytest.raises(ValueError, match="CUSIP"):
        write_health(tmp_path, health_stats(flags=[{"cusip": CUSIP}]))
    assert not (tmp_path / "health.json").exists()


def test_write_health_needs_exactly_the_contract_stats(tmp_path):
    missing = {k: v for k, v in health_stats().items() if k != "flags"}
    with pytest.raises(ValueError, match="flags"):
        write_health(tmp_path, missing)
    with pytest.raises(ValueError, match="extra"):
        write_health(tmp_path, health_stats(extra=1))


# --- no CUSIP in any published file -----------------------------------------------------------


def test_no_cusip_in_output(tmp_path):
    staging = new_version(tmp_path, "run1")
    fund = build_engine_fund()
    files = publish_fund(staging, fund)
    files |= shared(
        staging, weekly={1: weekly_closes(daily([(date(2024, 1, 5), 12.0)]))}
    )  # the securities frame passed in carries the cusip and figi columns
    files |= write_health(staging, health_stats())
    write_manifest(tmp_path, "run1", files)
    published = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert len(published) >= 20
    for path in published:
        text = brotli.decompress(path.read_bytes()).decode()
        assert CUSIP not in text, path
        assert "594918104" not in text, path
        assert "cusip" not in text.replace("unmapped_cusips", ""), path


def test_manifest_takes_a_fixed_build_time(tmp_path):
    built = datetime(2026, 10, 30, 6, 23, 5, tzinfo=UTC)

    write_manifest(tmp_path, "v", {"a.json": "abc"}, compress=False, built=built)

    assert (
        read_json(tmp_path / "manifest.json", compressed=False)["built"] == "2026-10-30T06:23:05Z"
    )
