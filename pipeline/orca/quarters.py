"""Quarter index helpers.

A quarter is an integer index: q = (year - 2013) * 4 + (quarter - 1), so
Q1 2013 is 0 and Q2 2026 is 53. Labels look like "Q2 2026".
"""

from datetime import date, timedelta

BASE_YEAR = 2013


def q_index(year: int, quarter: int) -> int:
    if not 1 <= quarter <= 4:
        raise ValueError(f"quarter must be 1-4, got {quarter}")
    return (year - BASE_YEAR) * 4 + (quarter - 1)


def _year_quarter(q: int) -> tuple[int, int]:
    year, quarter0 = divmod(q, 4)
    return BASE_YEAR + year, quarter0 + 1


def q_label(q: int) -> str:
    year, quarter = _year_quarter(q)
    return f"Q{quarter} {year}"


def q_of_date(d: date) -> int:
    return q_index(d.year, (d.month - 1) // 3 + 1)


def q_start(q: int) -> date:
    year, quarter = _year_quarter(q)
    return date(year, 3 * (quarter - 1) + 1, 1)


def q_end(q: int) -> date:
    return q_start(q + 1) - timedelta(days=1)
