import { describe, expect, it } from "vitest";
import { DEPOSIT_ROUTE, USDC_ASSET_ID } from "./deposit";
import { MIN_WITHDRAW_USDC, TX_TYPE_L2_WITHDRAW, WithdrawError, buildWithdraw, formatUsdcUnits, usdcUnits } from "./withdraw";

describe("usdcUnits", () => {
  it("turns a decimal string into integer units without float drift", () => {
    expect(usdcUnits("0.1")).toBe(100_000n);
    expect(usdcUnits("12.5")).toBe(12_500_000n);
    expect(usdcUnits("7")).toBe(7_000_000n);
    expect(usdcUnits(" 3.000001 ")).toBe(3_000_001n);
    expect(usdcUnits("0.000001")).toBe(1n);
  });

  it("refuses what USDC cannot represent or what is not a plain decimal", () => {
    expect(() => usdcUnits("1.0000001")).toThrow(WithdrawError);
    for (const bad of ["12,5", "-5", "1e3", "", ".", "abc", "$10"]) {
      expect(() => usdcUnits(bad), bad).toThrow(WithdrawError);
    }
  });
});

describe("buildWithdraw", () => {
  it("describes a perps withdrawal in the signer's units with the constants the venue expects", () => {
    const w = buildWithdraw({ amountUsdc: "12.5", availableUsdc: 100 });
    expect(w).toEqual({ assetIndex: USDC_ASSET_ID, routeType: DEPOSIT_ROUTE.perps, amount: 12_500_000, amountUsdc: "12.500000" });
    expect(w.assetIndex).toBe(3);
    expect(w.routeType).toBe(0);
    expect(TX_TYPE_L2_WITHDRAW).toBe(13);
  });

  it("can target the spot balance", () => {
    expect(buildWithdraw({ amountUsdc: "5", availableUsdc: 5, route: "spot" }).routeType).toBe(1);
  });

  it("holds the venue's minimum", () => {
    expect(MIN_WITHDRAW_USDC).toBe(1);
    expect(() => buildWithdraw({ amountUsdc: "0.999999", availableUsdc: 100 })).toThrow(/at least 1 USDC/);
    expect(buildWithdraw({ amountUsdc: "1", availableUsdc: 100 }).amount).toBe(1_000_000);
  });

  it("never exceeds the available balance, flooring the venue's float before comparing", () => {
    expect(buildWithdraw({ amountUsdc: "10", availableUsdc: 10.0000004 }).amount).toBe(10_000_000);
    expect(() => buildWithdraw({ amountUsdc: "10.000001", availableUsdc: 10.0000004 })).toThrow(/available balance/);
    expect(() => buildWithdraw({ amountUsdc: "10.000001", availableUsdc: 10 })).toThrow(/available balance/);
  });

  it("refuses to build against a balance it does not know", () => {
    expect(() => buildWithdraw({ amountUsdc: "5", availableUsdc: Number.NaN })).toThrow(/not known/);
    expect(() => buildWithdraw({ amountUsdc: "5", availableUsdc: -1 })).toThrow(/not known/);
  });

  it("refuses an amount the signer's number type could not carry exactly", () => {
    expect(() => buildWithdraw({ amountUsdc: "10000000000", availableUsdc: 1e11 })).toThrow(/exactly/);
  });
});

describe("formatUsdcUnits", () => {
  it("prints all six places", () => {
    expect(formatUsdcUnits(1_234_567n)).toBe("1.234567");
    expect(formatUsdcUnits(5_000_000n)).toBe("5.000000");
    expect(formatUsdcUnits(1n)).toBe("0.000001");
  });
});
