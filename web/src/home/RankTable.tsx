import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { DataTable, type SortState } from "../components/DataTable";
import { Pager } from "../components/Pager";
import { State } from "../components/State";
import type { TopRow } from "../data/types";
import { count, pct, qLabel, ratio } from "../lib/format";
import { shortNameOf } from "../lib/famousNames";
import { useSortedRows, type Col } from "../lib/sort";
import { Photo, useDark } from "./FamousChart";
import { aumLabel, retLabel, shadeFor } from "./famousChart";
import "./rankTable.css";

// The Table view of the ranked lists (Famous funds, Top funds), drawn like their chart (owner, 2026-11-23): the
// chart's photo or initials, short names and fonts, no grid lines, and the return as a small bar in the chart's
// shades with the S&P 500 marked, to one decimal. Every column still sorts and the list still pages. On a phone
// each fund is one block (name; return bar; AUM, positions, drawdown and Sharpe in a line) with a Sort by menu,
// so nothing hides off to the side.

export const BEST_RETURN: SortState = { key: "ret", dir: -1 };
/** Famous lists open with the most popular fund first. */
export const MOST_POPULAR: SortState = { key: "pop", dir: -1 };

/** The return bar's scale: zero, every fund's return and the S&P 500 in view, in fractions. */
type Dom = { lo: number; hi: number };

function domainOf(rows: TopRow[], spx: number | null): Dom {
  let lo = 0;
  let hi = spx != null && spx > 0 ? spx : 0;
  for (const r of rows) {
    lo = Math.min(lo, r.ann_return);
    hi = Math.max(hi, r.ann_return);
  }
  return hi - lo > 0 ? { lo, hi } : { lo: 0, hi: 1 };
}

const at = (x: number, d: Dom) => `${(((x - d.lo) / (d.hi - d.lo)) * 100).toFixed(3)}%`;

/** The fund as the chart shows it: photo (or initials), short name (the filer's name on hover), the person. */
function RankFund({ r }: { r: TopRow }) {
  const short = shortNameOf(r.fund_id, r.name);
  const sub = [r.manager, r.until_q != null && `filed until ${qLabel(r.until_q)}`].filter(Boolean).join(" · ");
  return (
    <div className="rk-fund">
      <Photo manager={r.manager} who={r.manager ?? short} />
      <div className="stk">
        <Link className="nm" to={`/fund/${r.fund_id}`} title={r.name}>
          {short}
        </Link>
        {sub && <span className="sub">{sub}</span>}
      </div>
    </div>
  );
}

/** The return: a bar from zero in the chart's shade, a mark at the S&P 500, the figure to one decimal. */
function RetCell({ ret, spx, dom, dark }: { ret: number; spx: number | null; dom: Dom; dark: boolean }) {
  const a = Math.min(0, ret);
  const b = Math.max(0, ret);
  return (
    <span className="rk-ret">
      <span className="rk-bar" aria-hidden="true">
        <i
          className={ret < 0 ? "loss" : "gain"}
          style={{ left: at(a, dom), right: `calc(100% - ${at(b, dom)})`, background: shadeFor(ret, dark) }}
        />
        <b className="rk-zero" style={{ left: at(0, dom) }} />
        {spx != null && <b className="rk-spx" style={{ left: at(spx, dom) }} />}
      </span>
      <span className="rk-v">{retLabel(ret)}</span>
    </span>
  );
}

/** The columns: Fund, AUM, Positions, Return / yr, Max drawdown, Sharpe. `rank` adds Famous funds' popularity order. */
function rankColumns(dom: Dom, spx: number | null, dark: boolean, rank?: Map<number, number>): Col<TopRow>[] {
  const fund: Col<TopRow> = {
    header: "Fund",
    key: "name",
    align: "l",
    width: "34%",
    by: (r) => shortNameOf(r.fund_id, r.name).toLowerCase(),
    cell: (r) => <RankFund r={r} />,
  };
  if (rank)
    Object.assign(fund, {
      orders: { pop: (r: TopRow) => -(rank.get(r.fund_id) ?? Infinity) },
      cycle: [{ key: "name", dir: 1 }, { key: "name", dir: -1 }, MOST_POPULAR],
      alt: { pop: "most popular" },
    });
  return [
    fund,
    { header: "AUM", key: "book", width: "10%", by: (r) => r.book, cell: (r) => aumLabel(r.book) },
    { header: "Positions", key: "positions", width: "10%", by: (r) => r.n_positions, cell: (r) => count(r.n_positions) },
    {
      header: "Return / yr",
      key: "ret",
      width: "26%",
      by: (r) => r.ann_return,
      cell: (r) => <RetCell ret={r.ann_return} spx={spx} dom={dom} dark={dark} />,
    },
    { header: "Max drawdown", key: "dd", width: "11%", by: (r) => r.max_dd, cell: (r) => pct(r.max_dd, 1, false) },
    { header: "Sharpe", key: "sharpe", width: "9%", by: (r) => r.sharpe, cell: (r) => ratio(r.sharpe) },
  ];
}

