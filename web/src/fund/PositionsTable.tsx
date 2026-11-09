import { Fragment, memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fMm, fP0, fPc1, fPx, fW0, qShort } from "./fmt";
import { useWidth } from "./hooks";
import { moreLabel, useRowBudget } from "./loading";
import { sortRows, type Mode, type PosRow, type SortKey } from "./positions";
import { StockPanel } from "./StockPanel";
import "./positions.css";

// The 13 columns, always in this order: key, heading, width in px. The widths add up to the table's
// minimum width (1064px); the table scrolls sideways inside its wrapper when the panel is narrower.
const COLS: { key: SortKey; head: string; w: number }[] = [
  { key: "t", head: "Stock", w: 124 },
  { key: "held", head: "Held", w: 78 },
  { key: "w", head: "Weight", w: 72 },
  { key: "ret", head: "Return", w: 62 },
  { key: "irr", head: "IRR", w: 62 },
  { key: "val", head: "Value", w: 80 },
  { key: "ac", head: "Avg cost", w: 62 },
  { key: "px", head: "Price", w: 62 },
  { key: "ax", head: "Avg exit", w: 62 },
  { key: "last", head: "Last change", w: 136 },
  { key: "re", head: "Realised", w: 84 },
  { key: "unreal", head: "Unrealised", w: 84 },
  { key: "total", head: "Total P&L", w: 96 },
];

const count = (n: number): string => n.toLocaleString("en-US");

const WORD = { new: "New", add: "Added", trim: "Trimmed", exit: "Sold all" } as const;
const TONE = { new: "add", add: "add", trim: "trim", exit: "sold" } as const;

function SortIcon({ desc }: { desc: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={desc ? "M4 6.25 8 10.25l4-4" : "M4 9.75l4-4 4 4"} />
    </svg>
  );
}

function LastChange({ r }: { r: PosRow }) {
  if (!r.tag) return <span className="lc-none">–</span>;
  return (
    <span className={"lc " + TONE[r.tag]}>
      <span className="lw">{WORD[r.tag]}</span>
      <b>{fPc1(r.dw)}</b>
    </span>
  );
}

function cells(r: PosRow, maxW: number): Record<SortKey, ReactNode> {
  return {
    t: (
      <div className="stk">
        <b>{r.ticker}</b>
        <span>{r.name}</span>
      </div>
    ),
    held: (
      <>
        <span className="hd">{qShort(r.from)}</span>
        {r.to != null && (
          <span className="hd hd2">
            <svg className="elb" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 1v7h7M7 5.7 9.6 8 7 10.3" />
            </svg>
            {qShort(r.to)}
          </span>
        )}
      </>
    ),
    w:
      r.open && r.val !== null ? (
        <span className="wcell">
          <span className="wn">{fW0(r.w)}</span>
          <i className="mb" style={{ width: Math.max(2, (r.w / maxW) * 100).toFixed(1) + "%" }} />
        </span>
      ) : (
        "–"
      ),
    ret: fP0(r.ret),
    irr: fP0(r.irr()),
    val: r.open ? fMm(r.val, false) : "–",
    ac: fPx(r.ac),
    px: fPx(r.px),
    ax: r.open ? "–" : fPx(r.ax),
    last: <LastChange r={r} />,
    re: fMm(r.re, true),
    unreal: r.unreal == null ? "–" : fMm(r.unreal, true),
    total: fMm(r.total, true),
  };
}

type Props = {
  fundId: number;
  /** Rows of the period; null before the first period has loaded. */
  rows: PosRow[] | null;
  /** The next period's prices are still loading: `rows` are the previous period's. */
  pending: boolean;
  /** Weekly price files that could not be loaded. */
  failed: number;
  /** Weekly files in, of those the period needs: the count in "Loading prices…". */
  progress?: { done: number; total: number };
  mode: Mode;
  /** Latest close per stock, for the price chart's last point. */
  latest: Map<number, number>;
};

type RowProps = {
  r: PosRow;
  maxW: number;
  isOpen: boolean;
  /** Width of the table's wrapper; only the opened row reads it (the others are given 0 so they stay as they are). */
  tw: number;
  fundId: number;
  latest: Map<number, number>;
  onToggle: (id: number) => void;
  onKey: (e: KeyboardEvent<HTMLTableRowElement>, id: number) => void;
};

