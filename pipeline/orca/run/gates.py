"""Health gates: a run whose numbers look broken must not publish. `check_health` raises before
the manifest is written, so the site stays on the last good version and the state keeps what is
owed (like InvariantError and CusipLeakError)."""

from orca.config import COVERAGE_MIN


class HealthGateError(RuntimeError):
    """A run's health figures say its data is bad; nothing was published."""


def check_health(
    *,
    cusips: int,
    mapped: int,
    coverage_median: float | None,
    funds_recomputed: int,
    funds_owed: int,
    budget_cut: bool = False,
) -> None:
    """Raise HealthGateError when
    - the lake has CUSIPs but none maps to a stock (run 5 of the first go-live published no
      tickers and said nothing),
    - the median fund prices less than COVERAGE_MIN of its book (None, no funds, passes), or
    - funds were owed a recompute and none was computed. A run cut short by its time budget may
      legitimately get through none, so `budget_cut` skips this one."""
    problems = []
    if cusips > 0 and mapped == 0:
        problems.append(f"none of {cusips} CUSIPs is mapped to a stock")
    if coverage_median is not None and coverage_median < COVERAGE_MIN:
        problems.append(
            f"median fund prices {coverage_median:.1%} of its book (minimum {COVERAGE_MIN:.0%})"
        )
    if funds_owed > 0 and funds_recomputed == 0 and not budget_cut:
        problems.append(f"{funds_owed} funds were owed a recompute and none was computed")
    if problems:
        raise HealthGateError("health gate: " + "; ".join(problems))
