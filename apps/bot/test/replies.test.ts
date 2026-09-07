import { describe, expect, it } from "vitest";
import { fitsX, xWeightedLength } from "@o1bot/shared";
import { clampReply, formatEthCeil, replies, successReply } from "../src/replies";

const TOKEN = "0x0ab6bF0ffA6D5C5aAa8fC94a8fB2f4Ea2F4F5C01";
const SITE = "https://o1bot.exchange";

describe("xWeightedLength", () => {
  it("counts every URL as 23 characters", () => {
    expect(xWeightedLength(`see https://launch.o1.exchange/token/${TOKEN}?chain=4663 now`)).toBe(4 + 23 + 4);
  });
  it("counts CJK and emoji as two", () => {
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("a🚀")).toBe(3);
  });
});

describe("successReply", () => {
  const base = { ticker: "CASHCAT", name: "Cash Cat", pair: "ETH", token: TOKEN, siteUrl: SITE, devBuyEth: "0.05", feesTo: "bob" };

  it("carries the ticker, one link to the token page, the dev buy and the fee note, and never the address", () => {
    const text = successReply(base);
    expect(fitsX(text)).toBe(true);
    expect(text).toContain("$CASHCAT");
    expect(text).toContain(`${SITE}/token/${TOKEN}`);
    expect(text).not.toContain("launch.o1.exchange");
    expect(text.split("https://").length - 1).toBe(1);
    expect(text).not.toMatch(/Token 0x/);
    expect(text).toContain("0.05 ETH");
    expect(text).toContain("@bob");
  });

  it("rotates the phrasing by token but stays stable for the same token", () => {
    const a = successReply(base);
    const b = successReply({ ...base, token: "0x0ab6bF0ffA6D5C5aAa8fC94a8fB2f4Ea2F4F5C02" });
    const c = successReply({ ...base, token: "0x0ab6bF0ffA6D5C5aAa8fC94a8fB2f4Ea2F4F5C03" });
    expect(successReply(base)).toBe(a);
    const opener = (t: string) => t.split("\n")[0];
    expect(new Set([opener(a), opener(b), opener(c)]).size).toBeGreaterThan(1);
  });

  it("drops optional sentences before ever truncating", () => {
    const text = successReply({ ...base, name: "A very long token name that pushes the reply well past the limit on X", pair: "AAPL" });
    expect(fitsX(text)).toBe(true);
    expect(text).not.toContain("…");
    expect(text).toContain(`${SITE}/token/`);
  });

  it("explains a failed fee redirect", () => {
    const text = successReply({ ...base, feesTo: null, feesToFailed: "bob" });
    expect(text).toContain("redirect to @bob failed");
  });
});

describe("clampReply", () => {
  it("leaves short text alone", () => expect(clampReply("hello")).toBe("hello"));
  it("truncates on the weighted length", () => {
    const long = "x".repeat(300);
    const out = clampReply(long);
    expect(fitsX(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatEthCeil", () => {
  it("rounds up so the user never sends too little", () => {
    expect(formatEthCeil(1_234_567_890_123_456n)).toBe("0.0013");
    expect(formatEthCeil(1_000_000_000_000_000n)).toBe("0.001");
    expect(formatEthCeil(0n)).toBe("0");
  });
});

describe("templates", () => {
  it("all fit X with realistic values", () => {
    const samples = [
      replies.notRegistered(SITE),
      replies.unsupportedChain(),
      replies.pairUnavailable("DOGE", SITE),
      replies.tickerCollides("NVDA"),
      replies.devBuyInvalid(),
      replies.devBuyTooLarge("1"),
      replies.feesToRejected("someone", "suspended"),
      replies.slowDown("cooldown", 300, 600),
      replies.slowDown("daily_cap", 3600, 600),
      replies.insufficient("0.0123", TOKEN),
      replies.insufficientUnknown(TOKEN),
      replies.insufficientSafe("0.0123", SITE),
      replies.devBuyNoRoute("AAPL"),
      replies.launchFailed("the chain RPC did not respond"),
    ];
    for (const s of samples) expect(fitsX(s), s).toBe(true);
  });
});
