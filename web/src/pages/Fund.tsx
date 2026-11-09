import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
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
  type Stock,
} from "../data/api";
import type { Contrib, Exits, PositionRow, Summary } from "../data/types";
import { tidyName } from "../lib/format";
import { positionRows, profitablePct } from "../lib/live";
import { parseId } from "../lib/routeId";
import { useLoad } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";
import { AumPanel } from "../fund/AumPanel";
import { DrivePanel } from "../fund/DrivePanel";
import { FundHeader } from "../fund/FundHeader";
import { KpiStrip } from "../fund/KpiStrip";
import { PositionsPanel } from "../fund/PositionsPanel";
import { WhatIfPanel } from "../fund/WhatIfPanel";
import { ReturnsPanel } from "../fund/ReturnsPanel";
import { buildSeries, defaultYearLabel, lastFullLabel, windowYears, type Range } from "../fund/series";
import type { Span } from "../fund/span";
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

function FundView({ data }: { data: FundData }) {
  const { summary, contrib, positions, stocks, prices, asof } = data;
  useTitle(`${summary.name} · Orca`);
  const series = useMemo(() => buildSeries(summary), [summary]);
  // The page's shared state: the window of years, the selected year, the annualised-return bracket and the
  // What-drove period (the last two as year labels, so they survive a change of window).
  const [range, setRangeState] = useState<Range>("15");
  const [sel, setSel] = useState<string | null>(() => (summary.years.label.length > 0 ? defaultYearLabel(summary) : null));
  const [br, setBr] = useState<Span | null>(null);
  const [cr, setCr] = useState<Span | null>(null);
  const win = useMemo(() => windowYears(series, range), [series, range]);
  // SEC names come in capitals with legal suffixes; the new panels print them tidied.
  const names = useMemo(() => new Map([...stocks].map(([id, s]) => [id, { ...s, name: tidyName(s.name) }])), [stocks]);

  const setRange = (r: Range) => {
    setRangeState(r);
    const next = windowYears(series, r);
    if (sel === null || !next.years.some((y) => y.label === sel)) setSel(lastFullLabel(next.years));
  };
  // Picking a year selects it and resets What drove to just that year.
  const select = (label: string) => {
    setSel(label);
    setCr({ a: label, b: label });
  };

  return (
    <div className="fp">
      <div className="fp-main">
        <FundHeader summary={summary} positionsEver={positions.length} />
        <KpiStrip series={series} win={win} br={br} summary={summary} profitable={data.profitable} />
        <ReturnsPanel series={series} win={win} range={range} onRange={setRange} sel={sel} onSelect={select} br={br} onBr={setBr} />
        <DrivePanel series={series} win={win} contrib={contrib} stocks={names} sel={sel} cr={cr} onCr={setCr} />
        <AumPanel series={series} win={win} />
        <PositionsPanel fundId={summary.id} summary={summary} positions={positions} prices={prices} stocks={names} asof={asof} />
        <WhatIfPanel fundId={summary.id} positions={positions} exits={data.exits} prices={prices} stocks={names} asof={asof} summary={summary} />
        <p className="fp-foot">
          Source: SEC Form 13F-HR filings, quarterly. Every figure is an Orca estimate built from quarter-end holdings, so risk numbers
          understate swings inside a quarter.
        </p>
      </div>
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
