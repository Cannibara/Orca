"""Home page lists: top funds, conviction moves, wins and losses, latest filings, crowded buys and
calls. Every list is a plain function of the per-fund snapshots and returns JSON-ready rows
(dicts of int, float, str and None; dates as ISO strings), identified by stock_id and fund_id."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from orca.config import (
    CALLS_MIN_MCAP,
    CALLS_MIN_PRICE,
    CALLS_MIN_WEIGHT,
    CONC_MAX_POS,
    CONC_MIN_BOOK,
    CONC_MIN_POS,
    CONC_MIN_TOP10,
    CONVICTION_JUMP,
    CONVICTION_WEIGHT,
    CROWDED_MIN_FUNDS,
    EXCLUDE_NAME_WORDS,
    GIANT_MIN_POSITIONS,
    PERIODS,
    TOP_MIN_BOOK,
    TOP_MIN_POSITIONS,
    TOP_MIN_PRICED,
    TOP_MIN_QUARTERS,
)
from orca.engine.metrics import Performance
from orca.engine.position import Trade

_BUYS = ("new", "add")


@dataclass(frozen=True, slots=True)
class FundSnapshot:
    """One fund's latest figures, as the home lists need them. Weights are shares of the book
    keyed by stock_id (`weights_prev` is the quarter before `weights_now`). `trades_latest` pairs
    each stock_id with its trade in the latest quarter; `pnl_latest` is the latest quarter's P&L
    per stock; `buys_recent` holds (stock_id, q, est. price, weight after, filed) for recent new
    and add trades. `perf` is keyed by period ("1y", "3y", "5y", "max"), None when too short."""

    fund_id: int
    name: str
    book: float
    n_priced: int
    priced_pct: float
    quarters_filed: int
    excluded: bool
    weights_now: dict[int, float]
    weights_prev: dict[int, float]
    trades_latest: list[tuple[int, Trade]]
    pnl_latest: dict[int, float]
    buys_recent: list[tuple[int, int, float, float, date]]
    perf: dict[str, Performance | None]
    filed: date
    period_q: int


def is_excluded_name(name: str) -> bool:
    """Whether a fund name marks a bank, insurer, pension or broker (case-insensitive)."""
    upper = name.upper()
    return any(word in upper for word in EXCLUDE_NAME_WORDS)


def top_funds(snaps: list[FundSnapshot], period: str) -> dict[str, list[dict]]:
    """The funds worth ranking over `period` ("1y", "3y", "5y" or "max"), by return per year.

    A fund needs the top-fund basics (book, quarters filed, priced positions, priced share of
    the book, not a bank or similar) and a performance for the period. Funds holding
    GIANT_MIN_POSITIONS or more priced positions are index giants and are listed apart, in
    "giants", never in "eligible"."""
    if period not in PERIODS:
        raise ValueError(f"unknown period {period!r}")
    ranked = []
    for s in snaps:
        p = s.perf.get(period)
        if p is None or not _top_base(s):
            continue
        ranked.append((s, p))
    ranked.sort(key=lambda sp: _return_order(sp[1].ann_return) + (sp[0].fund_id,))
    out: dict[str, list[dict]] = {"eligible": [], "giants": []}
    for s, p in ranked:
        row = {
            "fund_id": s.fund_id,
            "name": s.name,
            "book": float(s.book),
            "n_positions": int(s.n_priced),
            "ann_return": _num(p.ann_return),
            "max_dd": _num(p.max_dd),
            "sharpe": _num(p.sharpe),
        }
        out["giants" if s.n_priced >= GIANT_MIN_POSITIONS else "eligible"].append(row)
    return out


def conviction_moves(snaps: list[FundSnapshot]) -> list[dict]:
    """Big bets of concentrated active funds in their latest quarter, largest change first.

    A new or add counts when the stock ends at CONVICTION_WEIGHT or more of the book, or gains
    CONVICTION_JUMP or more of it; an exit counts when the stock was CONVICTION_WEIGHT or more
    before. Trims never count. `change_pts` is the weight change in percentage points."""
    rows = []
    for s in snaps:
        if not _concentrated(s):
            continue
        for stock_id, t in s.trades_latest:
            now = s.weights_now.get(stock_id, 0.0)
            prev = s.weights_prev.get(stock_id, 0.0)
            if t.type in _BUYS:
                counts = now >= CONVICTION_WEIGHT or now - prev >= CONVICTION_JUMP
            elif t.type == "exit":
                counts = prev >= CONVICTION_WEIGHT
            else:
                counts = False
            if not counts:
                continue
            rows.append(
                {
                    "fund_id": s.fund_id,
                    "name": s.name,
                    "stock_id": stock_id,
                    "move": t.type,
                    "weight_now": float(now),
                    "change_pts": (now - prev) * 100,
                    "est_price": float(t.px),
                    "q": int(t.q),
                }
            )
    rows.sort(key=lambda r: (-abs(r["change_pts"]), r["fund_id"], r["stock_id"]))
    return rows


def wins_losses(snaps: list[FundSnapshot], n: int = 25) -> dict[str, list[dict]]:
    """The `n` biggest winning and losing positions of the latest quarter across the top-fund
    basics (any period, index giants included): {"wins": pnl > 0 largest first, "losses":
    pnl < 0 most negative first}."""
    wins, losses = [], []
    for s in snaps:
        if not _top_base(s):
            continue
        for stock_id, pnl in s.pnl_latest.items():
            row = {"fund_id": s.fund_id, "name": s.name, "stock_id": stock_id, "pnl": float(pnl)}
            if pnl > 0:
                wins.append(row)
            elif pnl < 0:
                losses.append(row)
    wins.sort(key=lambda r: (-r["pnl"], r["fund_id"], r["stock_id"]))
    losses.sort(key=lambda r: (r["pnl"], r["fund_id"], r["stock_id"]))
    return {"wins": wins[:n], "losses": losses[:n]}


def just_filed(snaps: list[FundSnapshot], n: int = 50) -> list[dict]:
    """The `n` latest filings by funds that are not excluded by name, newest first (ties by
    name). The headline is the stock whose weight changed most, either way; its
    `headline_change_pts` is signed, in percentage points. Both are None for a fund without
    stocks."""
    listed = [s for s in snaps if not _excluded(s)]
    listed.sort(key=lambda s: (-s.filed.toordinal(), s.name, s.fund_id))
    rows = []
    for s in listed[:n]:
        stocks = sorted(s.weights_now.keys() | s.weights_prev.keys())
        change = {
            stock_id: s.weights_now.get(stock_id, 0.0) - s.weights_prev.get(stock_id, 0.0)
            for stock_id in stocks
        }
        headline = max(stocks, key=lambda stock_id: abs(change[stock_id])) if stocks else None
        rows.append(
            {
                "fund_id": s.fund_id,
                "name": s.name,
                "filed": s.filed.isoformat(),
                "period_q": int(s.period_q),
                "book": float(s.book),
                "headline_stock_id": headline,
                "headline_change_pts": None if headline is None else change[headline] * 100,
            }
        )
    return rows


def crowded_buys(snaps: list[FundSnapshot]) -> list[dict]:
    """Stocks that at least CROWDED_MIN_FUNDS distinct concentrated active funds bought (new or
    add) in the latest quarter: fund count, dollars bought and the funds' mean weight after."""
    buyers: dict[int, dict[int, tuple[float, float]]] = {}  # stock -> fund -> (dollars, weight)
    for s in snaps:
        if not _concentrated(s):
            continue
        for stock_id, t in s.trades_latest:
            if t.type not in _BUYS:
                continue
            by_fund = buyers.setdefault(stock_id, {})
            dollars = by_fund.get(s.fund_id, (0.0, 0.0))[0] + t.delta * t.px
            by_fund[s.fund_id] = (dollars, s.weights_now.get(stock_id, 0.0))
    rows = [
        {
            "stock_id": stock_id,
            "funds_buying": len(by_fund),
            "total_bought": float(sum(d for d, _ in by_fund.values())),
            "avg_weight_after": float(sum(w for _, w in by_fund.values()) / len(by_fund)),
        }
        for stock_id, by_fund in buyers.items()
        if len(by_fund) >= CROWDED_MIN_FUNDS
    ]
    rows.sort(key=lambda r: (-r["funds_buying"], -r["total_bought"], r["stock_id"]))
    return rows


