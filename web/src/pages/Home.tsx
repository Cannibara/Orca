import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Chips, type ChipOption } from "../components/Chips";
import { DataTable, type Column } from "../components/DataTable";
import { Tabs, tabPanelProps, type TabItem } from "../components/Tabs";
import { loadFunds, loadHome, loadLatestPrices, loadSecurities, priceMap } from "../data/api";
import type {
  CallRow,
  ConvictionRow,
  CrowdedRow,
  FundsIndex,
  JustFiledRow,
  TopRow,
  WinLossRow,
} from "../data/types";
import { DASH, fmtDate, money, pct, pp, px, qLabel, ratio, signClass } from "../lib/format";
import { useLoad, type Load } from "../lib/useLoad";

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
  stocks: Map<number, { ticker: string; name: string }>;
  prices: Map<number, number>;
};

async function loadLookup(): Promise<Lookup> {
  const [sec, lp] = await Promise.all([loadSecurities(), loadLatestPrices()]);
  const stocks = new Map<number, { ticker: string; name: string }>();
  sec.stock_id.forEach((id, i) => stocks.set(id, { ticker: sec.ticker[i], name: sec.name[i] }));
  return { stocks, prices: priceMap(lp) };
}

// ---- cells --------------------------------------------------------------------

/** Price move from `base` to `price`; null when either is missing. */
function change(price: number | undefined, base: number): number | null {
  return price === undefined || !(base > 0) ? null : price / base - 1;
}

function Signed({ v, children }: { v: number | null; children: ReactNode }) {
  return <span className={signClass(v) || undefined}>{children}</span>;
}

function FundLink({ id, name }: { id: number; name: string }) {
  return <Link to={`/fund/${id}`}>{name}</Link>;
}

function StockLabel({ lookup, stockId }: { lookup: Lookup; stockId: number }) {
  const s = lookup.stocks.get(stockId);
  return (
    <>
      <span className="mono">{s?.ticker ?? `#${stockId}`}</span>
      {s && (
        <>
          {" "}
          <span className="cap">{s.name}</span>
        </>
      )}
    </>
  );
}

