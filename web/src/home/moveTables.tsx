// The columns of the home page's Conviction moves and Best & worst calls, drawn as the ranked lists' table is
// (home/ScrollTable.tsx; owner, 2026-11-28: the same look as Famous funds' Table view). A fund is the chart's row:
// the person's photo (or initials), the short name and its AUM, the person under it; a stock is its ticker over the
// company. On a phone a row is the fund with the stock and the move under it, and one figure on the right.
import { Link } from "react-router";
import type { SortState } from "../components/DataTable";
import { Signed } from "../components/Signed";
import type { Stock } from "../data/api";
import type { CallRow, ConvictionRow } from "../data/types";
import { managerLine, phoneNameOf, shortNameOf } from "../lib/famousNames";
import { DASH, pct, qLabel } from "../lib/format";
import { fAum, fBook, fPrice } from "../pages/homeFmt";
import { Photo } from "./FamousChart";
import { aumLabel } from "./famousChart";
import type { SortOption, TCol } from "./ScrollTable";

/** What the lists are made of: names, today's prices, fund sizes and the people behind famous funds. */
export type ListLookup = {
  stocks: Map<number, Stock>;
  prices: Map<number, number>;
  /** Fund id -> reported book. Empty when the fund index did not load. */
  books: Map<number, number>;
  /** Fund id -> the person behind a famous fund (Famous funds' rows). Empty when that list did not load. */
  people: Map<number, string>;
};

/** Price move from `base` to `price`; null when either is missing. */
export function change(price: number | undefined, base: number): number | null {
  return price === undefined || !(base > 0) ? null : price / base - 1;
}

/** Sort value of a name column. */
const lower = (text: string | undefined) => (text ?? "").toLowerCase();

/** The fund as the chart shows it: photo (or initials), short name (the filer's name on hover) and AUM, the
 * person under it; on a phone the stock and the move take the second line. */
function ListFund({
  look,
  id,
  name,
  phone,
  line2,
}: {
  look: ListLookup;
  id: number;
  name: string;
  phone: boolean;
  line2: string[];
}) {
  const short = shortNameOf(id, name);
  const manager = look.people.get(id);
  const who = managerLine(manager, short);
  const book = look.books.get(id);
  return (
    <span className="rk-fund">
      <Photo manager={manager} who={who ?? short} />
      <span className="who">
        {phone ? (
          <>
            <Link className="nm" to={`/fund/${id}`} title={name}>
              {phoneNameOf(short)}
            </Link>
            <span className="l2">
              {line2.map((s, i) => (
                <span key={i}>
                  {i > 0 && <i className="sep" aria-hidden="true" />}
                  {s}
                </span>
              ))}
            </span>
          </>
        ) : (
          <>
            <span className="l1">
              <Link className="nm" to={`/fund/${id}`} title={name}>
                {short}
              </Link>
              {book !== undefined && (
                <>
                  <i className="sep" aria-hidden="true" />
                  <span className="am">{aumLabel(book)}</span>
                </>
              )}
            </span>
            {who && <span className="mg">{who}</span>}
          </>
        )}
      </span>
    </span>
  );
}

/** Ticker over the company, a link to the stock's page within the fund. */
function StockCell({ stock, stockId, fundId }: { stock: Stock | undefined; stockId: number; fundId: number }) {
  return (
    <Link className="stk2" to={`/fund/${fundId}/stock/${stockId}`} title={stock?.name}>
      <span className="tk">{stock?.ticker ?? `#${stockId}`}</span>
      {stock && <span className="co">{stock.name}</span>}
    </Link>
  );
}

const ticker = (look: ListLookup, id: number) => look.stocks.get(id)?.ticker ?? `#${id}`;

function fundCol<R>(look: ListLookup, phone: boolean, id: (r: R) => number, name: (r: R) => string, line2: (r: R) => string[]): TCol<R> {
  return {
    cls: "c-fund",
    ph: "main",
    header: "Fund",
    key: "fund",
    align: "l",
    by: (r) => lower(shortNameOf(id(r), name(r))),
    cell: (r) => <ListFund look={look} id={id(r)} name={name(r)} phone={phone} line2={line2(r)} />,
  };
}

