"""Our own index for every hierarchy label: sector, industry and industry vertical, plus the whole market.

Market-cap weighted with no cap on any stock, rebalanced each quarter, total return with dividends
(DECISIONS 2026-11-17). A hierarchy label's index holds every stock whose main label sits under it, so each tier
partitions the market and industries, sectors and the market are cap-weighted sums of their stocks.

Per label and quarter q, with weights wᵢ fixed by market caps at the end of q−1:
  ret       = Σ wᵢ (closeᵢ,q + divᵢ,q) / closeᵢ,q−1 − 1
  level_end = level_end(q−1) × (1 + ret)        (1 at the quarter before the first return)
  level_avg = level_end(q−1) × Σ wᵢ vwapᵢ,q / closeᵢ,q−1   (fund trades are priced at the quarter VWAP)
A stale close (more than STALE_DAYS before the quarter end) sits out of the quarter it ends and the next one,
unless the stock never trades again: then it is a delisting and earns its return up to that last close.
"""

from __future__ import annotations

import math
from datetime import timedelta

import polars as pl

from orca.quarters import BASE_YEAR, q_end
from orca.shares_hist import SCHEMA as SHARES_SCHEMA
from orca.shares_hist import shares_asof

MARKET = "Market"
SEP = " > "
STALE_DAYS = 7  # about five trading days
QUARTER_SCHEMA = pl.Schema(
    {"stock_id": pl.Int32, "q": pl.Int32, "close": pl.Float64, "div": pl.Float64, "vwap": pl.Float64, "cap": pl.Float64, "stale": pl.Boolean}
)
OUT_SCHEMA = pl.Schema(
    {"label": pl.String, "tier": pl.Int8, "q": pl.Int32, "ret": pl.Float64, "level_end": pl.Float64, "level_avg": pl.Float64,
     "n": pl.Int32, "cap": pl.Float64, "top_weight": pl.Float64}
)  # fmt: skip
__all__ = ["HEAVY_WEIGHT", "MARKET", "QUARTER_SCHEMA", "REPORTED_SCHEMA", "SHARES_SCHEMA", "cap_report", "held_scales", "index_returns",
           "market_caps", "mispriced", "stock_quarters", "todays_counts", "vendor_rejects"]  # fmt: skip
