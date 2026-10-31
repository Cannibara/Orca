import type { Stock } from "../data/api";

/** A stock's ticker with its name beside it. A stock missing from securities.json shows as #id. */
export function StockLabel({ stock, stockId }: { stock: Stock | undefined; stockId: number }) {
  return (
    <>
      <span className="mono">{stock?.ticker ?? `#${stockId}`}</span>
      {stock && (
        <>
          {" "}
          <span className="cap">{stock.name}</span>
        </>
      )}
    </>
  );
}
