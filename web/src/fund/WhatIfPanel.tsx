import { Fragment, memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Stock } from "../data/api";
import type { Exits, PositionRow, Summary } from "../data/types";
import { count, pct, pp, signClass } from "../lib/format";
import { fMm, fMoneySigned, fP0, fPc1, fPx, qShort } from "./fmt";
import { useWidth } from "./hooks";
import { moreLabel, useRowBudget } from "./loading";
import { StockPanel } from "./StockPanel";
import {
  buildSaleRows,
  sortSales,
  statusWord,
  tileFigures,
  TEXT_KEYS,
  type SaleKey,
  type SaleRow,
  type TileFigures,
} from "./whatif";
import "./whatif.css";

// "What if they'd kept it": every stock the fund sold or trimmed, with what it did afterwards and what
// holding on would have earned. It has the Positions table's look and behaviour (fixed 38px rows, sticky
// head and first column, every column always there, rows that open into the price chart and the trades,
// arrow keys between rows), without the period picker: the figures are as of the newest quarter.

// The 14 columns, always in this order: key, heading, width in px. The widths add up to the table's
// minimum width (1173px, which fits the page's 1190px column with room for a scrollbar); it scrolls sideways inside its wrapper when the panel is narrower.
const COLS: { key: SaleKey; head: string; w: number }[] = [
  { key: "t", head: "Stock", w: 116 },
  { key: "status", head: "Status", w: 82 },
  { key: "sh", head: "Shares sold", w: 92 },
  { key: "ac", head: "Avg cost", w: 62 },
  { key: "px", head: "Price", w: 56 },
  { key: "ax", head: "Avg exit", w: 60 },
  { key: "ret", head: "Return", w: 60 },
  { key: "irr", head: "IRR actual", w: 69 },
  { key: "irrHeld", head: "IRR if held", w: 70 },
  { key: "last", head: "Last change", w: 164 },
  { key: "since", head: "Since sale", w: 71 },
  { key: "one", head: "1y after", w: 56 },
  { key: "spy", head: "SPY 1y after", w: 81 },
  { key: "missed", head: "$ missed / dodged", w: 134 },
];

const LEFT: ReadonlySet<SaleKey> = new Set<SaleKey>(["t", "status"]);

const WORD = { new: "New", add: "Added", trim: "Trimmed", exit: "Sold all" } as const;
const TONE = { new: "add", add: "add", trim: "trim", exit: "sold" } as const;

const n0 = (v: number): string => Math.round(v).toLocaleString("en-US");

// ---- cells ------------------------------------------------------------------------------------

function SortIcon({ desc }: { desc: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={desc ? "M4 6.25 8 10.25l4-4" : "M4 9.75l4-4 4 4"} />
    </svg>
  );
}

/** The weight change in a box tinted by what was done, and its quarter beside it. */
function LastChange({ r }: { r: SaleRow }) {
  const l = r.last;
  if (!l) return <span className="lc-none">–</span>;
  const title = `${WORD[l.tag]} in ${qShort(l.q)}${l.dw === null ? "" : `: ${fPc1(l.dw)} of the fund's book${l.exact ? "" : " (estimated)"}`}`;
  return (
    <span className="lcw" title={title}>
      <span className={"lc " + TONE[l.tag]}>
        <span className="lw">{WORD[l.tag]}</span>
        <b>{fPc1(l.dw)}</b>
      </span>
      <span className="lq">{qShort(l.q)}</span>
    </span>
  );
}

/** Plus = missed = loss colour, minus = dodged = gain colour; a figure that prints as $0m, or an unknown one, has none. */
function MissedCell({ v }: { v: number | null }) {
  const text = fMm(v, true);
  const tone = v === null || text === "$0m" || text === "–" ? "" : v > 0 ? " loss" : " gain";
  return <span className={"mv" + tone}>{text}</span>;
}

function cells(r: SaleRow): Record<SaleKey, ReactNode> {
  return {
    t: (
      <div className="stk">
        <b>{r.ticker}</b>
        <span>{r.name}</span>
      </div>
    ),
    status: <span className={"st " + (r.status === "trimmed" ? "trim" : "sold")}>{statusWord(r.status)}</span>,
    sh: n0(r.soldShares),
    ac: fPx(r.ac),
    px: fPx(r.px),
    ax: fPx(r.ax),
    ret: fP0(r.ret),
    irr: fP0(r.irr()),
    irrHeld: fP0(r.irrHeld()),
    last: <LastChange r={r} />,
    since: fP0(r.since),
    one: fP0(r.oneY),
    spy: fP0(r.spyOneY),
    missed: <MissedCell v={r.missed} />,
  };
}