# No real stock has come near 15% of the US market (the biggest are ~7%), so a cap above it is a data error: an ADR
# counted in ordinary shares (LATAM: 604bn shares, 2,000 to an ADR, read as $21tn in run 39) or a unit slip. Such a
# stock sits out of every index that quarter, and the sectors step logs it. Only where the market has enough stocks
# for the share to mean that (a tiny universe, as in the demo, is left alone).
MAX_MARKET_WEIGHT = 0.15
MIN_MARKET_STOCKS = 100
# Run 40's cap report showed single-quarter share counts a million times too big (Oracle, Clorox, Exelon...) and
# prices that jump by multiples: data slips, not markets. A quarter whose implied share count (cap over close) moves
# 5x or more against the quarter before keeps its price but not its cap, so the stock sits out of the next quarter's
# weights; a quarterly return over +300% (MAX_RETURN) sits out of that quarter. A small cap that really quadruples
# barely moves a cap-weighted index, so little is lost.
MAX_SHARE_JUMP = 5.0
MAX_RETURN = 3.0
# The movers log also lists every stock-quarter at this share of the market or more (Apple, Microsoft and Nvidia
# reach 5–7%), so an overweight stock is named even in a quarter its price stood still; only in a quarter of
# MIN_MARKET_STOCKS or more, where the share means that.
HEAVY_WEIGHT = 0.04
# Run 45 put Mechanics Bancorp, once HomeStreet, at $875bn in 2017: its ticker, MCHB, was Mechanics Bank's on the OTC
# market, and the price vendor's history under it is that bank's ($10,800–36,500 a share) up to their 2025 merger. A
# stock's 13F holders report its price too (value over shares), so an as-traded close MAX_PRICE_GAP-fold or more off
# the median they report, MIN_PRICE_HOLDERS funds or more, is some other security's price (`mispriced`).
MAX_PRICE_GAP = 5.0
MIN_PRICE_HOLDERS = 3
# The funds' price says something about ours only if what they hold is this company's stock: shares held of
# HELD_SHARE_RANGE of its count (on the same basis). Run 49 set aside right prices for Honeywell, Accenture and Eaton,
# whose most-held CUSIP in the 13F data was some other security mapped to them; Mechanics Bancorp's holders held 80%
# of HomeStreet's shares.
HELD_SHARE_RANGE = (0.25, 1.5)
# A stock whose price history at the vendor is mostly another company's takes that company's prices on the fund pages
# too (Juniper Networks under JNP, Juniper Pharmaceuticals', 1999-2017; Exact Sciences under EXK, Endeavour Silver's).
# Where REJECT_SHARE or more of its quarters with a 13F price (REJECT_MIN_QUARTERS or more) are mispriced, its vendor
# ticker is rejected (`vendor_rejects`; lake table `vendor_rejects`), and the next run looks for another
# (`vendor.resolve`); with none, the fund engine values it at the funds' reported prices.
REJECT_SHARE = 0.8
REJECT_MIN_QUARTERS = 4
REJECT_MIN_HOLDERS = 20
# A quarter where more than this share of the stocks checked disagree (MIN_MARKET_STOCKS or more checked) points at
# the filings (values in thousands read as dollars), not at the prices: it is left alone, not emptied out of the indices.
MAX_MISPRICED_SHARE = 0.1
# per stock and quarter, from the 13F holdings: the median price per share reported, the funds reporting it and the
# shares they hold in all (as reported, on the quarter's share basis)
REPORTED_SCHEMA = pl.Schema({"stock_id": pl.Int32, "q": pl.Int32, "price": pl.Float64, "holders": pl.Int32, "held": pl.Float64})
# Before a company's first filed count its earliest stands in, far off for one that issued many shares in between: no
# SEC count exists before 2009, and Citigroup's first (Sept 2009, 22.9bn) is 4.6x its 2007 count, Lloyds' (2017)
# 13x, so both read at 6-10% of the market in 2000-08 (runs 43-46). The shares the 13F filers hold move with the shares
# outstanding, so there the earliest count is scaled by the stock's 13F-held shares then over those at that count,
# against the median stock's same ratio (13F coverage and institutional ownership grow for all stocks), where
# MIN_SCALE_HOLDERS funds or more hold it at both ends. Only scales of SCALE_BELOW or less are used: issuance between
# the two dates. A higher one is more often institutions leaving a stock in distress (AIG's in 2009, held by the
# government) than a company buying back half its shares, and a stock read too small does the index less harm.
MIN_SCALE_HOLDERS = 10
SCALE_BELOW = 0.5
# Run 48 left Citigroup unscaled: in Sept 2009 the government held a third of it and no 13F reports that, so its
# 13F-held shares were low against its count. Each scale is now the median of those against the company's first
# ANCHOR_QUARTERS filed counts (by 2011 institutions held Citigroup as before). Held shares are a centred median of
# 5 quarters (one quarter's missing big holder put Bank of America at x0.05), and a quarter counts only where at
# least 1/HOLDER_DROP as many funds hold the stock as at the count (JPMorgan's 2000 CUSIP, Chase's, is mostly mapped
# elsewhere: 12 holders against 500, x0.001). Not 1/4 (run 50): far fewer US funds held Lloyds' ADRs in 2002–05 than
# at its first counts (2017–18), and Lloyds went back to 6% of the market.
ANCHOR_QUARTERS = 8
HOLDER_DROP = 10


