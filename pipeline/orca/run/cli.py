"""Command line: `python -m orca.run weekly | rebuild | verify | workbook | demo`."""

import argparse
import json
import logging
from datetime import date
from pathlib import Path

from orca import config
from orca.run.sources import production_sources
from orca.run.weekly import run_home, run_weekly, verify
from orca.storage import Lake

DESCRIPTION = (
    "Weekly orchestrator: ingest new filings and prices, recompute the funds they touch, publish."
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m orca.run", description=DESCRIPTION)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("weekly", help="ingest new data, recompute affected funds, publish changes")
    commands.add_parser("rebuild", help="recompute and republish every fund")
    commands.add_parser(
        "home", help="republish the home lists from the stored fund state (no fetch, no recompute)"
    )
    commands.add_parser(
        "check-keys", help="one test request to OpenFIGI, Tiingo and FRED with the keys set"
    )
    check = commands.add_parser(
        "verify", help="rebuild a sample of funds and compare with the published files"
    )
    check.add_argument("--sample", type=int, default=50)
    check.add_argument("--seed", type=int, default=None)
    book = commands.add_parser(
        "workbook", help="build the Excel workbook of chosen funds from the lake (private output)"
    )
    book.add_argument("--fund", type=int, action="append", required=True, metavar="ID")
    book.add_argument("--out", type=Path, default=Path("data/workbooks"))
    book.add_argument("--max-positions", type=int, default=500)
    demo_cmd = commands.add_parser("demo", help="build the synthetic demo dataset (no network)")
    demo_cmd.add_argument("--out", type=Path, default=Path("data/demo"))
    demo_cmd.add_argument(
        "--plain", action="store_true", help="uncompressed JSON (for the Vite dev server)"
    )
    demo_cmd.add_argument("--seed", type=int, default=7)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO lines print the FRED key

    if args.command == "check-keys":
        from orca.run.preflight import check_keys, production_probes

        problems = check_keys(production_probes())
        for problem in problems:
            print(f"::error::{problem}")
        print(f"check-keys: {len(problems)} problem(s)")
        return 1 if problems else 0
    if args.command == "home":
        stats = run_home(Lake(config.LAKE_DIR), config.OUT_DIR, date.today())
        print(f"staging: {stats.staging}")
        print(f"changed: {len(stats.changed)} files, funds recomputed: 0")
        return 0
    if args.command in ("weekly", "rebuild"):
        stats = run_weekly(
            Lake(config.LAKE_DIR),
            config.OUT_DIR,
            production_sources(),
            date.today(),
            full=args.command == "rebuild",
        )
        from orca.run.publish_step import capped

        for flag in capped(stats.flags):  # health.json's flags, as many of each kind as it keeps
            print(f"flag: {json.dumps(flag, sort_keys=True)}")
        if stats.staging is None:
            print("published nothing: the time budget ran out before any fund was computed")
            return 0
        print(f"staging: {stats.staging}")
        print(f"changed: {len(stats.changed)} files, funds recomputed: {stats.funds_recomputed}")
        return 0
    if args.command == "verify":
        diffs = verify(Lake(config.LAKE_DIR), config.OUT_DIR, args.sample, args.seed)
        for path in diffs:
            print(f"differs: {path}")
        print(f"verify: {len(diffs)} file(s) differ")
        return 1 if diffs else 0
    if args.command == "workbook":
        from orca.run.workbook import build_workbooks

        results = build_workbooks(
            Lake(config.LAKE_DIR), args.fund, args.out, args.max_positions
        )
        return 1 if any(r.failed for r in results) else 0
    from orca import demo

    files = demo.write_demo(args.out, seed=args.seed, compress=not args.plain)
    print(f"demo: {files} files written to {args.out}")
    return 0