def calls(
    snaps: list[FundSnapshot],
    mcap: dict[int, float],
    latest_px: dict[int, float],
    px_on_filed: Callable[[int, date], float | None],
    window: str,
) -> list[dict]:
    """Recent buys by top and concentrated funds, ordered by the stock's move since the fund's
    estimated buy price (latest price / est. price - 1), best first; the browser shows the top
    as the best calls and the bottom as the worst.

    A buy must be CALLS_MIN_WEIGHT or more of the book, in a stock with a known market cap of
    CALLS_MIN_MCAP or more and a known latest price of CALLS_MIN_PRICE or more. Window "q" keeps
    buys of the latest quarter across `snaps`, "y" those of the latest four. A buy without a
    positive est. price has no move to rank and is left out."""
    if window not in ("q", "y"):
        raise ValueError(f"unknown window {window!r}")
    if not snaps:
        return []
    latest_q = max(s.period_q for s in snaps)
    oldest_q = latest_q if window == "q" else latest_q - 3
    ranked = []
    for s in snaps:
        if not (_top_base(s) or _concentrated(s)):
            continue
        for stock_id, q, est_price, weight_after, filed in s.buys_recent:
            if q < oldest_q or weight_after < CALLS_MIN_WEIGHT or est_price <= 0:
                continue
            cap, price = mcap.get(stock_id), latest_px.get(stock_id)
            if cap is None or cap < CALLS_MIN_MCAP or price is None or price < CALLS_MIN_PRICE:
                continue
            row = {
                "stock_id": stock_id,
                "fund_id": s.fund_id,
                "name": s.name,
                "q": int(q),
                "est_price": float(est_price),
                "price_on_filed": _num(px_on_filed(stock_id, filed)),
                "filed": filed.isoformat(),
            }
            ranked.append((price / est_price - 1, row))
    ranked.sort(key=lambda pr: (-pr[0], pr[1]["fund_id"], pr[1]["stock_id"], pr[1]["q"]))
    return [row for _, row in ranked]


def _excluded(s: FundSnapshot) -> bool:
    return s.excluded or is_excluded_name(s.name)


def _top_base(s: FundSnapshot) -> bool:
    """The top-fund basics, before any period's performance."""
    return (
        s.book >= TOP_MIN_BOOK
        and s.quarters_filed >= TOP_MIN_QUARTERS
        and s.n_priced >= TOP_MIN_POSITIONS
        and s.priced_pct >= TOP_MIN_PRICED
        and not _excluded(s)
    )


def _concentrated(s: FundSnapshot) -> bool:
    """A concentrated active fund: few enough positions, a heavy top ten, a big enough book."""
    top10 = sum(sorted(s.weights_now.values(), reverse=True)[:10])
    return (
        CONC_MIN_POS <= s.n_priced <= CONC_MAX_POS
        and top10 >= CONC_MIN_TOP10
        and s.book >= CONC_MIN_BOOK
        and not _excluded(s)
    )


def _return_order(ann_return: float | None) -> tuple[bool, float]:
    """Sort key putting the highest return first and a missing one last."""
    return (ann_return is None, -(ann_return or 0.0))


def _num(x: float | None) -> float | None:
    return None if x is None else float(x)
