import { describe, expect, it } from "vitest";
import type { LighterClient } from "@o1bot/lighter";
import { UnexpectedShapeError, openOrders } from "../lib/orders";

/** The field names the public orderBookOrders endpoint returns (2026-09-24). */
const REAL_ORDER = {
  order_index: 562953415622946,
  order_id: "562953415622946",
  owner_account_index: 27927,
  initial_base_amount: "0.00020",
  remaining_base_amount: "0.00020",
  price: "83705.3",
  order_expiry: 1790255681486,
  transaction_time: 0,
};

function clientReturning(value: unknown): LighterClient {
  return { accountActiveOrders: async () => value } as unknown as LighterClient;
}

describe("openOrders", () => {
  it("reads the fields the venue actually publishes", async () => {
    const [o] = await openOrders(clientReturning({ code: 200, orders: [REAL_ORDER] }), 50, "t");
    expect(o).toEqual({
      orderIndex: 562953415622946,
      marketId: null,
      price: "83705.3",
      remaining: "0.00020",
      initial: "0.00020",
      isAsk: null,
      expiryMs: 1790255681486,
    });
  });

  it("accepts is_ask as a boolean or as 0/1", async () => {
    const bool = await openOrders(clientReturning({ code: 200, orders: [{ ...REAL_ORDER, is_ask: true }] }), 50, "t");
    const num = await openOrders(clientReturning({ code: 200, orders: [{ ...REAL_ORDER, is_ask: 1 }] }), 50, "t");
    const zero = await openOrders(clientReturning({ code: 200, orders: [{ ...REAL_ORDER, is_ask: 0 }] }), 50, "t");
    expect(bool[0]?.isAsk).toBe(true);
    expect(num[0]?.isAsk).toBe(true);
    expect(zero[0]?.isAsk).toBe(false);
  });

  it("leaves a missing side null rather than defaulting it", async () => {
    // Defaulting to buy would paint a sell order as a buy, which is worse than
    // showing nothing.
    const [o] = await openOrders(clientReturning({ code: 200, orders: [REAL_ORDER] }), 50, "t");
    expect(o?.isAsk).toBeNull();
  });

  it("names the keys it did get when the payload has no orders array", async () => {
    // This endpoint has never been called with a valid token, so a different
    // envelope must be diagnosable rather than looking like an empty book.
    const err = await openOrders(clientReturning({ code: 200, active_orders: [] }), 50, "t").catch((e) => e);
    expect(err).toBeInstanceOf(UnexpectedShapeError);
    expect((err as UnexpectedShapeError).keys).toEqual(["active_orders"]);
    expect(String(err)).toContain("active_orders");
  });

  it("returns an empty list for an account with nothing resting", async () => {
    expect(await openOrders(clientReturning({ code: 200, orders: [] }), 50, "t")).toEqual([]);
  });
});
