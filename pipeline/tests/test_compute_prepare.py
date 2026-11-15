import tempfile
from pathlib import Path

from conftest import demo_batch

from orca import demo
from orca.publish import publish_fund, read_manifest
from orca.quarters import q_index

CIKS = list(range(demo.FUND_CIK0, demo.FUND_CIK0 + 12))


def test_prepare_batch_reproduces_published_files(demo_run):
    _, batch = demo_batch(demo_run, CIKS)
    assert [p.cik for p, _ in batch] == CIKS
    published = read_manifest(demo_run.root / "out")
    rebuilt: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for _, result in batch:
            rebuilt.update(publish_fund(Path(tmp), result.output))
    assert len(rebuilt) == 4 * 12
    assert rebuilt == {path: published[path] for path in rebuilt}


def test_prepared_filed_times_factor_is_adjusted(demo_run):
    ctx, batch = demo_batch(demo_run, CIKS)
    checked = 0
    for p, _ in batch:
        assert p.filed.keys() == p.adjusted.keys() == p.px.keys()
        for stock_id, series in p.filed.items():
            for q, (shares, value) in series.items():
                a_shares, a_value = p.adjusted[stock_id][q]
                assert shares * ctx.share_factors[stock_id].of(q) == a_shares
                assert value == a_value
                checked += 1
    assert checked > 0


def test_prepared_bound_for_inactive_fund(demo_run):
    _, batch = demo_batch(demo_run, [9100010])
    prepared = batch[0][0]
    assert prepared.end_q == q_index(2023, 4)
    assert prepared.bound == demo.LAST_Q


def test_inactive_fund_perf_runs_to_its_last_quarter(demo_run):
    # Cobblereef stopped after Q4 2023: its periods end there (the Famous funds lists show it).
    _, batch = demo_batch(demo_run, [9100010, demo.FUND_CIK0])
    (_, active), (_, stopped) = batch  # in fund id order
    assert stopped.snapshot.excluded and stopped.snapshot.period_q == q_index(2023, 4)
    assert stopped.snapshot.perf["1y"] is not None
    assert stopped.snapshot.perf["3y"] is not None
    assert stopped.snapshot.perf["10y"] is None  # tracked from 2014: not 10 years by 2023
    assert not active.snapshot.excluded and active.snapshot.perf["1y"] is not None
