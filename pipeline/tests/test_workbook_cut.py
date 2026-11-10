"""The 500-position cut: top rows plus the "All other positions" sums equal the fund."""

import dataclasses

import pytest
from conftest import demo_batch

from orca.engine.position import PositionQuarter, PositionResult
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.cut import split_top
from orca.workbook.inputs import build_inputs, from_json, to_json, validate

SEASTACK = 9100009
CIKS = list(range(9100001, 9100013))
KEEP = 3


@pytest.fixture(scope="module")
def cut(demo_run):
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    (p, r), = [(p, r) for p, r in batch if p.cik == SEASTACK]
    fi = build_inputs(ctx, p, r, latest, securities, max_positions=KEEP)
    return ctx, p, r, latest, securities, fi


def test_top_rows_plus_other_equal_fund_totals(cut):
    _, _, r, _, _, fi = cut
    assert fi.other is not None
    top_ids = {s.stock_id for s in fi.stocks}
    top = [pos for pos in r.output.positions if pos.stock_id in top_ids]
    assert len(top) == KEEP
    fq = {q.q: q for q in r.output.quarters}
    sums = {
        "value": ("end", lambda pq: pq.value),
        "market_move": ("market_move", lambda pq: pq.market_move),
        "trade_gain": ("trade_gains", lambda pq: pq.trade_gain),
        "dividends": ("dividends", lambda pq: pq.dividends),
    }
    for i, q in enumerate(fi.quarters):
        if q not in fq:
            assert fi.other.value[i] == 0.0
            continue
        pqs = [pq for pos in top for pq in pos.quarters if pq.q == q]
        for name, (field, get) in sums.items():
            got = sum(get(pq) for pq in pqs) + getattr(fi.other, name)[i]
            assert got == pytest.approx(getattr(fq[q], field), rel=1e-9, abs=1e-6)
        buys = sum(max(pq.net_buying, 0.0) for pq in pqs) + fi.other.buys[i]
        sells = sum(max(-pq.net_buying, 0.0) for pq in pqs) + fi.other.sells[i]
        assert buys == pytest.approx(fq[q].buys, rel=1e-9, abs=1e-6)
        assert sells == pytest.approx(fq[q].sells, rel=1e-9, abs=1e-6)


def test_other_counts(cut):
    _, p, r, _, _, fi = cut
    top_ids = {s.stock_id for s in fi.stocks}
    rest = [pos for pos in r.output.positions if pos.stock_id not in top_ids]
    o = fi.other
    assert o.count == len(r.output.positions) - KEEP == len(rest)
    assert o.held_now == sum(pos.shares_now > 0 for pos in rest)
    want = sum(((pos.to_q or p.end_q) - pos.from_q + 1) / 4 for pos in rest)
    assert o.hold_sum_all == pytest.approx(want)
    assert o.hold_n_all == len(rest)
    assert o.hold_n_sold == sum(pos.to_q is not None for pos in rest)
    assert 0 <= o.profitable <= o.computable <= o.count
    assert o.in_book_count == len(rest)


def test_ties_break_by_stock_id():
    def pos(sid: int, value: float) -> PositionResult:
        pq = PositionQuarter(0, 1, 1, 1, 1, 0, 0, 0, 0, value, 0)
        return PositionResult(sid, 0, None, [pq], [], 0, 0, 0, 1, 1, 1, None, 0, 0)

    top, rest = split_top([pos(9, 5.0), pos(3, 5.0), pos(7, 5.0), pos(1, 9.0)], 2)
    assert [x.stock_id for x in top] == [1, 3]
    assert [x.stock_id for x in rest] == [7, 9]


def test_no_cut_when_small(demo_run):
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    for p, r in batch:
        assert build_inputs(ctx, p, r, latest, securities, 500).other is None


def test_cut_round_trip_and_validate(cut):
    *_, fi = cut
    validate(fi)
    assert from_json(to_json(fi)) == fi
    short = dataclasses.replace(fi.other, value=fi.other.value[:-1])
    with pytest.raises(ValueError, match=rf"{fi.fund_id}.*other.value"):
        validate(dataclasses.replace(fi, other=short))
