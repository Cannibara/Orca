"""LibreOffice for the workbook tests: recalculate a built .xlsx headless (the file stores no
values, so every number read back was computed by LibreOffice), read the values, and compare
them with the engine's within the stated tolerances (ruling R15).

Tolerances: dollars and shares within 1e-9 x MAX(1, |engine|, scale), where scale is the size
of the amounts the figure was summed from (LibreOffice's SUM is compensated, the engine's plain
+=, so a near-zero sum of large terms differs by more than 1e-9 of itself); returns, ratios,
prices and points within 1e-9 x MAX(1, |engine|); counts and quarters exactly. A blank cell
(None) stands for the engine's None."""

import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterable
from pathlib import Path

import openpyxl
import pytest

from orca.engine.fund import FundQuarter
from orca.engine.position import PositionResult

TOL = 1e-9
TIMEOUT = 120  # seconds per soffice run


def require_libreoffice() -> None:
    """Skip the calling test without `soffice`, or fail it when ORCA_REQUIRE_LIBREOFFICE=1
    (CI installs LibreOffice and must not skip silently)."""
    if shutil.which("soffice"):
        return
    if os.environ.get("ORCA_REQUIRE_LIBREOFFICE") == "1":
        pytest.fail("soffice not found, and ORCA_REQUIRE_LIBREOFFICE=1")
    pytest.skip("soffice (LibreOffice) not installed")


def recalc(path: Path, out_dir: Path) -> Path:
    """`path` opened, computed and saved by LibreOffice as out_dir/<same name>."""
    return recalc_all([path], out_dir)[0]


def recalc_all(paths: Iterable[Path], out_dir: Path) -> list[Path]:
    """`recalc` for several files in one soffice run (its start-up costs seconds). Each run has
    a fresh profile, so no user setting or a running LibreOffice interferes."""
    paths = [Path(p) for p in paths]
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="orca-lo-") as profile:
        subprocess.run(
            [
                "soffice",
                f"-env:UserInstallation=file://{profile}",
                "--headless",
                "--calc",
                "--convert-to",
                "xlsx",
                "--outdir",
                str(out_dir),
                *map(str, paths),
            ],
            check=True,
            capture_output=True,
            timeout=TIMEOUT,
        )
    out = [out_dir / p.name for p in paths]
    missing = [str(p) for p in out if not p.exists()]
    if missing:
        raise RuntimeError(f"LibreOffice wrote no {missing}")
    return out


def values(path: Path) -> dict[tuple[str, str], object]:
    """Every non-empty cell of a recalculated file: (tab, "A1") -> value. A formula's "" reads
    back as no value, so a missing key is a blank cell."""
    book = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        out = {}
        for ws in book.worksheets:
            for row in ws.iter_rows():
                for cell in row:
                    if cell.value is not None and cell.value != "":
                        out[(ws.title, cell.coordinate)] = cell.value
        return out
    finally:
        book.close()


# --- tolerances (ruling R15) -------------------------------------------------------------------


def money_tol(engine: float, scale: float = 0.0) -> float:
    """Dollars and shares: 1e-9 x MAX(1, |engine|, scale)."""
    return TOL * max(1.0, abs(engine), scale)


def ratio_tol(engine: float) -> float:
    """Returns, ratios, prices and points: 1e-9 x MAX(1, |engine|)."""
    return TOL * max(1.0, abs(engine))


def quarter_scale(fq: FundQuarter) -> float:
    """A fund quarter's scale: MAX(|Start|, |End|, Buys + Sells), the bridge check's own."""
    return max(abs(fq.start), abs(fq.end), fq.buys + fq.sells)


def year_scale(quarters: Iterable[FundQuarter]) -> float:
    """A fund year's scale: the largest of its quarters' scales."""
    return max((quarter_scale(fq) for fq in quarters), default=0.0)


def stock_scale(pos: PositionResult | None) -> float:
    """A stock's scale: MAX(|value|, |cost|, invested) over the segment (0 without a position)."""
    if pos is None:
        return 0.0
    return max([pos.invested, *(max(abs(pq.value), abs(pq.cost)) for pq in pos.quarters)])


def blank(got: object) -> bool:
    return got is None or got == ""


def _numeric(got: object, where: str) -> float:
    assert isinstance(got, (int, float)) and not isinstance(got, bool), (where, got)
    return float(got)


def assert_money(got: object, engine: float | None, scale: float, where: str) -> None:
    """A dollar or share cell: blank exactly when the engine has None."""
    if engine is None:
        assert blank(got), (where, got)
        return
    value = _numeric(got, where)
    assert abs(value - engine) <= money_tol(engine, scale), (where, value, engine)


def assert_ratio(got: object, engine: float | None, where: str) -> None:
    """A return, ratio, price or points cell: blank exactly when the engine has None."""
    if engine is None:
        assert blank(got), (where, got)
        return
    value = _numeric(got, where)
    assert abs(value - engine) <= ratio_tol(engine), (where, value, engine)


def assert_exact(got: object, engine: object, where: str) -> None:
    """A count, flag, quarter or text cell: equal (blank exactly when the engine has None)."""
    if engine is None:
        assert blank(got), (where, got)
    else:
        assert got == engine, (where, got, engine)
