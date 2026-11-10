"""`python -m orca.run workbook`: build the fund workbook of chosen funds from the restored lake.

Reads the filings the way `verify` does (holdings rebuilt from the raw filings), runs the
engine, and writes per fund `inputs/<id>.json` (brotli, the FundInputs) and the `.xlsx`. The
lake is only read. Output lines carry fund ids, sizes and timings, never names or CUSIPs."""

import time
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from orca.holdings import build_holdings, select_reports
from orca.run.compute import Context, prepare_batch
from orca.run.market import latest_closes
from orca.run.state import RAW_SCHEMA, REPORTS_SCHEMA, State, read_table
from orca.sec.live import FILINGS_SCHEMA
from orca.securities import SECURITIES_SCHEMA
from orca.storage import Lake
from orca.workbook.build import BuildInfo, build_workbook, file_name
from orca.workbook.inputs import FundInputs, build_inputs, from_json, to_json, validate


@dataclass(frozen=True)
class WorkbookResult:
    """One requested fund: its files and build info, or why it has none. `skipped` is a normal
    outcome (exit 0); `failed` is an error (exit 1)."""

    fund_id: int
    path: Path | None = None
    inputs: Path | None = None
    info: BuildInfo | None = None
    skipped: str | None = None
    failed: str | None = None


def build_workbooks(
    lake: Lake, fund_ids: list[int], out: Path, max_positions: int = 500
) -> list[WorkbookResult]:
    """Build the workbook of each fund of `fund_ids` (CIKs) into `out`, one line printed per
    fund. A fund unknown to the lake, or whose inputs fail validation, is a `failed` result and
    writes no file; the others are still built."""
    ids = sorted(set(fund_ids))
    state = State.load(lake)
    if state.last_q is None:
        return [_fail(i, "not found") for i in ids]
    holdings, reports = [], []
    for part in lake.parts("filings"):
        filings = lake.read("filings", part=part).cast(FILINGS_SCHEMA)
        raw = lake.read("raw_holdings", part=part)
        if raw.is_empty():
            raw = pl.DataFrame(schema=RAW_SCHEMA)
        holdings.append(
            build_holdings(filings, raw.cast(RAW_SCHEMA)).filter(pl.col("cik").is_in(ids))
        )
        reports.append(
            select_reports(filings).cast(REPORTS_SCHEMA).filter(pl.col("cik").is_in(ids))
        )
    results: dict[int, WorkbookResult] = {}
    reports_all = pl.concat(reports) if reports else pl.DataFrame(schema=REPORTS_SCHEMA)
    if reports_all.height:
        ctx = Context.build(lake, state.last_q)
        latest = latest_closes(lake)
        securities = read_table(lake, "securities", SECURITIES_SCHEMA)
        out.mkdir(parents=True, exist_ok=True)
        for p, r in prepare_batch(ctx, pl.concat(holdings), reports_all):
            fund_id = int(p.cik)
            began = time.perf_counter()
            if not r.output.positions:
                results[fund_id] = _skip(fund_id, "no priced positions")
                continue
            try:
                fi = build_inputs(ctx, p, r, latest, securities, max_positions)
                results[fund_id] = _write(fi, out, began)
            except ValueError as err:
                results[fund_id] = _fail(fund_id, str(err))
    return [results.get(i) or _fail(i, "not found") for i in ids]


def _write(fi: FundInputs, out: Path, began: float) -> WorkbookResult:
    """Validate and round-trip `fi` before anything is written, then write its inputs file and
    workbook. `to_json` does not validate, and demo data cannot prove that every value of
    real funds serialises, so the file is read back and compared first."""
    validate(fi)
    data = to_json(fi)
    if from_json(data) != fi:
        return _fail(fi.fund_id, "its inputs file does not read back equal; nothing written")
    (out / "inputs").mkdir(exist_ok=True)
    inputs_path = out / "inputs" / f"{fi.fund_id}.json"
    inputs_path.write_bytes(data)
    path = out / file_name(fi)
    info = build_workbook(fi, path)
    seconds = time.perf_counter() - began
    print(f"fund {fi.fund_id}: {info.rows} rows, {info.bytes / 1e6:.1f} MB, {seconds:.1f} s")
    return WorkbookResult(fi.fund_id, path, inputs_path, info)


def _skip(fund_id: int, why: str) -> WorkbookResult:
    print(f"fund {fund_id}: skipped: {why}")
    return WorkbookResult(fund_id, skipped=why)


def _fail(fund_id: int, why: str) -> WorkbookResult:
    # validate() messages already start "fund N: "; keep one prefix
    prefix = f"fund {fund_id}: "
    print(why if why.startswith(prefix) else prefix + why)
    return WorkbookResult(fund_id, failed=why)
