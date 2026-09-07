import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import fixtures from "./fixtures/robinhood-launches.json" with { type: "json" };
import {
  buildLaunchRoute,
  encodeRoute,
  launchPoolStep,
  MAX_ROUTE_DATA_BYTES,
  nativeToLaunchPoolRoute,
  ROUTE_STEPS_ABI,
  v3PoolStep,
  v4PoolStep,
} from "../src/route";

// Robinhood Chain addresses (config/o1.json).
const HOOK = "0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
/** SwapX V3 WETH/USDG pool, fee tier 100 (factory.getPool, verified 2026-09-07). */
const V3_WETH_USDG_100 = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as const;

describe("dev-buy route data", () => {
  it("reproduces the routeData of a live ETH-paired createLaunchAndBuy byte for byte", () => {
    const buy = fixtures.cgmBuy.buy!;
    const encoded = nativeToLaunchPoolRoute({ token: getAddress(fixtures.cgmBuy.token), hook: HOOK, tickSpacing: 200 });
    expect(encoded.toLowerCase()).toBe(buy.routeData.toLowerCase());
  });

  it("reproduces the 3-hop routeData of a live stock-paired createLaunchAndBuy byte for byte", () => {
    const f = fixtures.directorBuy;
    const stock = getAddress(f.params.quoteToken);
    const encoded = buildLaunchRoute(
      [v3PoolStep(WETH, USDG, V3_WETH_USDG_100, 100), v4PoolStep(USDG, stock, 1500, 15)],
      launchPoolStep({ quote: stock, token: getAddress(f.token), hook: HOOK, tickSpacing: 200 }),
    );
    expect(encoded.toLowerCase()).toBe(f.buy!.routeData.toLowerCase());
  });

  it("reproduces a stock-paired buy through a V4 USDG pool on a tier outside the old fixed list (BA, 2000/20)", () => {
    // Launched through o1's own UI on 2026-09-07; the bot must produce identical bytes.
    const f = fixtures.flyBuy;
    const stock = getAddress(f.params.quoteToken);
    const encoded = buildLaunchRoute(
      [v3PoolStep(WETH, USDG, V3_WETH_USDG_100, 100), v4PoolStep(USDG, stock, 2000, 20)],
      launchPoolStep({ quote: stock, token: getAddress(f.token), hook: HOOK, tickSpacing: 200 }),
    );
    expect(encoded.toLowerCase()).toBe(f.buy!.routeData.toLowerCase());
    expect(BigInt(f.value)).toBe(BigInt(f.buy!.amountIn) + 1_000_000_000_000_000n);
  });

  it("round-trips through the step layout", () => {
    const [steps] = decodeAbiParameters(ROUTE_STEPS_ABI, fixtures.directorBuy.buy!.routeData as Hex);
    expect(steps.map((s) => s.kind)).toEqual([1, 2, 2]);
    expect(getAddress(steps[0]!.pool)).toBe(V3_WETH_USDG_100);
    expect(steps[0]!.fee).toBe(100);
    expect(steps[1]!.fee).toBe(1500);
    expect(steps[1]!.tickSpacing).toBe(15);
    expect(steps[2]!.fee).toBe(0);
    expect(getAddress(steps[2]!.hooks)).toBe(HOOK);
    expect(steps.every((s) => s.hookData === "0x")).toBe(true);
  });

  it("refuses routes above o1's 4096-byte cap", () => {
    const token = getAddress(fixtures.cgmBuy.token) as Address;
    const step = v4PoolStep("0x0000000000000000000000000000000000000000", token, 0, 200, HOOK);
    expect(() => encodeRoute(Array.from({ length: 20 }, () => step))).toThrow(new RegExp(String(MAX_ROUTE_DATA_BYTES)));
  });
});
