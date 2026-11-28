import { useMemo } from "react";
import { Link } from "react-router";
import type { SortState } from "../components/DataTable";
import type { TopRow } from "../data/types";
import { count, pct, qLabel, ratio } from "../lib/format";
import { managerLine, phoneNameOf, shortNameOf } from "../lib/famousNames";
import { Photo } from "./FamousChart";
import { aumLabel, retLabel } from "./famousChart";
import { ScrollTable, type SortOption, type TCol } from "./ScrollTable";

// The Table view of the ranked lists (Famous funds, Top funds), on the chart's grid and in its window
// (home/ScrollTable.tsx), so switching Chart | Table moves nothing (owner, 2026-11-23; 2026-11-28): the same header
// strip, the S&P 500 figure on top of the return heading as on the chart's axis, rows with the photo (or initials),
// short name and person where the chart has them, the same 20 funds in view (phone 10), opening in the chart's
// order (best return first) at the funds the chart was showing. The return column starts where the chart's bars
// do. Every heading sorts; Famous funds' Fund heading also steps to most popular. On a phone a fund is one block
// (name and return; AUM, positions, drawdown, Sharpe under it) and the sort is a menu in the header strip.

export const BEST_RETURN: SortState = { key: "ret", dir: -1 };
/** Famous lists' popularity order, one click away on the Fund heading. */
export const MOST_POPULAR: SortState = { key: "pop", dir: -1 };

/** A phone's second line under the name, where the chart has AUM · person: the figures the columns hold. */
const phoneLine = (r: TopRow) => [aumLabel(r.book), `${count(r.n_positions)} pos`, `Max DD ${pct(r.max_dd, 1, false)}`, `Sharpe ${ratio(r.sharpe)}`];

/** The fund as the chart shows it: photo (or initials), short name (the filer's name on hover), the person. */
function RankFund({ r, phone }: { r: TopRow; phone: boolean }) {
  const short = shortNameOf(r.fund_id, r.name);
  const sub = [managerLine(r.manager, short), r.until_q != null && `filed until ${qLabel(r.until_q)}`].filter(Boolean).join(" · ");
  return (
    <span className="rk-fund">
      <Photo manager={r.manager} who={managerLine(r.manager, short) ?? short} />
      <span className="who">
        <Link className="nm" to={`/fund/${r.fund_id}`} title={r.name}>
          {phone ? phoneNameOf(short) : short}
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

function rankColumns(phone: boolean, spx: number | null, rank?: Map<number, number>): TCol<TopRow>[] {
  const fund: TCol<TopRow> = {
    cls: "c-fund",
    ph: "main",
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
    {
      cls: "c-ret",
      ph: "end",
      header: "Return / yr",
      key: "ret",
      by: (r) => r.ann_return,
      cell: (r) => retLabel(r.ann_return),
      top: spx != null && (
        <span className="rk-spx" aria-hidden="true">
          S&amp;P 500 {pct(spx, 1)}
        </span>
      ),
    },
    { cls: "c-aum", header: "AUM", key: "book", by: (r) => r.book, cell: (r) => aumLabel(r.book) },
    { cls: "c-pos", header: "Positions", key: "positions", by: (r) => r.n_positions, cell: (r) => count(r.n_positions) },
    { cls: "c-dd", header: "Max drawdown", key: "dd", by: (r) => r.max_dd, cell: (r) => pct(r.max_dd, 1, false) },
    { cls: "c-sh", header: "Sharpe", key: "sharpe", by: (r) => r.sharpe, cell: (r) => ratio(r.sharpe) },
  ];
}

/** A phone's sort menu: the orders the headings give on a wider screen. */
const SORTS: (SortOption & { famous?: true })[] = [
  { label: "Return, highest", sort: BEST_RETURN },
  { label: "Return, lowest", sort: { key: "ret", dir: 1 } },
  { label: "Most popular", sort: MOST_POPULAR, famous: true },
  { label: "Name, A–Z", sort: { key: "name", dir: 1 } },
  { label: "AUM, largest", sort: { key: "book", dir: -1 } },
  { label: "Positions, most", sort: { key: "positions", dir: -1 } },
  { label: "Drawdown, smallest", sort: { key: "dd", dir: -1 } },
  { label: "Sharpe, highest", sort: { key: "sharpe", dir: -1 } },
];

export function RankTable({
  rows,
  label,
  pageSize,
  page,
  onPage,
  spx,
  phone,
  rank,
  start,
  onView,
}: {
  /** Best return first (`bestFirst`), the chart's order, so ties keep their places too. */
  rows: TopRow[];
  label: string;
  /** Funds a page (Top funds: 80, as its chart); unset for a whole list. */
  pageSize?: number;
  page?: number;
  onPage?: (page: number) => void;
  spx: number | null;
  phone: boolean;
  /** Famous funds' popularity places (1 = most popular): adds that order to the Fund heading and the menu. */
  rank?: Map<number, number>;
  start?: number;
  onView?: (top: number, sort: SortState) => void;
}) {
  const columns = useMemo(() => rankColumns(phone, spx, rank), [phone, spx, rank]);
  const sorts = useMemo(() => SORTS.filter((o) => !o.famous || rank), [rank]);
  return (
    <ScrollTable
      rows={rows}
      columns={columns}
      initial={BEST_RETURN}
      label={label}
      noun={["fund", "funds"]}
      rowKey={(r) => r.fund_id}
      href={(r) => `/fund/${r.fund_id}`}
      phone={phone}
      sorts={sorts}
      pageSize={pageSize}
      page={page}
      onPage={onPage}
      start={start}
      onView={onView}
      className="rank"
    />
  );
}
