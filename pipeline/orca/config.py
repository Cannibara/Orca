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
# Quarters per period. The SEC's 13F data starts in 2013: no fund has 15 years until 2028.
PERIODS = {"1y": 4, "3y": 12, "5y": 20, "10y": 40, "15y": 60, "max": None}

# Funds excluded by name: banks, insurers, brokers (pensions and endowments are managed: they count)
EXCLUDE_NAME_WORDS = (
    "BANK",
    "BANCORP",
    "TRUST CO",
    "INSURANCE",
    "ASSURANCE",
    "SECURITIES LLC",
    "BROKERAGE",
)

# Concentrated active funds
CONC_MIN_POS = 4
CONC_MAX_POS = 60
CONC_MIN_TOP10 = 0.50  # top-10 weight
CONC_MIN_BOOK = 5e8  # dollars

# Conviction moves: a move (dollars traded in one stock over the fund's AUM at the end of that
# quarter) large for the fund that made it
CONVICTION_MIN_MOVE = 0.03  # at least this share of the AUM
CONVICTION_USUAL_X = 2.0  # at least this many times the fund's usual move
CONVICTION_LOOKBACK = 4  # the usual move: the biggest single move of this many quarters before
CONVICTION_QUIET = 0.01  # a usual move under this counts as this: the fund was quiet
CONVICTION_VS_TOP = 0.50  # at least this share of the fund's largest holding at the quarter's start
CONVICTION_MAX_TOP = 0.33  # a quarter whose largest holding at the start was more is left out
CONVICTION_MAX_BOOK_CHANGE = 2.0  # ... and so is one whose AUM grew or shrank more than this many times
CONVICTION_WINDOW = 4  # quarters of the "last 4 quarters" list
CONVICTION_MAX_ROWS = 200  # rows of each conviction list
# Moves a fund's snapshot keeps, as a share of the quarter's AUM. Smaller ones can never be
# listed or set a usual move above the quiet floor, so the lists come out the same without them.
CONVICTION_KEEP = 0.01

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

# Storage (read from the environment at import time; tests monkeypatch the module attribute)
LAKE_DIR = Path(os.environ.get("ORCA_LAKE_DIR", "data/lake"))
OUT_DIR = Path(os.environ.get("ORCA_OUT_DIR", "data/out"))
