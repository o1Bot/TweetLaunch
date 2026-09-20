import { describe, expect, it } from "vitest";
import {
  buildCloseOrder,
  buildCreateOrder,
  OrderBuildError,
  ORDER_TYPE,
  TIME_IN_FORCE,
} from "./order";

// BTC riil: market_id 1, pxDec 1, szDec 5 (docs/api-truth.md).
const btc = { market_id: 1, supported_price_decimals: 1, supported_size_decimals: 5 };

describe("buildCreateOrder", () => {
  it("limit long BTC $100 @ 64321.6 → correct wire values", () => {
    const o = buildCreateOrder({
      side: "long",
      type: "limit",
      notionalUsd: 100,
      price: 64321.6,
      market: btc,
    });
    expect(o.contracts).toBe("0.00155");
    expect(o.baseAmount).toBe(155);
    expect(o.price).toBe(643216);
    expect(o.isAsk).toBe(0);
    expect(o.orderType).toBe(ORDER_TYPE.limit);
    expect(o.timeInForce).toBe(TIME_IN_FORCE.goodTillTime);
    expect(o.orderExpiry).toBe(-1);
  });

  it("short → isAsk 1", () => {
    expect(
      buildCreateOrder({ side: "short", type: "limit", notionalUsd: 100, price: 64000, market: btc })
        .isAsk,
    ).toBe(1);
  });

  it("market order: guard slippage 0.5% + IOC", () => {
    const o = buildCreateOrder({
      side: "long",
      type: "market",
      notionalUsd: 100,
      price: 64000,
      market: btc,
    });
    expect(o.price).toBe(643200); // 64000 × 1.005 = 64320.0
    expect(o.orderType).toBe(ORDER_TYPE.market);
    expect(o.timeInForce).toBe(TIME_IN_FORCE.immediateOrCancel);
    expect(o.orderExpiry).toBe(0);
    const short = buildCreateOrder({
      side: "short",
      type: "market",
      notionalUsd: 100,
      price: 64000,
      market: btc,
    });
    expect(short.price).toBe(636800); // 64000 × 0.995
  });

  it("contracts round DOWN — a position is never oversized", () => {
    // $99 @ 64000 = 0.001546875 → floor 5 desimal = 0.00154 (bukan 0.00155)
    const o = buildCreateOrder({ side: "long", type: "limit", notionalUsd: 99, price: 64000, market: btc });
    expect(o.contracts).toBe("0.00154");
  });

  it("konsistensi ledger: contracts === baseAmount / 10^szDec", () => {
    const o = buildCreateOrder({ side: "long", type: "limit", notionalUsd: 250, price: 64321.6, market: btc });
    expect(Number(o.contracts)).toBeCloseTo(o.baseAmount / 1e5, 10);
  });

  it("ukuran di bawah resolusi market ditolak", () => {
    expect(() =>
      buildCreateOrder({ side: "long", type: "limit", notionalUsd: 0.5, price: 64000, market: btc }),
    ).toThrow(OrderBuildError);
  });

  it("stop-loss: type 2, IOC, trigger set, expiry required by the venue", () => {
    const o = buildCreateOrder({
      side: "short",
      type: "stopLoss",
      notionalUsd: 100,
      price: 64000,
      triggerPrice: 62000,
      reduceOnly: true,
      market: btc,
    });
    expect(o.orderType).toBe(ORDER_TYPE.stopLoss);
    expect(o.timeInForce).toBe(TIME_IN_FORCE.immediateOrCancel);
    expect(o.triggerPrice).toBe(620000); // 62000 @ pxDec 1
    expect(o.orderExpiry).toBe(-1); // NOT nil: the venue rejects trigger orders without expiry
    expect(o.reduceOnly).toBe(1);
  });

  it("take-profit: type 4 with its trigger", () => {
    const o = buildCreateOrder({
      side: "short",
      type: "takeProfit",
      notionalUsd: 100,
      price: 64000,
      triggerPrice: 70000,
      market: btc,
    });
    expect(o.orderType).toBe(ORDER_TYPE.takeProfit);
    expect(o.triggerPrice).toBe(700000);
  });

  it("trigger order without a trigger price is rejected", () => {
    expect(() =>
      buildCreateOrder({ side: "long", type: "stopLoss", notionalUsd: 100, price: 64000, market: btc }),
    ).toThrow(OrderBuildError);
  });

  it("close: reduce-only market on the opposite side, sized to the position", () => {
    const long = buildCloseOrder({
      positionSign: 1,
      positionSize: "0.00155",
      markPrice: 64000,
      market: btc,
    });
    expect(long.isAsk).toBe(1); // closing a long sells
    expect(long.reduceOnly).toBe(1);
    expect(long.baseAmount).toBe(155);
    expect(long.orderType).toBe(ORDER_TYPE.market);
    expect(long.price).toBe(636800); // sell guard: 64000 × 0.995

    const short = buildCloseOrder({
      positionSign: -1,
      positionSize: "0.00155",
      markPrice: 64000,
      market: btc,
    });
    expect(short.isAsk).toBe(0); // closing a short buys
    expect(short.price).toBe(643200); // buy guard: 64000 × 1.005
  });

  it("input tak valid ditolak", () => {
    expect(() =>
      buildCreateOrder({ side: "long", type: "limit", notionalUsd: 0, price: 64000, market: btc }),
    ).toThrow(OrderBuildError);
  });
});
