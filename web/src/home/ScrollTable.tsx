// The home page's tables, drawn as the ranked return chart is (home/FamousChart.tsx; owner, 2026-11-28: switching
// Chart | Table must look seamless, and Conviction moves and Best & worst calls take the same look). The chart's
// grid (photo 32px, 14px gap, 252px name column), its 42px header strip with one hairline, its 46px rows with no
// lines and its hover band; and its window: 20 rows in view (phone 10, 48px rows) that scroll with the chart's
// eased glide, its fades and its scrollbar, the header staying put above them, and its foot (the caption that
// follows the rows, page buttons on the right). Every heading sorts; on a phone a row folds into its main cell
// and one figure, and the sort is a menu in the header strip.
//
// Still one <table>: the header and the body are blocks so only the body scrolls (the scrollbar runs beside the
// rows, as the chart's does), each row laying its cells out on the same fixed widths. The roles are written out,
// as a browser can drop a table's semantics once its parts are not table boxes.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import type { SortState } from "../components/DataTable";
import { Pager } from "../components/Pager";
import { State } from "../components/State";
import { useSortedRows, type Col } from "../lib/sort";
import { captionText } from "./famousChart";
import { DESKTOP, PHONE, SETTLE_MS, useSettled } from "./FamousChart";
import { useEasedScroll } from "./useEasedScroll";
import "./rankTable.css";

/** A column: `cls` places and sizes it (rankTable.css); `top` sits over its heading (the S&P 500 figure); `ph`
 * keeps it on a phone, as the row's main cell or its one figure on the right (the rest are folded away). */
export type TCol<R> = Col<R> & { cls: string; top?: ReactNode; ph?: "main" | "end" };

/** An order in a phone's sort menu. */
export type SortOption = { label: string; sort: SortState };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sortId = (s: SortState) => `${s.key}:${s.dir}`;

function SortIcon({ desc }: { desc: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={desc ? "M4 6.25 8 10.25l4-4" : "M4 9.75l4-4 4 4"} />
    </svg>
  );
}

