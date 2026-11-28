import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { Choice, type ChoiceOption } from "../components/Choice";
import { DataTable, type SortState } from "../components/DataTable";
import { Pager } from "../components/Pager";
import { Panel } from "../components/Panel";
import { Signed } from "../components/Signed";
import { State } from "../components/State";
import { StockLabel } from "../components/StockLabel";
import { Tabs, tabPanelProps, type TabItem } from "../components/Tabs";
import {
  NotFoundError,
  loadFunds,
  loadHome,
  loadLatestPrices,
  loadSecurities,
  priceMap,
  stockMap,
  type Stock,
} from "../data/api";
import type {
  CallRow,
  ConvictionRow,
  CrowdedRow,
  SpxWindow,
  TopRow,
  WinLossRow,
} from "../data/types";
import { count, HOME_TITLE, qLabel, tidyName } from "../lib/format";
import { useWidth } from "../fund/hooks";
import { bestFirst, FALLBACK_W, FamousChart, PHONE_BELOW } from "../home/FamousChart";
import { sourceLine } from "../home/famousChart";
import { ListIndex } from "../home/ListIndex";
import { ROOT as LANDSCAPE_ROOT, aum } from "../home/landscape";
import { LandscapeMap } from "../home/LandscapeMap";
import { BEST_RETURN, RankTable } from "../home/RankTable";
import {
  CALL_SORTS,
  CONVICTION_SORTS,
  MOST_UNUSUAL,
  callColumns,
  change,
  convictionColumns,
  type Call,
  type ListLookup,
} from "../home/moveTables";
import { ScrollTable } from "../home/ScrollTable";
import { indexMode, layoutFor, type IndexItem } from "../home/listIndex";
import { photoOf } from "../lib/people";
import { useSortedRows, type Col } from "../lib/sort";
import { useLoad, type Load } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";
import { fBook, fWeight } from "./homeFmt";
import "./home.css";
import { FAMOUS_GROUPS } from "../data/famousGroups";

// ---- loading ----------------------------------------------------------------

/** The body of a panel while its list loads (shimmering rows) or when it could not (the error state). */
function Status({ state }: { state: Load<unknown> }) {
  if (state.status === "error") {
    return (
      <div className="pb">
        <State kind="error" title="Couldn't load this list.">
          Check your connection and reload the page.
        </State>
      </div>
    );
  }
  return (
    <div className="skl" role="status">
      <span className="vh">Loading…</span>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="skr" aria-hidden="true" key={i}>
          <i className="sk" />
          <i className="sk" style={{ width: 56 + ((i * 17) % 40) }} />
          <i className="sk" style={{ width: 40 + ((i * 11) % 30) }} />
        </div>
      ))}
    </div>
  );
}

/** What most lists need to turn ids into names, to compute figures from today's close, and to show the person
 * behind a famous fund (`people`, from Famous funds' rows, which the default tab has already loaded). */
type Lookup = ListLookup;

async function loadLookup(): Promise<Lookup> {
  const [sec, lp, funds, top] = await Promise.all([
    loadSecurities(),
    loadLatestPrices(),
    loadFunds().catch(() => null),
    loadHome("top_3y").catch(() => null),
  ]);
  // SEC names come in capitals with legal suffixes; the lists print them tidied, as the fund page does.
  const stocks = new Map(
    [...stockMap(sec)].map(([id, s]): [number, Stock] => [
      id,
      { ...s, name: tidyName(s.name) },
    ]),
  );
  const people = new Map<number, string>();
  for (const f of top?.famous ?? []) if (f.manager) people.set(f.fund_id, f.manager);
  return {
    stocks,
    prices: priceMap(lp),
    books: new Map(
      funds
        ? funds.id.map((id, i): [number, number] => [id, funds.book[i]])
        : [],
    ),
    people,
  };
}

// ---- cells --------------------------------------------------------------------

/**
 * Widths of the name columns when a list lays out fixed: the name's cap (home.css: --nm-w for funds,
 * --stk-w for stocks) and the cell's padding, so the longest name that fits shows in full with no slack.
 */
const FUND_W = "calc(var(--nm-w) + var(--tpad) + 8px)";
const STOCK_W = "calc(var(--stk-w) + var(--tpad) + 8px)";

/** A fund's name, bold, cut with an ellipsis (the full name on hover). */
function FundLink({ id, name }: { id: number; name: string }) {
  return (
    <Link className="nm" to={`/fund/${id}`} title={name}>
      {name}
    </Link>
  );
}

/** A fund's name over its reported book, as a stock shows its ticker over its company. */
function FundCell({
  lookup,
  id,
  name,
}: {
  lookup: Lookup;
  id: number;
  name: string;
}) {
  const book = lookup.books.get(id);
  return (
    <div className="stk fund">
      <FundLink id={id} name={name} />
      {book !== undefined && <span className="sub">{fBook(book)}</span>}
    </div>
  );
}

/** Ticker over the company name, linking to the stock's page within a fund. */
function StockLink({
  lookup,
  fundId,
  stockId,
}: {
  lookup: Lookup;
  fundId: number;
  stockId: number;
}) {
  return (
    <Link className="tick stk" to={`/fund/${fundId}/stock/${stockId}`}>
      <StockLabel stock={lookup.stocks.get(stockId)} stockId={stockId} />
    </Link>
  );
}

// ---- lists --------------------------------------------------------------------------

