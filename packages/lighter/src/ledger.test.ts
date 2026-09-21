import { describe, expect, it } from "vitest";
import { perpLedger, spotLedger } from "./ledger";

describe("perpLedger", () => {
  // BTC riil: entry 64000, maintenance 120 bps (api-truth §4)
  const base = {
    side: "long" as const,
    notionalUsd: 1000,
    entryPrice: 64000,
    leverage: 10,
    isTaker: true,
    maintenanceMarginBps: 120,
  };

  it("margin = notional / leverage", () => {
    expect(perpLedger(base).marginUsd).toBe(100);
  });

  it("integrator taker 2.0 bps, Lighter 0", () => {
    const l = perpLedger(base);
    expect(l.integratorFeeUsd).toBeCloseTo(0.2); // 1000 × 200/1e6
    expect(l.lighterFeeUsd).toBe(0);
    expect(l.totalDebitedUsd).toBeCloseTo(100.2);
  });

  it("maker gratis by design", () => {
    const l = perpLedger({ ...base, isTaker: false });
    expect(l.integratorFeeUsd).toBe(0);
    expect(l.integratorFeePpm).toBe(0);
  });

  it("kontrak = notional / entry", () => {
    expect(perpLedger(base).contracts).toBeCloseTo(1000 / 64000);
  });

  it("liq long di bawah entry, short di atas — dan makin jauh saat leverage turun", () => {
    const long10 = perpLedger(base).liqPrice;
    const long2 = perpLedger({ ...base, leverage: 2 }).liqPrice;
    const short10 = perpLedger({ ...base, side: "short" }).liqPrice;
    expect(long10).toBeLessThan(64000);
    expect(short10).toBeGreaterThan(64000);
    expect(long2).toBeLessThan(long10);
    // 64000 × (1 − 0.1 + 0.012) = 58368
    expect(long10).toBeCloseTo(58368);
  });

  it("8h funding from the percent rate", () => {
    expect(perpLedger({ ...base, fundingRatePct: 0.0012 }).estFunding8hUsd).toBeCloseTo(0.012);
  });

  it("invalid input → zero ledger, not NaN", () => {
    const l = perpLedger({ ...base, notionalUsd: 0 });
    expect(l.totalDebitedUsd).toBe(0);
    expect(Number.isNaN(l.liqPrice)).toBe(false);
  });
});

describe("spotLedger", () => {
  const base = {
    side: "buy" as const,
    notionalUsd: 500,
    limitPrice: 1900,
    midPrice: 1910,
    isTaker: true,
  };

  it("buy: bayar notional + fee, terima base", () => {
    const l = spotLedger(base);
    expect(l.youPayUsd).toBeCloseTo(500.1);
    expect(l.youReceiveBase).toBeCloseTo(500 / 1900);
    expect(l.totalUsd).toBeCloseTo(-500.1);
  });

  it("sell: kredit notional − fee", () => {
    const l = spotLedger({ ...base, side: "sell" });
    expect(l.totalUsd).toBeCloseTo(499.9);
  });

  it("distance from mid in bps", () => {
    // (1900 − 1910) / 1910 × 1e4 ≈ −52.36 bps (di bawah mid)
    expect(spotLedger(base).distanceFromMidBps).toBeCloseTo(-52.36, 1);
  });

  it("no mid → null distance, not NaN", () => {
    expect(spotLedger({ ...base, midPrice: undefined }).distanceFromMidBps).toBeNull();
  });
});
