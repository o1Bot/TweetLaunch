import { describe, expect, it } from "vitest";
import type { AccountPosition } from "@o1bot/lighter";
import { CloseError, closeOrderFor } from "../lib/close";
import type { PerpRow } from "../lib/markets";

const BTC: PerpRow = {
  symbol: "BTC",
  marketId: 1,
  category: "crypto",
  lastPrice: 86_000,
  markPrice: 86_500,
  changePct: 1,
  volumeUsd: 1e9,
  openInterestUsd: 1e8,
  maxLeverage: 50,
  priceDecimals: 1,
  sizeDecimals: 5,
  maintenanceMarginBps: 120,
};

function position(over: Partial<AccountPosition> = {}): AccountPosition {
  return {
    market_id: 1,
    symbol: "BTC",
    sign: 1,
    position: "0.25",
    avg_entry_price: "80000",
    position_value: "21625",
    unrealized_pnl: "1625",
    realized_pnl: "0",
    liquidation_price: "60000",
    ...over,
  } as AccountPosition;
}

describe("closeOrderFor", () => {
  it("sells to close a long and buys to close a short", () => {
    expect(closeOrderFor(position({ sign: 1 }), [BTC]).isAsk).toBe(1);
    expect(closeOrderFor(position({ sign: -1 }), [BTC]).isAsk).toBe(0);
  });

  it("is always reduce-only, so it can never open the other side", () => {
    expect(closeOrderFor(position(), [BTC]).reduceOnly).toBe(1);
  });

  it("sizes to the position, not to a dollar amount", () => {
    const o = closeOrderFor(position({ position: "0.25" }), [BTC]);
    expect(o.contracts).toBe("0.25000");
    expect(o.baseAmount).toBe(25000); // 0.25 at 5 size decimals
  });

  it("uses the market's decimals rather than anything on the position", () => {
    // A market quoted to 1 price decimal must not produce a price scaled by 5.
    // Closing a long is a sell, and a seller's worst acceptable price is BELOW
    // the mark, so the guard subtracts the slippage rather than adding it.
    const o = closeOrderFor(position(), [BTC]);
    expect(o.price).toBe(Math.round(86_500 * 0.995 * 10 ** BTC.priceDecimals));
  });

  it("guards the price on the side the close actually trades", () => {
    const long = closeOrderFor(position({ sign: 1 }), [BTC]); // sells
    const short = closeOrderFor(position({ sign: -1 }), [BTC]); // buys
    expect(long.price).toBeLessThan(86_500 * 10 ** BTC.priceDecimals);
    expect(short.price).toBeGreaterThan(86_500 * 10 ** BTC.priceDecimals);
  });

  it("treats the venue's unsigned size as a magnitude", () => {
    // Shorts report the size without a sign; a negative would floor to nothing.
    const o = closeOrderFor(position({ sign: -1, position: "-0.25" }), [BTC]);
    expect(o.contracts).toBe("0.25000");
    expect(o.isAsk).toBe(0);
  });

  it("refuses a market it has no decimals for rather than guessing them", () => {
    expect(() => closeOrderFor(position({ market_id: 999 }), [BTC])).toThrow(CloseError);
  });

  it("refuses a flat position", () => {
    expect(() => closeOrderFor(position({ position: "0" }), [BTC])).toThrow(/already flat/);
  });

  it("falls back to last price when the venue reports no mark", () => {
    const noMark = { ...BTC, markPrice: 0 };
    const o = closeOrderFor(position(), [noMark]);
    expect(o.price).toBe(Math.round(86_000 * 0.995 * 10 ** BTC.priceDecimals));
  });
});
