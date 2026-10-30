"""What-if figures for a fund's sales: how the stock did in the year after, against SPY.

A trade is compared with the stock's own close in the quarter four quarters later. A stock with
no row in that quarter (delisted or acquired) has no such figure; the last close before it would
be a stale price, so it is not used.
"""

from dataclasses import dataclass
from typing import Literal

from orca.engine.position import PositionResult
from orca.quarter_px import QuarterPx

_BUYS = ("new", "add")
_SELLS = ("trim", "exit")
_YEAR = 4  # quarters


@dataclass(frozen=True, slots=True)
class ExitRow:
    """A position the fund sold from. sold_shares, sold_usd and avg_exit cover all its sales;
    `one_y` is the stock's return from the last sale's price to its close four quarters later,
    `spy_one_y` SPY's return from that quarter's VWAP to its close four quarters later."""

    stock_id: int
    status: Literal["trimmed", "sold_all"]
    sold_shares: float
    sold_usd: float
    avg_exit: float
    last_sale_q: int
    one_y: float | None
    spy_one_y: float | None


def exit_rows(
    positions: list[PositionResult],
    px_by_stock: dict[int, dict[int, QuarterPx]],
    spy_px: dict[int, QuarterPx],
) -> list[ExitRow]:
    """A row per position with at least one sale (trim or exit), in `positions` order."""
    rows = []
    for position in positions:
        sales = [t for t in position.trades if t.type in _SELLS]
        if not sales:
            continue
        last = sales[-1]
        spy_start = spy_px.get(last.q)
        rows.append(
            ExitRow(
                stock_id=position.stock_id,
                status="sold_all" if position.to_q is not None else "trimmed",
                sold_shares=position.sold_shares,
                sold_usd=position.sold_usd,
                avg_exit=position.sold_usd / position.sold_shares,
                last_sale_q=last.q,
                one_y=_return_after(px_by_stock.get(position.stock_id, {}), last.q, last.px),
                spy_one_y=_return_after(
                    spy_px, last.q, spy_start.vwap if spy_start is not None else None
                ),
            )
        )
    return rows


def buys_vs_sells(
    positions: list[PositionResult], px_by_stock: dict[int, dict[int, QuarterPx]]
) -> tuple[float | None, float | None]:
    """The mean one-year-after return of the fund's buys (new, add) and of its sales (trim,
    exit): close four quarters later / trade price - 1. A trade without that close is skipped,
    and a side without any trade is None."""
    buys: list[float] = []
    sells: list[float] = []
    for position in positions:
        px = px_by_stock.get(position.stock_id, {})
        for trade in position.trades:
            side = buys if trade.type in _BUYS else sells
            result = _return_after(px, trade.q, trade.px)
            if result is not None:
                side.append(result)
    return (
        sum(buys) / len(buys) if buys else None,
        sum(sells) / len(sells) if sells else None,
    )


def beat_spy_pct(rows: list[ExitRow]) -> float | None:
    """The share of rows with both returns whose `one_y` is above `spy_one_y`; None when no row
    has both."""
    pairs = [
        (r.one_y, r.spy_one_y) for r in rows if r.one_y is not None and r.spy_one_y is not None
    ]
    if not pairs:
        return None
    return sum(one_y > spy_one_y for one_y, spy_one_y in pairs) / len(pairs)


def _return_after(px: dict[int, QuarterPx], q: int, start_px: float | None) -> float | None:
    """Close in quarter `q` + 4 / `start_px` - 1; None without that close or a positive start."""
    later = px.get(q + _YEAR)
    if later is None or later.close is None or start_px is None or start_px <= 0:
        return None
    return later.close / start_px - 1
