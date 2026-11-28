import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useTooltip } from "../charts/Tooltip";
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
import { fundTitle, tidyName } from "../lib/format";
import { positionRows, profitablePct } from "../lib/live";
import { parseId } from "../lib/routeId";
import { useLoad, type Load } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";
import { AboutPanel } from "../fund/AboutPanel";
import { AumPanel } from "../fund/AumPanel";
import { DrivePanel } from "../fund/DrivePanel";
import { FundHeader, tabOfHash, type FundTab } from "../fund/FundHeader";
import { HoldingsTab } from "../fund/HoldingsTab";
import { KpiStrip } from "../fund/KpiStrip";
import { WeeklyStoreContext, useHoldingsState } from "../fund/usePositionData";
import { WhatIfPanel } from "../fund/WhatIfPanel";
import { ReturnsPanel } from "../fund/ReturnsPanel";
import type { Tier } from "../fund/skill";
import { loadSkillData, SPECIALIZATION_HOLD, SpecializationTab, useSkillData, type SkillData } from "../fund/SkillPanels";
import type { MapView } from "../fund/SkillMapPanel";
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

// ---- opening a fund from another's map ---------------------------------------------------------------

/**
 * A click on a peer's dot on the Specialization map opens that fund in place (owner 2026-11-28): same tab, same
 * level, same comparison, and its map where the last one was on screen; only the fund changes. The page stays as
 * it is while the fund loads, then swaps in one frame. Both history entries carry this, so Back and Forward
 * return to each fund the same way.
 */
type Hop = MapView & {
  tier: Tier;
  /** Where the map's chart sat in the viewport (px from its top); null when it was not on the page. */
  anchor: number | null;
};

function hopOf(state: unknown): Hop | null {
  const h = (state as { hop?: Hop } | null)?.hop;
  return h && typeof h === "object" && (h.tier === 1 || h.tier === 2 || h.tier === 3) ? h : null;
}

/** Funds loaded for a hop (the one opened and the one left), so either opens without a Loading frame. */
type Warm = { fund: FundData | null; skill: SkillData | null };
const warm = new Map<number, Warm>();
const WARM_MAX = 4;

function keepWarm(id: number, w: Warm) {
  warm.delete(id);
  warm.set(id, w);
  for (const k of warm.keys()) {
    if (warm.size <= WARM_MAX) break;
    warm.delete(k);
  }
}

/** The map's chart, else its panel: the part of the page a hop holds still. */
const mapAnchor = () => document.querySelector<Element>(".fp .mapp svg.viz") ?? document.querySelector<Element>(".fp .mapp");

/** The tab the URL's hash picks, and a way to open another (it replaces the hash: a tab is not a page to go back to). */
function useFundTab(): [FundTab, (t: FundTab) => void] {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tip = useTooltip();
  const tab = tabOfHash(hash);
  const open = (t: FundTab) => {
    if (t === tab) return;
    tip.hide();
    navigate({ hash: "#" + t }, { replace: true });
  };
  // A long tab can leave the reader far down the page: bring the tab strip back under the sticky top bar.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const strip = document.querySelector<HTMLElement>(".fp .tabs");
    if (!strip || typeof window.scrollTo !== "function") return;
    const top = document.querySelector<HTMLElement>("header.top");
    const th = top ? top.getBoundingClientRect().height : 0;
    const r = strip.getBoundingClientRect();
    if (r.top < th) window.scrollTo({ top: window.scrollY + r.top - th - 8, behavior: "auto" });
  }, [tab]);
  return [tab, open];
}

