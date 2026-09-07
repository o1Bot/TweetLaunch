import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { RESERVED_HANDLES } from "@o1bot/shared";
import { checkDevBuy, checkFeesToHandle, checkRate, startOfUtcDay } from "../src/validator";

const T0 = new Date("2026-09-07T10:00:00Z");

describe("checkRate", () => {
  const base = { now: T0, cooldownSeconds: 600, maxPerDay: 5 };

  it("allows a first launch", () => {
    expect(checkRate({ ...base, lastLaunchAt: null, launchesToday: 0 })).toEqual({ ok: true });
  });

  it("enforces the cooldown with the remaining seconds", () => {
    const r = checkRate({ ...base, lastLaunchAt: new Date(T0.getTime() - 200_000), launchesToday: 1 });
    expect(r).toEqual({ ok: false, reason: "cooldown", retryAfterSeconds: 400 });
  });

  it("allows a launch once the cooldown passed", () => {
    expect(checkRate({ ...base, lastLaunchAt: new Date(T0.getTime() - 600_000), launchesToday: 1 })).toEqual({ ok: true });
  });

  it("enforces the daily cap until the next UTC day", () => {
    const r = checkRate({ ...base, lastLaunchAt: new Date(T0.getTime() - 3_600_000), launchesToday: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("daily_cap");
      expect(r.retryAfterSeconds).toBe(14 * 3600);
    }
  });
});

describe("startOfUtcDay", () => {
  it("truncates to midnight UTC", () => {
    expect(startOfUtcDay(T0).toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("checkDevBuy", () => {
  const max = parseEther("1");
  it("treats null as no dev buy", () => expect(checkDevBuy(null, max)).toEqual({ ok: true, wei: null }));
  it("parses a decimal ETH string exactly", () => expect(checkDevBuy("0.05", max)).toEqual({ ok: true, wei: 50_000_000_000_000_000n }));
  it("rejects zero and garbage", () => {
    expect(checkDevBuy("0", max)).toEqual({ ok: false, reason: "invalid" });
    expect(checkDevBuy("lots", max)).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects amounts above the cap", () => expect(checkDevBuy("1.0001", max)).toEqual({ ok: false, reason: "too_large" }));
  it("accepts exactly the cap", () => expect(checkDevBuy("1", max)).toEqual({ ok: true, wei: max }));
});

describe("checkFeesToHandle", () => {
  it("passes through a normal handle", () => expect(checkFeesToHandle("@Bob_Builds", RESERVED_HANDLES, "alice")).toEqual({ ok: true, handle: "bob_builds" }));
  it("treats the author's own handle as no redirect", () => expect(checkFeesToHandle("@ALICE", RESERVED_HANDLES, "alice")).toEqual({ ok: true, handle: null }));
  it("rejects bot and o1 accounts", () => {
    expect(checkFeesToHandle("o1bot_exchange", RESERVED_HANDLES, "alice")).toEqual({ ok: false, reason: "reserved" });
    expect(checkFeesToHandle("@O1LaunchPad", RESERVED_HANDLES, "alice")).toEqual({ ok: false, reason: "reserved" });
  });
  it("rejects malformed handles", () => expect(checkFeesToHandle("this-is-not-a-handle", RESERVED_HANDLES, "alice")).toEqual({ ok: false, reason: "invalid" }));
});
