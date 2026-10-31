import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { ColumnChart } from "../charts/ColumnChart";
import { DivergingBars, type DivergingItem } from "../charts/DivergingBars";
import { Chips, type ChipOption } from "../components/Chips";
import { DataTable, type Column } from "../components/DataTable";
import { Section } from "../components/Section";
import { Signed } from "../components/Signed";
import { StockLabel } from "../components/StockLabel";
import { Tile, Tiles } from "../components/Tiles";
import {
  isFundFileMissing,
  isListedFund,
  loadContrib,
  loadExits,
  loadLatestPrices,
  loadPositions,
  loadSecurities,
  loadSummary,
  priceMap,
  stockMap,
  toRows,
  type Stock,
} from "../data/api";
import type { Contrib, ContribYear, Exits, PositionRow, Summary, YearsBlock } from "../data/types";
import { DASH, MINUS, count, fmtDate, money, pct, pp, qLabel, ratio, signClass } from "../lib/format";
import { liveValue, positionRows, profitablePct } from "../lib/live";
import { parseId } from "../lib/routeId";
import { useLoad } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";
import { FundTables } from "./FundTables";
import NotFound from "./NotFound";

// ---- loading ----------------------------------------------------------------

/** Everything the page shows, loaded together. */
type FundData = {
  summary: Summary;
  contrib: Contrib;
  positions: PositionRow[];
  exits: Exits;
  stocks: Map<number, Stock>;
  prices: Map<number, number>;
  /** Date of the latest prices (latest_prices.json `asof`): the IRR clock. */
  asof: string;
  /** Share of positions in profit at the latest prices; null when no position has a computable total. */
  profitable: number | null;
};

/** null when funds.json does not list the fund (R29): nothing of an unknown fund is requested. */
async function loadFund(id: number): Promise<FundData | null> {
  if (!(await isListedFund(id))) return null;
  const [summary, positionsFile, contrib, exits, securities, latest] = await Promise.all([
    loadSummary(id),
    loadPositions(id),
    loadContrib(id),
    loadExits(id),
    loadSecurities(),
    loadLatestPrices(),
  ]);
  const prices = priceMap(latest);
  const positions = positionRows(positionsFile);
  return {
    summary,
    contrib,
    positions,
    exits,
    stocks: stockMap(securities),
    prices,
    asof: latest.asof,
    profitable: profitablePct(positions, prices),
  };
}

// ---- small pieces -----------------------------------------------------------

/** Below this share of the book priced, the header carries a warning badge. */
const COVERAGE_WARN = 0.8;

const yrs = (x: number | null): string => (x == null || !Number.isFinite(x) ? DASH : `${x.toFixed(1)} yrs`);

/** An axis tick for a value already in percent: −2.5 → "−2.5%", 10 → "10%". */
const axisPct = (v: number): string => (v < 0 ? MINUS : "") + Math.abs(v).toFixed(1).replace(/\.0$/, "") + "%";

/** The "Show the numbers" / "Show the chart" button, and whether the table is the one showing. */
function useNumbersToggle(): [numbers: boolean, button: ReactNode] {
  const [numbers, setNumbers] = useState(false);
  const button = (
    <button type="button" className="linkbtn" onClick={() => setNumbers((n) => !n)}>
      {numbers ? "Show the chart" : "Show the numbers"}
    </button>
  );
  return [numbers, button];
}

// ---- header and tiles ---------------------------------------------------------

function Header({ summary: s, prices }: { summary: Summary; prices: Map<number, number> }) {
  const live = useMemo(() => liveValue(s.holdings_now, prices), [s.holdings_now, prices]);
  // Rounded down, so a book that is not fully priced never reads as 100% and a warning never reads "80%".
  const priced = Math.floor(s.priced_pct * 100 + 1e-9);
  return (
    <div className="fhead">
      <p className="eyebrow">{`13F-HR · Period ${qLabel(s.period_q)} · Filed ${fmtDate(s.filed)}`}</p>
      <h1>{s.name}</h1>
      <div className="meta">
        <span>
          13F book <b>{money(s.book)}</b>
        </span>
        <span>
          Live value <b>{money(live.value)}</b>
          {live.missing > 0 && (
            <>
              {" "}
              <span className="cap">{`${count(live.missing, "holding")} unpriced`}</span>
            </>
          )}
        </span>
        <span>
          <b>{count(s.n_holdings)}</b> {s.n_holdings === 1 ? "holding" : "holdings"}
        </span>
        {s.priced_pct < COVERAGE_WARN ? (
          <span className="badge" title="Part of this fund's reported book has no price, so its figures cover only the priced part.">
            {priced}% of book priced
          </span>
        ) : (
          <span>
            <b>{priced}%</b> of book priced
          </span>
        )}
        <span>
          Tracked since <b>{qLabel(s.tracked_since_q)}</b>
        </span>
      </div>
      {s.inactive && (
        <p className="note">This fund filed nothing in the latest two quarters, so these figures stop at its last filing.</p>
      )}
    </div>
  );
}

