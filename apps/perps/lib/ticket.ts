import { buildCreateOrder, perpLedger, type BuiltOrder, type PerpLedger } from "@o1bot/lighter";

/** The venue's sentinels for "no integrator on this order". o1bot has no
 *  integrator account yet and the rate it will charge is undecided, so orders
 *  carry none rather than a placeholder that would quietly bill someone. */
export const NO_INTEGRATOR = { accountIndex: 0, takerFeePpm: 0, makerFeePpm: 0 } as const;

/** Venue defaults: expire the resting maker, compare on account index. */
export const SELF_TRADE = { behaviour: 0, equality: 0 } as const;

export interface Market {
  market_id: number;
  supported_price_decimals: number;
  supported_size_decimals: number;
  /** basis points, from the venue's maintenance_margin_fraction */
  maintenance_margin_fraction: number;
}

export interface QuoteInput {
  side: "long" | "short";
  type: "limit" | "market";
  /** What the user asked for, in quote currency. */
  notionalUsd: number;
  /** Limit price, or the mark for a market order. */
  price: number;
  leverage: number;
  market: Market;
  /** Percent per period from market stats, when known. */
  fundingRatePct?: number;
  slippage?: number;
}

export interface Quote {
  built: BuiltOrder;
  ledger: PerpLedger;
  /** What the user typed. */
  requestedNotionalUsd: number;
  /** What the order will actually be worth once the size is floored. */
  effectiveNotionalUsd: number;
  /** How much of the request the market's size resolution ate, as a percent. */
  shortfallPct: number;
}

/**
 * One quote, used for both the numbers on screen and the numbers that go to the
 * signer. They cannot disagree because they are not computed twice.
 *
 * The order is built FIRST and the ledger follows from it, not the other way
 * round. buildCreateOrder floors the size to the market's size resolution,
 * which is coarse on plenty of markets — 23 perp markets trade in whole units
 * and BNB is priced high enough that a $100 order floors to $93.75 of exposure,
 * 6.25% less than asked. Running the ledger on the requested notional would
 * then show a margin, a fee and a liquidation price for a position nobody is
 * getting. Deriving the notional back from the floored size makes every figure
 * describe the order that will actually be sent.
 *
 * The gap is reported rather than hidden, because a request that silently
 * shrinks is exactly the kind of surprise a cost ledger exists to prevent.
 */
export function quote(i: QuoteInput): Quote {
  // Leverage is not part of a wire order — the venue derives margin from the
  // account's mode and the position. It only enters the ledger below.
  const built = buildCreateOrder({
    side: i.side,
    type: i.type,
    notionalUsd: i.notionalUsd,
    price: i.price,
    market: i.market,
    ...(i.slippage !== undefined ? { slippage: i.slippage } : {}),
  });

  const effectiveNotionalUsd = Number(built.contracts) * i.price;
  const shortfallPct =
    i.notionalUsd > 0 ? ((i.notionalUsd - effectiveNotionalUsd) / i.notionalUsd) * 100 : 0;

  const ledger = perpLedger({
    side: i.side,
    notionalUsd: effectiveNotionalUsd,
    entryPrice: i.price,
    leverage: i.leverage,
    // A market order crosses the book; a limit order is assumed to rest. If it
    // crosses it pays the taker rate, so this is the optimistic side of the
    // estimate and must not be presented as a guarantee.
    isTaker: i.type === "market",
    maintenanceMarginBps: i.market.maintenance_margin_fraction,
    ...(i.fundingRatePct !== undefined ? { fundingRatePct: i.fundingRatePct } : {}),
    takerFeePpm: NO_INTEGRATOR.takerFeePpm,
    makerFeePpm: NO_INTEGRATOR.makerFeePpm,
  });

  return {
    built,
    ledger,
    requestedNotionalUsd: i.notionalUsd,
    effectiveNotionalUsd,
    shortfallPct,
  };
}
