import { describe, expect, it } from "vitest";
import type { LighterClient } from "@o1bot/lighter";
import { lookupAccount, pickTradingAccount } from "../lib/account";

/** The two accounts the venue actually returned for 0xbbC93d22…4155. */
const REAL_PAIR = [
  {
    account_index: 50,
    account_type: 0,
    collateral: "33.418105",
    available_balance: "33.418105",
    total_asset_value: "33.418105",
  },
  {
    account_index: 281474976710398,
    account_type: 1,
    collateral: "0.000000",
    available_balance: "0.000000",
    total_asset_value: "0",
  },
];

function clientReturning(value: unknown): LighterClient {
  return { accountByL1Address: async () => value } as unknown as LighterClient;
}

describe("pickTradingAccount", () => {
  it("selects the standard account out of a real multi-account address", () => {
    expect(pickTradingAccount(REAL_PAIR)?.index).toBe(50);
  });

  it("does not depend on the venue's ordering", () => {
    // The API promises no order; reversing it must not change the answer.
    expect(pickTradingAccount([...REAL_PAIR].reverse())?.index).toBe(50);
  });

  it("parses the numeric strings the venue sends", () => {
    const a = pickTradingAccount(REAL_PAIR);
    expect(a?.collateral).toBeCloseTo(33.418105);
    expect(a?.availableBalance).toBeCloseTo(33.418105);
  });

  it("returns null when no standard account is present", () => {
    expect(pickTradingAccount([REAL_PAIR[1]!])).toBeNull();
    expect(pickTradingAccount([])).toBeNull();
  });

  it("ignores an entry with no index", () => {
    expect(pickTradingAccount([{ account_type: 0 }])).toBeNull();
  });
});

describe("lookupAccount", () => {
  it("treats a missing account as 'none', the normal first-time case", async () => {
    // The client turns the venue's 21100 into null.
    expect(await lookupAccount(clientReturning(null), "0xdead")).toEqual({ state: "none" });
  });

  it("reports the standard account when one exists", async () => {
    const r = await lookupAccount(clientReturning({ accounts: REAL_PAIR }), "0xbbC9");
    expect(r).toMatchObject({ state: "linked", account: { index: 50 } });
  });

  it("flags an address that has accounts but none usable, rather than claiming none", async () => {
    const r = await lookupAccount(clientReturning({ accounts: [REAL_PAIR[1]] }), "0x1");
    expect(r).toEqual({ state: "unusable", types: [1] });
  });

  it("reports an empty list as none", async () => {
    expect(await lookupAccount(clientReturning({ accounts: [] }), "0x1")).toEqual({ state: "none" });
  });

  it("surfaces a venue failure instead of looking like a fresh address", async () => {
    const client = {
      accountByL1Address: async () => {
        throw new Error("lighter api 503");
      },
    } as unknown as LighterClient;
    const r = await lookupAccount(client, "0x1");
    expect(r).toEqual({ state: "error", message: "lighter api 503" });
  });
});