def stock_quarters(daily: pl.DataFrame) -> pl.DataFrame:
    """Per stock and quarter: last close, its date, stale flag, raw (as traded) close, dividends and VWAP.

    `daily` is `split_adjust_prices` output (split-adjusted bars that keep the raw split_factor)."""
    close = pl.col("close")
    later = pl.col("split_factor").fill_null(1.0).reverse().cum_prod().reverse().shift(-1, fill_value=1.0).over("stock_id")
    typical = (pl.col("high").fill_null(close) + pl.col("low").fill_null(close) + close) / 3
    vol = pl.col("volume").fill_null(0.0)
    bars = (
        daily.sort("stock_id", "date")
        .with_columns(factor=later, q=((pl.col("date").dt.year() - BASE_YEAR) * 4 + (pl.col("date").dt.month() - 1) // 3).cast(pl.Int32))
        .filter(close.is_not_null() | (pl.col("dividend").fill_null(0.0) != 0))
    )  # fmt: skip
    priced = bars.filter(close.is_not_null())
    out = priced.group_by("stock_id", "q").agg(
        close.last(),
        pl.col("date").last().alias("last"),
        (close * pl.col("factor")).last().alias("raw_close"),
        pl.when(vol.sum() > 0).then((typical * vol).sum() / vol.sum()).otherwise(typical.mean()).alias("vwap"),
    )
    divs = bars.group_by("stock_id", "q").agg(pl.col("dividend").fill_null(0.0).sum().alias("div"))
    out = out.join(divs, on=["stock_id", "q"], how="left").with_columns(pl.col("div").fill_null(0.0))
    ends = pl.DataFrame({"q": sorted(set(out["q"].to_list()))}, schema={"q": pl.Int32})
    ends = ends.with_columns(pl.col("q").map_elements(lambda q: q_end(q) - timedelta(days=STALE_DAYS), return_dtype=pl.Date).alias("_cut"))
    return out.join(ends, on="q").with_columns(stale=pl.col("last") < pl.col("_cut")).drop("_cut").sort("stock_id", "q")


def _compared(sq: pl.DataFrame, reported: pl.DataFrame) -> pl.DataFrame:
    """The stock-quarters with a 13F price to check ours against (`mispriced`): stock_id, q, raw_close, _f (as-traded
    close over the split-adjusted one), price, holders, held, gap; _off where MAX_PRICE_GAP-fold or more off, _ok in
    quarters whose share of such rows points at the prices, not the filings (MAX_MISPRICED_SHARE)."""
    theirs = reported.filter((pl.col("holders") >= MIN_PRICE_HOLDERS) & (pl.col("price") > 0))
    off = (pl.col("gap") >= MAX_PRICE_GAP) | (pl.col("gap") <= 1 / MAX_PRICE_GAP)
    return (
        sq.filter(pl.col("raw_close") > 0)
        .select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "raw_close", (pl.col("raw_close") / pl.col("close")).alias("_f"))
        .join(theirs.select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "price", "holders", "held"), on=["stock_id", "q"])
        .with_columns(gap=pl.col("raw_close") / pl.col("price"))
        .with_columns(_off=off, _ok=(off.mean().over("q") <= MAX_MISPRICED_SHARE) | (pl.len().over("q") < MIN_MARKET_STOCKS))
    )  # fmt: skip


def _held_share(rows: pl.DataFrame, units: pl.DataFrame) -> pl.DataFrame:
    u = units.select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "units")
    return rows.join(u, on=["stock_id", "q"], how="left").with_columns(held_share=pl.col("held") * pl.col("_f") / pl.col("units"))


def mispriced(sq: pl.DataFrame, reported: pl.DataFrame, units: pl.DataFrame | None = None, spared: list | None = None) -> pl.DataFrame:
    """(stock_id, q, gap = ours / theirs, ours, theirs, held_share) of the quarters whose as-traded close (`sq`,
    `stock_quarters` output) is MAX_PRICE_GAP-fold or more off the median price per share the stock's 13F holders
    report (`reported`, REPORTED_SCHEMA), where MIN_PRICE_HOLDERS funds or more report it, in quarters where no more
    than MAX_MISPRICED_SHARE of the stocks checked are (if MIN_MARKET_STOCKS or more are checked). Both are on the
    quarter's own share basis, so a split needs no adjusting. With `units` (stock_id, q, units: the company's count on
    today's basis, in the unit its price is quoted in), only where the funds hold HELD_SHARE_RANGE of it; the others
    go to `spared`."""
    rows = _compared(sq, reported).filter(pl.col("_off") & pl.col("_ok"))
    if units is None:
        rows = rows.with_columns(held_share=pl.lit(None, pl.Float64))
    else:
        rows = _held_share(rows, units)
        lo, hi = HELD_SHARE_RANGE
        own = pl.col("held_share").is_between(lo, hi)
        if spared is not None:
            spared.append(rows.filter(~own.fill_null(False)).select("stock_id", "q", "gap", pl.col("raw_close").alias("ours"),
                                                                   pl.col("price").alias("theirs"), "held_share"))  # fmt: skip
        rows = rows.filter(own.fill_null(False))
    return rows.select("stock_id", "q", "gap", pl.col("raw_close").alias("ours"), pl.col("price").alias("theirs"), "held_share").sort("stock_id", "q")