// ---- rows -------------------------------------------------------------------------------------

type RowProps = {
  r: SaleRow;
  fundId: number;
  open: boolean;
  /** Width of the table's wrapper: the opened row's panel is as wide, so it stays in view while the table scrolls. */
  tw: number;
  onToggle: (id: number) => void;
  onKey: (e: KeyboardEvent<HTMLTableRowElement>, id: number) => void;
};

// Memoised: appending the next chunk of rows must not render the ones already there again.
const Row = memo(function Row({ r, fundId, open, tw, onToggle, onKey }: RowProps) {
  const c = cells(r);
  return (
    <Fragment>
      <tr
        data-t={r.ticker}
        tabIndex={0}
        aria-expanded={open}
        className={open ? "is-sel" : undefined}
        onClick={() => onToggle(r.id)}
        onKeyDown={(e) => onKey(e, r.id)}
      >
        {COLS.map((col) => (
          <td key={col.key} className={col.key === "status" ? "l" : col.key === "last" ? "lastc" : undefined}>
            {c[col.key]}
          </td>
        ))}
      </tr>
      {open && (
        <tr className="xrow">
          <td colSpan={COLS.length}>
            <div className="xpanel" style={{ width: tw - 2 }}>
              <StockPanel row={r.base} fundId={fundId} width={Math.max(200, tw - 40)} latestPrice={r.px ?? undefined} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
});

// ---- tiles (R25) ------------------------------------------------------------------------------

type Tone = "" | "gain" | "loss";

function Tile({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div className="wi-tile">
      <div className="wi-l">{label}</div>
      <div className={"wi-v" + (tone ? " " + tone : "")}>{value}</div>
      {sub !== undefined && <div className="wi-n">{sub}</div>}
    </div>
  );
}

function Tiles({ f, summary }: { f: TileFigures; summary: Exits["summary"] }) {
  const { beat_spy_pct: beat, buys_12m: buys, sells_12m: sells } = summary;
  const both = buys !== null && sells !== null;
  const gap = both ? signClass(buys - sells) : "";
  // The sign is printed with the figure, as in the column: plus = gains missed, minus = drops avoided.
  return (
    <div className="wi-tiles" role="group" aria-label="What-if statistics">
      <Tile
        label="Sold too early"
        value={fMoneySigned(f.early)}
        sub="gains missed after selling"
        tone={f.early > 0 ? "loss" : ""}
      />
      <Tile
        label="Losses dodged"
        value={fMoneySigned(-f.dodged)}
        sub="drops avoided by selling"
        tone={f.dodged > 0 ? "gain" : ""}
      />
      <Tile
        label="Sold stocks that beat SPY next year"
        value={beat === null ? "–" : pct(beat, 0, false)}
        sub={beat !== null && f.measured > 0 ? `of ${count(f.measured, "sold stock")}` : undefined}
      />
      <Tile
        label="Buys vs sells, next 12 months"
        value={both ? `${pct(buys, 0)} vs ${pct(sells, 0)}` : "–"}
        sub={both ? `${sells < buys ? "Sells were smart" : "Sells were costly"}: ${pp((buys - sells) * 100)} gap` : undefined}
        tone={gap === "up" ? "gain" : gap === "down" ? "loss" : ""}
      />
    </div>
  );
}

// ---- the panel --------------------------------------------------------------------------------

export type WhatIfPanelProps = {
  fundId: number;
  /** positions.json, trades parsed. */
  positions: PositionRow[];
  exits: Exits;
  /** Latest close of every stock that has one. */
  prices: Map<number, number>;
  stocks: Map<number, Stock>;
  /** Date of those prices (latest_prices.json `asof`): "now" for every IRR. */
  asof: string;
  summary: Summary;
};

/**
 * Every sale of the fund, most missed first: the Positions table's figures for the stock, and how the
 * stock did since the fund sold it. Sorting covers every row. Only the first INITIAL_ROWS are drawn at once;
 * more follow in idle time up to AUTO_FILL_MAX and "Show more" adds the rest (see ./loading).
 */
export function WhatIfPanel(props: WhatIfPanelProps) {
  // A new fund starts again from the top.
  return <Panel key={props.fundId} {...props} />;
}

function Panel({ fundId, positions, exits, prices, stocks, asof, summary }: WhatIfPanelProps) {
  const [sort, setSort] = useState<{ key: SaleKey; dir: 1 | -1 }>({ key: "missed", dir: -1 });
  const [open, setOpen] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tw = useWidth(wrap, 300, 900);

  const rows = useMemo(
    () =>
      buildSaleRows({
        positions,
        exits,
        summary: { period_q: summary.period_q, tracked_since_q: summary.tracked_since_q },
        prices,
        stocks,
        asof,
      }),
    [positions, exits, summary.period_q, summary.tracked_since_q, prices, stocks, asof],
  );
  const sorted = useMemo(() => sortSales(rows, sort.key, sort.dir), [rows, sort]);
  const figures = useMemo(() => tileFigures(rows), [rows]);
  const { limit, filling, left, more } = useRowBudget(sorted.length, sorted);
  const shown = sorted.length > limit ? sorted.slice(0, limit) : sorted;

  const onSort = (key: SaleKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: TEXT_KEYS.has(key) ? 1 : -1 }));
  const onToggle = useCallback((id: number) => setOpen((o) => (o === id ? null : id)), []);

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLTableRowElement>, id: number) => {
      if (e.target !== e.currentTarget) return; // keys inside the row's own controls are theirs
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle(id);
        return;
      }
      const dir = e.key === "ArrowDown" ? "nextElementSibling" : e.key === "ArrowUp" ? "previousElementSibling" : null;
      if (!dir) return;
      let n = e.currentTarget[dir];
      while (n && !n.hasAttribute("data-t")) n = n[dir];
      if (n instanceof HTMLElement) {
        e.preventDefault();
        n.focus();
      }
    },
    [onToggle],
  );

  return (
    <section className="panel" id="whatIfPanel" aria-labelledby="whatIfTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="whatIfTitle">
            What if they'd kept it
          </h3>
          <p className="ps">For every stock they sold or trimmed: what it did afterwards, and what holding on would have earned.</p>
        </div>
      </div>
      <Tiles f={figures} summary={exits.summary} />
      <div className="wi-wrap" ref={wrap} tabIndex={0} role="region" aria-label="Sold or trimmed stocks, scrollable" aria-busy={filling > 0}>
        <table className="wi" aria-label="Sold or trimmed stocks">
          <colgroup>
            {COLS.map((c) => (
              <col key={c.key} style={{ width: c.w + "px" }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={LEFT.has(c.key) ? "l" : undefined}
                    aria-sort={on ? (sort.dir < 0 ? "descending" : "ascending") : "none"}
                  >
                    <button type="button" className="sort" onClick={() => onSort(c.key)}>
                      {c.head}
                      {on && <SortIcon desc={sort.dir < 0} />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="t-empty">
                  They have not sold or trimmed anything yet.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <Row key={r.id} r={r} fundId={fundId} open={open === r.id} tw={open === r.id ? tw : 0} onToggle={onToggle} onKey={onKey} />
            ))}
          </tbody>
        </table>
      </div>
      {filling > 0 && <p className="wi-more">{`Loading ${n0(filling)} more…`}</p>}
      {filling === 0 && left > 0 && (
        <div className="wi-more t-more">
          <button type="button" className="btn btn-secondary sm" onClick={more}>
            {moreLabel(left)}
          </button>
        </div>
      )}
      <p className="pf wi-foot">
        IRR uses mid-quarter trade dates and today's price for anything still held; "IRR if held" assumes no share was ever sold.
        "1y after" compares the stock with SPY over the 12 months after the sale. "$ missed / dodged": plus means the shares sold
        would be worth more now than they sold for (missed), minus means less (dodged). Last change is how far the stock's weight in
        the fund's book moved in the quarter of its last trade; before the newest quarter it is estimated from the fund's own trade
        prices. All figures are 13F estimates.
      </p>
    </section>
  );
}