function FundView({ data, ready, hop }: { data: FundData; ready?: SkillData | null; hop: Hop | null }) {
  const { summary, contrib, positions, stocks, prices, asof } = data;
  useTitle(fundTitle(summary.name));
  const [tab, openTab] = useFundTab();
  const navigate = useNavigate();
  const location = useLocation();
  const tip = useTooltip();
  // The Holdings tab's period and weekly files live here, so a visit to another tab keeps them.
  const holdings = useHoldingsState(summary, positions, prices, asof);
  const series = useMemo(() => buildSeries(summary), [summary]);
  // The page's shared state: the window of years, the selected year, the annualised-return bracket and the
  // What-drove period (the last two as year labels, so they survive a change of window).
  const [range, setRangeState] = useState<Range>("15");
  const [sel, setSel] = useState<string | null>(() => (summary.years.label.length > 0 ? defaultYearLabel(summary) : null));
  const [br, setBr] = useState<Span | null>(null);
  const [cr, setCr] = useState<Span | null>(null);
  const win = useMemo(() => windowYears(series, range), [series, range]);
  // Specialization: the sector file (loaded when the tab first opens) and the level choices are judged at (R9).
  const skill = useSkillData(summary.id, tab === "specialization" && !SPECIALIZATION_HOLD, ready);
  const [tier, setTier] = useState<Tier>(hop?.tier ?? 2);
  // SEC names come in capitals with legal suffixes; the new panels print them tidied.
  const names = useMemo(() => new Map([...stocks].map(([id, s]) => [id, { ...s, name: tidyName(s.name) }])), [stocks]);

  const setRange = (r: Range) => {
    setRangeState(r);
    const next = windowYears(series, r);
    if (sel === null || !next.years.some((y) => y.label === sel)) setSel(lastFullLabel(next.years));
  };
  // Picking a year selects it and resets Return constituents to just that year.
  const select = (label: string) => {
    setSel(label);
    setCr({ a: label, b: label });
  };

  // A peer's dot: load that fund (its page and sector file), then open it in this place. A later click, another
  // tab, another level or leaving the page drops a hop still loading.
  const hops = useRef(0);
  useEffect(() => () => void (hops.current += 1), [tab, tier]);
  const openPeer = (to: number, view: MapView) => {
    const n = ++hops.current;
    Promise.all([loadFund(to), loadSkillData(to)]).then(
      ([fund, sk]) => keepWarm(to, { fund, skill: sk }),
      () => undefined, // its page loads again and says what failed
    ).then(() => {
      if (n !== hops.current) return;
      tip.hide();
      const el = mapAnchor();
      const at: Hop = { ...view, tier, anchor: el ? el.getBoundingClientRect().top : null };
      // this fund too, as it is now, for Back
      if (skill?.status === "ready") keepWarm(summary.id, { fund: data, skill: skill.data });
      navigate(location, { replace: true, state: { hop: at } });
      navigate(`/fund/${to}#specialization`, { state: { hop: at } });
    });
  };

  // Opened by a hop: put the map back where it was on screen (before the first paint, so nothing jumps).
  useLayoutEffect(() => {
    const el = hop?.anchor != null ? mapAnchor() : null;
    if (!el || hop?.anchor == null || typeof window.scrollTo !== "function") return;
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - hop.anchor, behavior: "instant" });
    // once, on opening
  }, []);

  return (
    <WeeklyStoreContext.Provider value={holdings.store}>
      <div className="fp">
        <div className="fp-main">
          <FundHeader summary={summary} positionsEver={positions.length} tab={tab} onTab={openTab} />
          {/* Only the open tab's panels are mounted. */}
          <div className="tp" role="tabpanel" id={"fund-panel-" + tab} aria-labelledby={"fund-tab-" + tab}>
            {tab === "holdings" && (
              <HoldingsTab
                fundId={summary.id}
                h={holdings}
                prices={prices}
                stocks={names}
                tiles={<KpiStrip group="holdings" series={series} win={win} br={br} summary={summary} profitable={data.profitable} />}
                returns={<ReturnsPanel series={series} win={win} range={range} onRange={setRange} sel={sel} onSelect={select} br={br} onBr={setBr} />}
              />
            )}
            {/* Analysis reads the window, year and bracket picked on Holdings' Annual returns; the state lives here. */}
            {tab === "analysis" && (
              <>
                <KpiStrip group="analysis" series={series} win={win} br={br} summary={summary} profitable={data.profitable} />
                <AumPanel series={series} win={win} />
                <DrivePanel series={series} win={win} contrib={contrib} stocks={names} sel={sel} cr={cr} onCr={setCr} />
                <WhatIfPanel fundId={summary.id} positions={positions} exits={data.exits} prices={prices} stocks={names} asof={asof} summary={summary} />
              </>
            )}
            {tab === "specialization" && (
              <SpecializationTab
                state={skill}
                tier={tier}
                onTier={setTier}
                fundId={summary.id}
                name={summary.name}
                stocks={names}
                view={hop ?? undefined}
                onPeer={openPeer}
              />
            )}
            {tab === "about" && <AboutPanel summary={summary} />}
          </div>
          <p className="fp-foot">
            Source: SEC Form 13F-HR filings, quarterly. Every figure is an Orca estimate built from quarter-end holdings, so risk numbers
            understate swings inside a quarter.
          </p>
        </div>
      </div>
    </WeeklyStoreContext.Provider>
  );
}

function FundLoader({ id }: { id: number }) {
  const hop = hopOf(useLocation().state);
  // A fund a hop loaded ahead opens on its first frame, so the page swaps funds without a Loading frame.
  const [warmed] = useState(() => (hop ? warm.get(id) : undefined));
  // The page is keyed by fund id, so `id` never changes within one instance.
  const loaded = useLoad(() => (warmed ? Promise.resolve(warmed.fund) : loadFund(id)), [id]);
  const state: Load<FundData | null> = warmed ? { status: "ready", data: warmed.fund } : loaded;
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
  return state.data === null ? <NotFound /> : <FundView data={state.data} ready={warmed?.skill} hop={hop} />;
}

export default function Fund() {
  const id = parseId(useParams().id);
  // Keyed by id, so moving to another fund drops the year picked on this one.
  return id === null ? <NotFound /> : <FundLoader key={id} id={id} />;
}