function MetricTiles({ summary, profitable }: { summary: Summary; profitable: number | null }) {
  const m = summary.metrics;
  const bestWorst = m.best_year && m.worst_year ? { best: m.best_year, worst: m.worst_year } : null;
  return (
    <div className="sec">
      <p className="eyebrow">Performance</p>
      <Tiles label="Performance">
        <Tile
          label="Return per year"
          value={pct(m.ann_return)}
          sub={m.first_year != null && m.last_year != null ? `${m.first_year}–${m.last_year}` : undefined}
          tone={signClass(m.ann_return)}
        />
        <Tile label="Sharpe ratio" value={ratio(m.sharpe)} sub="return above T-bills ÷ volatility" />
        <Tile label="Sortino ratio" value={ratio(m.sortino)} sub="same, counting only downside swings" />
        <Tile label="Volatility" value={pct(m.vol, 1, false)} sub="per year, from quarterly returns" />
        <Tile
          label="Max drawdown"
          value={pct(m.max_dd, 1, false)}
          sub="worst peak-to-trough at quarter ends"
          tone={signClass(m.max_dd)}
        />
        <Tile label="Calmar ratio" value={ratio(m.calmar)} sub="return per year ÷ max drawdown" />
        <Tile
          label="Best / worst year"
          value={bestWorst ? `${pct(bestWorst.best.ret, 0)} / ${pct(bestWorst.worst.ret, 0)}` : DASH}
          sub={bestWorst ? `${bestWorst.best.label} / ${bestWorst.worst.label}` : undefined}
        />
        <Tile
          label="Years positive"
          value={m.years_pos != null && m.years_total != null ? `${m.years_pos} of ${m.years_total}` : DASH}
          sub={`quarters positive: ${pct(m.quarters_pos_pct, 0, false)}`}
        />
      </Tiles>
      <p className="eyebrow">How they trade</p>
      <Tiles label="How they trade">
        <Tile label="Turnover per year" value={pct(m.turnover, 0, false)} sub="of fund size · lesser of buys or sells" />
        <Tile label="Avg hold length" value={yrs(m.hold_all)} sub={`sold positions only: ${yrs(m.hold_sold)}`} />
        <Tile label="Positions profitable" value={pct(profitable, 0, false)} sub="of stocks ever held, at latest prices" />
      </Tiles>
      <p className="cap">
        All figures are 13F estimates built from quarter-end holdings, so risk numbers understate swings inside a quarter.
        Sharpe and Sortino use 3-month T-bill rates as the risk-free rate.
      </p>
    </div>
  );
}

// ---- gains vs inflows -----------------------------------------------------------

type YearRow = {
  label: string;
  ret: number | null;
  start: number;
  end: number;
  gains: number;
  inflows: number;
  dividends: number;
  approx_ret: number | null;
};

const FLOW_COLUMNS: Column<YearRow>[] = [
  { header: "Year", align: "l", cell: (r) => r.label },
  { header: "Start value", cell: (r) => money(r.start) },
  { header: "Investment gains", cell: (r) => <Signed v={r.gains}>{money(r.gains, true)}</Signed> },
  { header: "Net inflows", cell: (r) => <Signed v={r.inflows}>{money(r.inflows, true)}</Signed> },
  { header: "End value", cell: (r) => money(r.end) },
  { header: "Dividends (in returns)", cell: (r) => money(r.dividends) },
];

function GainsVsInflows({ years }: { years: YearsBlock }) {
  const [numbers, toggle] = useNumbersToggle();
  const rows = useMemo(() => toRows<YearRow>(years), [years]);
  return (
    <Section
      id="fund-gains"
      title="Gains vs inflows"
      intro={
        <p>
          How much of the book's growth came from investment gains, and how much from net buying (money moved into
          stocks).
        </p>
      }
    >
      <div className="panel sec">
        {years.label.length === 0 ? (
          <p className="cap">No yearly figures yet</p>
        ) : (
          <>
            {numbers ? (
              <DataTable label="Gains vs inflows by year" columns={FLOW_COLUMNS} rows={rows} rowKey={(r) => r.label} />
            ) : (
              <ColumnChart
                cats={years.label}
                stacked
                series={[
                  { name: "Investment gains", color: "var(--s1)", values: years.gains },
                  { name: "Net inflows", color: "var(--s2)", values: years.inflows },
                ]}
                yFmt={(v) => money(v)}
                tipFmt={(v) => money(v, true)}
                topLabel={(i) => money(years.end[i])}
                extraTip={(i) => [{ value: money(years.end[i]), label: "end value" }]}
                height={270}
                label="Investment gains and net inflows by year"
              />
            )}
            {toggle}
          </>
        )}
      </div>
      <p className="cap">
        Net inflows are a proxy: net buying of reported stocks, not investor money. Dividends are counted in returns but
        not in this bar.
      </p>
    </Section>
  );
}

