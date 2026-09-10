import { describe, expect, it } from "vitest";
import {
  activeFactory,
  activeFeeEscrow,
  activeSuite,
  findQuote,
  o1Chain,
  o1Config,
  registryDrift,
  stockQuotes,
  suiteByFactory,
  tickerCollidesWithStock,
} from "../src/o1-registry";

describe("o1 registry snapshot (Robinhood)", () => {
  it("has a current suite with a factory, escrow and token deployer", () => {
    expect(activeSuite("robinhood").status).toBe("current");
    expect(activeFactory("robinhood")).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(activeFeeEscrow("robinhood")).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(o1Chain("robinhood").contracts.launchTokenDeployer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(o1Chain("robinhood").chainId).toBe(4663);
    expect(o1Chain("robinhood").requiredTokenAddressSuffix).toBe("01");
  });

  it("resolves native, stablecoin and stock pairs", () => {
    expect(findQuote("robinhood", "eth")?.address).toBe("0x0000000000000000000000000000000000000000");
    expect(findQuote("robinhood", "$USDG")?.decimals).toBe(6);
    expect(findQuote("robinhood", "USDG")?.kind).toBe("crypto");
    expect(findQuote("robinhood", "NVDA")?.kind).toBe("stock");
    expect(findQuote("robinhood", "nvda")?.decimals).toBe(18);
    expect(findQuote("robinhood", "USDC")).toBeNull();
    expect(stockQuotes("robinhood").length).toBeGreaterThan(100);
  });

  it("looks a pair up by address regardless of casing", () => {
    const usdg = findQuote("robinhood", "USDG")!;
    expect(findQuote("robinhood", usdg.address.toLowerCase())?.symbol).toBe("USDG");
  });

  it("recognises historical factories and ticker collisions", () => {
    const suites = o1Config().chains.robinhood.suites;
    const historical = suites.find((s) => s.status === "historical");
    expect(historical).toBeDefined();
    const factory = historical!.contracts.factory!;
    expect(suiteByFactory(4663, factory.toLowerCase())?.suite.suiteId).toBe(historical!.suiteId);
    expect(suiteByFactory(8453, factory)).toBeNull();
    expect(tickerCollidesWithStock("robinhood", "tsla")).toBe(true);
    expect(tickerCollidesWithStock("robinhood", "RUGRAT")).toBe(false);
  });

  it("reports no drift against a registry that mirrors the snapshot", async () => {
    const cfg = o1Config();
    const live = {
      lastUpdatedAt: "now",
      chains: Object.values(cfg.chains).map((c) => ({ chainId: c.chainId, currentSuiteId: c.currentSuiteId, suites: c.suites })),
    };
    expect(await registryDrift(live)).toEqual([]);
    const rotated = { ...live, chains: live.chains.map((c) => ({ ...c, currentSuiteId: "something-new" })) };
    // Every chain's suite was rotated, so every chain drifts.
    expect((await registryDrift(rotated)).length).toBe(live.chains.length);
  });
});
