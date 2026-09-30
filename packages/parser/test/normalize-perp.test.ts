import { describe, expect, it } from "vitest";
import { normalizeParseOutput } from "../src/normalize";
import { cleanPerpLeverage, cleanPerpMargin } from "../src/perp";
import type { ParseOutput } from "../src/schema";

const base: ParseOutput = {
  kind: "perp",
  language: "en",
  topic: "none",
  site_slug: "",
  perp_leverage: "10",
  ticker: "btc",
  name: null,
  pair: null,
  chain: null,
  devbuy_native: null,
  fees_to_handle: null,
  description: null,
  website: null,
  telegram: null,
  x_handle: null,
  trade_side: "long",
  trade_amount: "500 usdc",
  trade_slippage_pct: null,
  missing: [],
  question: null,
  reply: null,
  reason: "complete long",
};

const norm = (over: Partial<ParseOutput> = {}) => normalizeParseOutput({ ...base, ...over }, { hasImage: false });

describe("normalizeParseOutput for perps", () => {
  it("reads a long: market uppercased, leverage as a number, collateral verbatim", () => {
    expect(norm()).toEqual({ kind: "perp", action: "open", side: "long", market: "BTC", leverage: 10, marginUsdc: "500", closePortion: null, language: "en", reason: "complete long" });
  });

  it("reads a short, a $ on the market, and the ways people write a dollar amount", () => {
    expect(norm({ trade_side: "short", ticker: "$eth", perp_leverage: "5x", trade_amount: "200" })).toMatchObject({ action: "open", side: "short", market: "ETH", leverage: 5, marginUsdc: "200" });
    expect(norm({ trade_amount: "$100" })).toMatchObject({ marginUsdc: "100" });
    expect(norm({ trade_amount: "100 usd" })).toMatchObject({ marginUsdc: "100" });
    expect(norm({ trade_amount: "12,5 USDC" })).toMatchObject({ marginUsdc: "12.5" });
  });

  it("closes the whole position when no portion is named, and a part when one is", () => {
    expect(norm({ trade_side: "close", perp_leverage: "", trade_amount: null })).toEqual({ kind: "perp", action: "close", side: null, market: "BTC", leverage: null, marginUsdc: null, closePortion: { kind: "all" }, language: "en", reason: "complete long" });
    expect(norm({ trade_side: "close", perp_leverage: "", trade_amount: "half" })).toMatchObject({ action: "close", closePortion: { kind: "percent", value: 50 } });
    expect(norm({ trade_side: "close", perp_leverage: "", trade_amount: "25%" })).toMatchObject({ closePortion: { kind: "percent", value: 25 } });
  });

  it("never assumes a leverage or an amount: a long without one is a question", () => {
    expect(norm({ perp_leverage: "" })).toMatchObject({ kind: "clarify", missing: ["perp_leverage"] });
    expect(norm({ trade_amount: null })).toMatchObject({ kind: "clarify", missing: ["perp_amount"] });
    const both = norm({ perp_leverage: "", trade_amount: null });
    expect(both).toMatchObject({ kind: "clarify" });
    expect((both as { missing: string[] }).missing.sort()).toEqual(["perp_amount", "perp_leverage"]);
    expect((both as { question: string }).question).toContain("long $BTC 10x with 50 usdc");
  });

  it("refuses collateral in anything but dollars", () => {
    for (const bad of ["0.01 BTC", "0.5 ETH", "10%", "100 contracts", "half"]) {
      expect(norm({ trade_amount: bad }), bad).toMatchObject({ kind: "clarify", missing: ["perp_amount"] });
    }
  });

  it("asks for the market when there is none or it cannot be a symbol", () => {
    expect(norm({ ticker: null })).toMatchObject({ kind: "clarify", missing: ["perp_market"] });
    expect(norm({ ticker: "0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01" })).toMatchObject({ kind: "clarify", missing: ["perp_market"] });
  });

  it("keeps the model's own question when it clarified, and treats a perp side on a clarify as perp intent", () => {
    const r = norm({ kind: "clarify", missing: ["perp_leverage"], perp_leverage: "", question: "What leverage?" });
    expect(r).toMatchObject({ kind: "clarify", question: "What leverage?", missing: ["perp_leverage"] });
    // No perp field in `missing`, but the side says perp: it must not fall through to the launch branch.
    expect(norm({ kind: "clarify", missing: [], trade_side: "short", perp_leverage: "", question: null })).toMatchObject({ kind: "clarify", missing: ["perp_leverage"] });
  });

  it("does not let a perp side leak into a launchpad trade", () => {
    // A model that says trade but gives a perp side has not named a trade side at all.
    expect(norm({ kind: "trade", trade_side: "long", ticker: "CAT", trade_amount: "0.05" })).toMatchObject({ kind: "clarify", missing: ["trade_side"] });
  });
});

describe("cleanPerpLeverage", () => {
  it("accepts a whole number with or without the x", () => {
    expect(cleanPerpLeverage("10")).toBe(10);
    expect(cleanPerpLeverage("10x")).toBe(10);
    expect(cleanPerpLeverage("X20")).toBe(20);
    expect(cleanPerpLeverage(" 3 x ")).toBe(3);
  });

  it("rejects what is not a usable leverage", () => {
    for (const bad of ["", "0", "2.5", "5-10", "max", "1000", null, undefined]) expect(cleanPerpLeverage(bad), String(bad)).toBeNull();
  });
});

describe("cleanPerpMargin", () => {
  it("reads dollars however they are written", () => {
    expect(cleanPerpMargin("500")).toEqual({ ok: true, value: "500" });
    expect(cleanPerpMargin("$500")).toEqual({ ok: true, value: "500" });
    expect(cleanPerpMargin("500usdc")).toEqual({ ok: true, value: "500" });
    expect(cleanPerpMargin(".5 usdc")).toEqual({ ok: true, value: "0.5" });
    expect(cleanPerpMargin(null)).toEqual({ ok: true, value: null });
  });

  it("rejects other assets, zero and percentages", () => {
    for (const bad of ["1 ETH", "0", "0 usdc", "50%", "ten"]) expect(cleanPerpMargin(bad), bad).toEqual({ ok: false });
  });
});
