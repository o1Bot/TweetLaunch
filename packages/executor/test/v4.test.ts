import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import fixtures from "./fixtures/robinhood-launches.json" with { type: "json" };
import { poolIdOf, poolKeyFor } from "../src/v4";

// Robinhood Chain LaunchHook (config/o1.json → contracts.hook).
const HOOK = "0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc" as const;

describe("v4 pool identity", () => {
  it("sorts currencies so native ETH is currency0", () => {
    const token = getAddress(fixtures.cgmBuy.token);
    const key = poolKeyFor(token, zeroAddress, 0, 200, HOOK);
    expect(key.currency0).toBe(zeroAddress);
    expect(key.currency1).toBe(token);
  });

  it("reproduces the poolId the factory emitted for live launches", () => {
    for (const f of [fixtures.cgmBuy, fixtures.directorBuy, fixtures.cashcat, fixtures.flyBuy]) {
      const key = poolKeyFor(getAddress(f.params.quoteToken), getAddress(f.token), 0, 200, HOOK);
      expect(poolIdOf(key)).toBe(f.poolId);
    }
  });
});
