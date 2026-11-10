"""FundInputs: what the fund workbook is built from, taken from the engine's own inputs."""

import dataclasses
import math

import pytest
from conftest import demo_batch

from orca.quarter_px import last_close_before
from orca.run.market import latest_closes
from orca.run.state import read_table
from orca.securities import SECURITIES_SCHEMA
from orca.workbook.inputs import build_inputs, from_json, to_json, validate

CIKS = list(range(9100001, 9100013))


@pytest.fixture(scope="module")
def built(demo_run):
    ctx, batch = demo_batch(demo_run, CIKS)
    latest = latest_closes(demo_run.lake)
    securities = read_table(demo_run.lake, "securities", SECURITIES_SCHEMA)
    inputs = [build_inputs(ctx, p, r, latest, securities) for p, r in batch]
    return ctx, batch, latest, inputs


def test_stock_order_is_peak_value_then_id(built):
    _, batch, _, inputs = built
    assert len(inputs) == 12
    for (p, r), fi in zip(batch, inputs, strict=True):
        peak = {
            pos.stock_id: max(pq.value for pq in pos.quarters) for pos in r.output.positions
        }
        want = sorted(p.adjusted, key=lambda s: (-peak.get(s, 0.0), s))
        assert [s.stock_id for s in fi.stocks] == want
        assert [o.stock_id for o in fi.orca_stocks] == want


def test_inputs_match_prepared(built):
    ctx, batch, latest, inputs = built
    for (p, _), fi in zip(batch, inputs, strict=True):
        assert fi.quarters == list(range(p.start, p.bound + 1))
        spy = [sid for sid in [ctx.spy_id] if sid in latest]
        mine = [latest[s.stock_id][0] for s in fi.stocks if s.stock_id in latest]
        dates = mine + [latest[s][0] for s in spy]
        assert fi.latest_date == max(dates or [d for d, _ in latest.values()])
        for st in fi.stocks:
            s = st.stock_id
            for i, q in enumerate(fi.quarters):
                filed = p.filed[s].get(q)
                assert st.shares_filed[i] == (filed[0] if filed else None)
                assert st.value_filed[i] == (filed[1] if filed else None)
                assert st.split_factor[i] == ctx.share_factors[s].of(q)
                qp = p.px[s].get(q)
                assert st.close[i] == (qp.close if qp else None)
                assert st.vwap[i] == (qp.vwap if qp else None)
                assert st.div_ps[i] == (qp.div_ps if qp else 0.0)
            assert st.close_before == last_close_before(p.px[s], p.start)
            assert st.close_latest == (latest[s][1] if s in latest else None)


def test_carried_and_total_reported(built):
    _, batch, _, inputs = built
    by_cik = {p.cik: (p, fi) for (p, _), fi in zip(batch, inputs, strict=True)}
    p, fi = by_cik[9100004]
    assert any(fi.carried)
    for p, fi in by_cik.values():
        for i, q in enumerate(fi.quarters):
            rows = p.rows.filter(p.rows["q"] == q)
            assert fi.carried[i] == int(rows["carried"].any())
            assert fi.total_reported[i] == rows["value_usd"].sum()


def test_tbill_and_spy(built):
    ctx, batch, _, inputs = built
    for (p, _), fi in zip(batch, inputs, strict=True):
        for i, q in enumerate(fi.quarters):
            assert fi.tbill[i] == ctx.rf.get(2013 + q // 4)
            qp = p.spy_px.get(q)
            assert fi.spy_close[i] == (qp.close if qp else None)
            assert fi.spy_vwap[i] == (qp.vwap if qp else None)


def test_orca_figures_are_the_engines(built):
    _, batch, _, inputs = built
    for (p, r), fi in zip(batch, inputs, strict=True):
        fq = {q.q: q for q in r.output.quarters}
        want = [fq[q].ret if q in fq else None for q in fi.quarters]
        assert fi.orca.quarters["ret"] == want
        assert fi.orca.quarters["end"][len(fq) - 1] == r.output.quarters[-1].end
        assert all(v is None for v in fi.orca.quarters["end"][len(fq) :])
        assert len(fi.years) == len(r.output.years)
        assert fi.orca.years["ret"] == [y.ret for y in r.output.years]
        assert fi.years == [2013 + y.qs[0] // 4 for y in r.output.years]
        by_stock = {pos.stock_id: pos for pos in r.output.positions}
        for st, o in zip(fi.stocks, fi.orca_stocks, strict=True):
            pos = by_stock.get(st.stock_id)
            assert o.avg_cost == (pos.avg_cost if pos else None)
            assert o.shares_now == (pos.shares_now if pos else None)
        assert fi.orca.book == r.output.meta.book
        assert fi.orca.n_holdings == r.output.meta.n_holdings
    assert any(
        o.avg_cost is not None and o.avg_cost != round(o.avg_cost, 4)
        for fi in inputs
        for o in fi.orca_stocks
    )


def test_round_trip(built):
    *_, inputs = built
    for fi in inputs:
        validate(fi)
        assert from_json(to_json(fi)) == fi


def test_validate_rejects_non_finite_and_cusip(built):
    *_, inputs = built
    fi = inputs[0]
    st = fi.stocks[0]
    bad_close = list(st.close)
    bad_close[0] = math.nan
    bad = dataclasses.replace(fi, stocks=[dataclasses.replace(st, close=bad_close)] + fi.stocks[1:])
    with pytest.raises(ValueError, match=rf"{fi.fund_id}.*close"):
        validate(bad)
    short = dataclasses.replace(fi, tbill=fi.tbill[:-1])
    with pytest.raises(ValueError, match=rf"{fi.fund_id}.*tbill"):
        validate(short)
    orca = dataclasses.replace(fi.orca, metrics={**fi.orca.metrics, "cusip": "x"})
    with pytest.raises(ValueError, match=rf"{fi.fund_id}.*cusip"):
        validate(dataclasses.replace(fi, orca=orca))
