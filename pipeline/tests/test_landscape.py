from orca.config import PERIODS
from orca.investors import Classifier
from orca.landscape import LANDSCAPE_PER_TYPE, landscape
from tests.test_home import LATEST_Q, perf, snap


def classifier(hand: dict[int, str]) -> Classifier:
    return Classifier(hand=hand, famous={}, adv={})


def test_current_filers_by_type_with_their_returns():
    snaps = [
        snap(1, "ALPHA", book=5e9),
        snap(2, "BETA", book=2e9, perf={"1y": perf(0.25)}),
        snap(3, "GONE", excluded=True),  # stopped filing
        snap(4, "STALE", period_q=LATEST_Q - 2),  # nothing for two quarters
        snap(5, "LATE", book=1e9, period_q=LATEST_Q - 1),  # a late filer keeps its last book
        snap(6, "EMPTY", book=0.0),
        snap(7, "THIN", book=3e9, priced_pct=0.5),  # too little priced for a return
    ]
    out = landscape(snaps, classifier({1: "bank", 2: "hedge.macro", 5: "bank", 7: "pension"}), LATEST_Q)
    f = out["funds"]
    # by type in TYPES order (hedge before bank before pension), then by book
    assert f["fund_id"] == [2, 1, 5, 7]
    assert f["type"] == ["hedge.macro", "bank", "bank", "pension"]
    assert f["book"] == [2_000_000_000, 5_000_000_000, 1_000_000_000, 3_000_000_000]
    assert set(f["ret"]) == set(PERIODS)
    assert f["ret"]["1y"] == [0.25, 0.1, 0.1, None]
    assert f["ret"]["10y"] == [None, None, None, None]  # no record that long
    assert out["n_filers"] == 4 and out["total"] == 11_000_000_000
    assert out["rest"]["type"] == []
    assert out["types"]["key"][0] == "hedge" and out["types"]["parent"][0] is None
    assert out["latest_q"] == LATEST_Q


def test_beyond_the_largest_of_a_type_the_rest_is_one_row():
    n = LANDSCAPE_PER_TYPE + 3
    snaps = [snap(i, f"F{i}", book=1e9 + i) for i in range(1, n + 1)]
    # the smallest three: one with a 1y return of 40%, one without a 1y record, one at 10%
    snaps[0] = snap(1, "F1", book=1e9, perf={"1y": perf(0.40)})
    snaps[1] = snap(2, "F2", book=3e9 / 3, perf={})
    out = landscape(snaps, classifier({}), LATEST_Q)  # all unclassified
    assert len(out["funds"]["fund_id"]) == LANDSCAPE_PER_TYPE
    assert 1 not in out["funds"]["fund_id"] and 2 not in out["funds"]["fund_id"]
    rest = out["rest"]
    assert rest["type"] == ["other"] and rest["n"] == [3]
    b1, b2, b3 = 1e9, 1e9, 1e9 + 3
    assert rest["book"] == [round(b1 + b2 + b3)]
    assert rest["ret"]["1y"] == [round((b1 * 0.40 + b3 * 0.10) / (b1 + b3), 4)]
    assert rest["covered"]["1y"] == [round((b1 + b3) / (b1 + b2 + b3), 3)]
    assert rest["ret"]["15y"] == [None] and rest["covered"]["15y"] == [0.0]
    assert out["n_filers"] == n
