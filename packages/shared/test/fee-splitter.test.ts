import { describe, expect, it } from "vitest";
import { FEE_SPLIT_BPS, parseFeeSplitConfig, recipientShareOf, recipientSharePct, soleRecipient } from "../src/fee-splitter";

const A = "0x4e90a00C8e5960ceCd285cAbb54923245C8e75eF";
const B = "0xad1a02FAe8DA640fdB051473FACb126e1d198908";

describe("fee splitter helpers", () => {
  it("gives a sole recipient the whole recipients' share", () => {
    expect(soleRecipient(A.toLowerCase() as `0x${string}`)).toEqual({ recipients: [A], shares: [FEE_SPLIT_BPS] });
  });

  it("states the recipients' share in whole percent", () => {
    expect(recipientSharePct(2000)).toBe(80);
    expect(recipientSharePct(0)).toBe(100);
    expect(recipientSharePct(3000)).toBe(70);
  });

  it("takes the platform share off a gross amount the way the clone does", () => {
    expect(recipientShareOf(1_000_000n, 2000)).toBe(800_000n);
    expect(recipientShareOf(0n, 2000)).toBe(0n);
    // Rounding favours the recipients: the platform's part is truncated.
    expect(recipientShareOf(7n, 2000)).toBe(6n);
    expect(recipientShareOf(10n ** 18n, 0)).toBe(10n ** 18n);
  });

  it("accepts a stored configuration and checksums its recipients", () => {
    expect(parseFeeSplitConfig({ recipients: [A.toLowerCase(), B], shares: [2000, 8000], platformBps: 2000 })).toEqual({ recipients: [A, B], shares: [2000, 8000], platformBps: 2000 });
  });

  it("rejects configurations it could not reproduce on chain", () => {
    expect(parseFeeSplitConfig(null)).toBeNull();
    expect(parseFeeSplitConfig("0x")).toBeNull();
    expect(parseFeeSplitConfig({ recipients: [], shares: [], platformBps: 2000 })).toBeNull();
    expect(parseFeeSplitConfig({ recipients: [A], shares: [9999], platformBps: 2000 })).toBeNull();
    expect(parseFeeSplitConfig({ recipients: [A, B], shares: [10000], platformBps: 2000 })).toBeNull();
    expect(parseFeeSplitConfig({ recipients: ["not an address"], shares: [10000], platformBps: 2000 })).toBeNull();
    expect(parseFeeSplitConfig({ recipients: [A], shares: [10000], platformBps: 10001 })).toBeNull();
    expect(parseFeeSplitConfig({ recipients: [A], shares: [10000], platformBps: "2000" })).toBeNull();
  });
});
