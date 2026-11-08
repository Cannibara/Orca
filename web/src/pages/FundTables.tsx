// The bottom of the Fund page: "What if they'd kept it" (the positions table itself is src/fund/PositionsPanel).
// Every figure that depends on the latest price (return, IRR, since sale, $ missed / dodged) is computed
// here from the price map; a stock without a price shows "—".
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import { Section } from "../components/Section";
import { Signed } from "../components/Signed";
import { StockLabel } from "../components/StockLabel";
import { Tile, Tiles } from "../components/Tiles";
import { toRows, yearsSince2013, type Stock } from "../data/api";
import type { Exits, ExitsRows, PositionRow } from "../data/types";
import { DASH, count, money, pct, pp, px, qLabel, shareCount, signClass } from "../lib/format";
import { heldFlows, irr, missed, positionFlows, returnPct, sinceSale, totalPnl, unrealised } from "../lib/live";
import { useSortedRows, type Col } from "../lib/sort";

// ---- shared table machinery -----------------------------------------------------

/** Above this many rows a table renders only the rows in view. */
const VIRTUAL_ABOVE = 500;

/** Runs `f` the first time it is asked and keeps the answer: an IRR is dear and most rows are never looked at. */
function once<T>(f: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = f();
      done = true;
    }
    return value;
  };
}

// ---- cells ------------------------------------------------------------------------

const stockCell = (stock: Stock | undefined, stockId: number) => (
  <span className="tick">
    <StockLabel stock={stock} stockId={stockId} />
  </span>
);

const pctCell = (v: number | null) => <Signed v={v}>{pct(v, 0)}</Signed>;
const moneyCell = (v: number | null) => <Signed v={v}>{money(v, true)}</Signed>;

/** "New", "Sold all", or the change in shares: +35%, −32%. */
function lastChangeText(p: PositionRow): string {
  if (p.last_type === "new") return "New";
  if (p.last_type === "exit") return "Sold all";
  return pct(p.last_pct, 0);
}

/** Sorts a new position above every add and a sale of everything below every trim. */
function lastChangeKey(p: PositionRow): number {
  if (p.last_pct !== null) return p.last_pct;
  return p.last_type === "new" ? 1e9 : -1e9;
}

const lastChangeCell = (p: PositionRow | undefined) =>
  p === undefined ? (
    DASH
  ) : (
    <span className="two-line">
      <Signed v={p.last_usd}>{lastChangeText(p)}</Signed> <span className="cap">{qLabel(p.last_q)}</span>
    </span>
  );

// ---- positions ----------------------------------------------------------------------

/** A position with the figures that need the latest price worked out. */
type PosRow = {
  p: PositionRow;
  stock: Stock | undefined;
  ticker: string;
  price: number | undefined;
  /** Shares held now at the latest price less their cost; null once sold out, or when held but unpriced. */
  unreal: number | null;
  total: number | null;
  ret: number | null;
  irr: () => number | null;
};

function posRow(p: PositionRow, stock: Stock | undefined, price: number | undefined, nowT: number): PosRow {
  return {
    p,
    stock,
    ticker: stock?.ticker ?? `#${p.stock_id}`,
    price,
    unreal: p.shares_now > 0 ? unrealised(p.shares_now, p.cost_now, price) : null,
    total: totalPnl(p, price),
    ret: returnPct(p, price),
    irr: once(() => irr(positionFlows(p.trades, p.shares_now, price, nowT))),
  };
}

// ---- what if they'd kept it ------------------------------------------------------------

type ExitIn = { [K in keyof ExitsRows]: ExitsRows[K][number] };

/** A sale (a position with at least one) joined to its position (R20) and the latest price. */
type SaleRow = {
  e: ExitIn;
  stock: Stock | undefined;
  ticker: string;
  /** The same stock's row in positions.json: avg cost, return, IRR, last change. Undefined if the file has none. */
  pos: PosRow | undefined;
  price: number | undefined;
  since: number | null;
  /** Sold shares at today's price less what they sold for: plus = sold too early, minus = loss dodged. */
  missed: number | null;
  irrHeld: () => number | null;
};

