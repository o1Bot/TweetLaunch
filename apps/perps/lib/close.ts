import { buildCloseOrder, type AccountPosition, type BuiltOrder } from "@o1bot/lighter";
import type { PerpRow } from "@/lib/markets";

export class CloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseError";
  }
}

/**
 * The order that flattens one open position.
 *
 * It is reduce-only and sized to the position itself rather than to a dollar
 * amount, because a close that misses by a rounding step leaves a dust position
 * open — and a reduce-only order that is somehow too large cannot flip the
 * position to the other side, which is the failure worth ruling out.
 *
 * The market's decimals come from the market list rather than the position,
 * because the account stream does not carry them and guessing them is how an
 * order ends up ten times the intended size.
 */
export function closeOrderFor(position: AccountPosition, markets: PerpRow[]): BuiltOrder {
  const market = markets.find((m) => m.marketId === position.market_id);
  if (!market) {
    // An inactive or unlisted market: the venue can hold a position in one, and
    // we have no decimals for it, so refuse rather than send a guessed size.
    throw new CloseError(`${position.symbol} is not in the tradeable market list`);
  }

  const size = Number(position.position);
  if (!Number.isFinite(size) || size === 0) throw new CloseError("position is already flat");

  const mark = market.markPrice || market.lastPrice;
  if (!(mark > 0)) throw new CloseError("no mark price for this market");

  return buildCloseOrder({
    positionSign: position.sign,
    // The venue reports the size unsigned on both sides; the sign above is what
    // decides the direction of the closing order.
    positionSize: String(Math.abs(size)),
    markPrice: mark,
    market: {
      market_id: market.marketId,
      supported_price_decimals: market.priceDecimals,
      supported_size_decimals: market.sizeDecimals,
    },
  });
}
