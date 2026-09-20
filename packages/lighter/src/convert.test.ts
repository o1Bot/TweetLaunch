import { describe, expect, it } from "vitest";
import { ConversionError, fromWire, toWire } from "./convert";
import { displaySymbol, marketKey, maxLeverage, tickSize } from "./market";

// Real cases from docs/api-truth.md: BTC pxDec 1 / szDec 5, SUI the inverse 5 / 1.
describe("toWire", () => {
  it("BTC: price 64479.7 → 644797", () => {
    expect(toWire("64479.7", 1)).toBe(644797n);
  });
  it("BTC: minimum size 0.00020 → 20", () => {
    expect(toWire("0.00020", 5)).toBe(20n);
  });
  it("SUI: price 0.68665 → 68665", () => {
    expect(toWire("0.68665", 5)).toBe(68665n);
  });
  it("SUI: size 3.0 → 30", () => {
    expect(toWire("3.0", 1)).toBe(30n);
  });
  it("whole number without a decimal point", () => {
    expect(toWire("10", 6)).toBe(10_000_000n);
  });
  it("zero", () => {
    expect(toWire("0", 3)).toBe(0n);
  });
  it("trailing zeros beyond decimals are still valid", () => {
    expect(toWire("1.500", 1)).toBe(15n);
  });
  it("rejects precision beyond the market's decimals", () => {
    expect(() => toWire("64479.75", 1)).toThrow(ConversionError);
    expect(() => toWire("0.000201", 5)).toThrow(ConversionError);
  });
  it("rejects formats that are not plain decimals", () => {
    for (const bad of ["", ".", ".5", "1e5", "-1", "1,5", "abc", "1.2.3", "0x10"]) {
      expect(() => toWire(bad, 2), `input: "${bad}"`).toThrow(ConversionError);
    }
  });
  it("rejects out-of-range decimals", () => {
    expect(() => toWire("1", -1)).toThrow(ConversionError);
    expect(() => toWire("1", 1.5)).toThrow(ConversionError);
  });
});

describe("fromWire", () => {
  it("BTC: 644797 → 64479.7", () => {
    expect(fromWire(644797n, 1)).toBe("64479.7");
  });
  it("trailing zeros dropped: 20 at 5 decimals → 0.0002", () => {
    expect(fromWire(20n, 5)).toBe("0.0002");
  });
  it("zero", () => {
    expect(fromWire(0n, 4)).toBe("0");
  });
  it("decimals 0 passes through as-is", () => {
    expect(fromWire(42n, 0)).toBe("42");
  });
  it("negative values (PnL) stay correct", () => {
    expect(fromWire(-15n, 1)).toBe("-1.5");
  });
  it("accepts number and string", () => {
    expect(fromWire(644797, 1)).toBe("64479.7");
    expect(fromWire("644797", 1)).toBe("64479.7");
  });
});

describe("round-trip both directions", () => {
  const wires = [0n, 1n, 20n, 644797n, 10_000_000n, 281_474_976_710_655n];
  const decimalsRange = [0, 1, 2, 3, 4, 5, 6];
  it("toWire(fromWire(x)) === x for all combinations", () => {
    for (const w of wires) {
      for (const d of decimalsRange) {
        expect(toWire(fromWire(w, d), d), `wire ${w} @ ${d} decimals`).toBe(w);
      }
    }
  });
});

describe("market helpers", () => {
  const btc = {
    symbol: "BTC",
    market_type: "perp" as const,
    supported_price_decimals: 1,
    min_initial_margin_fraction: 200,
  };
  const ethSpot = { symbol: "ETH/USDG", market_type: "spot" as const };

  it("maxLeverage BTC: 10000/200 = 50x", () => {
    expect(maxLeverage(btc)).toBe(50);
  });
  it("tickSize BTC: 0.1", () => {
    expect(tickSize(btc)).toBe("0.1");
  });
  it("displaySymbol: perp uses dash + instance quote, spot as-is", () => {
    expect(displaySymbol(btc)).toBe("BTC-USDC"); // mainnet default
    expect(displaySymbol(btc, "USDG")).toBe("BTC-USDG"); // RH instance
    expect(displaySymbol(ethSpot)).toBe("ETH/USDG");
  });
  it("marketKey unique across venues", () => {
    expect(marketKey(btc)).toBe("BTC-perp");
    expect(marketKey(ethSpot)).toBe("ETH-spot");
  });
});