type Period = "1y" | "3y" | "5y" | "10y" | "15y" | "max";
const PERIODS: ChoiceOption<Period>[] = [
  { id: "1y", label: "1 year" },
  { id: "3y", label: "3 years" },
  { id: "5y", label: "5 years" },
  { id: "10y", label: "10 years" },
  { id: "15y", label: "15 years" },
  { id: "max", label: "Since start" },
];
/** A phone's period switch: the six fit on one row beside Chart | Table (finance sites' 1Y … Max). */
const PERIODS_SHORT: ChoiceOption<Period>[] = [
  { id: "1y", label: "1y" },
  { id: "3y", label: "3y" },
  { id: "5y", label: "5y" },
  { id: "10y", label: "10y" },
  { id: "15y", label: "15y" },
  { id: "max", label: "Max" },
];

/** Few funds have a record this long, so its empty list gets its own note. */
const EMPTY: Partial<Record<Period, string>> = {
  "15y": "No fund has 15 years of 13F history that meets the list's rules.",
};


/** Rows shown on one page of a long list. */
const PAGE_SIZE = 100;

/**
 * A home list: every column sorts (`initial` first), and with `paged` the rows come 100 a page
 * with page buttons above and below. A new order or a new list starts again at the first page.
 * A list with no rows is the empty state instead of a table of headings. A paged list (or one with
 * `fixed`) keeps its column widths whatever the rows, so the columns do not move from page to page.
 */
function ListTable<R>({
  columns,
  rows,
  initial,
  label,
  noun,
  rowKey,
  empty = "Nothing to show.",
  paged = false,
  pageSize = PAGE_SIZE,
  pagerAbove = true,
  fixed = paged,
}: {
  columns: Col<R>[];
  rows: R[];
  initial: SortState;
  label: string;
  noun: string;
  rowKey?: (r: R, i: number) => string | number;
  empty?: string;
  paged?: boolean;
  pageSize?: number;
  /** Page buttons above the table as well as below (short pages need them only below). */
  pagerAbove?: boolean;
  fixed?: boolean;
}) {
  const { sorted, sort, onSort } = useSortedRows(rows, columns, initial);
  const [page, setPage] = useState(0);
  const [shownFor, setShownFor] = useState(sorted);
  if (shownFor !== sorted) {
    setShownFor(sorted);
    setPage(0);
  }
  const shown = useMemo(
    () =>
      paged ? sorted.slice(page * pageSize, (page + 1) * pageSize) : sorted,
    [paged, sorted, page, pageSize],
  );
  if (rows.length === 0) {
    return (
      <div className="pb">
        <State>{empty}</State>
      </div>
    );
  }
  const pager = paged ? (
    <Pager
      page={page}
      pageSize={pageSize}
      total={sorted.length}
      onPage={setPage}
      noun={noun}
    />
  ) : null;
  return (
    <>
      {pagerAbove && pager}
      <DataTable
        label={label}
        columns={columns}
        rows={shown}
        rowKey={rowKey}
        sort={sort}
        onSort={onSort}
        fixed={fixed}
      />
      {pager}
    </>
  );
}


/**
 * Every famous fund's place in the popularity order, 1 = most popular: the owner's order first
 * (famous_rank.csv), then funds with a Google Trends score by score (a manager's several filers share
 * both), then the rest by size. A fund in two lists has one place.
 */
