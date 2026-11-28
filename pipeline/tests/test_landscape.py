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


def test_a_firm_filing_under_several_names_is_one_row_per_type():
    snaps = [
        snap(1, "VANGUARD CAPITAL MANAGEMENT LLC", book=3e9, perf={"1y": perf(0.10)}),
        snap(2, "VANGUARD PORTFOLIO MANAGEMENT LLC", book=1e9, perf={"1y": perf(0.30)}),
        snap(3, "VANGUARD FIDUCIARY TRUST CO", book=5e8, perf={}),  # no return: left out of the mean
        snap(4, "VANGUARD NATIONAL BANK", book=2e8),  # the same firm, another type: its own row
        snap(5, "SOLO LLC", book=6e9),
    ]
    out = landscape(
        snaps,
        classifier({1: "am.etf", 2: "am.etf", 3: "am.etf", 4: "bank", 5: "am.etf"}),
        LATEST_Q,
        parents={1: "Vanguard", 2: "Vanguard", 3: "Vanguard", 4: "Vanguard"},
    )
    f = out["funds"]
    assert f["fund_id"] == [5, 1, 4]  # the firm's row links to its largest filer
    assert f["name"] == ["SOLO LLC", "Vanguard", "VANGUARD NATIONAL BANK"]
    assert f["book"] == [6_000_000_000, 4_500_000_000, 200_000_000]
    assert f["n"] == [1, 3, 1]
    assert f["members"] == [None, ["VANGUARD CAPITAL MANAGEMENT LLC", "VANGUARD PORTFOLIO MANAGEMENT LLC", "VANGUARD FIDUCIARY TRUST CO"], None]
    assert f["ret"]["1y"][1] == round((3e9 * 0.10 + 1e9 * 0.30) / 4e9, 4)
    assert out["n_filers"] == 5


def test_an_other_hedge_fund_gets_a_style_from_what_it_holds():
    health = {1000: 0.7, 1001: 0.3}
    tech = {1002: 0.4, 1003: 0.25, 1000: 0.35}
    sector = {1000: "Health care", 1001: "Industrials", 1002: "Tech", 1003: "Communication"}
    snaps = [
        snap(1, "BIO LP", weights_now=health),
        snap(2, "CHIPS LP", weights_now=tech),
        snap(3, "PODS LP", weights_now={1001: 1.0}, n_priced=900),
        snap(4, "PICKER LP", weights_now={1001: 1.0}),
        snap(5, "BANK", weights_now=health),  # only hedge funds get a style
    ]
    hand = {i: "hedge.other" for i in range(1, 5)} | {5: "bank"}
    out = landscape(snaps, classifier(hand), LATEST_Q, sector=sector)
    kinds = dict(zip(out["funds"]["fund_id"], out["funds"]["type"]))
    assert kinds == {1: "hedge.health", 2: "hedge.tech", 3: "hedge.quant", 4: "hedge.other", 5: "bank"}