/** Ticker with the name beside it, linking to the stock's page within a fund. */
function StockLink({ lookup, fundId, stockId }: { lookup: Lookup; fundId: number; stockId: number }) {
  return (
    <Link className="tick" to={`/fund/${fundId}/stock/${stockId}`}>
      <StockLabel lookup={lookup} stockId={stockId} />
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
  const matches = useMemo(() => (funds.status === "ready" ? matchFunds(funds.data, query) : []), [funds, query]);
  const typed = query.trim() !== "";

  return (
    <div className="search-box">
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
          id="fund-search"
          type="search"
          placeholder="Type a fund name"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
      {typed && funds.status !== "error" && (
        <div className="results">
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
                      {money(m.book)} · {m.n} positions
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

type Period = "1y" | "3y" | "5y" | "max";
const PERIODS: ChipOption<Period>[] = [
  { id: "1y", label: "1 year" },
  { id: "3y", label: "3 years" },
  { id: "5y", label: "5 years" },
  { id: "max", label: "Since start" },
];

const TOP_COLUMNS: Column<TopRow>[] = [
  { header: "Fund", align: "l", cell: (r) => <FundLink id={r.fund_id} name={r.name} /> },
  { header: "13F book", cell: (r) => money(r.book) },
  { header: "Positions", cell: (r) => r.n_positions },
  { header: "Return / yr", cell: (r) => <Signed v={r.ann_return}>{pct(r.ann_return)}</Signed> },
  { header: "Worst drop", cell: (r) => pct(r.max_dd, 0, false) },
  { header: "Sharpe", cell: (r) => ratio(r.sharpe) },
];

function TopFunds({ period, onPeriod }: { period: Period; onPeriod: (p: Period) => void }) {
  const list = useLoad(() => loadHome(`top_${period}`), [period]);
  return (
    <>
      <Chips label="Period" options={PERIODS} value={period} onChange={onPeriod} />
      <p className="rule">
        Who qualifies: 13F book ≥ $1B · ≥ 12 quarters filed · ≥ 4 positions · ≥ 80% of book priced · no banks,
        insurers, pensions or brokers. Index giants sit in a separate list.
      </p>
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <>
          <DataTable
            label="Top funds"
            columns={TOP_COLUMNS}
            rows={list.data.eligible}
            rowKey={(r) => r.fund_id}
            empty="No fund qualifies for this period yet."
          />
          {list.data.giants.length > 0 && (
            <>
              <h3>Index giants</h3>
              <DataTable label="Index giants" columns={TOP_COLUMNS} rows={list.data.giants} rowKey={(r) => r.fund_id} />
            </>
          )}
        </>
      )}
    </>
  );
}

const MOVE_LABEL: Record<ConvictionRow["move"], string> = { new: "New", add: "Add", exit: "Exit" };

function Conviction({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("conviction"), []);
  if (list.status !== "ready") return <Status state={list} />;
  const columns: Column<ConvictionRow>[] = [
    { header: "Fund", align: "l", cell: (r) => <FundLink id={r.fund_id} name={r.name} /> },
    { header: "Stock", align: "l", cell: (r) => <StockLink lookup={lookup} fundId={r.fund_id} stockId={r.stock_id} /> },
    {
      header: "Move",
      align: "l",
      cell: (r) => <span className={`pill ${r.move === "exit" ? "sell" : "buy"}`}>{MOVE_LABEL[r.move]}</span>,
    },
    { header: "Weight now", cell: (r) => pct(r.weight_now, 1, false) },
    { header: "Change", cell: (r) => <Signed v={r.change_pts}>{pp(r.change_pts)}</Signed> },
    { header: "Est. price", cell: (r) => px(r.est_price) },
    {
      header: "Since",
      cell: (r) => {
        const since = change(lookup.prices.get(r.stock_id), r.est_price);
        return <Signed v={since}>{pct(since)}</Signed>;
      },
    },
  ];
  return (
    <>
      <p className="rule">
        Funds: concentrated active managers (4–60 positions, top 10 ≥ 50% of book, book ≥ $500M). A move counts if
        it's a new position or add that takes the stock to ≥ 5% of the book, a weight jump of ≥ 3 points, or the exit
        of a ≥ 5% position.
      </p>
      <DataTable
        label="Conviction moves"
        columns={columns}
        rows={list.data.rows}
        empty="No conviction moves this quarter."
      />
      <p className="cap">
        {qLabel(list.data.latest_q)} filings. "Since" = price change from the estimated trade price to today.
      </p>
    </>
  );
}

function WinsLosses({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("wins_losses"), []);
  if (list.status !== "ready") return <Status state={list} />;
  const columns: Column<WinLossRow>[] = [
    { header: "Fund", align: "l", cell: (r) => <FundLink id={r.fund_id} name={r.name} /> },
    { header: "Stock", align: "l", cell: (r) => <StockLink lookup={lookup} fundId={r.fund_id} stockId={r.stock_id} /> },
    { header: "Quarter P&L", cell: (r) => <Signed v={r.pnl}>{money(r.pnl, true)}</Signed> },
  ];
  return (
    <>
      <p className="rule">
        Largest single-position gains and losses in {qLabel(list.data.latest_q)}, among funds that qualify for Top
        funds.
      </p>
      <h3>Biggest wins</h3>
      <DataTable label="Biggest wins" columns={columns} rows={list.data.wins} empty="No wins to show." />
      <h3>Biggest losses</h3>
      <DataTable label="Biggest losses" columns={columns} rows={list.data.losses} empty="No losses to show." />
    </>
  );
}

function JustFiled({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("just_filed"), []);
  if (list.status !== "ready") return <Status state={list} />;
  const columns: Column<JustFiledRow>[] = [
    { header: "Fund", align: "l", cell: (r) => <FundLink id={r.fund_id} name={r.name} /> },
    { header: "Filed", cell: (r) => fmtDate(r.filed) },
    { header: "Period", cell: (r) => qLabel(r.period_q) },
    { header: "13F book", cell: (r) => money(r.book) },
    {
      header: "Headline change",
      align: "l",
      cell: (r) =>
        r.headline_stock_id == null ? (
          DASH
        ) : (
          <>
            <StockLink lookup={lookup} fundId={r.fund_id} stockId={r.headline_stock_id} />{" "}
            <Signed v={r.headline_change_pts}>{pp(r.headline_change_pts)}</Signed>
          </>
        ),
    },
  ];
  return (
    <>
      <p className="rule">Newest 13F filings, each with its headline change.</p>
      <DataTable label="Just filed" columns={columns} rows={list.data.rows} empty="No new filings." />
    </>
  );
}

function Crowded({ lookup }: { lookup: Lookup }) {
  const list = useLoad(() => loadHome("crowded"), []);
  if (list.status !== "ready") return <Status state={list} />;
  const columns: Column<CrowdedRow>[] = [
    {
      header: "Stock",
      align: "l",
      cell: (r) => (
        <span className="tick">
          <StockLabel lookup={lookup} stockId={r.stock_id} />
        </span>
      ),
    },
    { header: "Funds buying", cell: (r) => r.funds_buying },
    { header: "Total bought", cell: (r) => money(r.total_bought) },
    { header: "Avg weight after", cell: (r) => pct(r.avg_weight_after, 1, false) },
  ];
  return (
    <>
      <p className="rule">
        Stocks bought by several concentrated active funds in the same quarter ({qLabel(list.data.latest_q)}).
      </p>
      <DataTable
        label="Crowded buys"
        columns={columns}
        rows={list.data.rows}
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
  const columns: Column<Call>[] = [
    {
      header: "Stock",
      align: "l",
      cell: (c) => <StockLink lookup={lookup} fundId={c.row.fund_id} stockId={c.row.stock_id} />,
    },
    { header: "Fund", align: "l", cell: (c) => <FundLink id={c.row.fund_id} name={c.row.name} /> },
    { header: "Bought", cell: (c) => qLabel(c.row.q) },
    { header: "Est. buy price", cell: (c) => px(c.row.est_price) },
    { header: "Price now", cell: (c) => px(c.price ?? null) },
    { header: "Since fund's buy", cell: (c) => <Signed v={c.sinceBuy}>{pct(c.sinceBuy)}</Signed> },
    { header: "Since 13F went public", cell: (c) => <Signed v={c.sinceFiled}>{pct(c.sinceFiled)}</Signed> },
  ];
  return (
    <>
      <div className="chip-groups">
        <Chips label="Best or worst" options={MODES} value={mode} onChange={onMode} />
        <Chips label="Buys from" options={WINDOWS} value={win} onChange={onWin} />
      </div>
      <p className="rule">
        New positions or adds ≥ 1% of the book, by funds that qualify for Top funds or Conviction moves. Stocks ≥
        $300M market cap and ≥ $1 a share.
      </p>
      {list.status !== "ready" ? (
        <Status state={list} />
      ) : (
        <>
          <DataTable
            label={mode === "best" ? "Best calls" : "Worst calls"}
            columns={columns}
            rows={ranked}
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

type TabId = "top" | "conviction" | "wins" | "filed" | "crowded" | "calls";
const TABS: TabItem<TabId>[] = [
  { id: "top", label: "Top funds" },
  { id: "conviction", label: "Conviction moves" },
  { id: "wins", label: "Big wins & losses" },
  { id: "filed", label: "Just filed" },
  { id: "crowded", label: "Crowded buys" },
  { id: "calls", label: "Best & worst calls" },
];

export default function Home() {
  const [tab, setTab] = useState<TabId>("top");
  // Chip choices live here so they survive switching to another tab and back.
  const [period, setPeriod] = useState<Period>("3y");
  const [mode, setMode] = useState<Mode>("best");
  const [win, setWin] = useState<CallWindow>("q");
  const lookup = useLoad(loadLookup, []);

  let panel: ReactNode;
  if (tab === "top") panel = <TopFunds period={period} onPeriod={setPeriod} />;
  else if (lookup.status !== "ready") panel = <Status state={lookup} />;
  else if (tab === "conviction") panel = <Conviction lookup={lookup.data} />;
  else if (tab === "wins") panel = <WinsLosses lookup={lookup.data} />;
  else if (tab === "filed") panel = <JustFiled lookup={lookup.data} />;
  else if (tab === "crowded") panel = <Crowded lookup={lookup.data} />;
  else panel = <Calls lookup={lookup.data} mode={mode} onMode={setMode} win={win} onWin={setWin} />;

  return (
    <div className="view">
      <div className="hero">
        <div className="sec">
          <p className="eyebrow">13F filings, turned into results</p>
          <h1>See how the big funds really did, stock by stock</h1>
          <p className="lede">
            Quarterly SEC filings show what each fund owns. Orca estimates what they paid, what they made, and whether
            their sells were smart.
          </p>
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
