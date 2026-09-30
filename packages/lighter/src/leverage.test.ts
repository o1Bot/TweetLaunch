import { describe, expect, it } from "vitest";
import { MARGIN_MODE, TX_TYPE_L2_UPDATE_LEVERAGE, marginFractionFor, marginFractionFromPercent } from "./leverage";

describe("marginFractionFor", () => {
  it("turns a leverage into the venue's initial margin fraction", () => {
    expect(marginFractionFor(1)).toBe(10_000);
    expect(marginFractionFor(10)).toBe(1_000);
    expect(marginFractionFor(20)).toBe(500);
    expect(marginFractionFor(50)).toBe(200);
  });

  it("rounds up, so the resulting leverage never exceeds the one asked for", () => {
    expect(marginFractionFor(3)).toBe(3_334);
    expect(10_000 / marginFractionFor(3)).toBeLessThanOrEqual(3);
    expect(marginFractionFor(7)).toBe(1_429);
    expect(10_000 / marginFractionFor(7)).toBeLessThanOrEqual(7);
  });

  it("refuses anything that is not a whole number of at least 1", () => {
    for (const bad of [0, -5, 2.5, Number.NaN]) expect(() => marginFractionFor(bad), String(bad)).toThrow(RangeError);
  });
});

describe("marginFractionFromPercent", () => {
  it("reads the venue's percent string in the same units", () => {
    // Measured live 2026-09-30: a BTC position entry carried "5.00" for 20x.
    expect(marginFractionFromPercent("5.00")).toBe(500);
    expect(marginFractionFromPercent("10.00")).toBe(marginFractionFor(10));
    expect(marginFractionFromPercent(2)).toBe(200);
  });

  it("returns null for what is not a positive number", () => {
    for (const bad of ["", "abc", "0", null, undefined]) expect(marginFractionFromPercent(bad), String(bad)).toBeNull();
  });
});

describe("constants", () => {
  it("match lighter-go at the pinned commit", () => {
    expect(TX_TYPE_L2_UPDATE_LEVERAGE).toBe(20);
    expect(MARGIN_MODE).toEqual({ cross: 0, isolated: 1 });
  });
});
