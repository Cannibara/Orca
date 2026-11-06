import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Chips, type ChipOption } from "../components/Chips";
import { DataTable, type SortState } from "../components/DataTable";
import { Pager } from "../components/Pager";
import { Signed } from "../components/Signed";
import { StockLabel } from "../components/StockLabel";
import { Tabs, tabPanelProps, type TabItem } from "../components/Tabs";
import { loadFunds, loadHome, loadLatestPrices, loadSecurities, priceMap, stockMap, type Stock } from "../data/api";
import type {
  CallRow,
  ConvictionRow,
  CrowdedRow,
  FundsIndex,
  TopRow,
  WinLossRow,
} from "../data/types";
import { count, money, pct, pp, px, qLabel, ratio } from "../lib/format";
import { useSortedRows, type Col } from "../lib/sort";
import { useLoad, type Load } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";

// ---- loading ----------------------------------------------------------------

function Status({ state }: { state: Load<unknown> }) {
  if (state.status === "error") {
    return (
      <p className="note" role="alert">
        Couldn't load this list. Check your connection and reload the page.
      </p>
    );
  }
  return (
    <p className="cap" role="status">
      Loading…
    </p>
  );
}

/** What most lists need to turn ids into names and to compute figures from today's close. */
type Lookup = {
  stocks: Map<number, Stock>;
  prices: Map<number, number>;
};

async function loadLookup(): Promise<Lookup> {
  const [sec, lp] = await Promise.all([loadSecurities(), loadLatestPrices()]);
  return { stocks: stockMap(sec), prices: priceMap(lp) };
}

// ---- cells --------------------------------------------------------------------

/** Price move from `base` to `price`; null when either is missing. */
function change(price: number | undefined, base: number): number | null {
  return price === undefined || !(base > 0) ? null : price / base - 1;
}

function FundLink({ id, name }: { id: number; name: string }) {
  return (
    <Link className="trunc" to={`/fund/${id}`} title={name}>
      {name}
    </Link>
  );
}

/** Ticker with the name beside it, linking to the stock's page within a fund. */
function StockLink({ lookup, fundId, stockId }: { lookup: Lookup; fundId: number; stockId: number }) {
  return (
    <Link className="tick" to={`/fund/${fundId}/stock/${stockId}`}>
      <StockLabel stock={lookup.stocks.get(stockId)} stockId={stockId} />
    </Link>
  );
}

// ---- search ---------------------------------------------------------------------

const MAX_MATCHES = 8;
type Match = { id: number; name: string; book: number; n: number };

/** Case-insensitive substring match on fund names; names that start with the text come first, then larger books. */
function matchFunds(funds: FundsIndex, query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: (Match & { rank: number })[] = [];
  funds.name.forEach((name, i) => {
    const at = name.toLowerCase().indexOf(q);
    if (at >= 0) hits.push({ id: funds.id[i], name, book: funds.book[i], n: funds.n[i], rank: at === 0 ? 0 : 1 });
  });
  hits.sort((a, b) => a.rank - b.rank || b.book - a.book);
  return hits.slice(0, MAX_MATCHES);
}