def vendor_rejects(sq: pl.DataFrame, reported: pl.DataFrame, units: pl.DataFrame) -> pl.DataFrame:
    """(stock_id, quarters, off) of the stocks whose price history at the vendor is mostly another company's: of the
    `quarters` with a 13F price to check against (REJECT_MIN_QUARTERS or more), REJECT_SHARE or more are `off` as in
    `mispriced`. Where the company has no count to check the funds' holding against, REJECT_MIN_HOLDERS funds or more
    must report it instead."""
    rows = _held_share(_compared(sq, reported), units)
    lo, hi = HELD_SHARE_RANGE
    own = pl.col("held_share").is_between(lo, hi) | (pl.col("held_share").is_null() & (pl.col("holders") >= REJECT_MIN_HOLDERS))
    per = rows.group_by("stock_id").agg(pl.len().cast(pl.Int32).alias("quarters"), (pl.col("_off") & pl.col("_ok") & own).sum().cast(pl.Int32).alias("off"))
    return per.filter((pl.col("quarters") >= REJECT_MIN_QUARTERS) & (pl.col("off") >= REJECT_SHARE * pl.col("quarters"))).sort("stock_id")


# The first XBRL cover pages (2009–11) often scaled the count 1,000x or 1,000,000x (Truist: 648 trillion shares,
# West Pharmaceutical 33 trillion; BioNTech's first two 20-Fs 1,000x), and later ones slip now and then. Run 42 used
# a company's earliest count for the years before it, so one slip set a stock at 5–15% of the market back to 1999.
# Such slips are 1,000^k exactly, and can be most of a stretch (Chesapeake Utilities' 10-Qs of 2024–25 in thousands
# between right 10-Ks; Methode's first four counts), where a median keeps the slip. So, walking back from a company's
# latest count, a count as reported within UNIT_TOLERANCE of 1,000^k times the next later one, with no split between
# them, is divided by 1,000^k (no real count moves 400x in a quarter). Then a count MAX_SHARE_JUMP-fold or more off the median of the COUNT_WINDOW counts
# around it (on today's basis) is dropped, and the counts either side stand in.
UNIT_TOLERANCE = 2.5
COUNT_WINDOW = 9


def _unit_slips(stock_ids: list[int], shares: list[float], split_after: list[bool]) -> list[float]:
    """`shares` as reported (sorted by stock, then date) with the 1,000^k slips divided out, against each company's
    latest count. A count with a split between it and the next is not compared: the split explains a jump (RedHill's
    ADS went from 10 to 10,000 shares while it issued 10x more; on today's basis that read as a 1,000x slip in run 44)."""
    out = list(shares)
    tol = math.log10(UNIT_TOLERANCE)
    for i in range(len(out) - 1, -1, -1):
        if i == len(out) - 1 or stock_ids[i + 1] != stock_ids[i] or split_after[i]:
            continue  # a company's latest count (the anchor), or a split before the next one
        e = math.log10(out[i] / out[i + 1])
        k = round(e / 3)
        if k and abs(e - 3 * k) < tol:
            out[i] /= 1000.0**k
    return out


def todays_counts(hist: pl.DataFrame, splits: pl.DataFrame | None = None) -> pl.DataFrame:
    """`hist` (SHARES_SCHEMA) with the 1,000^k slips divided out of the counts as reported, then each count on
    today's share basis, times the `splits` (stock_id, date, split_factor) dated after its `end` (the day it is as
    of), and the other slips dropped (UNIT_TOLERANCE, COUNT_WINDOW)."""
    h = hist.filter(pl.col("shares").is_not_null() & (pl.col("shares") > 0)).sort("stock_id", "end", "filed")
    has_splits = splits is not None and not splits.is_empty()
    if has_splits:
        splits = splits.select(pl.col("stock_id").cast(pl.Int32), pl.col("date").alias("_d"), pl.col("split_factor").cast(pl.Float64))
        between = (
            h.select("stock_id", "end", _next=pl.col("end").shift(-1).over("stock_id")).join(splits, on="stock_id")
            .filter((pl.col("_d") > pl.col("end")) & (pl.col("_d") <= pl.col("_next"))).select("stock_id", "end", _split=pl.lit(True)).unique()
        )  # fmt: skip
        h = h.join(between, on=["stock_id", "end"], how="left", maintain_order="left")
    else:
        h = h.with_columns(_split=pl.lit(None, pl.Boolean))
    split_after = h["_split"].fill_null(False).to_list()
    h = h.drop("_split").with_columns(shares=pl.Series(_unit_slips(h["stock_id"].to_list(), h["shares"].to_list(), split_after), dtype=pl.Float64))
    if has_splits:
        later = (
            h.select("stock_id", "end").unique()
            .join(splits, on="stock_id")
            .filter(pl.col("_d") > pl.col("end")).group_by("stock_id", "end").agg(pl.col("split_factor").product().alias("_f"))
        )  # fmt: skip
        h = h.join(later, on=["stock_id", "end"], how="left").with_columns(shares=pl.col("shares") * pl.col("_f").fill_null(1.0)).drop("_f")
    h = h.sort("stock_id", "end", "filed").with_columns(_l=pl.col("shares").log())
    h = h.with_columns(_m=pl.col("_l").rolling_median(COUNT_WINDOW, min_samples=1, center=True).over("stock_id"))
    return h.filter((pl.col("_l") - pl.col("_m")).abs() < math.log(MAX_SHARE_JUMP)).drop("_l", "_m").select(*SHARES_SCHEMA.names())


