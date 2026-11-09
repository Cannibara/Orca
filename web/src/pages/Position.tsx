// One fund's position in one stock: what it cost, what it is worth at the latest price, and every
// trade behind it. Every figure that depends on the latest price is worked out here from latest_prices.json.
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PriceChart } from "../charts/PriceChart";
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
import { DASH, fmtDate, money, pct, printsZero, px, qLabel, sgn, shareCount, signClass } from "../lib/format";
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

const TRADE_COLUMNS: Column<Trade>[] = [
  { header: "Quarter", align: "l", cell: (t) => qLabel(t.q) },
  {
    header: "Move",
    align: "l",
    cell: (t) => <span className={t.delta > 0 ? "pill buy" : "pill sell"}>{tradeMove(t)}</span>,
  },
  { header: "Shares", cell: (t) => <Signed v={t.delta}>{sgn(t.delta) + shareCount(Math.abs(t.delta))}</Signed> },
  { header: "Est. price (VWAP)", cell: (t) => px(t.px) },
  { header: "Quarter range", cell: (t) => (t.low == null || t.high == null ? DASH : `${px(t.low)}–${px(t.high)}`) },
  { header: "$ value", cell: (t) => money(Math.abs(t.delta) * t.px) },
  { header: "Shares after", cell: (t) => shareCount(t.sharesAfter) },
];

// ---- page ------------------------------------------------------------------------------

function Header({ data }: { data: PositionData }) {
  const { summary, position: p, security, price, priceDate } = data;
  return (
    <div className="fhead">
      <Link className="eyebrow back" to={`/fund/${summary.id}`}>
        {`← ${summary.name}`}
      </Link>
      <h1>
        <span className="mono">{security?.ticker ?? `#${p.stock_id}`}</span>
        {security && ` · ${security.name}`}
      </h1>
      <div className="meta">
        <span>
          Sector <b>{security?.sector ?? DASH}</b>
        </span>
        <span>
          Held{" "}
          <b>
            {qLabel(p.from_q)} – {p.to_q == null ? "now" : qLabel(p.to_q)}
          </b>
        </span>
        <span>
          Latest price <b>{px(price ?? null)}</b>
          {priceDate !== undefined && ` · ${fmtDate(priceDate)}`}
        </span>
      </div>
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
    <div className="sec">
      <Tiles label="This position">
        <Tile label="Shares now" value={shareCount(p.shares_now)} sub={sharesSub} />
        <Tile label="Avg cost" value={px(p.avg_cost)} sub="avg of estimated buy prices" />
        <Tile label="$ in" value={money(p.invested)} />
        <Tile
          label="Total P&L"
          value={money(total, true)}
          sub={ret === null ? dividends : `${pct(ret, 0)} on $ in · ${dividends}`}
          tone={signClass(total)}
        />
        <Tile label="IRR" value={pct(x, 0)} sub="mid-quarter trade dates" tone={signClass(x)} />
      </Tiles>
      <p className="cap">
        13F estimates, not actual fills: trades are inferred from quarter-end holdings and priced at each quarter's
        volume-weighted average. <Link to="/how-it-works">How it works</Link>
      </p>
    </div>
  );
}

function PositionView({ data }: { data: PositionData }) {
  const { summary, position: p, security, weekly } = data;
  useTitle(`${security?.ticker ?? `#${p.stock_id}`} · ${summary.name} · Orca`);
  return (
    <div className="view">
      <Header data={data} />
      <PositionTiles data={data} />
      <Section
        id="pos-price"
        title="Price and estimated trades"
        intro={<p>Dots sit at the quarter's volume-weighted price; the shaded bar is that quarter's low to high.</p>}
      >
        <div className="panel sec">
          {weekly ? <PriceChart closes={weekly.close} start={weekly.start} trades={p.trades} /> : <p className="cap">No price history</p>}
        </div>
      </Section>
      <Section id="pos-shares" title="Shares held" intro={<p>From each quarter's 13F, split-adjusted.</p>}>
        <div className="panel">
          {/* An open position's last level runs to the fund's latest filed quarter, a closed one's ends with its exit. */}
          <StepChart
            quarters={p.trades.map((t) => t.q)}
            shares={p.trades.map((t) => t.sharesAfter)}
            endQ={p.to_q ?? summary.period_q}
          />
        </div>
      </Section>
      <Section id="pos-trades" title="Trades by quarter" intro={<p>Every dot on the price chart, with the numbers behind it.</p>}>
        <DataTable label="Trades by quarter" columns={TRADE_COLUMNS} rows={p.trades} />
      </Section>
    </div>
  );
}

function PositionLoader({ fundId, stockId }: { fundId: number; stockId: number }) {
  // The page is keyed by fund and stock, so the ids never change within one instance.
  const state = useLoad(() => loadPosition(fundId, stockId), [fundId, stockId]);
  if (state.status === "loading") {
    return (
      <p className="cap" role="status">
        Loading…
      </p>
    );
  }
  if (state.status === "error") {
    return isFundFileMissing(state.error, fundId) ? (
      <NotFound />
    ) : (
      <p className="note" role="alert">
        Couldn't load this position. Check your connection and reload the page.
      </p>
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
