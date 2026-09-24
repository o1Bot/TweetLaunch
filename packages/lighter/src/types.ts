// Lighter API response types (RH instance). Shapes verified against the live API on
// 2026-07-29 — see docs/api-truth.md and the raw snapshots in docs/api-snapshots/.

export type MarketType = "perp" | "spot";

export interface OrderBookSummary {
  market_id: number;
  symbol: string;
  market_type: MarketType;
  status: string;
  base_asset_id: number;
  quote_asset_id: number;
  supported_price_decimals: number;
  supported_size_decimals: number;
  supported_quote_decimals: number;
  min_base_amount: string;
  min_quote_amount: string;
  taker_fee: string;
  maker_fee: string;
  is_taker_fee_enabled: boolean;
  is_maker_fee_enabled: boolean;
  liquidation_fee: string;
  order_quote_limit: string;
  multiplier: string;
  /** Epoch ms as a string (e.g. "1782499411043") — used to sort "new markets". */
  created_at?: string | number;
}

export interface SpotOrderBookDetail extends OrderBookSummary {
  last_trade_price: number;
  daily_trades_count: number;
  daily_base_token_volume: number;
  daily_quote_token_volume: number;
  daily_price_change: number;
  daily_price_high: number;
  daily_price_low: number;
}

export interface PerpMarketConfig {
  trading_hours: string;
  force_reduce_only: boolean;
  hidden: boolean;
  [k: string]: unknown;
}

export interface PerpOrderBookDetail extends SpotOrderBookDetail {
  mark_price: string;
  index_price: string;
  open_interest: number;
  // Margin fractions in basis points (10000 = 100%) — calibration in docs/api-truth.md §4.
  default_initial_margin_fraction: number;
  min_initial_margin_fraction: number;
  maintenance_margin_fraction: number;
  closeout_margin_fraction: number;
  funding_clamp_small: string;
  funding_clamp_big: string;
  base_interest_rate: string;
  market_config: PerpMarketConfig;
}

export interface OrderBooksResponse {
  code: number;
  order_books: OrderBookSummary[];
}

export interface OrderBookDetailsResponse {
  code: number;
  order_book_details: PerpOrderBookDetail[];
  spot_order_book_details: SpotOrderBookDetail[];
}

// Tape prints: type "trade" is normal, "liquidation" is a forced liquidation —
// both are real prints on the book and both count toward candles.
export interface Trade {
  trade_id: number;
  type: "trade" | "liquidation" | (string & {});
  market_id: number;
  size: string;
  price: string;
  usd_amount: string;
  /** Epoch milliseconds. */
  timestamp: number;
  is_maker_ask: boolean;
}

export interface RecentTradesResponse {
  code: number;
  trades: Trade[];
}

// The "found" case shape is not yet verified against a real account — only the
// not-found case (code 21100) is verified. Do not type deeper fields before
// seeing a real response.
export interface AccountLookupResponse {
  code: number;
  message?: string;
  [k: string]: unknown;
}

// Native OHLCV candles from /api/v1/candles (NOT "candlesticks", which 403s —
// discovered from app.lighter.xyz network traffic). Timestamps in milliseconds;
// v = base volume, V = quote volume. Verified live: resolutions 1m/5m/15m/1h/4h/1d,
// max 500 bars.
export interface ApiCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  V: number;
  [k: string]: unknown;
}

export type CandleResolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface CandlesResponse {
  code: number;
  r: string;
  c: ApiCandle[];
}

// Hourly funding history — formerly the only source of historical prices before
// the candles endpoint was found; still useful for funding analytics:
// value = mark_price × rate%, so hourly mark can be derived back from it (30 days).
export interface FundingPoint {
  /** Epoch seconds, hour-aligned. */
  timestamp: number;
  value: string;
  /** Percent per period, e.g. "0.0012". */
  rate: string;
  direction: "long" | "short" | (string & {});
}

export interface FundingsResponse {
  code: number;
  resolution: string;
  fundings: FundingPoint[];
}

// Success shape not yet verified (needs a real account) — only the error path is.
export interface SendTxResponse {
  code: number;
  message?: string;
  tx_hash?: string;
  [k: string]: unknown;
}

// Integrator fee values are scaled by 1e6 relative to notional: 200 = 2.0 bps.
// Ceilings are separate for perps/spot — never hardcode them, always read live.
export interface SystemConfig {
  code: number;
  max_integrator_perps_taker_fee: number;
  max_integrator_perps_maker_fee: number;
  max_integrator_spot_taker_fee: number;
  max_integrator_spot_maker_fee: number;
  funding_fee_rebate_account_index: number;
  market_maker_incentive_account_index: number;
}

/**
 * A resting order. Fields observed live on the public `orderBookOrders`
 * endpoint (2026-09-24), which returns the same objects:
 *   order_index, order_id, owner_account_index, initial_base_amount,
 *   remaining_base_amount, price, order_expiry, transaction_time
 *
 * `market_id` and `is_ask` are optional because orderBookOrders does not carry
 * them — it splits by side into separate arrays and is scoped to one market —
 * and the account-wide endpoint has not been seen with a valid token yet.
 */
export interface ActiveOrder {
  order_index: number;
  order_id?: string;
  owner_account_index?: number;
  initial_base_amount?: string;
  remaining_base_amount?: string;
  price?: string;
  order_expiry?: number;
  transaction_time?: number;
  market_id?: number;
  is_ask?: boolean | number;
  [k: string]: unknown;
}

export interface ActiveOrdersResponse {
  code: number;
  orders?: ActiveOrder[];
  [k: string]: unknown;
}