def held_scales(sq: pl.DataFrame, reported: pl.DataFrame, rows: pl.DataFrame) -> pl.DataFrame:
    """(stock_id, q, scale) for the `rows` (stock_id, q, shares: the count filed by then, null before the first;
    _s0: the earliest count, which stands in) before a company's first count, where its 13F-held shares say the
    company had SCALE_BELOW or less of the earliest count. For each of its first ANCHOR_QUARTERS quarters with a
    filed count: that count x the stock's held shares in q over those then, over the market's same move (a chained
    index of the median stock's quarter-on-quarter change); the scale is the median of those, over the earliest
    count. Held shares go to today's share basis with the stock's splits (as-traded close over the split-adjusted
    one in `sq`) and are a centred median of 5 quarters; only quarters MIN_SCALE_HOLDERS funds or more hold the
    stock, and at least 1/HOLDER_DROP as many as at the count, count."""
    factor = sq.filter((pl.col("close") > 0) & (pl.col("raw_close") > 0)).select(
        pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), (pl.col("raw_close") / pl.col("close")).alias("_f")
    )
    h = (
        reported.filter((pl.col("holders") >= MIN_SCALE_HOLDERS) & (pl.col("held") > 0))
        .select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "holders", "held")
        .join(factor, on=["stock_id", "q"])
        .select("stock_id", "q", "holders", (pl.col("held") * pl.col("_f")).alias("_h"))
        .sort("stock_id", "q")
        .with_columns(_hs=pl.col("_h").rolling_median(5, min_samples=1, center=True).over("stock_id"))
    )  # fmt: skip
    step = (
        h.join(h.select("stock_id", (pl.col("q") + 1).alias("q"), pl.col("_h").alias("_hp")), on=["stock_id", "q"])
        .group_by("q").agg((pl.col("_h") / pl.col("_hp")).median().alias("_g"))
    )  # fmt: skip
    index = (
        pl.DataFrame({"q": sorted(set(h["q"].to_list()))}, schema={"q": pl.Int32}).join(step, on="q", how="left")
        .sort("q").select("q", pl.col("_g").fill_null(1.0).cum_prod().alias("_i"))
    )  # fmt: skip
    h = h.join(index, on="q")
    rows = rows.select(pl.col("stock_id").cast(pl.Int32), pl.col("q").cast(pl.Int32), "shares", "_s0")
    anchors = (
        rows.filter(pl.col("shares").is_not_null()).join(h, on=["stock_id", "q"]).sort("stock_id", "q")
        .group_by("stock_id", maintain_order=True).head(ANCHOR_QUARTERS)
        .select("stock_id", pl.col("shares").alias("_ca"), pl.col("_hs").alias("_ha"), pl.col("holders").alias("_na"), pl.col("_i").alias("_ia"))
    )  # fmt: skip
    est = (
        rows.filter(pl.col("shares").is_null() & pl.col("_s0").is_not_null()).join(h, on=["stock_id", "q"]).join(anchors, on="stock_id")
        .filter(pl.col("holders") * HOLDER_DROP >= pl.col("_na"))
        .with_columns(_e=pl.col("_ca") * pl.col("_hs") / pl.col("_ha") * pl.col("_ia") / pl.col("_i"))
        .group_by("stock_id", "q").agg(pl.col("_e").median(), pl.col("_s0").first())
    )  # fmt: skip
    return est.select("stock_id", "q", (pl.col("_e") / pl.col("_s0")).alias("scale")).filter(pl.col("scale") <= SCALE_BELOW).sort("stock_id", "q")