function FundSearch() {
  const navigate = useNavigate();
  const funds = useLoad(loadFunds, []);
  const [query, setQuery] = useState("");
  // The results can be put away (Escape, or focus leaving the box) without losing the text; typing or focus brings them back.
  const [open, setOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (funds.status === "ready" ? matchFunds(funds.data, query) : []), [funds, query]);
  const typed = query.trim() !== "";
  const showing = typed && open && funds.status !== "error";

  return (
    <div
      className="search-box"
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        // Focus moving to something else inside the box (the button, a result) keeps the results open.
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !showing) return;
        e.preventDefault(); // a search field would otherwise clear itself
        input.current?.focus(); // (before closing: focusing the box opens the results)
        setOpen(false);
      }}
    >
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches.length > 0) navigate(`/fund/${matches[0].id}`);
        }}
      >
        <label htmlFor="fund-search">Search a fund or manager</label>
        <input
          ref={input}
          id="fund-search"
          type="search"
          placeholder="Type a fund name"
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        <button className="btn" type="submit" disabled={matches.length === 0}>
          Open fund
        </button>
      </form>
      {funds.status === "error" && (
        <p className="cap" role="status">
          Search isn't available right now. The fund list didn't load.
        </p>
      )}
      {showing && (
        // A press on the results must not take focus from the box, or the results would close before the click lands.
        <div className="results" onMouseDown={(e) => e.preventDefault()}>
          {funds.status === "loading" ? (
            <p className="cap" role="status">
              Loading funds…
            </p>
          ) : matches.length === 0 ? (
            <p className="cap" role="status">
              No fund matches "{query.trim()}".
            </p>
          ) : (
            <ul aria-label="Matching funds">
              {matches.map((m) => (
                <li key={m.id}>
                  <Link to={`/fund/${m.id}`}>
                    <span>{m.name}</span>
                    <span className="cap">
                      {money(m.book)} · {count(m.n, "position")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---- lists --------------------------------------------------------------------------

type Period = "1y" | "3y" | "5y" | "10y" | "15y" | "max";
const PERIODS: ChipOption<Period>[] = [
  { id: "1y", label: "1 year" },
  { id: "3y", label: "3 years" },
  { id: "5y", label: "5 years" },
  { id: "10y", label: "10 years" },
  { id: "15y", label: "15 years" },
  { id: "max", label: "Since start" },
];

/** The SEC's 13F data starts in 2013, so a period this long has no fund yet. */
const EMPTY: Partial<Record<Period, string>> = {
  "15y": "No fund has 15 years of 13F data yet: the SEC's data starts in 2013.",
};

const TOP_COLUMNS: Col<TopRow>[] = [
  { header: "Fund", key: "name", align: "l", by: (r) => r.name.toLowerCase(), cell: (r) => <FundLink id={r.fund_id} name={r.name} /> },
  { header: "AUM", key: "book", by: (r) => r.book, cell: (r) => money(r.book) },
  { header: "Positions", key: "positions", by: (r) => r.n_positions, cell: (r) => count(r.n_positions) },
  { header: "Return / yr", key: "ret", by: (r) => r.ann_return, cell: (r) => <Signed v={r.ann_return}>{pct(r.ann_return)}</Signed> },
  { header: "Max Drawdown", key: "dd", by: (r) => r.max_dd, cell: (r) => pct(r.max_dd, 0, false) },
  { header: "Sharpe", key: "sharpe", by: (r) => r.sharpe, cell: (r) => ratio(r.sharpe) },
];

/** Rows shown on one page of a long list. */
const PAGE_SIZE = 100;

/**
 * A home list: every column sorts (`initial` first), and with `paged` the rows come 100 a page
 * with page buttons above and below. A new order or a new list starts again at the first page.
 */
function ListTable<R>({
  columns,
  rows,
  initial,
  label,
  noun,
  rowKey,
  empty,
  paged = false,
}: {
  columns: Col<R>[];
  rows: R[];
  initial: SortState;
  label: string;
  noun: string;
  rowKey?: (r: R, i: number) => string | number;
  empty?: string;
  paged?: boolean;
}) {
  const { sorted, sort, onSort } = useSortedRows(rows, columns, initial);
  const [page, setPage] = useState(0);
  const [shownFor, setShownFor] = useState(sorted);
  if (shownFor !== sorted) {
    setShownFor(sorted);
    setPage(0);
  }
  const shown = useMemo(
    () => (paged ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : sorted),
    [paged, sorted, page],
  );
  const pager = paged ? <Pager page={page} pageSize={PAGE_SIZE} total={sorted.length} onPage={setPage} noun={noun} /> : null;
  return (
    <>
      {pager}
      <DataTable label={label} columns={columns} rows={shown} rowKey={rowKey} sort={sort} onSort={onSort} empty={empty} />
      {pager}
    </>
  );
}

const BEST_RETURN: SortState = { key: "ret", dir: -1 };

function TopFunds({ period, onPeriod }: { period: Period; onPeriod: (p: Period) => void }) {
  const list = useLoad(() => loadHome(`top_${period}`), [period]);
  return (
    <>
      <Chips label="Period" options={PERIODS} value={period} onChange={onPeriod} />
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <>
          <ListTable
            label="Top funds"
            noun="funds"
            columns={TOP_COLUMNS}
            rows={list.data.eligible}
            initial={BEST_RETURN}
            rowKey={(r) => r.fund_id}
            empty={EMPTY[period] ?? "No fund qualifies for this period yet."}
            paged
          />
          {list.data.giants.length > 0 && (
            <>
              <h3>Index giants</h3>
              <ListTable
                label="Index giants"
                noun="funds"
                columns={TOP_COLUMNS}
                rows={list.data.giants}
                initial={BEST_RETURN}
                rowKey={(r) => r.fund_id}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

const MOVE_LABEL: Record<ConvictionRow["move"], string> = { new: "New", add: "Add", trim: "Trim", exit: "Exit" };
/** Buys before sells when the Buy/Sell column is sorted. */
const MOVE_ORDER: Record<ConvictionRow["move"], number> = { new: 0, add: 1, trim: 2, exit: 3 };

/** Sort value of a fund or stock name column. */
const lower = (text: string | undefined) => (text ?? "").toLowerCase();

function fundCol<R>(id: (r: R) => number, name: (r: R) => string): Col<R> {
  return { header: "Fund", key: "fund", align: "l", by: (r) => lower(name(r)), cell: (r) => <FundLink id={id(r)} name={name(r)} /> };
}

function stockCol<R>(lookup: Lookup, fund: (r: R) => number, stock: (r: R) => number): Col<R> {
  return {
    header: "Stock",
    key: "stock",
    align: "l",
    by: (r) => lower(lookup.stocks.get(stock(r))?.ticker),
    cell: (r) => <StockLink lookup={lookup} fundId={fund(r)} stockId={stock(r)} />,
  };
}

/** The order of the file: the most unusual move for its fund first (no column sorts on it). */
const MOST_UNUSUAL: SortState = { key: "score", dir: -1 };

const MOVE_WINDOWS: ChipOption<CallWindow>[] = [
  { id: "q", label: "Last quarter" },
  { id: "y", label: "Last 4 quarters" },
];

function Conviction({ lookup, win, onWin }: { lookup: Lookup; win: CallWindow; onWin: (w: CallWindow) => void }) {
  const list = useLoad(() => loadHome(win === "q" ? "conviction_q" : "conviction_y"), [win]);
  const columns = useMemo<Col<ConvictionRow>[]>(() => {
    const now = (r: ConvictionRow) => lookup.prices.get(r.stock_id) ?? null;
    const since = (r: ConvictionRow) => change(lookup.prices.get(r.stock_id), r.est_price);
    const quarter: Col<ConvictionRow>[] =
      win === "y" ? [{ header: "Quarter", key: "q", by: (r) => r.q, cell: (r) => qLabel(r.q) }] : [];
    return [
      fundCol((r) => r.fund_id, (r) => r.name),
      stockCol(lookup, (r) => r.fund_id, (r) => r.stock_id),
      ...quarter,
      {
        header: "Buy/Sell",
        key: "move",
        align: "l",
        by: (r) => MOVE_ORDER[r.move],
        cell: (r) => <span className={`pill ${r.move === "exit" || r.move === "trim" ? "sell" : "buy"}`}>{MOVE_LABEL[r.move]}</span>,
      },
      {
        header: win === "q" ? "Weight now" : "Weight after",
        key: "weight",
        by: (r) => r.weight_after,
        cell: (r) => pct(r.weight_after, 1, false),
      },
      { header: "Change", key: "change", by: (r) => r.change_pts, cell: (r) => <Signed v={r.change_pts}>{pp(r.change_pts)}</Signed> },
      { header: "$ bought / sold", key: "usd", by: (r) => r.usd, cell: (r) => <Signed v={r.usd}>{money(r.usd, true)}</Signed> },
      { header: "Est. price", key: "est", by: (r) => r.est_price, cell: (r) => px(r.est_price) },
      { header: "Price now", key: "now", by: now, cell: (r) => px(now(r)) },
      {
        header: "Since",
        key: "since",
        by: since,
        cell: (r) => {
          const s = since(r);
          return <Signed v={s}>{pct(s)}</Signed>;
        },
      },
    ];
  }, [lookup, win]);
  return (
    <>
      <Chips label="Moves from" options={MOVE_WINDOWS} value={win} onChange={onWin} />
      <p className="rule">
        Moves of ≥ 3% of a fund's AUM that are at least twice its biggest single-stock move of the 4 quarters before
        and at least half its largest holding. Funds ≥ $500M; no ETFs.
      </p>
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <>
          <ListTable
            key={win}
            label="Conviction moves"
            noun="moves"
            columns={columns}
            rows={list.data.rows}
            initial={MOST_UNUSUAL}
            rowKey={(r) => `${r.fund_id}-${r.stock_id}-${r.q}`}
            empty={win === "q" ? "No conviction moves this quarter." : "No conviction moves in the last 4 quarters."}
            paged
          />
          <p className="cap">
            {win === "q" ? `${qLabel(list.data.latest_q)} filings` : `The 4 quarters to ${qLabel(list.data.latest_q)}`}, the
            most unusual move for its fund first. "Since" = price change from the estimated trade price to today.
          </p>
        </>
      )}
    </>
  );
}

function WinsLosses({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("wins_losses"), []);
  const columns = useMemo<Col<WinLossRow>[]>(
    () => [
      fundCol((r) => r.fund_id, (r) => r.name),
      stockCol(lookup, (r) => r.fund_id, (r) => r.stock_id),
      { header: "Quarter P&L", key: "pnl", by: (r) => r.pnl, cell: (r) => <Signed v={r.pnl}>{money(r.pnl, true)}</Signed> },
    ],
    [lookup],
  );
  if (list.status !== "ready") return <Status state={list} />;
  return (
    <>
      <p className="rule">
        Largest single-position gains and losses in {qLabel(list.data.latest_q)}, among funds that qualify for Top
        funds.
      </p>
      <h3>Biggest wins</h3>
      <ListTable label="Biggest wins" noun="wins" columns={columns} rows={list.data.wins} initial={{ key: "pnl", dir: -1 }} empty="No wins to show." />
      <h3>Biggest losses</h3>
      <ListTable label="Biggest losses" noun="losses" columns={columns} rows={list.data.losses} initial={{ key: "pnl", dir: 1 }} empty="No losses to show." />
    </>
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
          <span className="tick">
            <StockLabel stock={lookup.stocks.get(r.stock_id)} stockId={r.stock_id} />
          </span>
        ),
      },
      { header: "Funds buying", key: "funds", by: (r) => r.funds_buying, cell: (r) => count(r.funds_buying) },
      { header: "Total bought", key: "bought", by: (r) => r.total_bought, cell: (r) => money(r.total_bought) },
      { header: "Avg weight after", key: "weight", by: (r) => r.avg_weight_after, cell: (r) => pct(r.avg_weight_after, 1, false) },
    ],
    [lookup],
  );
  if (list.status !== "ready") return <Status state={list} />;
  return (
    <>
      <p className="rule">
        Stocks bought by several concentrated active funds in the same quarter ({qLabel(list.data.latest_q)}).
      </p>
      <ListTable
        label="Crowded buys"
        noun="stocks"
        columns={columns}
        rows={list.data.rows}
        initial={{ key: "funds", dir: -1 }}
        empty="No stock was bought by several funds this quarter."
      />
    </>
  );
}

type Mode = "best" | "worst";
type CallWindow = "q" | "y";
const MODES: ChipOption<Mode>[] = [
  { id: "best", label: "Best calls" },
  { id: "worst", label: "Worst calls" },
];
const WINDOWS: ChipOption<CallWindow>[] = [
  { id: "q", label: "Last quarter's buys" },
  { id: "y", label: "Last 4 quarters' buys" },
];

type Call = { row: CallRow; price: number | undefined; sinceBuy: number | null; sinceFiled: number | null };

/** Every row of the file with today's figures, best first (or worst first); rows without a price go last. */
function rankCalls(rows: CallRow[], prices: Map<number, number>, mode: Mode): Call[] {
  const dir = mode === "best" ? -1 : 1;
  return rows
    .map((row) => {
      const price = prices.get(row.stock_id);
      return { row, price, sinceBuy: change(price, row.est_price), sinceFiled: change(price, row.price_on_filed) };
    })
    .sort((a, b) =>
      a.sinceBuy === null ? (b.sinceBuy === null ? 0 : 1) : b.sinceBuy === null ? -1 : dir * (a.sinceBuy - b.sinceBuy),
    );
}

function Calls({
  lookup,
  mode,
  onMode,
  win,
  onWin,
}: {
  lookup: Lookup;
  mode: Mode;
  onMode: (m: Mode) => void;
  win: CallWindow;
  onWin: (w: CallWindow) => void;
}) {
  const list = useLoad(() => loadHome(win === "q" ? "calls_q" : "calls_y"), [win]);
  const ranked = useMemo(
    () => (list.status === "ready" ? rankCalls(list.data.rows, lookup.prices, mode) : []),
    [list, lookup, mode],
  );
  const columns = useMemo<Col<Call>[]>(
    () => [
      stockCol(lookup, (c) => c.row.fund_id, (c) => c.row.stock_id),
      fundCol((c) => c.row.fund_id, (c) => c.row.name),
      { header: "Bought", key: "q", by: (c) => c.row.q, cell: (c) => qLabel(c.row.q) },
      { header: "Est. buy price", key: "est", by: (c) => c.row.est_price, cell: (c) => px(c.row.est_price) },
      { header: "Price now", key: "now", by: (c) => c.price ?? null, cell: (c) => px(c.price ?? null) },
      { header: "Since fund's buy", key: "since", by: (c) => c.sinceBuy, cell: (c) => <Signed v={c.sinceBuy}>{pct(c.sinceBuy)}</Signed> },
      {
        header: "Since 13F went public",
        key: "filed",
        by: (c) => c.sinceFiled,
        cell: (c) => <Signed v={c.sinceFiled}>{pct(c.sinceFiled)}</Signed>,
      },
    ],
    [lookup],
  );
  return (
    <>
      <div className="chip-groups">
        <Chips label="Best or worst" options={MODES} value={mode} onChange={onMode} />
        <Chips label="Buys from" options={WINDOWS} value={win} onChange={onWin} />
      </div>
      <p className="rule">
        New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or concentrated active funds.
        Stocks ≥ $300M market cap and ≥ $1 a share.
      </p>
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <>
          <ListTable
            key={mode}
            label={mode === "best" ? "Best calls" : "Worst calls"}
            noun="buys"
            columns={columns}
            rows={ranked}
            initial={{ key: "since", dir: mode === "best" ? -1 : 1 }}
            rowKey={(c) => `${c.row.fund_id}-${c.row.stock_id}-${c.row.q}`}
            empty="No buys in this window."
          />
          <p className="cap">
            "Since 13F went public" starts on the day the 13F was filed: what a copier could still have caught. Each
            list holds at most the 50 best and 50 worst buys at the last data build; the order here uses today's
            prices.
          </p>
        </>
      )}
    </>
  );
}

// ---- page ----------------------------------------------------------------------------

type TabId = "top" | "conviction" | "wins" | "crowded" | "calls";
const TABS: TabItem<TabId>[] = [
  { id: "top", label: "Top funds" },
  { id: "conviction", label: "Conviction moves" },
  { id: "wins", label: "Big wins & losses" },
  { id: "crowded", label: "Crowded buys" },
  { id: "calls", label: "Best & worst calls" },
];

export default function Home() {
  useTitle("Orca");
  const [tab, setTab] = useState<TabId>("top");
  // Chip choices live here so they survive switching to another tab and back.
  const [period, setPeriod] = useState<Period>("3y");
  const [mode, setMode] = useState<Mode>("best");
  const [win, setWin] = useState<CallWindow>("q");
  const [moveWin, setMoveWin] = useState<CallWindow>("q");
  const lookup = useLoad(loadLookup, []);

  let panel: ReactNode;
  if (tab === "top") panel = <TopFunds period={period} onPeriod={setPeriod} />;
  else if (lookup.status !== "ready") panel = <Status state={lookup} />;
  else if (tab === "conviction") panel = <Conviction lookup={lookup.data} win={moveWin} onWin={setMoveWin} />;
  else if (tab === "wins") panel = <WinsLosses lookup={lookup.data} />;
  else if (tab === "crowded") panel = <Crowded lookup={lookup.data} />;
  else panel = <Calls lookup={lookup.data} mode={mode} onMode={setMode} win={win} onWin={setWin} />;

  return (
    <div className="view">
      <div className="hero">
        <div className="sec">
          <p className="eyebrow">Quarterly 13F Data from SEC.gov</p>
          <h1>Fund Manager Research</h1>
        </div>
        <FundSearch />
      </div>

      <div className="sec">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Home lists" idPrefix="home" />
        <div className="sec" {...tabPanelProps("home", tab)}>
          {panel}
        </div>
        <p className="cap">All figures are estimates built from 13F filings, not a fund's real return.</p>
      </div>
    </div>
  );
}