export function ScrollTable<R>({
  rows,
  columns,
  initial,
  label,
  noun,
  rowKey,
  href,
  phone,
  sorts,
  phoneHead = "Fund",
  pageSize,
  page: pageIn,
  onPage,
  start = 0,
  onView,
  empty = "Nothing to show.",
  className,
}: {
  rows: R[];
  columns: TCol<R>[];
  initial: SortState;
  /** The table's accessible name. */
  label: string;
  /** What a row is: singular, plural ("fund", "funds"). */
  noun: readonly [string, string];
  rowKey: (r: R) => string | number;
  /** Where a click on the row goes (its links keep their own). */
  href: (r: R) => string;
  phone: boolean;
  /** A phone's sort menu; without it a phone's header strip shows only `phoneHead`. */
  sorts?: SortOption[];
  /** The phone's header strip, over the main cell. */
  phoneHead?: string;
  /** Rows a page; the rest come with the page buttons in the foot. Unset: one page. */
  pageSize?: number;
  /** The page shown, when the caller keeps it (Top funds: the chart and its table share it). A new order calls
   * `onPage(0)`. */
  page?: number;
  onPage?: (page: number) => void;
  /** The row to open at, in the opening order (where the chart was). */
  start?: number;
  /** Told the row at the top of the window whenever it changes, and the order it is in. */
  onView?: (top: number, sort: SortState) => void;
  empty?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const { sorted, sort, onSort, setSort } = useSortedRows(rows, columns, initial);
  const [ownPage, setOwnPage] = useState(0);
  const page = pageIn ?? ownPage;
  const setPage = onPage ?? setOwnPage;
  // new rows start again at the first page (a caller keeping the page does this itself)
  const [pageFor, setPageFor] = useState(rows);
  if (pageFor !== rows) {
    setPageFor(rows);
    if (pageIn === undefined) setOwnPage(0);
  }
  const reorder = (to: () => void) => {
    to();
    setPage(0);
  };

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const pg = Math.min(page, pages - 1);
  const offset = pageSize ? pg * pageSize : 0;
  const shown = useMemo(
    () => (pageSize ? sorted.slice(offset, offset + pageSize) : sorted),
    [sorted, pageSize, offset],
  );

  const M = phone ? PHONE : DESKTOP;
  const n = shown.length;
  const scrolls = n > M.vis;
  const body = useRef<HTMLTableSectionElement>(null);
  const fades = useRef<[HTMLSpanElement | null, HTMLSpanElement | null]>([null, null]);

  // The body's scrollbar takes width from its rows (not where scrollbars overlay): the header row gives up as
  // much on its right, so the columns line up (the chart's axis does the same).
  const [bar, setBar] = useState(0);
  useLayoutEffect(() => {
    const el = body.current;
    setBar(el && scrolls ? Math.max(0, el.offsetWidth - el.clientWidth) : 0);
  }, [scrolls, phone, n]);

  // Position in rows from the top; React keeps only the whole row at the top of the window.
  const pos = useRef(start);
  const [view, setView] = useState(start);
  const live = useRef({ n, vis: M.vis, scrolls });
  live.current = { n, vis: M.vis, scrolls };
  const onPos = useCallback((p: number) => {
    pos.current = p;
    const { n, vis, scrolls } = live.current;
    const pc = scrolls ? clamp(p, 0, n - vis) : 0;
    fades.current[0]?.classList.toggle("on", scrolls && pc > 0.01);
    fades.current[1]?.classList.toggle("on", scrolls && pc < n - vis - 0.01);
    setView(Math.round(pc));
  }, []);
  const es = useEasedScroll(body, M.row, onPos, "rows");

  // A new order or page starts at the top, with nothing gliding.
  const shownFor = useRef(shown);
  useLayoutEffect(() => {
    if (shownFor.current === shown) return;
    shownFor.current = shown;
    es.stop();
    pos.current = 0;
    if (body.current) body.current.scrollTop = 0;
    onPos(0);
  }, [shown, es, onPos]);
  // The window shows the whole row it is at: on opening at `start`, and when the row height changes.
  useLayoutEffect(() => {
    const el = body.current;
    const top = scrolls ? Math.round(clamp(pos.current, 0, n - M.vis)) : 0;
    if (el && el.scrollTop !== top * M.row) el.scrollTop = top * M.row;
    onPos(top);
  }, [M.row, M.vis, scrolls, n, onPos]);

  const top = scrolls ? clamp(view, 0, n - M.vis) : 0;
  const told = useRef(onView);
  told.current = onView;
  useEffect(() => {
    told.current?.(top, sort);
  }, [top, sort]);

  const first = top + 1;
  const last = Math.min(n, top + M.vis);
  // places in the whole list when it has more than a page, as the chart's caption does
  const total = pageSize && sorted.length > pageSize ? sorted.length : undefined;
  const caption = captionText(offset + first, offset + last, n, scrolls, total, noun, false);
  const said = useSettled(caption, SETTLE_MS);

  if (rows.length === 0)
    return (
      <div className="pb">
        <State>{empty}</State>
      </div>
    );
  // a click anywhere on a row opens it (its links keep their own, for the keyboard and a new tab)
  const open = (r: R) => (e: MouseEvent) => {
    if (!(e.target instanceof Element && e.target.closest("a, button, select"))) navigate(href(r));
  };
  const cellCls = (c: TCol<R>) => c.cls + (c.ph ? " ph-" + c.ph : "");

  return (
    <div className={"rk" + (phone ? " phone" : "") + (scrolls ? " scrolls" : "") + (className ? " " + className : "")}>
      {phone && (
        // the phone's header strip: where the chart has its axis, the main column's name and the sort menu
        <div className="rk-head">
          <span>{phoneHead}</span>
          {sorts && (
            <select
              aria-label="Sort by"
              value={sortId(sort)}
              onChange={(e) => {
                const o = sorts.find((x) => sortId(x.sort) === e.target.value);
                if (o) reorder(() => setSort(o.sort));
              }}
            >
              {!sorts.some((o) => sortId(o.sort) === sortId(sort)) && <option value={sortId(sort)}>—</option>}
              {sorts.map((o) => (
                <option key={sortId(o.sort)} value={sortId(o.sort)}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="rk-wrap">
        <span className="fade t" aria-hidden="true" ref={(e) => void (fades.current[0] = e)} />
        <table aria-label={label}>
          <thead role="rowgroup" style={bar ? { paddingRight: bar } : undefined}>
            <tr role="row">
              {columns.map((c) => {
                const dir = sort.key === c.key ? sort.dir : 0;
                const alt = c.alt?.[sort.key];
                const on = dir !== 0 || alt !== undefined;
                return (
                  <th
                    key={c.key}
                    role="columnheader"
                    scope="col"
                    className={cellCls(c)}
                    aria-sort={!on ? undefined : (dir || -1) > 0 ? "ascending" : "descending"}
                  >
                    {c.top}
                    <button type="button" className="sort" onClick={() => reorder(() => onSort(c.key))}>
                      {c.header}
                      {dir !== 0 && <SortIcon desc={dir < 0} />}
                      {alt && (
                        <>
                          {" "}
                          <span className="alt">{alt}</span>
                        </>
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody
            ref={body}
            role="rowgroup"
            className="rk-body"
            style={scrolls ? { height: M.vis * M.row } : undefined}
          >
            {shown.map((r) => (
              <tr key={rowKey(r)} role="row" onClick={open(r)}>
                {columns.map((c) => (
                  <td key={c.key} role="cell" className={cellCls(c)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <span className="fade b" aria-hidden="true" ref={(e) => void (fades.current[1] = e)} />
      </div>
      {/* the chart's foot: the caption follows the rows; a screen reader hears it once the window has settled */}
      <div className="fc-foot rk-foot">
        <p className="fc-cap" aria-hidden="true">
          {caption}
        </p>
        {pageSize && sorted.length > pageSize && (
          <Pager page={pg} pageSize={pageSize} total={sorted.length} onPage={setPage} noun={noun[1]} />
        )}
      </div>
      <p className="vh" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
