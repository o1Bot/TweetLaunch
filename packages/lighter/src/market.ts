import { fromWire, toWire } from "./convert";
import type { MarketType, PerpOrderBookDetail } from "./types";

interface PriceScaled {
  supported_price_decimals: number;
}

interface SizeScaled {
  supported_size_decimals: number;
}

export function priceToWire(price: string, market: PriceScaled): bigint {
  return toWire(price, market.supported_price_decimals);
}

export function priceFromWire(price: bigint | number, market: PriceScaled): string {
  return fromWire(price, market.supported_price_decimals);
}

export function sizeToWire(size: string, market: SizeScaled): bigint {
  return toWire(size, market.supported_size_decimals);
}

export function sizeFromWire(size: bigint | number, market: SizeScaled): string {
  return fromWire(size, market.supported_size_decimals);
}

/** Tick size as a decimal string, e.g. pxDec 1 → "0.1". */
export function tickSize(market: PriceScaled): string {
  return fromWire(1n, market.supported_price_decimals);
}

/** Margin fraction in bps: max leverage = 10000 / min_initial_margin_fraction. */
export function maxLeverage(market: Pick<PerpOrderBookDetail, "min_initial_margin_fraction">): number {
  return 10000 / market.min_initial_margin_fraction;
}

declare const process: { env: Record<string, string | undefined> } | undefined;

/** Quote symbol of the active instance — mainnet uses USDC; the RH instance uses USDG. */
export const QUOTE_SYMBOL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LIGHTER_QUOTE) || "USDC";

/**
 * The venue must be readable from the symbol: perps use a dash
 * separator ("BTC-USDC"), spot from the API is already "ETH/USDC" — left as-is.
 */
export function displaySymbol(
  market: { symbol: string; market_type: MarketType },
  quote: string = QUOTE_SYMBOL,
): string {
  return market.market_type === "perp" ? `${market.symbol}-${quote}` : market.symbol;
}

/** Market id unique across venues — never key on the bare symbol. */
export function marketKey(market: { symbol: string; market_type: MarketType }): string {
  return `${market.symbol.split("/")[0]}-${market.market_type}`;
}
