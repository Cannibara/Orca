"""The run's time budget: a run stops its long stages cleanly when the budget is spent, so the
workflow always has time left to save the lake, and the next run carries on where it stopped."""

import math
import os
import time
from collections.abc import Callable

BUDGET_ENV = "ORCA_TIME_BUDGET_MIN"
DEFAULT_MINUTES = 270.0  # the workflow gives the pipeline step 300 minutes and the job 330


class Budget:
    """`minutes` of run time from now on `clock` (seconds). `spent()` says whether they are used
    up; a stage that stops early, or never starts, because of it records itself with `cut()`."""

    def __init__(self, minutes: float, clock: Callable[[], float] = time.monotonic):
        self.minutes = minutes
        self._clock = clock
        self._deadline = clock() + minutes * 60
        self.stages: list[str] = []  # the stages cut short or skipped, in run order

    @classmethod
    def from_env(cls) -> "Budget":
        """ORCA_TIME_BUDGET_MIN minutes (a positive number), else 270."""
        raw = os.environ.get(BUDGET_ENV, "").strip()
        if not raw:
            return cls(DEFAULT_MINUTES)
        try:
            minutes = float(raw)
        except ValueError:
            minutes = math.nan
        if not math.isfinite(minutes) or minutes <= 0:
            raise RuntimeError(f"{BUDGET_ENV} must be a positive number of minutes, got {raw!r}")
        return cls(minutes)

    def spent(self) -> bool:
        return self._clock() >= self._deadline

    def cut(self, stage: str) -> None:
        if stage not in self.stages:
            self.stages.append(stage)

    def flag(self) -> dict | None:
        """The health flag saying which stages the budget cut short, or None."""
        if not self.stages:
            return None
        return {"type": "time_budget", "minutes": self.minutes, "stages": list(self.stages)}
