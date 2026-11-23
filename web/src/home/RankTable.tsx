import { useMemo, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { SortState } from "../components/DataTable";
import { Pager } from "../components/Pager";
import { State } from "../components/State";
import type { TopRow } from "../data/types";
import { count, pct, qLabel, ratio } from "../lib/format";
import { shortNameOf } from "../lib/famousNames";
import { useSortedRows, type Col } from "../lib/sort";
import { Photo } from "./FamousChart";
import { aumLabel, retLabel } from "./famousChart";
import "./rankTable.css";

// The Table view of the ranked lists (Famous funds, Top funds), laid out on the chart's own grid so switching
// Chart | Table keeps everything in place (owner, 2026-11-23): the same 42px header strip with one hairline under
// it, the S&P 500 figure on top of the return heading as on the chart's axis, 46px rows with the photo (or
// initials), short name and person where the chart has them, no lines between rows, the chart's hover band. The
// return column starts where the chart's bars do. Every heading sorts; Famous funds' Fund heading also steps to
// most popular. On a phone a fund is one block (name and return; AUM, positions, drawdown, Sharpe under it) and the
// sort is a menu in the header strip.

export const BEST_RETURN: SortState = { key: "ret", dir: -1 };
/** Famous lists open with the most popular fund first. */
export const MOST_POPULAR: SortState = { key: "pop", dir: -1 };

type RCol = Col<TopRow> & { cls: string };

/** A phone's second line under the name, where the chart has AUM · person: the figures the columns hold. */
const phoneLine = (r: TopRow) => [aumLabel(r.book), `${count(r.n_positions)} pos`, `Max DD ${pct(r.max_dd, 1, false)}`, `Sharpe ${ratio(r.sharpe)}`];

/** The fund as the chart shows it: photo (or initials), short name (the filer's name on hover), the person. */
function RankFund({ r, phone }: { r: TopRow; phone: boolean }) {
  const short = shortNameOf(r.fund_id, r.name);
  const sub = [r.manager, r.until_q != null && `filed until ${qLabel(r.until_q)}`].filter(Boolean).join(" · ");
  return (
    <span className="rk-fund">
      <Photo manager={r.manager} who={r.manager ?? short} />
      <span className="who">
        <Link className="nm" to={`/fund/${r.fund_id}`} title={r.name}>
          {short}
        </Link>
        {phone ? (
          <span className="l2">
            {phoneLine(r).map((s, i) => (
              <span key={i}>
                {i > 0 && <i className="sep" aria-hidden="true" />}
                {s}
              </span>
            ))}
          </span>
        ) : (
          sub && <span className="mg">{sub}</span>
        )}
      </span>
    </span>
  );
}

function rankColumns(phone: boolean, rank?: Map<number, number>): RCol[] {
  const fund: RCol = {
    cls: "c-fund",
    header: "Fund",
    key: "name",
    align: "l",
    by: (r) => shortNameOf(r.fund_id, r.name).toLowerCase(),
    cell: (r) => <RankFund r={r} phone={phone} />,
  };
  if (rank)
    Object.assign(fund, {
      orders: { pop: (r: TopRow) => -(rank.get(r.fund_id) ?? Infinity) },
      cycle: [{ key: "name", dir: 1 }, { key: "name", dir: -1 }, MOST_POPULAR],
      alt: { pop: "most popular" },
    });
  return [
    fund,
    { cls: "c-ret", header: "Return / yr", key: "ret", by: (r) => r.ann_return, cell: (r) => retLabel(r.ann_return) },
    { cls: "c-aum", header: "AUM", key: "book", by: (r) => r.book, cell: (r) => aumLabel(r.book) },
    { cls: "c-pos", header: "Positions", key: "positions", by: (r) => r.n_positions, cell: (r) => count(r.n_positions) },
    { cls: "c-dd", header: "Max drawdown", key: "dd", by: (r) => r.max_dd, cell: (r) => pct(r.max_dd, 1, false) },
    { cls: "c-sh", header: "Sharpe", key: "sharpe", by: (r) => r.sharpe, cell: (r) => ratio(r.sharpe) },
  ];
}

/** A phone's sort menu: the orders the headings give on a wider screen. */
const SORTS: { label: string; sort: SortState; famous?: true }[] = [
  { label: "Most popular", sort: MOST_POPULAR, famous: true },
  { label: "Return, highest", sort: BEST_RETURN },
  { label: "Return, lowest", sort: { key: "ret", dir: 1 } },
  { label: "Name, A–Z", sort: { key: "name", dir: 1 } },
  { label: "AUM, largest", sort: { key: "book", dir: -1 } },
  { label: "Positions, most", sort: { key: "positions", dir: -1 } },
  { label: "Drawdown, smallest", sort: { key: "dd", dir: -1 } },
  { label: "Sharpe, highest", sort: { key: "sharpe", dir: -1 } },
];
const sortId = (s: SortState) => `${s.key}:${s.dir}`;

function SortIcon({ desc }: { desc: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
      <path d={desc ? "M4 6.25 8 10.25l4-4" : "M4 9.75l4-4 4 4"} />
    </svg>
  );
}

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
  const navigate = useNavigate();
  const columns = useMemo(() => rankColumns(phone, rank), [phone, rank]);
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
  // a click anywhere on a row opens the fund (its name is the link, for the keyboard and a new tab)
  const open = (r: TopRow) => (e: MouseEvent) => {
    if (!(e.target instanceof Element && e.target.closest("a, button, select"))) navigate(`/fund/${r.fund_id}`);
  };

  return (
    <div className={"rk" + (phone ? " phone" : "")}>
      {phone && (
        // the phone's header strip: where the chart has its axis, the column name and the sort menu
        <div className="rk-head">
          <span>Fund</span>
          <select aria-label="Sort by" value={sortId(sort)} onChange={(e) => {
            const o = sorts.find((x) => sortId(x.sort) === e.target.value);
            if (o) setSort(o.sort);
          }}>
            {!sorts.some((o) => sortId(o.sort) === sortId(sort)) && <option value={sortId(sort)}>—</option>}
            {sorts.map((o) => (
              <option key={sortId(o.sort)} value={sortId(o.sort)}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => {
              const dir = sort.key === c.key ? sort.dir : 0;
              const alt = c.alt?.[sort.key];
              const on = dir !== 0 || alt !== undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.cls}
                  aria-sort={!on ? undefined : (dir || -1) > 0 ? "ascending" : "descending"}
                >
                  {c.key === "ret" && spx != null && (
                    <span className="rk-spx" aria-hidden="true">
                      S&amp;P 500 {pct(spx, 1)}
                    </span>
                  )}
                  <button type="button" className="sort" onClick={() => onSort(c.key)}>
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
        <tbody>
          {shown.map((r) => (
            <tr key={r.fund_id} onClick={open(r)}>
              {columns.map((c) => (
                <td key={c.key} className={c.cls}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {spx != null && <p className="vh">{`The S&P 500 returned ${pct(spx, 1)} a year over the same period.`}</p>}
      <div className="rk-foot">
        <Pager page={page} pageSize={pageSize} total={sorted.length} onPage={setPage} noun="funds" />
      </div>
    </div>
  );
}