// ---- annual returns ---------------------------------------------------------------

const RETURN_COLUMNS: Column<YearRow>[] = [
  { header: "Year", align: "l", cell: (r) => r.label },
  { header: "Return (13F estimate)", cell: (r) => <Signed v={r.ret}>{pct(r.ret)}</Signed> },
];

/** R14: the latest full year when it is one of the labels, else the last label. */
function defaultYear(summary: Summary): string | null {
  const labels = summary.years.label;
  const last = summary.metrics.last_year;
  if (last != null && labels.includes(String(last))) return String(last);
  return labels.length > 0 ? labels[labels.length - 1] : null;
}

function AnnualReturns({
  years,
  yearLabels,
  year,
  onYear,
}: {
  years: YearsBlock;
  /** One chip per label: every year with contributions, bar or not (R24). */
  yearLabels: string[];
  year: string | null;
  onYear: (label: string) => void;
}) {
  const [numbers, toggle] = useNumbersToggle();
  const rows = useMemo(() => toRows<YearRow>(years), [years]);
  // A bar for each year with a chained return, in percent (R24).
  const bars = useMemo(() => {
    const out: { label: string; value: number }[] = [];
    years.label.forEach((label, i) => {
      const r = years.ret[i];
      if (r != null) out.push({ label, value: r * 100 });
    });
    return out;
  }, [years]);
  const chips = useMemo<ChipOption<string>[]>(() => yearLabels.map((label) => ({ id: label, label })), [yearLabels]);
  const selected = bars.findIndex((b) => b.label === year);

  return (
    <Section
      id="fund-annual"
      title="Annual returns"
      intro={
        <p className="hint">
          Click a year to see what drove it.
          {year !== null && (
            <>
              {" "}
              Showing <b>{year}</b>.
            </>
          )}
        </p>
      }
    >
      <div className="panel sec">
        {numbers ? (
          <DataTable label="Annual returns by year" columns={RETURN_COLUMNS} rows={rows} rowKey={(r) => r.label} />
        ) : bars.length === 0 ? (
          <p className="cap">No annual returns yet</p>
        ) : (
          <ColumnChart
            cats={bars.map((b) => b.label)}
            series={[{ name: "Return (13F estimate)", color: "var(--s1)", values: bars.map((b) => b.value) }]}
            selected={selected >= 0 ? selected : undefined}
            onSelect={(i) => onYear(bars[i].label)}
            yFmt={axisPct}
            tipFmt={(v) => pct(v / 100)}
            height={260}
            label="Annual return by year (13F estimate)"
          />
        )}
        {year !== null && chips.length > 0 && <Chips label="Pick a year" options={chips} value={year} onChange={onYear} />}
        {bars.length > 0 && toggle}
      </div>
    </Section>
  );
}

// ---- what drove the year ------------------------------------------------------------

type Contribution = { stockId: number; points: number; pnl: number };

/** One year's contributions, largest first. */
function contributions(col: ContribYear | undefined): Contribution[] {
  if (!col) return [];
  return col.stock_id
    .map((stockId, i) => ({ stockId, points: col.points[i], pnl: col.pnl[i] }))
    .sort((a, b) => b.points - a.points);
}

/** R32: this many of the largest and of the smallest contributions get a bar of their own. */
const BARS_AT_EACH_END = 15;
/** A year with no more stocks than this draws them all; a bar per stock would run to thousands of rows for a big fund. */
const MAX_ALL_BARS = 2 * BARS_AT_EACH_END + 1;

/** The bars to draw for contributions sorted largest first: all of them, or both ends and one row adding up the rest (R32). */
function barItems(sorted: Contribution[], stocks: Map<number, Stock>): DivergingItem[] {
  const bar = (c: Contribution): DivergingItem => {
    const stock = stocks.get(c.stockId);
    return {
      label: stock?.ticker ?? `#${c.stockId}`,
      sub: stock?.name ?? "",
      value: c.points,
      extra: [{ value: money(c.pnl, true), label: "P&L" }],
    };
  };
  if (sorted.length <= MAX_ALL_BARS) return sorted.map(bar);
  const rest = sorted.slice(BARS_AT_EACH_END, sorted.length - BARS_AT_EACH_END);
  const others: DivergingItem = {
    label: `${count(rest.length)} other stocks`,
    sub: "the rest, added together",
    value: rest.reduce((t, c) => t + c.points, 0),
    extra: [{ value: money(rest.reduce((t, c) => t + c.pnl, 0), true), label: "P&L" }],
    sum: true,
  };
  return [
    ...sorted.slice(0, BARS_AT_EACH_END).map(bar),
    others,
    ...sorted.slice(sorted.length - BARS_AT_EACH_END).map(bar),
  ];
}

