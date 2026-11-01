"""Command line: `python -m orca.run weekly | rebuild | verify | demo`."""

import argparse
import json
import logging
from datetime import date
from pathlib import Path

from orca import config
from orca.run.sources import production_sources
from orca.run.weekly import run_weekly, verify
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
        "check-keys", help="one test request to OpenFIGI, Tiingo and FRED with the keys set"
    )
    check = commands.add_parser(
        "verify", help="rebuild a sample of funds and compare with the published files"
    )
    check.add_argument("--sample", type=int, default=50)
    check.add_argument("--seed", type=int, default=None)
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
    if args.command in ("weekly", "rebuild"):
        stats = run_weekly(
            Lake(config.LAKE_DIR),
            config.OUT_DIR,
            production_sources(),
            date.today(),
            full=args.command == "rebuild",
        )
        for flag in stats.flags:  # health.json's flags, so the run log says what went wrong
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
    from orca import demo

    files = demo.write_demo(args.out, seed=args.seed, compress=not args.plain)
    print(f"demo: {files} files written to {args.out}")
    return 0
