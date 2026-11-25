"""The run step that builds the sector indices from the lake (`orca/run/sectors_step.build_sector_returns`)."""

from datetime import date

import polars as pl

from orca.hierarchy import parse
from orca.hierarchy.assign import SicTable, StockLabel
from orca.prices import PRICES_SCHEMA
from orca.run.sectors_step import build_sector_returns, reported_prices
from orca.run.state import CUSIP_MAP_SCHEMA, SECURITIES_TABLE_SCHEMA
from orca.shares_hist import SCHEMA as SHARES_SCHEMA
from orca.storage import Lake

H = parse("## Tech > Chips\nMemory: MU\nLogic: INTC\n@default Semis => Tech > Chips > Logic\n")
MEMORY, LOGIC = H.nodes


def test_the_step_writes_one_series_per_label_from_stocks_only(tmp_path):
    lake = Lake(tmp_path / "lake")
    sec = {"stock_id": [1, 2, 3, 4], "ticker": ["MU", "INTC", "SOXX", "MU 1 01-01-30"], "cik": [10, 20, None, 10],
           "sic": [3674, 3674, None, None], "sector": ["Tech", "Tech", "ETF/Fund", "Tech"], "shares_out": [100.0, 100.0, None, None]}  # fmt: skip
    lake.write("securities", pl.DataFrame(sec).cast({k: v for k, v in SECURITIES_TABLE_SCHEMA.items() if k in sec}), part=None)
    days = [date(2015, 9, 30), date(2015, 12, 31)]
    bars = [(sid, d, close) for sid, c0, c1 in ((1, 10.0, 11.0), (2, 10.0, 10.0), (3, 10.0, 20.0), (4, 10.0, 20.0)) for d, close in zip(days, (c0, c1))]
    prices = pl.DataFrame({"stock_id": [b[0] for b in bars], "date": [b[1] for b in bars], "open": [b[2] for b in bars], "high": [b[2] for b in bars],
                           "low": [b[2] for b in bars], "close": [b[2] for b in bars], "volume": [1.0] * len(bars),
                           "split_factor": [1.0] * len(bars), "dividend": [0.0] * len(bars)}, schema=PRICES_SCHEMA)  # fmt: skip
    lake.write("prices_daily", prices, part="000")
    lake.write("shares_hist", pl.DataFrame(schema=SHARES_SCHEMA))
    labels = {1: StockLabel("MU", "stock", MEMORY, "placed")}  # INTC is labelled by its SIC code
    flags: list = []
    stats = build_sector_returns(lake, last_q=11, flags=flags, labels=labels, sic=SicTable({"3674": LOGIC}), adr={})
    out = lake.read("sector_returns")
    ret = {(r["label"], r["q"]): r["ret"] for r in out.iter_rows(named=True)}
    assert abs(ret[(MEMORY.path, 11)] - 0.1) < 1e-12 and ret[(LOGIC.path, 11)] == 0.0
    assert abs(ret[("Market", 11)] - 0.05) < 1e-12  # the ETF and the bond doubled and are left out
    assert stats["stocks"] == 2 and stats["by_how"] == {"placed": 1, "sic": 1} and stats["fallback_caps"] == 2


def test_funds_are_scored_in_chunks_of_about_the_same_number_of_trades():
    from orca.run.sectors_step import trade_chunks

    counts = {1: 5, 2: 5, 3: 12, 4: 3, 5: 3, 6: 3}
    assert trade_chunks(counts, max_trades=10) == [[1, 2], [3], [4, 5, 6]]  # a fund bigger than a chunk gets its own