type ContributionRow = Contribution & { stock: Stock | undefined };

const CONTRIBUTION_COLUMNS: Column<ContributionRow>[] = [
  {
    header: "Stock",
    align: "l",
    cell: (r) => (
      <span className="tick">
        <StockLabel stock={r.stock} stockId={r.stockId} />
      </span>
    ),
  },
  { header: "Contribution", cell: (r) => <Signed v={r.points}>{pp(r.points)}</Signed> },
  { header: "P&L", cell: (r) => <Signed v={r.pnl}>{money(r.pnl, true)}</Signed> },
];

function Contributions({
  label,
  years,
  contrib,
  stocks,
}: {
  label: string;
  years: YearsBlock;
  contrib: Contrib;
  stocks: Map<number, Stock>;
}) {
  const sorted = useMemo(() => contributions(contrib.by_year[label]), [contrib, label]);
  const items = useMemo(() => barItems(sorted, stocks), [sorted, stocks]);
  const rows = useMemo<ContributionRow[]>(() => sorted.map((c) => ({ ...c, stock: stocks.get(c.stockId) })), [sorted, stocks]);
  const [all, setAll] = useState(false);
  const capped = sorted.length > MAX_ALL_BARS;
  const total = sorted.reduce((t, c) => t + c.points, 0);
  const at = years.label.indexOf(label);
  const chained = at >= 0 ? years.ret[at] : null;

  return (
    <Section
      id="fund-drove"
      title={`What drove ${label}`}
      intro={
        <p>
          Each stock's P&amp;L that year as percentage points of the fund's return. Contributions add up to an approximate
          return, shown below.
        </p>
      }
    >
      <div className="panel sec">
        {items.length === 0 ? (
          <p className="cap">No positions this year</p>
        ) : (
          <>
            {capped && all ? (
              <DataTable
                label={`All contributions to ${label}`}
                columns={CONTRIBUTION_COLUMNS}
                rows={rows}
                virtual
                rowKey={(r) => r.stockId}
              />
            ) : (
              <DivergingBars items={items} fmt={pp} label={`Contribution to ${label} return by stock`} />
            )}
            {capped && (
              <button type="button" className="linkbtn" onClick={() => setAll((a) => !a)}>
                {all ? "Show the chart" : `Show all ${count(sorted.length)}`}
              </button>
            )}
            <p className="cap">{`Contributions add up to ${pp(total)}, an approximate return. The chained quarterly return for ${label} is ${pct(chained)}.`}</p>
            {capped && !all && (
              <p className="cap">
                {`Showing the ${BARS_AT_EACH_END} largest and ${BARS_AT_EACH_END} smallest of ${count(sorted.length, "stock")}. The other ${count(rows.length - 2 * BARS_AT_EACH_END)} are added together in one bar, which stops at the edge of the chart if it is longer than the scale.`}
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// ---- page ------------------------------------------------------------------------------

function FundView({ data }: { data: FundData }) {
  const { summary, contrib, positions, exits, stocks, prices, asof, profitable } = data;
  useTitle(`${summary.name} · Orca`);
  const [year, setYear] = useState(() => defaultYear(summary));
  return (
    <div className="view">
      <Header summary={summary} prices={prices} />
      <MetricTiles summary={summary} profitable={profitable} />
      <GainsVsInflows years={summary.years} />
      <AnnualReturns years={summary.years} yearLabels={contrib.years} year={year} onYear={setYear} />
      {year !== null && <Contributions label={year} years={summary.years} contrib={contrib} stocks={stocks} />}
      <FundTables fundId={summary.id} positions={positions} exits={exits} prices={prices} stocks={stocks} asof={asof} />
    </div>
  );
}

function FundLoader({ id }: { id: number }) {
  // The page is keyed by fund id, so `id` never changes within one instance.
  const state = useLoad(() => loadFund(id), [id]);
  if (state.status === "loading") {
    return (
      <p className="cap" role="status">
        Loading…
      </p>
    );
  }
  if (state.status === "error") {
    return isFundFileMissing(state.error, id) ? (
      <NotFound />
    ) : (
      <p className="note" role="alert">
        Couldn't load this fund. Check your connection and reload the page.
      </p>
    );
  }
  return state.data === null ? <NotFound /> : <FundView data={state.data} />;
}

export default function Fund() {
  const id = parseId(useParams().id);
  // Keyed by id, so moving to another fund drops the year picked on this one.
  return id === null ? <NotFound /> : <FundLoader key={id} id={id} />;
}