function popularity(rows: TopRow[]): Map<number, number> {
  const best = new Map<number, TopRow>();
  for (const r of rows) {
    const held = best.get(r.fund_id);
    if (!held || (r.fame ?? 0) > (held.fame ?? 0)) best.set(r.fund_id, r);
  }
  const order = [...best.values()].sort(
    (a, b) =>
      (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
      (b.fame ?? 0) - (a.fame ?? 0) ||
      b.book - a.book ||
      a.fund_id - b.fund_id,
  );
  return new Map(order.map((r, i) => [r.fund_id, i + 1]));
}

/** A table's Fund cell on Famous and Top funds: the person's photo, the fund's name, and under it the person
 * behind the fund (people know "Burry", not "Scion") and the last quarter of a fund that stopped filing. */
/** Funds in Most searched: the head of the ranking, as a list of what people look up should be. */
const MOST_SEARCHED_MAX = 50;
const MOST_SEARCHED_ABOUT = "The famous funds investors look up most.";

/**
 * Most searched: the funds with a place in it (`search` set: one filer per manager), once each, in
 * the popularity order (`rank` from `popularity`: the owner's order, then Google Trends).
 */
function mostSearched(rows: TopRow[], rank: Map<number, number>): TopRow[] {
  const seen = new Set<number>();
  const place = (r: TopRow) => rank.get(r.fund_id) ?? Infinity;
  return rows
    .filter((r) => r.search != null)
    .sort((a, b) => place(a) - place(b) || a.fund_id - b.fund_id)
    .filter((r) => !seen.has(r.fund_id) && !!seen.add(r.fund_id))
    .slice(0, MOST_SEARCHED_MAX);
}


/** The famous rows by style, in FAMOUS_GROUPS order; styles with no fund for the period are left out. A row
 * without a group (none should come) goes to a list named "Other", last. */
function byGroup(
  rows: TopRow[],
): { name: string; about?: string; rows: TopRow[] }[] {
  const groups = new Map<string, TopRow[]>();
  for (const r of rows) {
    const g = r.group ?? "Other";
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const known = FAMOUS_GROUPS.filter((g) => groups.has(g.name)).map((g) => ({
    ...g,
    rows: groups.get(g.name)!,
  }));
  const rest = [...groups.keys()]
    .filter((g) => !FAMOUS_GROUPS.some((k) => k.name === g))
    .sort();
  return [...known, ...rest.map((name) => ({ name, rows: groups.get(name)! }))];
}

/** Famous and Top funds open as a chart; Table shows the figures behind it. */
type RankView = "chart" | "table";
const VIEWS: ChoiceOption<RankView>[] = [
  {
    id: "chart",
    label: "Chart",
    // the fund page's Annual returns toggle icons (ReturnsPanel)
    icon: (
      <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 13V8.5M8 13V3.5M12.5 13V6.5" />
      </svg>
    ),
  },
  {
    id: "table",
    label: "Table",
    icon: (
      <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M2.5 6.5h11M6.5 6.5V13" />
      </svg>
    ),
  },
];
const MOST_SEARCHED = "Most searched";
/** Lists named by whose money it is rather than how it is invested: the index's "Type of investor" column. */
const INVESTOR_TYPES = new Set(["Family offices", "Big companies", "Sovereign & pension funds"]);
const indexItem = (name: string): IndexItem => ({
  name,
  group: name === MOST_SEARCHED ? "pop" : INVESTOR_TYPES.has(name) ? "who" : "style",
});
/** Faces in Most searched's cell of the list index. */
const INDEX_FACES = 5;

type FamousList = { name: string; about?: string; rows: TopRow[] };

/** The row at the top of the last view (chart or table) of a list, period and page (`key`), so switching Chart |
 * Table keeps the same funds in view. The table reports 0 once sorted by anything but return. */
type Carry = { key: string; top: number };
const startAt = (c: Carry, key: string) => (c.key === key ? c.top : 0);
const isBest = (s: SortState) => s.key === BEST_RETURN.key && s.dir === BEST_RETURN.dir;

/**
 * Famous funds: one list at a time (Most searched, then the styles), as a chart of returns best first
 * or as a table of the same funds in the same order and window. The list, the view and the period live in Home.
 */
function FamousFunds({
  period,
  onPeriod,
  list,
  onList,
  view,
  onView,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
  list: string;
  onList: (name: string) => void;
  view: RankView;
  onView: (v: RankView) => void;
}) {
  const load = useLoad(() => loadHome(`top_${period}`), [period]);
  const data = load.status === "ready" ? load.data : undefined;
  const rows = data?.famous;
  const rank = useMemo(() => popularity(rows ?? []), [rows]);
  const lists = useMemo<FamousList[]>(() => {
    const searched = mostSearched(rows ?? [], rank);
    return [
      ...(searched.length > 0
        ? [{ name: MOST_SEARCHED, about: MOST_SEARCHED_ABOUT, rows: searched }]
        : []),
      ...byGroup(rows ?? []),
    ];
  }, [rows, rank]);
  const shown =
    lists.find((l) => l.name === list) ??
    lists.find((l) => l.name === MOST_SEARCHED) ??
    lists[0];
  // A list the new period does not have: the switch moves to the list shown in its place.
  useEffect(() => {
    if (shown && shown.name !== list) onList(shown.name);
  }, [shown, list, onList]);
  // The switch keeps the last lists (and Most searched's faces and size) while the next period loads, so the
  // controls do not jump.
  const next = useMemo(() => {
    const ms = lists.find((l) => l.name === MOST_SEARCHED)?.rows ?? [];
    const faces = [...new Set(ms.map((r) => r.manager ?? "").filter((m) => !!photoOf(m)))].slice(0, INDEX_FACES);
    const v = { names: lists.map((l) => l.name), faces, searched: ms.length };
    return { ...v, key: JSON.stringify(v) };
  }, [lists]);
  const [index, setIndex] = useState({ names: [] as string[], faces: [] as string[], searched: 0, key: "" });
  if (next.names.length > 0 && next.key !== index.key) setIndex(next);
  const names = index.names;
  const items = useMemo(() => names.map(indexItem), [names]);
  // The chart's bars grow in again on a new list, new figures, and coming back from the table.
  const [run, setRun] = useState({ n: 0, rows, name: shown?.name, view });
  if (run.rows !== rows || run.name !== shown?.name || run.view !== view)
    setRun({ n: run.n + 1, rows, name: shown?.name, view });

  const spx = data?.spx?.ann_return ?? null;
  // The table holds the chart's rows in the chart's order, and each view opens at the funds the other showed.
  const ranked = useMemo(() => [...(shown?.rows ?? [])].sort(bestFirst), [shown]);
  const viewKey = `${shown?.name}|${period}`;
  const carry = useRef<Carry>({ key: "", top: 0 });
  const section = useRef<HTMLElement>(null);
  const width = useWidth(section, 280, FALLBACK_W);
  const phone = width < PHONE_BELOW;
  const mode = indexMode(width);
  const layout = useMemo(() => (mode === "pick" ? null : layoutFor(items, mode)), [items, mode]);
  // the period takes half the tracks, or more until its six options have room (about 440px)
  let perSpan = 1;
  if (layout) {
    const track = (width - (layout.cols - 1) * 24) / layout.cols;
    perSpan = Math.max(1, Math.floor(layout.cols / 2));
    while (perSpan < layout.cols - 1 && perSpan * track + (perSpan - 1) * 24 < 440) perSpan++;
  }
  const h2 = useId();
  const about = useId();

  let body: ReactNode;
  if (load.status !== "ready") body = <Status state={load} />;
  else if (!shown)
    body = (
      <div className="pb">
        <State>
          {rows === undefined
            ? "The famous funds list arrives with the next data update."
            : (EMPTY[period] ??
              "No famous fund has a long enough record for this period yet.")}
        </State>
      </div>
    );
  else
    body = (
      <div className="fam-mod">
        <div className="fam-rule">
          {/* no count or summary line under the list's name (owner, 2026-11-23) */}
          <div className="fam-h3">
            <h3>{shown.name}</h3>
          </div>
          {shown.about && (
            <p id={about} className="vh">
              {shown.about}
            </p>
          )}
        </div>
        {view === "chart" ? (
          <FamousChart
            name={shown.name}
            rows={shown.rows}
            spx={spx}
            period={period}
            run={run.n}
            start={startAt(carry.current, viewKey)}
            onView={(top) => (carry.current = { key: viewKey, top })}
          />
        ) : (
          <RankTable
            key={shown.name} // each list opens in the chart's order
            label={shown.name}
            rows={ranked}
            spx={spx}
            phone={phone}
            rank={rank}
            start={startAt(carry.current, viewKey)}
            onView={(top, sort) => (carry.current = { key: viewKey, top: isBest(sort) ? top : 0 })}
          />
        )}
        <SourceNote spx={data?.spx} />
      </div>
    );

  return (
    <section
      ref={section}
      className={"ranked famous" + (phone ? " phone" : "")}
      aria-labelledby={h2}
      aria-describedby={shown?.about ? about : undefined}
    >
      {/* The tab already says Famous funds, and the chart labels the S&P 500 line (owner, 2026-11-23): the
          heading stays for screen readers, the standfirst goes. */}
      {/* (out of the layout: no wrapper, so it adds no gap above the switches) */}
      <h2 id={h2} className="vh">
        Famous funds
      </h2>
      <div className="fam-ctl">
        {names.length > 0 && (
          <ListIndex
            items={items}
            layout={layout}
            value={shown?.name ?? list}
            onChange={onList}
            faces={index.faces}
            featNote={`Top ${index.searched} by search interest`}
          />
        )}
        {/* one row on the index's tracks: the period from the left edge, Chart | Table in the last track, both
            the same height on one centre line */}
        <div
          className={"fam-opts" + (layout ? " on-grid" : "")}
          style={layout ? { gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` } : undefined}
        >
          <div className="fo-per" style={layout ? { gridColumn: `1 / span ${perSpan}` } : undefined}>
            <Choice
              label="Period"
              options={phone ? PERIODS_SHORT : PERIODS}
              value={period}
              onChange={onPeriod}
            />
          </div>
          <div className="fo-view" style={layout ? { gridColumn: layout.cols } : undefined}>
            <Choice
              label="View"
              options={VIEWS}
              value={view}
              onChange={onView}
            />
          </div>
        </div>
      </div>
      {body}
    </section>
  );
}

/** Funds a page in Top funds, chart and table: the chart's window shows 20 of them (phone 10), then Next. */
const TOP_PAGE = 80;
const TOP_LIST = "Funds over $1B";
/** Who is in the list (pipeline/orca/config.py, docs/PRODUCT.md "Home list rules"). */
const TOP_RULE =
  "Funds with AUM ≥ $1B, ≥ 12 quarters of 13F filings, ≥ 4 positions and ≥ 80% of AUM priced; banks, insurers, brokers and index-sized books (≥ 1,000 positions) are left out.";

/** The source note under a ranked list: who is in it (Top funds), then where the figures come from. */
function SourceNote({ rule, spx }: { rule?: string; spx: SpxWindow | null | undefined }) {
  return <p className="fam-src">{rule ? `${rule} ${sourceLine(spx)}` : sourceLine(spx)}</p>;
}

/**
 * Top funds: every qualifying fund as a chart of returns best first, 80 a page (Next for the rest), or as a
 * sortable table. Laid out as Famous funds is (heading for screen readers, period and Chart | Table, the module with its
 * name and source); the people behind famous funds keep their photo and name here too.
 */
function TopFunds({
  period,
  onPeriod,
  view,
  onView,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
  view: RankView;
  onView: (v: RankView) => void;
}) {
  const load = useLoad(() => loadHome(`top_${period}`), [period]);
  const data = load.status === "ready" ? load.data : undefined;
  // The famous rows name the person behind a fund: a famous fund in Top funds shows them (and their photo) too.
  const rows = useMemo(() => {
    const people = new Map<number, string>();
    for (const f of data?.famous ?? []) if (f.manager) people.set(f.fund_id, f.manager);
    return (data?.eligible ?? [])
      .map((r) => (people.has(r.fund_id) ? { ...r, manager: people.get(r.fund_id) } : r))
      .sort(bestFirst);
  }, [data]);
  // A new period starts again on the first page.
  const [page, setPage] = useState(0);
  const [pageFor, setPageFor] = useState(rows);
  if (pageFor !== rows) {
    setPageFor(rows);
    setPage(0);
  }
  const shown = useMemo(() => rows.slice(page * TOP_PAGE, (page + 1) * TOP_PAGE), [rows, page]);
  // The bars grow in again on new figures, a new page, and coming back from the table.
  const [run, setRun] = useState({ n: 0, rows, page, view });
  if (run.rows !== rows || run.page !== page || run.view !== view)
    setRun({ n: run.n + 1, rows, page, view });

  const spx = data?.spx?.ann_return ?? null;
  const viewKey = `${period}|${page}`;
  const carry = useRef<Carry>({ key: "", top: 0 });
  const section = useRef<HTMLElement>(null);
  const phone = useWidth(section, 280, FALLBACK_W) < PHONE_BELOW;
  const h2 = useId();

  let body: ReactNode;
  if (load.status !== "ready") body = <Status state={load} />;
  else if (rows.length === 0)
    body = (
      <div className="pb">
        <State>{EMPTY[period] ?? "No fund qualifies for this period yet."}</State>
      </div>
    );
  else
    body = (
      <div className="fam-mod">
        <div className="fam-rule">
          <div className="fam-h3">
            <h3>{TOP_LIST}</h3>
          </div>
        </div>
        {view === "chart" ? (
          <FamousChart
            name={`top-${page}`}
            rows={shown}
            spx={spx}
            period={period}
            run={run.n}
            offset={page * TOP_PAGE}
            total={rows.length > TOP_PAGE ? rows.length : undefined}
            start={startAt(carry.current, viewKey)}
            onView={(top) => (carry.current = { key: viewKey, top })}
            foot={
              rows.length > TOP_PAGE && (
                <Pager page={page} pageSize={TOP_PAGE} total={rows.length} onPage={setPage} noun="funds" />
              )
            }
          />
        ) : (
          <RankTable
            label="Top funds"
            rows={rows}
            pageSize={TOP_PAGE}
            page={page}
            onPage={setPage}
            spx={spx}
            phone={phone}
            start={startAt(carry.current, viewKey)}
            onView={(top, sort) => (carry.current = { key: viewKey, top: isBest(sort) ? top : 0 })}
          />
        )}
        <SourceNote rule={TOP_RULE} spx={data?.spx} />
      </div>
    );

  return (
    <section ref={section} className={"ranked top-funds" + (phone ? " phone" : "")} aria-labelledby={h2}>
      {/* As on Famous funds (owner, 2026-11-23): the tab names it, the chart labels the S&P 500 line; the
          heading stays for screen readers, the standfirst and the fund count go. */}
      {/* (out of the layout: no wrapper, so it adds no gap above the switches) */}
      <h2 id={h2} className="vh">
        Top funds
      </h2>
      <div className="fam-ctl">
        {/* Famous funds' row without its list index: the period on the left, Chart | Table on the right */}
        <div className="fam-opts">
          <div className="fo-per">
            <Choice label="Period" options={phone ? PERIODS_SHORT : PERIODS} value={period} onChange={onPeriod} />
          </div>
          <div className="fo-view">
            <Choice label="View" options={VIEWS} value={view} onChange={onView} />
          </div>
        </div>
      </div>
      {body}
    </section>
  );
}

/** Sort value of a fund or stock name column. */
const lower = (text: string | undefined) => (text ?? "").toLowerCase();

function fundCol<R>(
  lookup: Lookup,
  id: (r: R) => number,
  name: (r: R) => string,
): Col<R> {
  return {
    header: "Fund",
    key: "fund",
    align: "l",
    width: FUND_W,
    by: (r) => lower(name(r)),
    cell: (r) => <FundCell lookup={lookup} id={id(r)} name={name(r)} />,
  };
}

function stockCol<R>(
  lookup: Lookup,
  fund: (r: R) => number,
  stock: (r: R) => number,
): Col<R> {
  return {
    header: "Stock",
    key: "stock",
    align: "l",
    width: STOCK_W,
    by: (r) => lower(lookup.stocks.get(stock(r))?.ticker),
    cell: (r) => (
      <StockLink lookup={lookup} fundId={fund(r)} stockId={stock(r)} />
    ),
  };
}

const MOVE_WINDOWS: ChoiceOption<CallWindow>[] = [
  { id: "q", label: "Last quarter" },
  { id: "y", label: "Last 4 quarters" },
];
const CONVICTION_RULE =
  "Moves of ≥ 3% of a fund's AUM that are at least twice its biggest single-stock move of the 4 quarters before and at least half its largest holding. Funds ≥ $500M; no ETFs.";

/** Rows a page in Conviction moves and Best & worst calls; 20 are in view (phone 10), then the window scrolls. */
const MOVE_PAGE = 100;
/** Below this width (px) a move or a call is a phone's row (fund, stock and move under it, one figure). */
const MOVE_COMPACT_BELOW = 760;
/** Below this width the prices go (they are in the stock's page a click away). */
const MOVE_NARROW_BELOW = 1000;

/**
 * A home list laid out as Famous funds is (owner, 2026-11-28): no card, the switches on a toolbar, then the module
 * (rule, the list's name, the table in the chart's window, the caption) and the rules and source under it.
 * `children` gets the layout the measured width calls for.
 */
function ListSection({
  title,
  className,
  controls,
  load,
  module,
  children,
}: {
  /** The tab's name, the section's heading (for screen readers: the tab already shows it). */
  title: string;
  className: string;
  controls: (phone: boolean) => ReactNode;
  /** What the list waits for. */
  load: Load<unknown>;
  /** The module's name over the table, and the note under it. */
  module?: { name: string; note: string };
  children: (layout: { phone: boolean; compact: boolean; narrow: boolean }) => ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const width = useWidth(section, 280, FALLBACK_W);
  const phone = width < PHONE_BELOW;
  const compact = width < MOVE_COMPACT_BELOW;
  const narrow = !compact && width < MOVE_NARROW_BELOW;
  const h2 = useId();
  return (
    <section ref={section} className={`ranked ${className}` + (phone ? " phone" : "")} aria-labelledby={h2}>
      <h2 id={h2} className="vh">
        {title}
      </h2>
      <div className="fam-ctl">
        <div className="fam-opts">{controls(phone)}</div>
      </div>
      {load.status !== "ready" || !module ? (
        <Status state={load} />
      ) : (
        <div className="fam-mod">
          <div className="fam-rule">
            <div className="fam-h3">
              <h3>{module.name}</h3>
            </div>
          </div>
          {children({ phone, compact, narrow })}
          <p className="fam-src">{module.note}</p>
        </div>
      )}
    </section>
  );
}

/** Both lists' window: "Q2 2026" or "the 4 quarters to Q2 2026". */
const windowName = (win: CallWindow, latest: number) =>
  win === "q" ? qLabel(latest) : `the 4 quarters to ${qLabel(latest)}`;

function Conviction({
  lookup,
  win,
  onWin,
}: {
  lookup: Load<Lookup>;
  win: CallWindow;
  onWin: (w: CallWindow) => void;
}) {
  const list = useLoad(
    () => loadHome(win === "q" ? "conviction_q" : "conviction_y"),
    [win],
  );
  const look = lookup.status === "ready" ? lookup.data : null;
  const file = list.status === "ready" ? list.data : null;
  const load: Load<unknown> = lookup.status !== "ready" ? lookup : list;
  return (
    <ListSection
      title="Conviction moves"
      className="moves"
      load={load}
      controls={() => (
        <div className="fo-per">
          <Choice
            label="Moves from"
            options={MOVE_WINDOWS}
            value={win}
            onChange={onWin}
          />
        </div>
      )}
      module={
        file
          ? {
              name: `Moves in ${win === "q" ? `${qLabel(file.latest_q)} filings` : windowName(win, file.latest_q)}`,
              note: `${CONVICTION_RULE} The most unusual move for its fund comes first. "Since" = price change from the estimated trade price to today. Source: SEC 13F filings; Orca estimates.`,
            }
          : undefined
      }
    >
      {({ compact, narrow }) =>
        look &&
        file && (
          <ConvictionTable
            key={win}
            look={look}
            rows={file.rows}
            win={win}
            compact={compact}
            narrow={narrow}
          />
        )
      }
    </ListSection>
  );
}

function ConvictionTable({
  look,
  rows,
  win,
  compact,
  narrow,
}: {
  look: Lookup;
  rows: ConvictionRow[];
  win: CallWindow;
  compact: boolean;
  narrow: boolean;
}) {
  const columns = useMemo(
    () => convictionColumns(look, win, rows, compact),
    [look, win, rows, compact],
  );
  return (
    <ScrollTable
      rows={rows}
      columns={columns}
      initial={MOST_UNUSUAL}
      label="Conviction moves"
      noun={["move", "moves"]}
      rowKey={(r) => `${r.fund_id}-${r.stock_id}-${r.q}`}
      href={(r) => `/fund/${r.fund_id}/stock/${r.stock_id}`}
      phone={compact}
      sorts={CONVICTION_SORTS}
      pageSize={MOVE_PAGE}
      empty={
        win === "q"
          ? "No conviction moves this quarter."
          : "No conviction moves in the last 4 quarters."
      }
      className={"moves" + (narrow ? " narrow" : "")}
    />
  );
}

function WinsLosses({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("wins_losses"), []);
  const columns = useMemo<Col<WinLossRow>[]>(
    () => [
      fundCol(
        lookup,
        (r) => r.fund_id,
        (r) => r.name,
      ),
      stockCol(
        lookup,
        (r) => r.fund_id,
        (r) => r.stock_id,
      ),
      {
        header: "Quarter P&L",
        key: "pnl",
        by: (r) => r.pnl,
        cell: (r) => <Signed v={r.pnl}>{fBook(r.pnl, true)}</Signed>,
      },
    ],
    [lookup],
  );
  return (
    <Panel
      title="Big wins & losses"
      subtitle={
        list.status === "ready"
          ? `Largest single-position gains and losses in ${qLabel(list.data.latest_q)}, among funds that qualify for Top funds.`
          : undefined
      }
    >
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <div className="pb duo">
          <div>
            <h3>Biggest wins</h3>
            <ListTable
              label="Biggest wins"
              noun="wins"
              columns={columns}
              rows={list.data.wins}
              initial={{ key: "pnl", dir: -1 }}
              empty="No wins to show."
            />
          </div>
          <div>
            <h3>Biggest losses</h3>
            <ListTable
              label="Biggest losses"
              noun="losses"
              columns={columns}
              rows={list.data.losses}
              initial={{ key: "pnl", dir: 1 }}
              empty="No losses to show."
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function Crowded({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("crowded"), []);
  const columns = useMemo<Col<CrowdedRow>[]>(
    () => [
      {
        header: "Stock",
        key: "stock",
        align: "l",
        by: (r) => lower(lookup.stocks.get(r.stock_id)?.ticker),
        cell: (r) => (
          <span className="tick stk">
            <StockLabel
              stock={lookup.stocks.get(r.stock_id)}
              stockId={r.stock_id}
            />
          </span>
        ),
      },
      {
        header: "Funds buying",
        key: "funds",
        by: (r) => r.funds_buying,
        cell: (r) => count(r.funds_buying),
      },
      {
        header: "Total bought",
        key: "bought",
        by: (r) => r.total_bought,
        cell: (r) => fBook(r.total_bought),
      },
      {
        header: "Avg weight after",
        key: "weight",
        by: (r) => r.avg_weight_after,
        cell: (r) => fWeight(r.avg_weight_after),
      },
    ],
    [lookup],
  );
  return (
    <Panel
      title="Crowded buys"
      subtitle={
        list.status === "ready"
          ? `Stocks bought by several concentrated active funds in the same quarter (${qLabel(list.data.latest_q)}).`
          : undefined
      }
    >
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <ListTable
          label="Crowded buys"
          noun="stocks"
          columns={columns}
          rows={list.data.rows}
          initial={{ key: "funds", dir: -1 }}
          empty="No stock was bought by several funds this quarter."
        />
      )}
    </Panel>
  );
}

type Mode = "best" | "worst";
type CallWindow = "q" | "y";
const MODES: ChoiceOption<Mode>[] = [
  { id: "best", label: "Best calls" },
  { id: "worst", label: "Worst calls" },
];
/** A phone's switches share one row: the window, then best or worst. */
const MODES_SHORT: ChoiceOption<Mode>[] = [
  { id: "best", label: "Best" },
  { id: "worst", label: "Worst" },
];
const MOVE_WINDOWS_SHORT: ChoiceOption<CallWindow>[] = [
  { id: "q", label: "Last quarter" },
  { id: "y", label: "Last 4 qtrs" },
];

/** Every row of the file with today's figures, best first (or worst first); rows without a price go last. */
function rankCalls(
  rows: CallRow[],
  prices: Map<number, number>,
  mode: Mode,
): Call[] {
  const dir = mode === "best" ? -1 : 1;
  return rows
    .map((row) => {
      const price = prices.get(row.stock_id);
      return {
        row,
        price,
        sinceBuy: change(price, row.est_price),
        sinceFiled: change(price, row.price_on_filed),
      };
    })
    .sort((a, b) =>
      a.sinceBuy === null
        ? b.sinceBuy === null
          ? 0
          : 1
        : b.sinceBuy === null
          ? -1
          : dir * (a.sinceBuy - b.sinceBuy),
    );
}

const CALLS_RULE =
  "New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or concentrated active funds. Stocks ≥ $300M market cap and ≥ $1 a share.";

function Calls({
  lookup,
  mode,
  onMode,
  win,
  onWin,
}: {
  lookup: Load<Lookup>;
  mode: Mode;
  onMode: (m: Mode) => void;
  win: CallWindow;
  onWin: (w: CallWindow) => void;
}) {
  const list = useLoad(
    () => loadHome(win === "q" ? "calls_q" : "calls_y"),
    [win],
  );
  const look = lookup.status === "ready" ? lookup.data : null;
  const file = list.status === "ready" ? list.data : null;
  const load: Load<unknown> = lookup.status !== "ready" ? lookup : list;
  return (
    <ListSection
      title="Best & worst calls"
      className="calls"
      load={load}
      controls={(phone) => (
        <>
          <div className="fo-per">
            <Choice
              label="Buys from"
              options={phone ? MOVE_WINDOWS_SHORT : MOVE_WINDOWS}
              value={win}
              onChange={onWin}
            />
          </div>
          <div className="fo-mode">
            <Choice
              label="Best or worst"
              options={phone ? MODES_SHORT : MODES}
              value={mode}
              onChange={onMode}
            />
          </div>
        </>
      )}
      module={
        file
          ? {
              name: `Buys in ${win === "q" ? `${qLabel(file.latest_q)} filings` : windowName(win, file.latest_q)}`,
              note: `${CALLS_RULE} "Since 13F went public" starts on the day the 13F was filed: what a copier could still have caught. Each list holds at most the 50 best and 50 worst buys at the last data build; the order here uses today's prices. Source: SEC 13F filings; Orca estimates.`,
            }
          : undefined
      }
    >
      {({ compact, narrow }) =>
        look &&
        file && (
          <CallsTable
            key={`${mode}-${win}`}
            look={look}
            rows={file.rows}
            mode={mode}
            win={win}
            compact={compact}
            narrow={narrow}
          />
        )
      }
    </ListSection>
  );
}

function CallsTable({
  look,
  rows,
  mode,
  win,
  compact,
  narrow,
}: {
  look: Lookup;
  rows: CallRow[];
  mode: Mode;
  win: CallWindow;
  compact: boolean;
  narrow: boolean;
}) {
  const ranked = useMemo(() => rankCalls(rows, look.prices, mode), [rows, look, mode]);
  const columns = useMemo(() => callColumns(look, win, compact), [look, win, compact]);
  return (
    <ScrollTable
      rows={ranked}
      columns={columns}
      initial={{ key: "since", dir: mode === "best" ? -1 : 1 }}
      label={mode === "best" ? "Best calls" : "Worst calls"}
      noun={["buy", "buys"]}
      rowKey={(c) => `${c.row.fund_id}-${c.row.stock_id}-${c.row.q}`}
      href={(c) => `/fund/${c.row.fund_id}/stock/${c.row.stock_id}`}
      phone={compact}
      sorts={CALL_SORTS}
      pageSize={MOVE_PAGE}
      empty="No buys in this window."
      className={"calls" + (narrow ? " narrow" : "")}
    />
  );
}

// ---- landscape --------------------------------------------------------------------------

/**
 * Landscape: every current 13F filer as one tree map, grouped by type of investor (hedge funds by style, asset
 * managers, banks, pensions, ...), sized by its 13F holdings and coloured by its return over the period that
 * Famous funds and Top funds share. The ETF providers are kept: their total is the scale of the double counting
 * the note under the map owns up to.
 */
function LandscapeSection({
  period,
  onPeriod,
  zoom,
  onZoom,
}: {
  period: Period;
  onPeriod: (p: Period) => void;
  zoom: string;
  onZoom: (type: string) => void;
}) {
  const load = useLoad(() => loadHome("landscape"), []);
  const section = useRef<HTMLElement>(null);
  const width = useWidth(section, 280, FALLBACK_W);
  const phone = width < PHONE_BELOW;
  const h2 = useId();
  const file = load.status === "ready" ? load.data : undefined;
  const etf = useMemo(() => {
    if (!file) return 0;
    let v = 0;
    file.funds.type.forEach((t, i) => t === "am.etf" && (v += file.funds.book[i]));
    file.rest.type.forEach((t, i) => t === "am.etf" && (v += file.rest.book[i]));
    return v;
  }, [file]);
  const periodLabel = PERIODS.find((p) => p.id === period)?.label.toLowerCase() ?? period;

  let body: ReactNode;
  if (load.status === "error" && load.error instanceof NotFoundError)
    body = (
      <div className="pb">
        <State>The landscape arrives with the next data update.</State>
      </div>
    );
  else if (load.status !== "ready") body = <Status state={load} />;
  else
    body = (
      <div className="fam-mod">
        <LandscapeMap file={load.data} period={period} periodLabel={periodLabel} zoom={zoom} onZoom={onZoom} />
        <p className="ls-note">
          {`${count(load.data.n_filers)} filers with ${aum(load.data.total)} of 13F holdings at ${qLabel(load.data.latest_q)}: long US-listed stocks, ETFs and options as filed, not their total assets. Holdings are counted as each filer reports them, so money in ETFs is counted twice: at the ETF provider, whose 13F holds its funds' stocks, and at any filer holding the ETF's shares. The ETF providers report ${aum(etf)} in all, the most that overlap can be. Types come from the SEC's adviser register, the firms' names and our own labels.`}
        </p>
        <SourceNote spx={null} />
      </div>
    );

  return (
    <section ref={section} className={"ranked landscape" + (phone ? " phone" : "")} aria-labelledby={h2}>
      <h2 id={h2} className="vh">
        Landscape of 13F filers
      </h2>
      <div className="fam-ctl">
        <div className="fam-opts">
          <div className="fo-per">
            <Choice label="Period" options={phone ? PERIODS_SHORT : PERIODS} value={period} onChange={onPeriod} />
          </div>
        </div>
      </div>
      {body}
    </section>
  );
}

// ---- page ----------------------------------------------------------------------------

type TabId = "top" | "famous" | "landscape" | "conviction" | "wins" | "crowded" | "calls";
const TABS: TabItem<TabId>[] = [
  { id: "famous", label: "Famous funds" },
  { id: "top", label: "Top funds" },
  { id: "landscape", label: "Landscape" },
  { id: "conviction", label: "Conviction moves" },
  { id: "wins", label: "Big wins & losses" },
  { id: "crowded", label: "Crowded buys" },
  { id: "calls", label: "Best & worst calls" },
];

export default function Home() {
  useTitle(HOME_TITLE);
  const [tab, setTab] = useState<TabId>("famous");
  // The toggles live here so they survive switching to another tab and back.
  const [period, setPeriod] = useState<Period>("3y");
  const [famousList, setFamousList] = useState(MOST_SEARCHED);
  const [famousView, setFamousView] = useState<RankView>("chart");
  const [topView, setTopView] = useState<RankView>("chart");
  const [zoom, setZoom] = useState(LANDSCAPE_ROOT);
  const [mode, setMode] = useState<Mode>("best");
  const [win, setWin] = useState<CallWindow>("q");
  const [moveWin, setMoveWin] = useState<CallWindow>("q");
  const lookup = useLoad(loadLookup, []);

  let panel: ReactNode;
  if (tab === "top")
    panel = <TopFunds period={period} onPeriod={setPeriod} view={topView} onView={setTopView} />;
  else if (tab === "landscape")
    panel = <LandscapeSection period={period} onPeriod={setPeriod} zoom={zoom} onZoom={setZoom} />;
  else if (tab === "famous")
    panel = (
      <FamousFunds
        period={period}
        onPeriod={setPeriod}
        list={famousList}
        onList={setFamousList}
        view={famousView}
        onView={setFamousView}
      />
    );
  else if (tab === "conviction")
    panel = <Conviction lookup={lookup} win={moveWin} onWin={setMoveWin} />;
  else if (tab === "calls")
    panel = (
      <Calls
        lookup={lookup}
        mode={mode}
        onMode={setMode}
        win={win}
        onWin={setWin}
      />
    );
  else if (lookup.status !== "ready") {
    // Stocks, prices and fund sizes are what these lists are made of: the panel waits for them.
    panel = (
      <Panel title={TABS.find((t) => t.id === tab)?.label ?? ""}>
        <Status state={lookup} />
      </Panel>
    );
  } else if (tab === "wins") panel = <WinsLosses lookup={lookup.data} />;
  else panel = <Crowded lookup={lookup.data} />;

  return (
    <div className="fp">
      <div className="home fp-main">
        <header className="hero">
          <div className="hero-t">
            <p className="eyebrow">Quarterly 13F Data from SEC.gov</p>
            <h1>Fund Manager Research</h1>
          </div>
        </header>

        {/* The fund search and the theme switch are in the top bar (App), on every page. */}
        <div className="tabrow">
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            label="Home lists"
            idPrefix="home"
          />
        </div>
        <div className="home-body" {...tabPanelProps("home", tab)}>
          {panel}
        </div>
        <p className="cap foot">
          All figures are estimates built from 13F filings, not a fund's real
          return.
        </p>
      </div>
    </div>
  );
}