/** One position, and under it the opened chart. Memoised: a chunk of new rows must not redraw the thousands before it. */
const Row = memo(function Row({ r, maxW, isOpen, tw, fundId, latest, onToggle, onKey }: RowProps) {
  const c = cells(r, maxW);
  return (
    <Fragment>
      <tr
        data-t={r.ticker}
        tabIndex={0}
        aria-expanded={isOpen}
        className={isOpen ? "is-sel" : undefined}
        onClick={() => onToggle(r.id)}
        onKeyDown={(e) => onKey(e, r.id)}
      >
        {COLS.map((col) => (
          <td key={col.key} className={col.key === "held" ? "held" : col.key === "last" ? "lastc" : undefined}>
            {c[col.key]}
          </td>
        ))}
      </tr>
      {isOpen && (
        <tr className="xrow">
          <td colSpan={COLS.length}>
            <div className="xpanel" style={{ width: tw - 2 }}>
              <StockPanel row={r} fundId={fundId} width={Math.max(200, tw - 40)} latestPrice={latest.get(r.id)} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
});

/**
 * The positions table: sortable columns, rows that open into a price chart and the trades behind
 * the position. Sorting always covers every row. Only the first INITIAL_ROWS of them are drawn at first (the
 * page lands fast with the biggest holdings); once the browser is idle more are added CHUNK at a time up to
 * AUTO_FILL_MAX, in the sorted order, and "Show more" adds the rest MORE_STEP at a time (see ./loading). A new
 * sort or period starts again from the first rows.
 */
export function PositionsTable({ fundId, rows, pending, failed, progress, mode, latest }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "w", dir: -1 });
  const [open, setOpen] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tw = useWidth(wrap, 300, 900);

  const all = useMemo(() => rows ?? [], [rows]);
  const sorted = useMemo(() => sortRows(all, sort.key, sort.dir), [all, sort]);
  const maxW = useMemo(() => Math.max(1, ...all.map((r) => r.w)), [all]);

  const { limit, filling, left, more } = useRowBudget(sorted.length, sorted);
  const shown = sorted.slice(0, limit);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "t" ? 1 : -1 }));
  const toggle = useCallback((id: number) => setOpen((o) => (o === id ? null : id)), []);

  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLTableRowElement>, id: number) => {
      if (e.target !== e.currentTarget) return; // keys inside the row's own controls are theirs
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(id);
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
    [toggle],
  );

  const prices = progress && progress.total > 0 ? ` ${count(progress.done)} of ${count(progress.total)}` : "";

  return (
    <>
      <div
        className={"twrap" + (pending ? " is-loading" : "")}
        ref={wrap}
        tabIndex={0}
        role="region"
        aria-label="Positions table, scrollable"
        aria-busy={pending}
      >
        {pending && rows && (
          <div className="t-load" role="status">
            <span>{"Loading prices…" + prices}</span>
          </div>
        )}
        <table className="t" aria-label="Positions">
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
                    className={c.key === "held" ? "held" : undefined}
                    aria-sort={on ? (sort.dir < 0 ? "descending" : "ascending") : "none"}
                  >
                    <button type="button" className="sort" onClick={() => onSort(c.key)}>
                      {c.key === "last" && mode !== "quarter" ? "Change" : c.head}
                      {on && <SortIcon desc={sort.dir < 0} />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={COLS.length} className="t-empty">
                  {"Loading prices…" + prices}
                </td>
              </tr>
            )}
            {rows !== null && shown.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="t-empty">
                  The fund held nothing in this period.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <Row
                key={r.id}
                r={r}
                maxW={maxW}
                isOpen={open === r.id}
                tw={open === r.id ? tw : 0}
                fundId={fundId}
                latest={latest}
                onToggle={toggle}
                onKey={onRowKey}
              />
            ))}
          </tbody>
        </table>
      </div>
      {filling > 0 && (
        <div className="t-more">
          <span>{`Loading ${count(filling)} more…`}</span>
        </div>
      )}
      {filling === 0 && left > 0 && (
        <div className="t-more">
          <button type="button" className="btn btn-secondary sm" onClick={more}>
            {moreLabel(left)}
          </button>
        </div>
      )}
      {failed > 0 && (
        <p className="t-note" role="status">
          Price history could not be loaded for some stocks; their earlier prices are the fund's own trade prices.
        </p>
      )}
    </>
  );
}