def market_caps(
    sq: pl.DataFrame,
    hist: pl.DataFrame,
    securities: pl.DataFrame,
    adr: dict[str, float],
    splits: pl.DataFrame | None = None,
    reported: pl.DataFrame | None = None,
    scaled: list | None = None,
    units: list | None = None,
) -> tuple[pl.DataFrame, set[int]]:
    """(stock_id, q, cap) at each quarter end, and the stock ids whose count in some quarter was not filed by then.

    cap = split-adjusted close × a share count on today's share basis (`todays_counts`). So price and count stand on
    the same basis whenever a split fell: run 41 paired a price after a split with a count from before it (Nvidia's
    10-for-1; reverse splits read 50x too big). The count is the latest filed by the quarter end; before a company's
    first filed count, its earliest one (today's count put penny stocks that later issued 1000s of times the shares
    at 10% of the 2013 market), scaled by its 13F holdings (`held_scales`) when `reported` (REPORTED_SCHEMA) is given;
    the rows scaled (stock_id, q, scale, cap) go to `scaled`. With no count on record, today's `shares_out`. All per
    ADR for an ADR. A company with several share classes reports one total, so it is counted once, on its lowest
    stock id. The counts used (stock_id, q, units: per ADR for an ADR) go to `units`."""
    securities = securities.filter(pl.col("stock_id").is_in(sq["stock_id"].unique().to_list()))  # a bond sharing the CIK never wins
    first = securities.filter(pl.col("cik").is_null() | (pl.col("stock_id") == pl.col("stock_id").min().over("cik")))
    sq = sq.join(first.select("stock_id", "ticker", "shares_out"), on="stock_id")
    counts = todays_counts(hist, splits)
    dates = {q: q_end(q) for q in sorted(set(sq["q"].to_list()))}
    asof = shares_asof(counts, list(dates.values()))
    asof = asof.join(pl.DataFrame({"q": list(dates), "asof": list(dates.values())}, schema={"q": pl.Int32, "asof": pl.Date}), on="asof")
    earliest = counts.sort("end", "filed").group_by("stock_id").first().select("stock_id", pl.col("shares").alias("_s0"))
    out = (
        sq.join(asof.select("stock_id", "q", "shares"), on=["stock_id", "q"], how="left").join(earliest, on="stock_id", how="left")
        .with_columns(fallback=pl.col("shares").is_null() & (pl.col("_s0").is_not_null() | pl.col("shares_out").is_not_null()))
    )  # fmt: skip
    if reported is not None and not reported.is_empty():
        scales = held_scales(sq, reported, out.select("stock_id", "q", "shares", "_s0"))
        out = out.join(scales.with_columns(pl.col("stock_id").cast(out.schema["stock_id"]), pl.col("q").cast(out.schema["q"])),
                       on=["stock_id", "q"], how="left")  # fmt: skip
    else:
        out = out.with_columns(scale=pl.lit(None, pl.Float64))
    out = out.with_columns(shares=pl.coalesce("shares", pl.col("_s0") * pl.col("scale").fill_null(1.0)))
    ratio = pl.col("ticker").replace_strict(adr, default=1.0, return_dtype=pl.Float64)
    out = out.with_columns(cap=pl.coalesce(pl.col("close") * pl.col("shares"), pl.col("close") * pl.col("shares_out")) / ratio)
    out = out.filter(pl.col("cap").is_not_null() & (pl.col("cap") > 0))
    if scaled is not None:
        scaled.append(out.filter(pl.col("scale").is_not_null()).select("stock_id", pl.col("q").cast(pl.Int32), "scale", "cap"))
    if units is not None:
        units.append(out.select("stock_id", pl.col("q").cast(pl.Int32), (pl.coalesce("shares", "shares_out") / ratio).alias("units")))
    return out.select("stock_id", pl.col("q").cast(pl.Int32), "cap"), set(out.filter("fallback")["stock_id"].to_list())