def test_a_close_the_13f_holders_disagree_with_sits_out(tmp_path):
    # Mechanics Bancorp in run 45: the vendor's history under its ticker was another bank's, at ~1,000x the price
    lake = Lake(tmp_path / "lake")
    sec = {"stock_id": [1, 2], "ticker": ["MU", "INTC"], "cik": [10, 20], "sic": [3674, 3674], "sector": ["Tech", "Tech"],
           "shares_out": [100.0, 100.0]}  # fmt: skip
    lake.write("securities", pl.DataFrame(sec).cast({k: v for k, v in SECURITIES_TABLE_SCHEMA.items() if k in sec}), part=None)
    days = [date(2015, 9, 30), date(2015, 12, 31)]
    bars = [(sid, d, close) for sid, c0, c1 in ((1, 10.0, 11.0), (2, 10.0, 30.0)) for d, close in zip(days, (c0, c1))]
    prices = pl.DataFrame({"stock_id": [b[0] for b in bars], "date": [b[1] for b in bars], "open": [b[2] for b in bars], "high": [b[2] for b in bars],
                           "low": [b[2] for b in bars], "close": [b[2] for b in bars], "volume": [1.0] * len(bars),
                           "split_factor": [1.0] * len(bars), "dividend": [0.0] * len(bars)}, schema=PRICES_SCHEMA)  # fmt: skip
    lake.write("prices_daily", prices, part="000")
    lake.write("shares_hist", pl.DataFrame(schema=SHARES_SCHEMA))
    lake.write("cusip_map", pl.DataFrame({"cusip": ["MU0000000", "IN0000000"], "stock_id": [1, 2], "method": ["openfigi"] * 2, "tried": [None, None]},
                                         schema=CUSIP_MAP_SCHEMA))  # fmt: skip
    # three funds value INTC at $1,000 a share in q10 (ours: $10), holding 90 of its 100 shares; only two say so of
    # MU: too few to overrule ours
    rows = [(c, "IN0000000", 30.0, 30000.0) for c in (1, 2, 3)] + [(c, "MU0000000", 30.0, 30000.0) for c in (1, 2)]
    lake.write("holdings", pl.DataFrame({"cik": [r[0] for r in rows], "q": [10] * len(rows), "cusip": [r[1] for r in rows], "kind": ["SH"] * len(rows),
                                         "shares": [r[2] for r in rows], "value_usd": [r[3] for r in rows]}).cast({"cik": pl.Int64, "q": pl.Int16}), part="q010")  # fmt: skip
    flags: list = []
    labels = {1: StockLabel("MU", "stock", MEMORY, "placed"), 2: StockLabel("INTC", "stock", LOGIC, "placed")}
    build_sector_returns(lake, last_q=11, flags=flags, labels=labels, sic=SicTable({}), adr={})
    ret = {(r["label"], r["q"]): r["ret"] for r in lake.read("sector_returns").iter_rows(named=True)}
    assert abs(ret[("Market", 11)] - 0.1) < 1e-12 and (LOGIC.path, 11) not in ret  # INTC's tripling is left out
    closes = {(r["stock_id"], r["q"]): r["close"] for r in lake.read("stock_quarters").iter_rows(named=True)}
    assert closes[(2, 10)] is None and closes[(2, 11)] == 30.0 and closes[(1, 10)] == 10.0  # the fund scores skip it too
    assert {"type": "prices_set_aside", "stocks": 1, "quarters": 1} in flags


def test_the_13f_prices_and_held_shares_leave_out_a_misread_share_count(tmp_path):
    lake = Lake(tmp_path / "lake")
    cusips = pl.DataFrame({"cusip": ["CC0000000", "XX0000000"], "stock_id": [7, None], "method": ["openfigi", "unmapped"], "tried": [None, None]},
                          schema=CUSIP_MAP_SCHEMA)  # fmt: skip
    # four funds hold stock 7 at ~$10 a share; a fifth's count was misread 10,000x (its price reads $0.001)
    rows = [(1, 100.0, 1000.0), (2, 200.0, 2100.0), (3, 300.0, 2900.0), (4, 50.0, 500.0), (5, 1e6, 1000.0)]
    lake.write("holdings", pl.DataFrame({"cik": [r[0] for r in rows] + [6], "q": [-21] * 6, "cusip": ["CC0000000"] * 5 + ["XX0000000"],
                                         "kind": ["SH"] * 6, "shares": [r[1] for r in rows] + [5.0], "value_usd": [r[2] for r in rows] + [50.0]})
               .cast({"cik": pl.Int64, "q": pl.Int16}), part="q-21")  # fmt: skip
    got = reported_prices(lake, cusips)
    assert got.rows() == [(7, -21, 10.0, 4, 650.0)]  # median $10 (of 5); the four near it hold 650 shares


def test_the_13f_price_is_the_most_held_cusips_not_that_of_funds_mapped_to_the_same_stock(tmp_path):
    # BlackRock in run 47: its own shares ($800) and dozens of BlackRock funds ($10) under one stock id
    lake = Lake(tmp_path / "lake")
    funds = [f"BF{i:07d}" for i in range(8)]
    cusips = pl.DataFrame({"cusip": ["BLK000000", *funds], "stock_id": [632] * 9, "method": ["openfigi"] + ["name"] * 8, "tried": [None] * 9},
                          schema=CUSIP_MAP_SCHEMA)  # fmt: skip
    rows = [(c, "BLK000000", 1000.0, 800_000.0) for c in (1, 2, 3)] + [(c, f, 100.0, 1000.0) for c in (4, 5, 6) for f in funds]
    lake.write("holdings", pl.DataFrame({"cik": [r[0] for r in rows], "q": [44] * len(rows), "cusip": [r[1] for r in rows], "kind": ["SH"] * len(rows),
                                         "shares": [r[2] for r in rows], "value_usd": [r[3] for r in rows]})
               .cast({"cik": pl.Int64, "q": pl.Int16}), part="q044")  # fmt: skip
    assert reported_prices(lake, cusips).rows() == [(632, 44, 800.0, 3, 3000.0)]
