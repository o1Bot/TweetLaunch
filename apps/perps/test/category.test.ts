import { describe, expect, it } from "vitest";
import { categorise } from "../lib/category";

describe("categorise", () => {
  it("reads the venue's multiplier for the clear cases", () => {
    // Checked live 2026-09-21: 100 on every known crypto market.
    for (const s of ["BTC", "ETH", "SOL", "DOGE", "AAVE", "HYPE"]) {
      expect(categorise(s, 100)).toBe("crypto");
    }
    // 50 on stocks, metals, energy, FX and indices.
    for (const s of ["AAPL", "XAU", "WTI", "EURUSD", "US500", "TENCENT"]) {
      expect(categorise(s, 50)).toBe("rwa");
    }
  });

  it("treats the pre-IPO tier as RWA", () => {
    expect(categorise("OPENAI", 1)).toBe("rwa");
    expect(categorise("ANTHROPIC", 1)).toBe("rwa");
  });

  it("corrects the symbols the multiplier gets wrong", () => {
    // Both sit at 100 on the venue despite not being crypto.
    expect(categorise("SPACEX", 100)).toBe("rwa");
    expect(categorise("ADI", 100)).toBe("rwa");
    expect(categorise("spacex", 100)).toBe("rwa");
  });

  it("falls to crypto for an unknown multiplier rather than dropping the market", () => {
    // A new market with a multiplier nobody has seen still appears in the list.
    expect(categorise("NEWTHING", undefined)).toBe("crypto");
    expect(categorise("NEWTHING", 7)).toBe("crypto");
  });
});
