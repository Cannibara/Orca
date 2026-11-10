"""The 500-position cut: top rows plus the "All other positions" sums equal the fund."""

import dataclasses

import pytest
from conftest import demo_batch

from orca.engine.metrics import hold_lengths
from orca.engine.position import PositionQuarter, PositionResult
from orca.engine.whatif import beat_spy_pct, buys_vs_sells, exit_rows
from orca.prices import ShareFactors
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


# --- every sum, pinned against the engine's own fund-level functions ----------------------------


def _all_in_other(demo_run, ciks=CIKS, latest_edit=None):
    ctx, batch = demo_batch(demo_run, ciks)
    latest = latest_closes(demo_run.lake)
    if latest_edit:
        latest = latest_edit(latest)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    return ctx, latest, securities, batch


def test_every_sum_matches_the_engine(demo_run):
    ctx, latest, securities, batch = _all_in_other(demo_run)
    saw_sold = saw_missing_price = False
    for p, r in batch:
        fi = build_inputs(ctx, p, r, latest, securities, max_positions=0)
        o, positions, pq = fi.other, r.output.positions, fi.period_q
        assert o is not None and o.count == len(positions)
        px_by = {pos.stock_id: p.px[pos.stock_id] for pos in positions}
        price = {
            pos.stock_id: latest[pos.stock_id][1] for pos in positions if pos.stock_id in latest
        }

        # filed values: the sum of Prepared.filed over the positions, per quarter column
        for i, q in enumerate(fi.quarters):
            want = sum(
                p.filed[pos.stock_id][q][1] for pos in positions if q in p.filed[pos.stock_id]
            )
            assert o.value_filed[i] == pytest.approx(want, rel=1e-12)

        # held now, value now, shares before x latest price
        assert o.held_now == sum(pos.shares_now > 0 for pos in positions)
        assert o.value_now == pytest.approx(
            sum(pos.shares_now * price[pos.stock_id] for pos in positions if pos.stock_id in price)
        )
        before = {  # shares at period_q - 1 by stock
            pos.stock_id: sum(x.shares for x in pos.quarters if x.q == pq - 1) for pos in positions
        }
        assert o.before_value_now == pytest.approx(
            sum(before[s] * price[s] for s in before if s in price)
        )

        # profitable / computable
        totals = []
        for pos in positions:
            if pos.shares_now > 0:
                if pos.stock_id not in price:
                    saw_missing_price = True
                    continue
                unrealised = pos.shares_now * price[pos.stock_id] - pos.cost_now
            else:
                saw_sold = True
                unrealised = 0.0
            totals.append(pos.realised + unrealised + pos.dividends)
        assert o.computable == len(totals)
        assert o.profitable == sum(t > 0 for t in totals)

        # hold lengths (hold_lengths returns means; sum = mean x n)
        mean_all, mean_sold = hold_lengths(positions, p.end_q)
        n_sold = sum(pos.to_q is not None for pos in positions)
        assert o.hold_n_all == len(positions) and o.hold_n_sold == n_sold
        assert o.hold_sum_all == pytest.approx(mean_all * len(positions))
        assert o.hold_sum_sold == pytest.approx((mean_sold or 0.0) * n_sold)

        # buys and sells one year on: the means behind buys_12m / sells_12m
        buys_mean, sells_mean = buys_vs_sells(positions, px_by)
        for mean, total, n in (
            (buys_mean, o.buys_1y_sum, o.buys_1y_n),
            (sells_mean, o.sells_1y_sum, o.sells_1y_n),
        ):
            assert (mean is None) == (n == 0)
            if n:
                assert total / n == pytest.approx(mean)

        # beat SPY and missed, from the exits table
        rows = exit_rows(positions, px_by, p.spy_px)
        beat = beat_spy_pct(rows)
        assert (beat is None) == (o.beat_n == 0)
        if o.beat_n:
            assert o.beat_pairs / o.beat_n == pytest.approx(beat)
        missed = [
            row.sold_shares * price[row.stock_id] - row.sold_usd
            for row in rows
            if row.stock_id in price
        ]
        assert o.missed_early == pytest.approx(sum(m for m in missed if m > 0))
        assert o.missed_dodged == pytest.approx(-sum(m for m in missed if m < 0))
    assert saw_sold  # the demo exercises sold-out positions
    assert not saw_missing_price  # (the unpriced branch has its own test)


def test_held_without_latest_price_is_not_computable(demo_run):
    ctx, latest, securities, batch = _all_in_other(demo_run, [SEASTACK])
    (p, r), = batch
    full = build_inputs(ctx, p, r, latest, securities, max_positions=0).other
    held = next(pos for pos in r.output.positions if pos.shares_now > 0)
    sold = next(pos for pos in r.output.positions if pos.shares_now == 0)
    gone = {k: v for k, v in latest.items() if k != held.stock_id}
    o = build_inputs(ctx, p, r, gone, securities, max_positions=0).other
    assert o.computable == full.computable - 1
    assert o.value_now == pytest.approx(full.value_now - held.shares_now * latest[held.stock_id][1])
    assert o.held_now == full.held_now  # still held, just unpriced
    # a sold-out position needs no latest price to have a total
    gone_sold = {k: v for k, v in latest.items() if k != sold.stock_id}
    o2 = build_inputs(ctx, p, r, gone_sold, securities, max_positions=0).other
    assert o2.computable == full.computable
    assert o2.profitable == full.profitable
    assert o2.value_now == full.value_now


def test_never_priced_stock_stays_a_zero_row(demo_run):
    ctx, latest, securities, batch = _all_in_other(demo_run, [SEASTACK])
    (p, r), = batch
    ghost = 999_999
    q = p.start + 1
    ctx.share_factors[ghost] = ShareFactors()
    try:
        p2 = dataclasses.replace(
            p,
            filed={**p.filed, ghost: {q: (100.0, 5000.0)}},
            adjusted={**p.adjusted, ghost: {q: (100.0, 5000.0)}},
            px={**p.px, ghost: {}},
        )
        fi = build_inputs(ctx, p2, r, latest, securities, max_positions=1)
        base = build_inputs(ctx, p, r, latest, securities, max_positions=1)
    finally:
        del ctx.share_factors[ghost]
    ids = [s.stock_id for s in fi.stocks]
    assert len(r.output.positions) > 1 and ghost in ids and len(ids) == 2
    assert ids[-1] == ghost  # peak 0 sorts after the kept position
    row = fi.stocks[-1]
    assert row.shares_filed[1] == 100.0 and all(c is None for c in row.close)
    assert fi.orca_stocks[-1].shares_now is None  # no position
    # never counted among the cut positions
    assert fi.other == base.other
    assert fi.other.count == len(r.output.positions) - 1
