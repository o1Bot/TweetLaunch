import { describe, expect, it } from "vitest";
import { NO_INTEGRATOR, TriggerError, quote, type Market } from "../lib/ticket";

/** BNB as the venue reports it: the worst size resolution measured on 2026-09-21. */
const BNB: Market = {
  market_id: 21,
  supported_price_decimals: 2,
  supported_size_decimals: 2,
  maintenance_margin_fraction: 250,
};

/** 23 perp markets trade in whole units; this is that case. */
const WHOLE_UNITS: Market = {
  market_id: 99,
  supported_price_decimals: 4,
  supported_size_decimals: 0,
  maintenance_margin_fraction: 500,
};

const base = { side: "long", type: "market", leverage: 5 } as const;

describe("quote", () => {
  it("prices the ledger off the order that will actually be sent", () => {
    // $100 of BNB at 781.22 wants 0.12800516 and floors to 0.12 — 6.25% less.
    const q = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB });

    expect(q.built.contracts).toBe("0.12");
    expect(q.effectiveNotionalUsd).toBeCloseTo(93.7464, 4);
    expect(q.shortfallPct).toBeCloseTo(6.25, 2);

    // Every ledger figure follows the floored size, not the request.
    expect(q.ledger.notionalUsd).toBeCloseTo(q.effectiveNotionalUsd, 6);
    expect(q.ledger.marginUsd).toBeCloseTo(q.effectiveNotionalUsd / 5, 6);
  });

  it("keeps the displayed size and the wire size the same number", () => {
    const q = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB });
    // contracts is the string shown; baseAmount is what is signed.
    expect(q.built.baseAmount).toBe(Number(q.built.contracts) * 10 ** BNB.supported_size_decimals);
  });

  it("reports the whole request as lost when it floors to nothing", () => {
    // $3 of a $10 asset in whole units cannot be ordered at all.
    expect(() => quote({ ...base, notionalUsd: 3, price: 10, market: WHOLE_UNITS })).toThrow(
      /below this market's size resolution/,
    );
  });

  it("has no shortfall when the size divides exactly", () => {
    const q = quote({ ...base, notionalUsd: 50, price: 10, market: WHOLE_UNITS });
    expect(q.built.contracts).toBe("5");
    expect(q.shortfallPct).toBeCloseTo(0, 9);
    expect(q.effectiveNotionalUsd).toBeCloseTo(50, 9);
  });

  it("never rounds a position up", () => {
    // Flooring is the safe direction: the position is never larger than asked.
    for (const notional of [10, 37, 99.99, 1234.56]) {
      const q = quote({ ...base, notionalUsd: notional, price: 781.22, market: BNB });
      expect(q.effectiveNotionalUsd).toBeLessThanOrEqual(notional + 1e-9);
    }
  });

  it("carries a market order's slippage guard on the price, not the size", () => {
    const q = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB, slippage: 0.01 });
    // A long accepts up to 1% worse, so the wire price is above the mark.
    expect(q.built.price).toBeGreaterThan(781.22 * 10 ** BNB.supported_price_decimals);
    expect(q.built.contracts).toBe("0.12");
  });

  it("marks a market order taker and a limit order maker", () => {
    const mk = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB });
    const lm = quote({ ...base, type: "limit", notionalUsd: 100, price: 781.22, market: BNB });
    expect(mk.built.timeInForce).toBe(0); // IOC
    expect(lm.built.timeInForce).toBe(1); // GTT
  });

  it("charges no integrator fee until one is configured", () => {
    const q = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB });
    expect(NO_INTEGRATOR.accountIndex).toBe(0);
    expect(q.ledger.integratorFeeUsd).toBe(0);
    expect(q.ledger.integratorFeePpm).toBe(0);
  });

  it("puts a short's liquidation above entry and a long's below", () => {
    const long = quote({ ...base, notionalUsd: 100, price: 781.22, market: BNB });
    const short = quote({ ...base, side: "short", notionalUsd: 100, price: 781.22, market: BNB });
    expect(long.ledger.liqPrice).toBeLessThan(781.22);
    expect(short.ledger.liqPrice).toBeGreaterThan(781.22);
  });
});

describe("quote — stops and take-profits", () => {
  // A sell-stop on BNB with the mark at 781.22.
  const stop = { side: "short", type: "stopLoss", leverage: 5, notionalUsd: 100, price: 781.22, market: BNB } as const;

  it("builds a stop as an IOC trigger order with an expiry", () => {
    const q = quote({ ...stop, triggerPrice: 760 });
    expect(q.built.orderType).toBe(2); // stopLoss
    expect(q.built.timeInForce).toBe(0); // IOC once it fires
    expect(q.built.triggerPrice).toBe(760 * 10 ** BNB.supported_price_decimals);
    expect(q.built.orderExpiry).toBe(-1); // the signer's default, not "unset"
  });

  it("builds a take-profit as its own order type", () => {
    expect(quote({ ...stop, type: "takeProfit", triggerPrice: 800 }).built.orderType).toBe(4);
  });

  it("refuses a stop on the wrong side of the mark", () => {
    // A sell-stop above the mark, or a buy-stop below it, fires the instant it
    // is placed — at market, which nobody setting a stop intends.
    expect(() => quote({ ...stop, triggerPrice: 800 })).toThrow(/below the mark/);
    expect(() => quote({ ...stop, side: "long", triggerPrice: 760 })).toThrow(/above the mark/);
  });

  it("refuses a take-profit on the wrong side of the mark", () => {
    // The mirror of a stop: a sell-TP sits above, a buy-TP below.
    expect(() => quote({ ...stop, type: "takeProfit", triggerPrice: 760 })).toThrow(/above the mark/);
    expect(() => quote({ ...stop, type: "takeProfit", side: "long", triggerPrice: 800 })).toThrow(/below the mark/);
  });

  it("names the direction in the error, so the message says what to change", () => {
    expect(() => quote({ ...stop, triggerPrice: 800 })).toThrow(TriggerError);
    expect(() => quote({ ...stop, triggerPrice: 800 })).toThrow(/stop to sell/);
  });

  it("requires a trigger for stops and take-profits", () => {
    expect(() => quote({ ...stop })).toThrow(/trigger price is required/);
    expect(() => quote({ ...stop, triggerPrice: 0 })).toThrow(/trigger price is required/);
  });

  it("does not touch market and limit orders", () => {
    // No trigger, no side check: these two must behave exactly as before.
    expect(quote({ ...stop, type: "market" }).built.triggerPrice).toBe(0);
    expect(quote({ ...stop, type: "limit" }).built.triggerPrice).toBe(0);
  });

  it("passes reduce-only through to the wire", () => {
    expect(quote({ ...stop, triggerPrice: 760, reduceOnly: true }).built.reduceOnly).toBe(1);
    expect(quote({ ...stop, triggerPrice: 760 }).built.reduceOnly).toBe(0);
  });
});
