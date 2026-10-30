from datetime import date

import pytest

from orca.quarters import q_end, q_index, q_label, q_of_date, q_start


def test_quarter_index_and_label():
    assert q_index(2013, 1) == 0
    assert q_index(2026, 2) == 53
    assert q_label(53) == "Q2 2026"
    assert q_of_date(date(2026, 8, 13)) == 54
    assert q_end(53) == date(2026, 6, 30)
    assert q_start(54) == date(2026, 7, 1)


def test_year_boundaries_and_round_trip():
    assert q_label(0) == "Q1 2013"
    assert q_end(3) == date(2013, 12, 31)
    assert q_start(4) == date(2014, 1, 1)
    assert q_of_date(date(2013, 1, 1)) == 0
    assert q_of_date(date(2013, 12, 31)) == 3
    for q in range(0, 60):
        assert q_of_date(q_start(q)) == q
        assert q_of_date(q_end(q)) == q
        assert (q_start(q + 1) - q_end(q)).days == 1


def test_invalid_quarter_rejected():
    for bad in (0, 5):
        with pytest.raises(ValueError):
            q_index(2020, bad)
