// Order builder — ONE source for the numbers shown in the ledger and the numbers
// that go to the signer. If the ledger and the submitted order could disagree,
// that's a P0; the way to prevent it is to never compute twice.

import { toWire } from "./convert";

/** CreateOrder txType — verified from the SignCreateOrder output in the spike. */
export const TX_TYPE_CREATE_ORDER = 14;

// Constants from lighter-go types/txtypes/constants.go (pinned commit).
export const ORDER_TYPE = {
  limit: 0,
  market: 1,
  stopLoss: 2,
  stopLossLimit: 3,
  takeProfit: 4,
  takeProfitLimit: 5,
} as const;
export const TIME_IN_FORCE = { immediateOrCancel: 0, goodTillTime: 1, postOnly: 2 } as const;

/** The venue treats 0 as "unset" for both fields (NilOrderExpiry / NilOrderTriggerPrice). */
const NIL = 0;
/** -1 tells the signer to use its 28-day default expiry. */
const DEFAULT_EXPIRY = -1;

export type OrderKind = "limit" | "market" | "stopLoss" | "takeProfit";

export interface OrderIntent {
  side: "long" | "short";
  type: OrderKind;
  notionalUsd: number;
  /** Limit price; for market/trigger orders = current mark (the guard basis). */
  price: number;
  /** Trigger level for stopLoss / takeProfit. Required for those kinds. */
  triggerPrice?: number;
  /** Market-order slippage guard as a fraction (default 0.005 = 0.5%). */
  slippage?: number;
  /** Closing/reducing orders never increase exposure. Perps only. */
  reduceOnly?: boolean;
  /**
   * Exact base size, bypassing the notional maths. Used when closing a position,
   * where the size must match the position rather than a dollar amount.
   */
  baseAmount?: string;
  market: {
    market_id: number;
    supported_price_decimals: number;
    supported_size_decimals: number;
  };
}

export interface BuiltOrder {
  marketIndex: number;
  baseAmount: number;
  price: number;
  isAsk: 0 | 1;
  orderType: number;
  timeInForce: number;
  reduceOnly: 0 | 1;
  triggerPrice: number;
  orderExpiry: number;
  /** Contracts after wire rounding — the decimal string that MUST show in the ledger. */
  contracts: string;
}

export class OrderBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderBuildError";
  }
}

// Floor (not round) so the position is never larger than requested.
// The epsilon damps float wobble before flooring (0.00155 × 1e5 = 154.9999…).
function floorToDecimals(v: number, decimals: number): string {
  const f = 10 ** decimals;
  return (Math.floor(v * f + 1e-9) / f).toFixed(decimals);
}

export function buildCreateOrder(i: OrderIntent): BuiltOrder {
  if (!(i.price > 0)) throw new OrderBuildError("price must be greater than zero");
  if (!i.baseAmount && !(i.notionalUsd > 0)) {
    throw new OrderBuildError("notional must be greater than zero");
  }
  const isTrigger = i.type === "stopLoss" || i.type === "takeProfit";
  if (isTrigger && !(i.triggerPrice && i.triggerPrice > 0)) {
    throw new OrderBuildError("a trigger price is required for stop-loss and take-profit");
  }

  const pxDec = i.market.supported_price_decimals;
  const szDec = i.market.supported_size_decimals;

  // Limit orders rest at the given price. Market and trigger orders execute
  // immediately when they fire, so they carry a worst-acceptable price.
  const slippage = i.slippage ?? 0.005;
  const guarded =
    i.type === "limit"
      ? i.price
      : i.price * (i.side === "long" ? 1 + slippage : 1 - slippage);
  const priceWire = toWire(guarded.toFixed(pxDec), pxDec);

  const contracts = i.baseAmount
    ? floorToDecimals(Number(i.baseAmount), szDec)
    : floorToDecimals(i.notionalUsd / i.price, szDec);
  const baseWire = toWire(contracts, szDec);
  if (baseWire === 0n) {
    throw new OrderBuildError("order size is below this market's size resolution");
  }

  // Per lighter-go validation: market orders take IOC with no expiry and no
  // trigger; limit orders take GTT with an expiry; stop-loss and take-profit
  // take IOC *and* require BOTH a trigger price and an expiry.
  const orderType =
    i.type === "limit"
      ? ORDER_TYPE.limit
      : i.type === "market"
        ? ORDER_TYPE.market
        : i.type === "stopLoss"
          ? ORDER_TYPE.stopLoss
          : ORDER_TYPE.takeProfit;

  return {
    marketIndex: i.market.market_id,
    baseAmount: Number(baseWire),
    price: Number(priceWire),
    isAsk: i.side === "short" ? 1 : 0,
    orderType,
    timeInForce:
      i.type === "limit" ? TIME_IN_FORCE.goodTillTime : TIME_IN_FORCE.immediateOrCancel,
    reduceOnly: i.reduceOnly ? 1 : 0,
    triggerPrice: isTrigger ? Number(toWire(i.triggerPrice!.toFixed(pxDec), pxDec)) : NIL,
    orderExpiry: i.type === "market" ? NIL : DEFAULT_EXPIRY,
    contracts,
  };
}

/**
 * Close (or reduce) an open position: a reduce-only market order on the opposite
 * side, sized to the position itself. `positionSign` is the venue's own field —
 * 1 long, -1 short.
 */
export function buildCloseOrder(args: {
  positionSign: 1 | -1;
  positionSize: string;
  markPrice: number;
  slippage?: number;
  market: OrderIntent["market"];
}): BuiltOrder {
  return buildCreateOrder({
    side: args.positionSign === 1 ? "short" : "long",
    type: "market",
    notionalUsd: 0,
    baseAmount: args.positionSize,
    price: args.markPrice,
    slippage: args.slippage,
    reduceOnly: true,
    market: args.market,
  });
}
