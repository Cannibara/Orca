from datetime import date

import polars as pl

from orca.holdings import HOLDINGS_SCHEMA
from orca.quarters import q_index, q_start
from orca.run.state import part_name
from orca.splits import infer_splits
from orca.storage import Lake

A, B = "037833100", "594918104"


def holdings(lake: Lake, q: int, rows: list[tuple[int, str, float, float]]) -> None:
    frame = pl.DataFrame(
        [
            {"cik": cik, "q": q, "cusip": cusip, "kind": "SH", "shares": shares,
             "value_usd": value, "filed": date(2010, 1, 1)}
            for cik, cusip, shares, value in rows
        ],
        schema=HOLDINGS_SCHEMA,
    )
    lake.write("holdings", frame, part=part_name(q))


def test_a_split_is_read_when_the_holders_agree(tmp_path):
    lake = Lake(tmp_path)
    q = q_index(2005, 1)
    holdings(lake, q - 1, [(1, A, 100, 5000), (2, A, 300, 15000), (3, A, 50, 2500)])
    # Two of three report twice the shares at about half the price; the third bought more.
    holdings(lake, q, [(1, A, 200, 5200), (2, A, 600, 15600), (3, A, 400, 10400)])
    assert infer_splits(lake, {A}) == {A: [(q_start(q), 2.0)]}


def test_no_split_from_one_fund_or_a_5_for_4_lookalike_or_after_2013(tmp_path):
    lake = Lake(tmp_path)
    q = q_index(2005, 1)
    holdings(lake, q - 1, [(1, A, 100, 5000), (1, B, 100_000, 5000), (2, B, 200_000, 10000)])
    # Fund 1 doubles A at half the price (one fund only); B: both funds add 25% at a lower price.
    holdings(lake, q, [(1, A, 200, 5000), (1, B, 125_000, 5300), (2, B, 250_000, 10600)])
    assert infer_splits(lake, {A, B}) == {}
    later = q_index(2015, 1)
    holdings(lake, later - 1, [(1, A, 100, 5000), (2, A, 300, 15000)])
    holdings(lake, later, [(1, A, 200, 5000), (2, A, 600, 15000)])
    assert infer_splits(lake, {A}) == {}  # the XML era is left as it was