function saleRows(
  exits: Exits,
  posRows: PosRow[],
  stocks: Map<number, Stock>,
  prices: Map<number, number>,
  nowT: number,
): SaleRow[] {
  const byStock = new Map(posRows.map((r) => [r.p.stock_id, r]));
  return toRows<ExitIn>(exits.rows).map((e) => {
    const stock = stocks.get(e.stock_id);
    const pos = byStock.get(e.stock_id);
    const price = prices.get(e.stock_id);
    return {
      e,
      stock,
      ticker: stock?.ticker ?? `#${e.stock_id}`,
      pos,
      price,
      since: sinceSale(e.avg_exit, price),
      missed: missed(e.sold_shares, e.sold_usd, price),
      irrHeld: once(() => (pos ? irr(heldFlows(pos.p.trades, price, nowT)) : null)),
    };
  });
}

const STATUS_LABEL = { trimmed: "Trimmed", sold_all: "Sold all" } as const;

const SALE_COLUMNS: Col<SaleRow>[] = [
  { header: "Stock", key: "stock", align: "l", by: (r) => r.ticker, cell: (r) => stockCell(r.stock, r.e.stock_id) },
  {
    header: "Status",
    key: "status",
    align: "l",
    by: (r) => STATUS_LABEL[r.e.status],
    cell: (r) => <span className="pill">{STATUS_LABEL[r.e.status]}</span>,
  },
  { header: "Shares sold", key: "sold_shares", by: (r) => r.e.sold_shares, cell: (r) => shareCount(r.e.sold_shares) },
  { header: "Avg cost", key: "avg_cost", by: (r) => r.pos?.p.avg_cost ?? null, cell: (r) => px(r.pos?.p.avg_cost ?? null) },
  { header: "Current price", key: "price", by: (r) => r.price ?? null, cell: (r) => px(r.price ?? null) },
  { header: "Avg exit", key: "avg_exit", by: (r) => r.e.avg_exit, cell: (r) => px(r.e.avg_exit) },
  { header: "Return", key: "return", by: (r) => r.pos?.ret ?? null, cell: (r) => pctCell(r.pos?.ret ?? null) },
  {
    header: "IRR actual",
    key: "irr_actual",
    by: (r) => r.pos?.irr() ?? null,
    cell: (r) => pctCell(r.pos?.irr() ?? null),
  },
  { header: "IRR if held", key: "irr_held", by: (r) => r.irrHeld(), cell: (r) => pctCell(r.irrHeld()) },
  {
    header: "Last change",
    key: "last_change",
    by: (r) => (r.pos ? lastChangeKey(r.pos.p) : null),
    cell: (r) => lastChangeCell(r.pos?.p),
  },
  {
    header: "Last change $",
    key: "last_usd",
    by: (r) => r.pos?.p.last_usd ?? null,
    cell: (r) => moneyCell(r.pos?.p.last_usd ?? null),
  },
  { header: "Since sale", key: "since", by: (r) => r.since, cell: (r) => pctCell(r.since) },
  { header: "1y after", key: "one_y", by: (r) => r.e.one_y, cell: (r) => pctCell(r.e.one_y) },
  { header: "SPY 1y after", key: "spy_one_y", by: (r) => r.e.spy_one_y, cell: (r) => pct(r.e.spy_one_y, 0) },
  {
    header: "$ missed / dodged",
    key: "missed",
    by: (r) => r.missed,
    // Plus = missed, which is bad news for the fund: red. Minus = dodged: green.
    cell: (r) => <Signed v={r.missed === null ? null : -r.missed}>{money(r.missed, true)}</Signed>,
  },
];