def _drop_count_slips(s: pl.DataFrame, report: list | None) -> pl.DataFrame:
    """`s` (one row per stock and quarter, sorted) with the cap set to null where the implied share count moved
    MAX_SHARE_JUMP-fold or more against the quarter before; those rows go to `report`."""
    sh = (pl.col("cap") / pl.col("cap").shift(1).over("stock_id")) / (pl.col("close") / pl.col("close").shift(1).over("stock_id"))
    s = s.with_columns(_sh=sh)
    slip = (pl.col("_sh") >= MAX_SHARE_JUMP) | (pl.col("_sh") <= 1 / MAX_SHARE_JUMP)
    if report is not None:
        bad = s.filter(slip)
        if not bad.is_empty():
            report.append(bad.select("stock_id", "q", "cap", pl.col("_sh").alias("weight"), pl.lit("count jump").alias("why")))
    return s.with_columns(cap=pl.when(slip).then(None).otherwise(pl.col("cap"))).drop("_sh")


def _set_aside_outsized(r: pl.DataFrame, report: list | None) -> pl.DataFrame:
    """`r` without the stock-quarters whose start-of-quarter cap is over MAX_MARKET_WEIGHT of the quarter's total,
    in quarters with MIN_MARKET_STOCKS or more; repeated, as setting one aside raises the others' shares. The rows
    set aside (stock_id, q, cap, weight) go to `report`."""
    gone = []
    for _ in range(5):
        w = r.with_columns(
            _w=pl.col("cap_p") / pl.col("cap_p").sum().over("q"),
            _n=pl.len().over("q"),
        )
        big = (pl.col("_w") > MAX_MARKET_WEIGHT) & (pl.col("_n") >= MIN_MARKET_STOCKS)
        out = w.filter(big)
        if out.is_empty():
            break
        gone.append(out.select("stock_id", "q", pl.col("cap_p").alias("cap"), pl.col("_w").alias("weight"), pl.lit("outsized").alias("why")))
        r = w.filter(~big).drop("_w", "_n")
    if report is not None and gone:
        report.append(pl.concat(gone))
    return r.drop("_w", "_n", strict=False)


def index_returns(
    sq: pl.DataFrame, labels: dict[int, str], last_q: int, set_aside: list | None = None, movers: list | None = None
) -> pl.DataFrame:
    """One row per hierarchy label (every tier, and MARKET) and quarter with a return, up to `last_q`.

    `sq` has QUARTER_SCHEMA columns (cap = market cap at that quarter's end); `labels` maps stock_id to its
    vertical path. Stocks without a label are left out, and so are data slips: share-count jumps
    (`_drop_count_slips`), returns over MAX_RETURN and outsized caps (`_set_aside_outsized`). The rows set aside go
    to `set_aside` (stock_id, q, cap, weight, why) and, per quarter, the stocks that moved the market 3 points or more
    or weighed HEAVY_WEIGHT of it to `movers` (stock_id, q, weight, r, pts), when lists are given."""
    lab = pl.DataFrame({"stock_id": list(labels), "path": list(labels.values())}, schema={"stock_id": pl.Int32, "path": pl.String})
    s = sq.filter(pl.col("q") <= last_q).join(lab, on="stock_id").sort("stock_id", "q")
    s = _drop_count_slips(s, set_aside)
    prev = s.select("stock_id", (pl.col("q") + 1).alias("q"), pl.col("close").alias("close_p"), pl.col("cap").alias("cap_p"), pl.col("stale").alias("stale_p"))
    last = s.group_by("stock_id").agg(pl.col("q").max().alias("q_last"))
    r = (
        s.join(prev, on=["stock_id", "q"]).join(last, on="stock_id")
        .filter(pl.col("close").is_not_null() & (pl.col("close_p") > 0) & (pl.col("cap_p") > 0) & ~pl.col("stale_p")
                & (~pl.col("stale") | (pl.col("q") == pl.col("q_last"))))
        .with_columns(
            r=(pl.col("close") + pl.col("div")) / pl.col("close_p") - 1,
            a=pl.col("vwap").fill_null(pl.col("close")) / pl.col("close_p"),
            vertical=pl.col("path"),
            industry=pl.col("path").str.split(SEP).list.slice(0, 2).list.join(SEP),
            sector=pl.col("path").str.split(SEP).list.first(),
            market=pl.lit(MARKET),
        )
    )  # fmt: skip
    jump = pl.col("r") > MAX_RETURN
    if set_aside is not None:
        bad = r.filter(jump)
        if not bad.is_empty():
            set_aside.append(bad.select("stock_id", "q", pl.col("cap_p").alias("cap"), pl.col("r").alias("weight"), pl.lit("price jump").alias("why")))
    r = r.filter(~jump)
    r = _set_aside_outsized(r, set_aside)
    if movers is not None:
        m = r.with_columns(w=pl.col("cap_p") / pl.col("cap_p").sum().over("q")).with_columns(pts=pl.col("w") * pl.col("r"))
        movers.append(
            m.filter((pl.col("pts").abs() >= 0.03) | ((pl.col("w") >= HEAVY_WEIGHT) & (pl.len().over("q") >= MIN_MARKET_STOCKS)))
            .sort("q", "pts", descending=[False, True])
            .select("stock_id", "q", pl.col("w").alias("weight"), "r", "pts")
        )  # fmt: skip
    parts = []
    for tier, key in enumerate(("market", "sector", "industry", "vertical")):
        g = r.group_by(key, "q").agg(
            ((pl.col("cap_p") * pl.col("r")).sum() / pl.col("cap_p").sum()).alias("ret"),
            ((pl.col("cap_p") * pl.col("a")).sum() / pl.col("cap_p").sum()).alias("avg"),
            pl.len().cast(pl.Int32).alias("n"),
            pl.col("cap_p").sum().alias("cap"),
            (pl.col("cap_p").max() / pl.col("cap_p").sum()).alias("top_weight"),
        )
        parts.append(g.rename({key: "label"}).with_columns(tier=pl.lit(tier, pl.Int8)))
    out = pl.concat(parts).sort("label", "q")
    growth = (1 + pl.col("ret")).cum_prod().over("label")
    out = out.with_columns(level_end=growth).with_columns(
        level_avg=pl.col("level_end").shift(1, fill_value=1.0).over("label") * pl.col("avg")
    )
    return out.select(*OUT_SCHEMA.names()).cast(OUT_SCHEMA)


