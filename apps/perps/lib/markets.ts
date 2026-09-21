import { maxLeverage, type PerpOrderBookDetail } from "@o1bot/lighter";
import { categorise, type Category } from "@/lib/category";
import { MARKETS_REVALIDATE_SECONDS, lighter, revalidating } from "@/lib/lighter";

export interface PerpRow {
  symbol: string;
  marketId: number;
  category: Category;
  lastPrice: number;
  markPrice: number;
  changePct: number;
  volumeUsd: number;
  openInterestUsd: number;
  maxLeverage: number;
  priceDecimals: number;
  sizeDecimals: number;
  maintenanceMarginBps: number;
}

function toRow(m: PerpOrderBookDetail): PerpRow {
  const last = m.last_trade_price;
  return {
    symbol: m.symbol,
    marketId: m.market_id,
    category: categorise(m.symbol, (m as { funding_premium_multiplier?: number }).funding_premium_multiplier),
    lastPrice: last,
    markPrice: Number(m.mark_price) || last,
    changePct: m.daily_price_change,
    volumeUsd: m.daily_quote_token_volume,
    openInterestUsd: (m.open_interest || 0) * last,
    maxLeverage: Math.floor(maxLeverage(m)),
    priceDecimals: m.supported_price_decimals,
    sizeDecimals: m.supported_size_decimals,
    maintenanceMarginBps: m.maintenance_margin_fraction,
  };
}

/** Every perp market, busiest first. One fetch serves the home grid, the rail
 *  and the terminal, so all three agree on the same moment. */
export async function loadPerps(): Promise<{ rows: PerpRow[]; error?: string }> {
  try {
    const res = await lighter.orderBookDetails(revalidating(MARKETS_REVALIDATE_SECONDS));
    // 21 of 235 perp markets are `inactive` — delisted names the venue still
    // returns, including SPACEX, SAMSUNG, WHEAT and HYUNDAI. They cannot be
    // traded, and MKR among them reports a zero margin fraction, which makes
    // maxLeverage() infinite. Listing them would offer trades that cannot be
    // placed, so they are dropped here rather than guarded against everywhere.
    const rows = res.order_book_details
      .filter((m) => m.status === "active")
      .map(toRow)
      .sort((a, b) => b.volumeUsd - a.volumeUsd);
    return { rows };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : "unknown error" };
  }
}

export function findPerp(rows: PerpRow[], symbol: string): PerpRow | undefined {
  const wanted = decodeURIComponent(symbol).toUpperCase();
  return rows.find((r) => r.symbol.toUpperCase() === wanted);
}