/** R25. */
function SaleTiles({ rows, summary }: { rows: SaleRow[]; summary: Exits["summary"] }) {
  const { early, dodged, measured } = useMemo(() => {
    let early = 0;
    let dodged = 0;
    let measured = 0;
    for (const r of rows) {
      if (r.missed !== null) {
        if (r.missed > 0) early += r.missed;
        else dodged -= r.missed;
      }
      if (r.e.one_y !== null && r.e.spy_one_y !== null) measured++;
    }
    return { early, dodged, measured };
  }, [rows]);

  const { beat_spy_pct: beat, buys_12m: buys, sells_12m: sells } = summary;
  const both = buys !== null && sells !== null;
  return (
    <Tiles label="What-if statistics">
      <Tile label="Sold too early" value={money(early)} sub="gains missed after selling" tone={early > 0 ? "down" : ""} />
      <Tile label="Losses dodged" value={money(dodged)} sub="drops avoided by selling" tone={dodged > 0 ? "up" : ""} />
      <Tile
        label="Sold stocks that beat SPY next year"
        value={pct(beat, 0, false)}
        sub={beat !== null && measured > 0 ? `of ${count(measured, "sold stock")}` : undefined}
      />
      <Tile
        label="Buys vs sells, next 12 months"
        value={both ? `${pct(buys, 0)} vs ${pct(sells, 0)}` : DASH}
        sub={both ? `${sells < buys ? "Sells were smart" : "Sells were costly"}: ${pp((buys - sells) * 100)} gap` : undefined}
        tone={both ? signClass(buys - sells) : ""}
      />
    </Tiles>
  );
}

function SalesSection({
  rows,
  summary,
  onOpen,
}: {
  rows: SaleRow[];
  summary: Exits["summary"];
  onOpen: (stockId: number) => void;
}) {
  const { sorted, sort, onSort } = useSortedRows(rows, SALE_COLUMNS, { key: "missed", dir: -1 });
  return (
    <Section
      id="fund-what-if"
      title="What if they'd kept it"
      intro={<p>For every stock they sold or trimmed: what it did afterwards, and what holding on would have earned.</p>}
    >
      <SaleTiles rows={rows} summary={summary} />
      <DataTable
        label="Sold or trimmed stocks"
        columns={SALE_COLUMNS}
        rows={sorted}
        sort={sort}
        onSort={onSort}
        onRow={(r) => onOpen(r.e.stock_id)}
        virtual={sorted.length > VIRTUAL_ABOVE}
        rowKey={(r) => r.e.stock_id}
        empty="They have not sold or trimmed anything yet."
      />
      <p className="cap">
        IRR uses mid-quarter trade dates and today's price for anything still held; "IRR if held" assumes no share was ever
        sold. "1y after" compares the stock with SPY over the 12 months after the sale. "$ missed / dodged": plus means the
        shares sold would be worth more now than they sold for (missed), minus means less (dodged). All figures are 13F
        estimates.
      </p>
    </Section>
  );
}

// ---- both ---------------------------------------------------------------------------------

type Props = {
  fundId: number;
  /** positions.json, trades parsed. */
  positions: PositionRow[];
  exits: Exits;
  /** Latest close of every stock that has one. */
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  /** Date of those prices (latest_prices.json `asof`): "now" for every IRR. */
  asof: string;
};

export function WhatIf({ fundId, positions, exits, prices, stocks, asof }: Props) {
  const navigate = useNavigate();
  const nowT = yearsSince2013(asof);
  const posRows = useMemo(
    () => positions.map((p) => posRow(p, stocks.get(p.stock_id), prices.get(p.stock_id), nowT)),
    [positions, stocks, prices, nowT],
  );
  const sales = useMemo(() => saleRows(exits, posRows, stocks, prices, nowT), [exits, posRows, stocks, prices, nowT]);
  return <SalesSection rows={sales} summary={exits.summary} onOpen={(stockId) => navigate(`/fund/${fundId}/stock/${stockId}`)} />;
}
