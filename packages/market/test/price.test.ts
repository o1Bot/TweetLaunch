import { describe, expect, it } from "vitest";
import { buildCandles } from "../src/candles";
import { e18ToDecimalString, parseDecimalToRaw, priceQuotePerTokenE18, Q96 } from "../src/price";
import { classifySwap, tokenIsCurrency0 } from "../src/swap";
import { computeStats } from "../src/stats";

describe("priceQuotePerTokenE18", () => {
  it("is 1 at sqrtPrice = 2^96 with equal decimals, either ordering", () => {
    expect(priceQuotePerTokenE18(Q96, true, 18)).toBe(10n ** 18n);
    expect(priceQuotePerTokenE18(Q96, false, 18)).toBe(10n ** 18n);
  });

  it("scales by decimals: 1 raw ratio with a 6-decimal quote is 1e12 quote per token", () => {
    // token (18 dec) is currency0, quote USDG (6 dec) is currency1, raw ratio 1:1
    expect(priceQuotePerTokenE18(Q96, true, 6)).toBe(10n ** 30n);
    // token is currency1: quote per token = 1/raw * 10^(18-6) = 1e12 as well at ratio 1
    expect(priceQuotePerTokenE18(Q96, false, 6)).toBe(10n ** 30n);
  });

  it("inverts correctly when the token is currency1", () => {
    // raw1 per raw0 = 4  → sqrt = 2 * 2^96
    const sqrt = 2n * Q96;
    expect(priceQuotePerTokenE18(sqrt, true, 18)).toBe(4n * 10n ** 18n); // token is c0: 4 quote per token
    expect(priceQuotePerTokenE18(sqrt, false, 18)).toBe(25n * 10n ** 16n); // token is c1: 0.25 quote per token
  });

  it("formats and parses decimals exactly", () => {
    expect(e18ToDecimalString(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(e18ToDecimalString(318_000_000_000_000n)).toBe("0.000318");
    expect(e18ToDecimalString(0n)).toBe("0");
    expect(parseDecimalToRaw("0.05", 18)).toBe(50_000_000_000_000_000n);
    expect(parseDecimalToRaw("12", 6)).toBe(12_000_000n);
    expect(() => parseDecimalToRaw("1e3", 18)).toThrow();
  });
});

describe("classifySwap", () => {
  it("reads buys and sells from the swapper's deltas", () => {
    // token is currency1, swapper paid 1 ETH (amount0 negative) and received tokens (amount1 positive)
    expect(classifySwap({ amount0: -(10n ** 18n), amount1: 5_000n, tokenIsCurrency0: false })).toEqual({ side: "BUY", amountToken: 5_000n, amountQuote: 10n ** 18n });
    // token is currency0, swapper sold tokens (amount0 negative) for quote (amount1 positive)
    expect(classifySwap({ amount0: -7n, amount1: 3n, tokenIsCurrency0: true })).toEqual({ side: "SELL", amountToken: 7n, amountQuote: 3n });
  });

  it("orders currencies by address with native ETH first", () => {
    expect(tokenIsCurrency0("0x4265C73fE356639f124E82fBeCf8a7C447F34D01", "0x0000000000000000000000000000000000000000")).toBe(false);
    expect(tokenIsCurrency0("0x149c347232EB1d8344508A50a93450FCe87F4701", "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8")).toBe(true);
  });
});

describe("computeStats", () => {
  it("derives change, market cap and USD values", () => {
    const s = computeStats({ lastPrice: 0.002, priceAt24hAgo: 0.001, volume24hQuote: 10, supplyTokens: 1e9, quoteUsd: 3000, launchPrice: null });
    expect(s.change24hPct).toBeCloseTo(100);
    expect(s.mcapQuote).toBeCloseTo(2_000_000);
    expect(s.mcapUsd).toBeCloseTo(6e9);
    expect(s.volume24hUsd).toBeCloseTo(30_000);
  });

  it("falls back to the launch price and tolerates unknowns", () => {
    const s = computeStats({ lastPrice: 2, priceAt24hAgo: null, volume24hQuote: 0, supplyTokens: 1e9, quoteUsd: null, launchPrice: 1 });
    expect(s.change24hPct).toBeCloseTo(100);
    expect(s.priceUsd).toBeNull();
    expect(computeStats({ lastPrice: null, priceAt24hAgo: null, volume24hQuote: 0, supplyTokens: 1e9, quoteUsd: 1, launchPrice: null }).mcapQuote).toBeNull();
  });
});

describe("buildCandles smoke", () => {
  it("buckets and fills", () => {
    const c = buildCandles([{ ts: 0, price: 1, volumeQuote: 1 }, { ts: 130, price: 3, volumeQuote: 2 }], 60, { fill: true });
    expect(c.map((x) => x.t)).toEqual([0, 60, 120]);
    expect(c[1]).toMatchObject({ o: 1, c: 1, v: 0, n: 0 });
    expect(c[2]).toMatchObject({ o: 1, h: 3, l: 1, c: 3, v: 2, n: 1 });
  });
});
