import { describe, expect, it } from "vitest";
import { NO_INTEGRATOR, quote, type Market } from "../lib/ticket";

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