/** A phone's Sort by menu: the orders the headings give on a wider screen. */
const SORTS: { label: string; sort: SortState; famous?: true }[] = [
  { label: "Most popular", sort: MOST_POPULAR, famous: true },
  { label: "Return, highest first", sort: BEST_RETURN },
  { label: "Return, lowest first", sort: { key: "ret", dir: 1 } },
  { label: "Name, A–Z", sort: { key: "name", dir: 1 } },
  { label: "AUM, largest first", sort: { key: "book", dir: -1 } },
  { label: "Positions, most first", sort: { key: "positions", dir: -1 } },
  { label: "Max drawdown, smallest first", sort: { key: "dd", dir: -1 } },
  { label: "Sharpe, highest first", sort: { key: "sharpe", dir: -1 } },
];
const sortId = (s: SortState) => `${s.key}:${s.dir}`;

export function RankTable({
  rows,
  label,
  initial,
  pageSize,
  spx,
  phone,
  rank,
}: {
  rows: TopRow[];
  label: string;
  initial: SortState;
  pageSize: number;
  spx: number | null;
  phone: boolean;
  /** Famous funds' popularity places (1 = most popular): adds that order to the Fund heading and the menu. */
  rank?: Map<number, number>;
}) {
  const dark = useDark();
  const navigate = useNavigate();
  // one scale for the whole list, as on the chart, so a bar keeps its length from page to page and sort to sort
  const dom = useMemo(() => domainOf(rows, spx), [rows, spx]);
  const columns = useMemo(() => rankColumns(dom, spx, dark, rank), [dom, spx, dark, rank]);
  const { sorted, sort, onSort, setSort } = useSortedRows(rows, columns, initial);
  const [page, setPage] = useState(0);
  const [shownFor, setShownFor] = useState(sorted);
  if (shownFor !== sorted) {
    setShownFor(sorted);
    setPage(0);
  }
  const shown = useMemo(() => sorted.slice(page * pageSize, (page + 1) * pageSize), [sorted, page, pageSize]);
  if (rows.length === 0)
    return (
      <div className="pb">
        <State>Nothing to show.</State>
      </div>
    );
  const sorts = SORTS.filter((o) => !o.famous || rank);
  return (
    <div className={"rk" + (phone ? " phone" : "")}>
      <div className="rk-top">
        {phone && (
          <label className="rk-sort">
            <span>Sort by</span>
            <select
              value={sortId(sort)}
              onChange={(e) => {
                const o = sorts.find((x) => sortId(x.sort) === e.target.value);
                if (o) setSort(o.sort);
              }}
            >
              {/* an order set by a heading on a wider screen that the menu lacks still shows as chosen */}
              {!sorts.some((o) => sortId(o.sort) === sortId(sort)) && <option value={sortId(sort)}>—</option>}
              {sorts.map((o) => (
                <option key={sortId(o.sort)} value={sortId(o.sort)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {spx != null && (
          <span className="rk-key">
            <i aria-hidden="true" />
            S&amp;P 500 {pct(spx, 1)} a year
          </span>
        )}
      </div>
      <DataTable
        label={label}
        columns={columns}
        rows={shown}
        rowKey={(r) => r.fund_id}
        sort={sort}
        onSort={onSort}
        onRow={(r) => navigate(`/fund/${r.fund_id}`)}
        fixed={!phone}
      />
      <Pager page={page} pageSize={pageSize} total={sorted.length} onPage={setPage} noun="funds" />
    </div>
  );
}