function stockCol<R>(look: ListLookup, fund: (r: R) => number, stock: (r: R) => number): TCol<R> {
  return {
    cls: "c-stk l",
    header: "Stock",
    key: "stock",
    align: "l",
    by: (r) => lower(look.stocks.get(stock(r))?.ticker),
    cell: (r) => <StockCell stock={look.stocks.get(stock(r))} stockId={stock(r)} fundId={fund(r)} />,
  };
}

// ---- Conviction moves ----

/** The order of the file: the most unusual move for its fund first (no column sorts on it). */
export const MOST_UNUSUAL: SortState = { key: "score", dir: -1 };

/** A weight in percent: "<1%" under half a percent, else whole percent (the fund page's fW0). */
const fW0 = (w: number) => (w > 0 && w < 0.5 ? "<1%" : Math.round(w) + "%");

/** The weight before a move, in percent: after less the change (floating-point dust clamped to 0). */
const weightBefore = (r: ConvictionRow) => Math.max(0, r.weight_after * 100 - r.change_pts);
const weightNow = (r: ConvictionRow) => (r.move === "exit" ? 0 : r.weight_after * 100);

/**
 * A move's weight as the fund page's Positions table draws it: "was → now" over a bar of the weight before in
 * solid grey, then the change as a striped extension (blue past the old end for a bigger weight, orange back from
 * it for a smaller one). A new position starts from 0%, a sale of everything ends at 0%.
 */
function WeightCell({ r, maxW }: { r: ConvictionRow; maxW: number }) {
  const prev = weightBefore(r);
  const now = weightNow(r);
  const w = (v: number) => (v / maxW) * 100;
  const solid = Math.min(now, prev);
  const diff = Math.abs(now - prev);
  return (
    <span className="wcell" title={`Weight ${fW0(prev)} before, ${fW0(now)} after (${fAum(r.change_pts)} of the fund's AUM)`}>
      <span className="wn">{`${fW0(prev)} → ${fW0(now)}`}</span>
      <span className="mbs">
        {solid > 0 && <i className="mb" style={{ width: Math.max(2, w(solid)).toFixed(1) + "%" }} />}
        {diff > 0 && <i className={"mb mbx " + (now > prev ? "up" : "dn")} style={{ width: Math.max(2, w(diff)).toFixed(1) + "%" }} />}
      </span>
    </span>
  );
}

export function convictionColumns(look: ListLookup, win: "q" | "y", rows: ConvictionRow[], phone: boolean): TCol<ConvictionRow>[] {
  // The longest bar (the biggest weight before or after) sets the scale, so bars compare across rows.
  const maxW = Math.max(1, ...rows.map((r) => Math.max(weightBefore(r), r.weight_after * 100)));
  const now = (r: ConvictionRow) => look.prices.get(r.stock_id) ?? null;
  const since = (r: ConvictionRow) => change(look.prices.get(r.stock_id), r.est_price);
  const line2 = (r: ConvictionRow) => [
    ticker(look, r.stock_id),
    ...(win === "y" ? [qLabel(r.q)] : []),
    `${fW0(weightBefore(r))} → ${fW0(weightNow(r))}`,
  ];
  return [
    fundCol(look, phone, (r) => r.fund_id, (r) => r.name, line2),
    stockCol(look, (r) => r.fund_id, (r) => r.stock_id),
    ...(win === "y" ? [{ cls: "c-q", header: "Quarter", key: "q", by: (r: ConvictionRow) => r.q, cell: (r: ConvictionRow) => qLabel(r.q) }] : []),
    // Sorts by the signed change in the fund's AUM, so the biggest buys lead and sales trail (or the reverse).
    { cls: "c-w", header: "Weight", key: "weight", by: (r) => r.change_pts, cell: (r) => <WeightCell r={r} maxW={maxW} /> },
    {
      cls: "c-usd key",
      ph: "end",
      header: "$ bought / sold",
      key: "usd",
      by: (r) => r.usd,
      cell: (r) => <Signed v={r.usd}>{fBook(r.usd, true)}</Signed>,
    },
    { cls: "c-est opt", header: "Est. price", key: "est", by: (r) => r.est_price, cell: (r) => fPrice(r.est_price) },
    { cls: "c-now opt", header: "Price now", key: "now", by: now, cell: (r) => fPrice(now(r)) },
    {
      cls: "c-since",
      header: "Since",
      key: "since",
      by: since,
      cell: (r) => {
        const s = since(r);
        return <Signed v={s}>{pct(s, 0)}</Signed>;
      },
    },
  ];
}

