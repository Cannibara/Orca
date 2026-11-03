// Types for every file the pipeline publishes. Field names and shapes follow
// pipeline/contract.md exactly (snake_case, column-oriented blocks). `null` means
// missing: unknown, not applicable or not computable. Every figure is a 13F
// estimate. Columnar blocks are type aliases (not interfaces) so they are
// assignable to toRows()'s Record<string, unknown[]>.

// ---- Index files -----------------------------------------------------------

export type FundsIndex = {
  v: number;
  id: number[];
  name: string[];
  book: number[];
  n: number[];
};

export type Securities = {
  stock_id: number[];
  ticker: string[];
  name: string[];
  sector: string[];
};

/** price/date are null for a stock without a close. */
export type LatestPrices = {
  asof: string;
  stock_id: number[];
  price: (number | null)[];
  date: (string | null)[];
};

// ---- fund/{id}/summary.json ------------------------------------------------

export type YearLabelRet = { label: string; ret: number };

export type Metrics = {
  ann_return: number | null;
  sharpe: number | null;
  sortino: number | null;
  vol: number | null;
  max_dd: number | null;
  calmar: number | null;
  best_year: YearLabelRet | null;
  worst_year: YearLabelRet | null;
  years_pos: number | null;
  years_total: number | null;
  quarters_pos_pct: number | null;
  turnover: number | null;
  hold_all: number | null;
  hold_sold: number | null;
  first_year: number | null;
  last_year: number | null;
};

export type YearsBlock = {
  label: string[];
  ret: (number | null)[];
  start: number[];
  end: number[];
  gains: number[];
  inflows: number[];
  dividends: number[];
  approx_ret: (number | null)[];
};

export type QuartersBlock = {
  q: number[];
  ret: (number | null)[];
  start: number[];
  end: number[];
  market_move: number[];
  net_buying: number[];
  trade_gains: number[];
  dividends: number[];
};

/** Positions held now: shares and cost basis in dollars. */
export type Holdings = {
  stock_id: number[];
  shares: number[];
  cost: number[];
};

export type Summary = {
  id: number;
  name: string;
  cik: number;
  period_q: number;
  filed: string;
  book: number;
  n_holdings: number;
  priced_pct: number;
  tracked_since_q: number;
  inactive: boolean;
  metrics: Metrics;
  years: YearsBlock;
  quarters: QuartersBlock;
  holdings_now: Holdings;
};

// ---- fund/{id}/positions.json ----------------------------------------------

/** One trade as published: [q, delta, px, low, high, shares_after]. */
export type TradeTuple = [
  q: number,
  delta: number,
  px: number,
  low: number | null,
  high: number | null,
  sharesAfter: number,
];

/** A trade parsed from a TradeTuple. low/high are null when the stock has no prices in the quarter. */
export type Trade = {
  q: number;
  delta: number;
  px: number;
  low: number | null;
  high: number | null;
  sharesAfter: number;
};

export type LastType = "new" | "add" | "trim" | "exit";

/** The file as published: one column per field, `trades[i]` the i-th position's trade tuples. */
export type Positions = {
  stock_id: number[];
  from_q: number[];
  to_q: (number | null)[];
  avg_cost: number[];
  avg_exit: (number | null)[];
  invested: number[];
  realised: number[];
  dividends: number[];
  shares_now: number[];
  cost_now: number[];
  last_q: number[];
  last_type: LastType[];
  last_pct: (number | null)[];
  last_usd: number[];
  trades: TradeTuple[][];
};

/** One row of positions.json, with its trades parsed. */
export type PositionRow = {
  stock_id: number;
  from_q: number;
  to_q: number | null;
  avg_cost: number;
  avg_exit: number | null;
  invested: number;
  realised: number;
  dividends: number;
  shares_now: number;
  cost_now: number;
  last_q: number;
  last_type: LastType;
  last_pct: number | null;
  last_usd: number;
  trades: Trade[];
};

// ---- fund/{id}/contrib.json, exits.json ------------------------------------

export type ContribYear = {
  stock_id: number[];
  points: number[];
  pnl: number[];
};

export type Contrib = {
  years: string[];
  by_year: Record<string, ContribYear>;
};

export type ExitStatus = "trimmed" | "sold_all";

export type ExitsRows = {
  stock_id: number[];
  status: ExitStatus[];
  sold_shares: number[];
  sold_usd: number[];
  avg_exit: number[];
  last_sale_q: number[];
  one_y: (number | null)[];
  spy_one_y: (number | null)[];
};

export type ExitsSummary = {
  buys_12m: number | null;
  sells_12m: number | null;
  beat_spy_pct: number | null;
};

export type Exits = {
  rows: ExitsRows;
  summary: ExitsSummary;
};

// ---- stock/{stock_id}/weekly.json ------------------------------------------

/** `start` is a Friday; close[i] is the last close of the week ending start + 7 i days. null = gap, never carried forward. */
export type Weekly = {
  start: string;
  close: (number | null)[];
};

// ---- home/*.json -----------------------------------------------------------

export type TopRow = {
  fund_id: number;
  name: string;
  book: number;
  n_positions: number;
  ann_return: number;
  max_dd: number | null;
  sharpe: number | null;
};

/** top_{1y|3y|5y|10y|15y|max}.json */
export type TopList = {
  latest_q: number;
  period: string;
  eligible: TopRow[];
  giants: TopRow[];
};

/** conviction, just_filed, crowded, calls_q, calls_y */
export type RowsFile<T> = {
  latest_q: number;
  rows: T[];
};

export type ConvictionRow = {
  fund_id: number;
  name: string;
  stock_id: number;
  move: "new" | "add" | "trim" | "exit";
  /** Dollars traded; negative when sold. */
  usd: number;
  /** The move over the fund's book last quarter. */
  size: number;
  /** The move over the fund's largest holding last quarter. */
  vs_top: number;
  /** The move over the fund's biggest move of the four quarters before; null when it was quiet. */
  vs_usual: number | null;
  weight_now: number;
  change_pts: number;
  est_price: number;
  q: number;
};

export type WinLossRow = {
  fund_id: number;
  name: string;
  stock_id: number;
  pnl: number;
};

export type WinsLosses = {
  latest_q: number;
  wins: WinLossRow[];
  losses: WinLossRow[];
};

export type JustFiledRow = {
  fund_id: number;
  name: string;
  filed: string;
  period_q: number;
  book: number;
  headline_stock_id: number | null;
  headline_change_pts: number | null;
};

export type CrowdedRow = {
  stock_id: number;
  funds_buying: number;
  total_bought: number;
  avg_weight_after: number;
};

export type CallRow = {
  stock_id: number;
  fund_id: number;
  name: string;
  q: number;
  est_price: number;
  price_on_filed: number;
  filed: string;
};

/** File name (without .json) -> parsed type, so loadHome("top_3y") returns a TopList. */
export type HomeFiles = {
  top_1y: TopList;
  top_3y: TopList;
  top_5y: TopList;
  top_10y: TopList;
  top_15y: TopList;
  top_max: TopList;
  conviction: RowsFile<ConvictionRow>;
  wins_losses: WinsLosses;
  just_filed: RowsFile<JustFiledRow>;
  crowded: RowsFile<CrowdedRow>;
  calls_q: RowsFile<CallRow>;
  calls_y: RowsFile<CallRow>;
};

export type HomeName = keyof HomeFiles;
