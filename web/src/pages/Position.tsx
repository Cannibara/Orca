// One fund's position in one stock: what it cost, what it is worth at the latest price, and every
// trade behind it. Every figure that depends on the latest price is worked out here from latest_prices.json.
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PriceChart } from "../charts/PriceChart";
import { ThemeToggle } from "../components/ThemeToggle";
import { StepChart } from "../charts/StepChart";
import {
  NotFoundError,
  isFundFileMissing,
  isListedFund,
  loadLatestPrices,
  loadPositions,
  loadSecurities,
  loadSummary,
  loadWeekly,
  priceDates,
  priceMap,
  yearsSince2013,
} from "../data/api";
import type { PositionRow, Summary, Trade, Weekly } from "../data/types";
import { fMm, qShort } from "../fund/fmt";
import { DASH, fmtDate, money, pct, printsZero, px, qLabel, sgn, shareCount, signClass, tidyName } from "../lib/format";
import { irr, positionFlows, positionRows, returnPct, totalPnl, tradeMove, type Move } from "../lib/live";
import { parseId } from "../lib/routeId";
import { useLoad } from "../lib/useLoad";
import { useTitle } from "../lib/useTitle";
import NotFound from "./NotFound";
import "./position.css";
import "./state.css";

// ---- loading ----------------------------------------------------------------

/** What securities.json says about the stock; undefined when it lists no such stock. */
type Security = { ticker: string; name: string; sector: string };

/** Everything the page shows, loaded together. */
type PositionData = {
  summary: Summary;
  position: PositionRow;
  security: Security | undefined;
  /** Latest close and its date; undefined when the stock has none. */
  price: number | undefined;
  priceDate: string | undefined;
  /** Date of the latest prices (latest_prices.json `asof`): the IRR clock. */
  asof: string;
  /** null when the stock has no weekly file (it was never priced): the page says there is no price history. */
  weekly: Weekly | null;
};

/**
 * null when the fund or the stock does not exist (R29): funds.json lists the funds, the fund's own
 * positions list its stocks, and nothing of an unknown one is requested.
 */