export const CONVICTION_SORTS: SortOption[] = [
  { label: "Most unusual", sort: MOST_UNUSUAL },
  { label: "Biggest buys", sort: { key: "usd", dir: -1 } },
  { label: "Biggest sales", sort: { key: "usd", dir: 1 } },
  { label: "Weight, most added", sort: { key: "weight", dir: -1 } },
  { label: "Since, highest", sort: { key: "since", dir: -1 } },
  { label: "Since, lowest", sort: { key: "since", dir: 1 } },
  { label: "Fund, A–Z", sort: { key: "fund", dir: 1 } },
  { label: "Stock, A–Z", sort: { key: "stock", dir: 1 } },
];

// ---- Best & worst calls ----

/** A buy with today's figures. */
export type Call = {
  row: CallRow;
  price: number | undefined;
  sinceBuy: number | null;
  sinceFiled: number | null;
};

export function callColumns(look: ListLookup, win: "q" | "y", phone: boolean): TCol<Call>[] {
  const line2 = (c: Call) => [
    ticker(look, c.row.stock_id),
    ...(win === "y" ? [qLabel(c.row.q)] : []),
    `${fPrice(c.row.est_price)} → ${c.price === undefined ? DASH : fPrice(c.price)}`,
  ];
  return [
    fundCol(look, phone, (c) => c.row.fund_id, (c) => c.row.name, line2),
    stockCol(look, (c) => c.row.fund_id, (c) => c.row.stock_id),
    ...(win === "y" ? [{ cls: "c-q", header: "Quarter", key: "q", by: (c: Call) => c.row.q, cell: (c: Call) => qLabel(c.row.q) }] : []),
    { cls: "c-est opt", header: "Est. buy price", key: "est", by: (c) => c.row.est_price, cell: (c) => fPrice(c.row.est_price) },
    { cls: "c-now opt", header: "Price now", key: "now", by: (c) => c.price ?? null, cell: (c) => fPrice(c.price ?? null) },
    {
      cls: "c-since key",
      ph: "end",
      header: "Since fund's buy",
      key: "since",
      by: (c) => c.sinceBuy,
      cell: (c) => <Signed v={c.sinceBuy}>{pct(c.sinceBuy, 0)}</Signed>,
    },
    {
      cls: "c-filed",
      header: "Since 13F went public",
      key: "filed",
      by: (c) => c.sinceFiled,
      cell: (c) => <Signed v={c.sinceFiled}>{pct(c.sinceFiled, 0)}</Signed>,
    },
  ];
}

export const CALL_SORTS: SortOption[] = [
  { label: "Since buy, highest", sort: { key: "since", dir: -1 } },
  { label: "Since buy, lowest", sort: { key: "since", dir: 1 } },
  { label: "Since 13F, highest", sort: { key: "filed", dir: -1 } },
  { label: "Since 13F, lowest", sort: { key: "filed", dir: 1 } },
  { label: "Fund, A–Z", sort: { key: "fund", dir: 1 } },
  { label: "Stock, A–Z", sort: { key: "stock", dir: 1 } },
];
