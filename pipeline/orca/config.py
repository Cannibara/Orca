"""Pipeline thresholds and paths. Values are fixed by the spec; do not tune ad hoc."""

import os
from datetime import date
from pathlib import Path

# Top funds
TOP_MIN_BOOK = 1e9  # dollars
TOP_MIN_QUARTERS = 12  # quarters filed
TOP_MIN_POSITIONS = 4
TOP_MIN_PRICED = 0.80  # share of book that must be priced
GIANT_MIN_POSITIONS = 1000  # index giants are listed separately
PERIODS = {"1y": 4, "3y": 12, "5y": 20, "max": None}  # quarters per period

# Funds excluded by name: banks, insurers, pensions, brokers
EXCLUDE_NAME_WORDS = (
    "BANK",
    "BANCORP",
    "TRUST CO",
    "INSURANCE",
    "ASSURANCE",
    "PENSION",
    "RETIREMENT SYSTEM",
    "SECURITIES LLC",
    "BROKERAGE",
)

# Concentrated active funds
CONC_MIN_POS = 4
CONC_MAX_POS = 60
CONC_MIN_TOP10 = 0.50  # top-10 weight
CONC_MIN_BOOK = 5e8  # dollars

# Conviction moves
CONVICTION_WEIGHT = 0.05  # new/add reaching this weight, or exit of a position that was this big
CONVICTION_JUMP = 0.03  # weight increase (3 points)

# Crowded buys
CROWDED_MIN_FUNDS = 3

# Calls
CALLS_MIN_WEIGHT = 0.01  # new/add of at least 1% of book
CALLS_MIN_MCAP = 3e8  # dollars
CALLS_MIN_PRICE = 1.0  # dollars

# Data quality
PRICE_MISMATCH = 10.0  # reported value / shares more than this far from our price -> flag
COVERAGE_WARN = 0.80  # warn below this share of book priced

# 13F VALUE is in thousands before this filing date, dollars from it
VALUE_DOLLARS_FROM = date(2023, 1, 3)

# Storage
LAKE_DIR = Path(os.environ.get("ORCA_LAKE_DIR", "data/lake"))
OUT_DIR = Path(os.environ.get("ORCA_OUT_DIR", "data/out"))
