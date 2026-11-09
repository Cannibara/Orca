import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fMm, fP0, fPc1, fPx, fW0, qShort } from "./fmt";
import { useWidth } from "./hooks";
import { whenIdle } from "./prefetch";
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

/**
 * Rows drawn at first: a fund can have thousands of positions. The rest follow once the page is idle,
 * CHUNK rows at a time (the "Show more" button asks for PAGE at once before that).
 */
const PAGE = 150;
const CHUNK = 150;
/** A chunk that takes longer than this to draw halves the next one (a slow device); one under FAST lets it grow back. */
const SLOW_MS = 40;
const FAST_MS = 15;
const MIN_CHUNK = 30;

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
 * the position. Sorting always covers every row. Only the first PAGE of them are drawn at first (the
 * page lands fast); once the browser is idle the rest are added CHUNK at a time, in the sorted order, and a
 * new sort or period starts again from the first chunk. Until then "Show more" can ask for more at once.
 */
export function PositionsTable({ fundId, rows, pending, failed, progress, mode, latest }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "w", dir: -1 });
  const [open, setOpen] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const tw = useWidth(wrap, 300, 900);

  const all = useMemo(() => rows ?? [], [rows]);
  const sorted = useMemo(() => sortRows(all, sort.key, sort.dir), [all, sort]);
  const maxW = useMemo(() => Math.max(1, ...all.map((r) => r.w)), [all]);

  // How many rows are drawn. The count belongs to one ordering: a new sort or period (a new `sorted`)
  // falls back to the first page without a render in between.
  const total = sorted.length;
  const [grow, setGrow] = useState<{ of: PosRow[]; n: number }>({ of: sorted, n: PAGE });
  const limit = Math.min(total, grow.of === sorted ? grow.n : PAGE);
  const shown = sorted.slice(0, limit);
  const more = useCallback(
    (by: number) => setGrow((g) => ({ of: sorted, n: Math.min(sorted.length, (g.of === sorted ? g.n : PAGE) + by) })),
    [sorted],
  );
  // Set when the background fill has begun, and kept: later sorts show the quiet line at once, not the button.
  const [filling, setFilling] = useState(false);
  // How big the next background chunk is: CHUNK, less on a device that drew the last one slowly.
  const pace = useRef({ size: CHUNK, from: 0, rows: 0 });
  useEffect(() => {
    if (limit >= total) return;
    return whenIdle(
      () => {
        setFilling(true);
        pace.current.from = performance.now();
        pace.current.rows = pace.current.size;
        more(pace.current.size);
      },
      { timeout: 1000 },
    );
  }, [limit, total, more]);
  useLayoutEffect(() => {
    const p = pace.current;
    if (p.from === 0) return;
    const ms = performance.now() - p.from; // React's render and commit of the chunk
    p.from = 0;
    p.size = ms > SLOW_MS ? Math.max(MIN_CHUNK, Math.floor(p.rows / 2)) : ms < FAST_MS ? Math.min(CHUNK, p.rows * 2) : p.rows;
  }, [limit]);

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
      {total > shown.length &&
        (filling ? (
          <div className="t-more">
            <span>{`Loading ${count(total - shown.length)} more…`}</span>
          </div>
        ) : (
          <div className="t-more">
            <button type="button" className="btn btn-secondary sm" onClick={() => more(PAGE)}>
              {`Show ${count(Math.min(PAGE, total - shown.length))} more`}
            </button>
            <span>{`${count(shown.length)} of ${count(total)} positions shown`}</span>
          </div>
        ))}
      {failed > 0 && (
        <p className="t-note" role="status">
          Price history could not be loaded for some stocks; their earlier prices are the fund's own trade prices.
        </p>
      )}
    </>
  );
}