async function loadPosition(fundId: number, stockId: number): Promise<PositionData | null> {
  if (!(await isListedFund(fundId))) return null;
  const [summary, positionsFile, securities, latest] = await Promise.all([
    loadSummary(fundId),
    loadPositions(fundId),
    loadSecurities(),
    loadLatestPrices(),
  ]);
  const position = positionRows(positionsFile).find((r) => r.stock_id === stockId);
  if (!position) return null;
  // Only now: a stock the fund never held has nothing to ask for, and one that was never priced has no file (R28).
  const weekly = await loadWeekly(stockId).catch((err: unknown) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  const at = securities.stock_id.indexOf(stockId);
  return {
    summary,
    position,
    security: at < 0 ? undefined : { ticker: securities.ticker[at], name: securities.name[at], sector: securities.sector[at] },
    price: priceMap(latest).get(stockId),
    priceDate: priceDates(latest).get(stockId),
    asof: latest.asof,
    weekly,
  };
}

// ---- trades table -----------------------------------------------------------------

/** The Move column's boxes, tinted like the fund page's "Last change" cells. */
const MOVE: Record<Move, { word: string; tone: "add" | "trim" | "sold" }> = {
  New: { word: "New", tone: "add" },
  Add: { word: "Added", tone: "add" },
  Trim: { word: "Trimmed", tone: "trim" },
  Exit: { word: "Sold all", tone: "sold" },
};

/** Column widths in px: they add up to the table's minimum width, below which it scrolls inside its wrapper. */
const TRADE_COLS = [
  { head: "Quarter", w: 84, left: true },
  { head: "Move", w: 112, left: true },
  { head: "Shares", w: 120 },
  { head: "Est. price (VWAP)", w: 124 },
  { head: "Quarter range", w: 152 },
  { head: "$ value", w: 92 },
  { head: "Shares after", w: 116 },
];

/** Whole millions like the fund page ("$2,968m"); under a million that would read "$0m", so plain dollars. */
const tradeValue = (usd: number): string => (usd < 1e6 ? money(usd) : fMm(usd));

function TradesTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="twrap" tabIndex={0} role="region" aria-label="Trades by quarter, scrollable">
      <table className="t" aria-label="Trades by quarter">
        <colgroup>
          {TRADE_COLS.map((c) => (
            <col key={c.head} style={{ width: c.w + "px" }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {TRADE_COLS.map((c) => (
              <th key={c.head} scope="col" className={c.left ? "l" : undefined}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trades.length === 0 && (
            <tr>
              <td colSpan={TRADE_COLS.length} className="t-empty">
                Nothing to show.
              </td>
            </tr>
          )}
          {trades.map((t, i) => {
            const move = MOVE[tradeMove(t)];
            return (
              <tr key={i}>
                <td title={qLabel(t.q)}>{qShort(t.q)}</td>
                <td className="l">
                  <span className={"lc " + move.tone}>
                    <span className="lw">{move.word}</span>
                  </span>
                </td>
                {/* The sign is always printed: the colour is never the only cue. */}
                <td>
                  <span className={signClass(t.delta) || undefined}>{sgn(t.delta) + shareCount(Math.abs(t.delta))}</span>
                </td>
                <td>{px(t.px)}</td>
                <td>{t.low == null || t.high == null ? DASH : `${px(t.low)}–${px(t.high)}`}</td>
                <td>{tradeValue(Math.abs(t.delta) * t.px)}</td>
                <td>{shareCount(t.sharesAfter)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- page ------------------------------------------------------------------------------

function Header({ data }: { data: PositionData }) {
  const { summary, position: p, security, price, priceDate } = data;
  return (
    <header className="pos-head">
      <Link className="crumb" to={`/fund/${summary.id}`}>
        {`← ${summary.name}`}
      </Link>
      <div className="pos-title">
        <h1>
          <span className="mono">{security?.ticker ?? `#${p.stock_id}`}</span>
          {security && ` · ${tidyName(security.name)}`}
        </h1>
        <ThemeToggle />
      </div>
      <div className="pos-meta">
        <span className="pill">
          Sector <b>{security?.sector ?? DASH}</b>
        </span>
        <span className="pill">
          Held{" "}
          <b>
            {qLabel(p.from_q)} – {p.to_q == null ? "now" : qLabel(p.to_q)}
          </b>
        </span>
        <span className="pill">
          Latest price <b>{px(price ?? null)}</b>
          {priceDate !== undefined && ` · ${fmtDate(priceDate)}`}
        </span>
      </div>
    </header>
  );
}

/** One tile of the strip: label, the figure, and a one-line note. A signed figure takes the gain or loss colour. */
function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "up" | "down" | "" }) {
  return (
    <div className="kpi">
      <div className="kpi-l">{label}</div>
      <div className={tone && !printsZero(value) ? `kpi-v ${tone}` : "kpi-v"}>{value}</div>
      {note && <div className="kpi-n">{note}</div>}
    </div>
  );
}

function PositionTiles({ data }: { data: PositionData }) {
  const { position: p, price, asof } = data;
  const total = totalPnl(p, price);
  const ret = returnPct(p, price);
  const x = irr(positionFlows(p.trades, p.shares_now, price, yearsSince2013(asof)));
  const sharesSub = p.shares_now === 0 ? "fully sold" : price === undefined ? undefined : `worth ${money(p.shares_now * price)}`;
  const dividends = `incl. ${money(p.dividends)} dividends`;
  return (
    <div className="pos-tiles">
      <div className="kpis" role="group" aria-label="This position">
        <Kpi label="Shares now" value={shareCount(p.shares_now)} note={sharesSub} />
        <Kpi label="Avg cost" value={px(p.avg_cost)} note="avg of estimated buy prices" />
        <Kpi label="$ in" value={money(p.invested)} />
        <Kpi
          label="Total P&L"
          value={money(total, true)}
          note={ret === null ? dividends : `${pct(ret, 0)} on $ in · ${dividends}`}
          tone={signClass(total)}
        />
        <Kpi label="IRR" value={pct(x, 0)} note="mid-quarter trade dates" tone={signClass(x)} />
      </div>
      <p className="kpi-cap">
        13F estimates, not actual fills: trades are inferred from quarter-end holdings and priced at each quarter's
        volume-weighted average.
      </p>
    </div>
  );
}

/** A panel with the artifact's head: the title, a line under it, and the body. */
function Panel({ id, title, sub, flush, children }: { id: string; title: string; sub: string; flush?: boolean; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="ph">
        <div className="ph-t">
          <h2 className="pt" id={id}>
            {title}
          </h2>
          <p className="ps">{sub}</p>
        </div>
      </div>
      {flush ? children : <div className="pb">{children}</div>}
    </section>
  );
}

function PositionView({ data }: { data: PositionData }) {
  const { summary, position: p, security, weekly, price } = data;
  useTitle(`${security?.ticker ?? `#${p.stock_id}`} · ${summary.name} · Orca`);
  return (
    <div className="pos-page">
      <div className="pos-main">
        <Header data={data} />
        <PositionTiles data={data} />
        <Panel
          id="pos-price"
          title="Price and estimated trades"
          sub="Each triangle sits at the quarter's volume-weighted price: up for a buy, down for a sale. The shaded bar is that quarter's low to high."
        >
          {weekly ? (
            <PriceChart closes={weekly.close} start={weekly.start} trades={p.trades} latest={price} />
          ) : (
            <p className="empty">No price history</p>
          )}
        </Panel>
        <Panel id="pos-shares" title="Shares held" sub="From each quarter's 13F, split-adjusted.">
          {/* An open position's last level runs to the fund's latest filed quarter, a closed one's ends with its exit. */}
          <StepChart
            quarters={p.trades.map((t) => t.q)}
            shares={p.trades.map((t) => t.sharesAfter)}
            endQ={p.to_q ?? summary.period_q}
          />
        </Panel>
        <Panel id="pos-trades" title="Trades by quarter" sub="Every marker on the price chart, with the numbers behind it." flush>
          <TradesTable trades={p.trades} />
        </Panel>
      </div>
    </div>
  );
}

function PositionLoader({ fundId, stockId }: { fundId: number; stockId: number }) {
  // The page is keyed by fund and stock, so the ids never change within one instance.
  const state = useLoad(() => loadPosition(fundId, stockId), [fundId, stockId]);
  if (state.status === "loading") {
    return (
      <div className="pos-page">
        <div className="pos-main" aria-busy="true">
          <p className="status" role="status">
            Loading…
          </p>
          {/* Placeholders in the shape of the page: the title, the tile strip and a panel. */}
          <div className="skel" aria-hidden="true">
            <span className="sk sk-h1" />
            <span className="sk sk-kpis" />
            <span className="sk sk-panel" />
          </div>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return isFundFileMissing(state.error, fundId) ? (
      <NotFound />
    ) : (
      <div className="pos-page">
        <div className="pg-state err" role="alert">
          <span className="ic">
            <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5 14 13H2L8 2.5z" />
              <path d="M8 6.75v3M8 11.4v.01" />
            </svg>
          </span>
          <p>
            <b>Couldn't load this position.</b> Check your connection and reload the page.
          </p>
        </div>
      </div>
    );
  }
  return state.data === null ? <NotFound /> : <PositionView data={state.data} />;
}

export default function Position() {
  const params = useParams();
  const fundId = parseId(params.id);
  const stockId = parseId(params.stockId);
  return fundId === null || stockId === null ? <NotFound /> : <PositionLoader key={`${fundId}/${stockId}`} fundId={fundId} stockId={stockId} />;
}