def cap_report(sq: pl.DataFrame, labels: dict[int, str], last_q: int, top: int = 15) -> dict[str, pl.DataFrame]:
    """What to look at when an index looks wrong (the sectors step logs it): `market`, the stocks with the biggest
    share of all labelled caps in any quarter; `sector`, stocks that are half or more of a sector of 10 or more stocks;
    `jumps`, caps that moved 5x or more in a quarter while the close moved under 2x (a share-count slip). Each has
    stock_id, q, cap and the figure that put it there."""
    lab = pl.DataFrame({"stock_id": list(labels), "path": list(labels.values())}, schema={"stock_id": pl.Int32, "path": pl.String})
    s = (
        sq.filter((pl.col("q") <= last_q) & pl.col("cap").is_not_null() & (pl.col("cap") > 0)).join(lab, on="stock_id")
        .with_columns(sector=pl.col("path").str.split(SEP).list.first())
    )  # fmt: skip
    s = s.with_columns(
        mkt_w=pl.col("cap") / pl.col("cap").sum().over("q"),
        sec_w=pl.col("cap") / pl.col("cap").sum().over("q", "sector"),
        sec_n=pl.len().over("q", "sector"),
    )
    best = lambda col: s.sort(col, descending=True).group_by("stock_id", maintain_order=True).first()  # noqa: E731
    market = best("mkt_w").head(top).select("stock_id", "q", "cap", "sector", pl.col("mkt_w").round(4).alias("weight"))
    sector = (
        best("sec_w").filter((pl.col("sec_w") >= 0.5) & (pl.col("sec_n") >= 10))
        .select("stock_id", "q", "cap", "sector", pl.col("sec_w").round(4).alias("weight")).head(top)
    )  # fmt: skip
    s = s.sort("stock_id", "q").with_columns(
        cap_x=pl.col("cap") / pl.col("cap").shift(1).over("stock_id"),
        px_x=pl.col("close") / pl.col("close").shift(1).over("stock_id"),
    )
    jump = ((pl.col("cap_x") >= 5) | (pl.col("cap_x") <= 0.2)) & (pl.col("px_x") < 2) & (pl.col("px_x") > 0.5)
    jumps = (
        s.filter(jump).sort("cap", descending=True).group_by("stock_id", maintain_order=True).first()
        .select("stock_id", "q", "cap", "sector", pl.col("cap_x").round(2).alias("weight")).head(top)
    )  # fmt: skip
    return {"market": market, "sector": sector, "jumps": jumps}
