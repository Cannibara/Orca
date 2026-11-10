import pytest

from orca.run import HealthGateError, check_health

HEALTHY = dict(cusips=500, mapped=480, coverage_median=0.988, funds_recomputed=12, funds_owed=12)


def test_a_healthy_run_passes():
    check_health(**HEALTHY)


def test_nothing_mapped_fires():
    with pytest.raises(HealthGateError, match="none of 500 CUSIPs"):
        check_health(**{**HEALTHY, "mapped": 0})


def test_an_empty_lake_is_not_an_unmapped_one():
    check_health(**{**HEALTHY, "cusips": 0, "mapped": 0})


def test_low_coverage_fires_and_the_threshold_is_inclusive():
    with pytest.raises(HealthGateError, match="89.9%"):
        check_health(**{**HEALTHY, "coverage_median": 0.899})
    check_health(**{**HEALTHY, "coverage_median": 0.90})
    check_health(**{**HEALTHY, "coverage_median": None})


def test_work_owed_but_none_done_fires_unless_the_budget_cut_the_run():
    with pytest.raises(HealthGateError, match="3 funds were owed"):
        check_health(**{**HEALTHY, "funds_recomputed": 0, "funds_owed": 3})
    check_health(**{**HEALTHY, "funds_recomputed": 0, "funds_owed": 3, "budget_cut": True})
    check_health(**{**HEALTHY, "funds_recomputed": 0, "funds_owed": 0})


def test_every_problem_is_named():
    with pytest.raises(HealthGateError) as err:
        check_health(cusips=5, mapped=0, coverage_median=0.1, funds_recomputed=0, funds_owed=1)
    assert str(err.value).count(";") == 2
