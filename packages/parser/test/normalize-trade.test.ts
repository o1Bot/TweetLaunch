import { describe, expect, it } from "vitest";
import { cleanSellPortion, cleanSlippage, cleanTradeAmount, normalizeParseOutput } from "../src/normalize";
import type { ParseOutput } from "../src/schema";

const base: ParseOutput = {
  kind: "trade",
  language: "en",
  topic: "none",
  site_slug: "",
  ticker: "cat",
  name: null,
  pair: null,
  chain: null,
  devbuy_native: null,
  fees_to_handle: null,
  description: null,
  website: null,
  telegram: null,
  x_handle: null,
  trade_side: "buy",
  trade_amount: "0.05",
  trade_slippage_pct: null,
  missing: [],
  question: null,
  reply: null,
  reason: "complete buy",
};

describe("normalizeParseOutput for trades", () => {
  it("passes a buy through with the ticker uppercased and the amount verbatim", () => {
    expect(normalizeParseOutput(base, { hasImage: false })).toMatchObject({ kind: "trade", side: "buy", ticker: "CAT", tokenAddress: null, amount: "0.05", amountSymbol: null, sellPortion: null, slippageBps: null });
  });

  it("keeps the asset of a buy amount and normalises its spelling", () => {
    expect(normalizeParseOutput({ ...base, trade_amount: "5 NVDA" }, { hasImage: false })).toMatchObject({ kind: "trade", amount: "5", amountSymbol: "NVDA" });
    expect(normalizeParseOutput({ ...base, trade_amount: "0.05 eth" }, { hasImage: false })).toMatchObject({ kind: "trade", amount: "0.05", amountSymbol: "ETH" });
    expect(cleanTradeAmount("20 $USDG")).toEqual({ ok: true, value: "20", symbol: "USDG" });
    expect(cleanTradeAmount(".5")).toEqual({ ok: true, value: "0.5", symbol: null });
    expect(cleanTradeAmount("$20")).toEqual({ ok: false });
    expect(cleanTradeAmount("10%")).toEqual({ ok: false });
    expect(cleanTradeAmount("0")).toEqual({ ok: false });
  });

  it("keeps an address as given and drops the ticker", () => {
    const r = normalizeParseOutput({ ...base, ticker: "0xF7d77243Fbd0413a6528edc275b09D31c25CB201" }, { hasImage: false });
    expect(r).toMatchObject({ kind: "trade", ticker: null, tokenAddress: "0xF7d77243Fbd0413a6528edc275b09D31c25CB201" });
  });

  it("normalises sell portions and bounds slippage", () => {
    const r = normalizeParseOutput({ ...base, trade_side: "sell", trade_amount: "half", trade_slippage_pct: "25" }, { hasImage: false });
    expect(r).toMatchObject({ kind: "trade", side: "sell", amount: null, sellPortion: { kind: "percent", value: 50 }, slippageBps: 1000 });
    expect(cleanSellPortion("all")).toEqual({ ok: true, value: { kind: "all" } });
    expect(cleanSellPortion("100%")).toEqual({ ok: true, value: { kind: "all" } });
    expect(cleanSellPortion("25 %")).toEqual({ ok: true, value: { kind: "percent", value: 25 } });
    expect(cleanSellPortion("quarter")).toEqual({ ok: true, value: { kind: "percent", value: 25 } });
    expect(cleanSellPortion("0")).toEqual({ ok: false });
    expect(cleanSellPortion("150")).toEqual({ ok: false });
    expect(cleanSellPortion("0.1 eth")).toEqual({ ok: false });
    expect(cleanSlippage("5")).toBe(500);
    expect(cleanSlippage("0.01")).toBe(10);
    expect(cleanSlippage("abc")).toBeNull();
  });

  it("turns a buy without an ETH amount into a clarify about the amount", () => {
    const r = normalizeParseOutput({ ...base, trade_amount: null }, { hasImage: false });
    expect(r).toMatchObject({ kind: "clarify", missing: ["trade_amount"] });
    expect(r.kind === "clarify" && r.question.length > 0).toBe(true);
  });

  it("turns a sell stated in tokens or ETH into a clarify, and a missing token into a clarify", () => {
    expect(normalizeParseOutput({ ...base, trade_side: "sell", trade_amount: "1000 tokens" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["trade_amount"] });
    expect(normalizeParseOutput({ ...base, ticker: null }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["trade_token"] });
    expect(normalizeParseOutput({ ...base, ticker: "this is not a ticker" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["trade_token"] });
  });

  it("treats a model clarify carrying trade fields as a trade clarify, never as a launch", () => {
    const r = normalizeParseOutput({ ...base, kind: "clarify", trade_amount: null, missing: ["trade_amount"], question: "How much ETH?" }, { hasImage: false });
    expect(r).toMatchObject({ kind: "clarify", missing: ["trade_amount"], question: "How much ETH?" });
  });

  it("carries an origin chain for a buy that bridges first, and refuses one it cannot bridge from", () => {
    expect(normalizeParseOutput({ ...base, chain: "base" }, { hasImage: false })).toMatchObject({ kind: "trade", fromChain: "base" });
    expect(normalizeParseOutput({ ...base, chain: "robinhood" }, { hasImage: false })).toMatchObject({ kind: "trade", fromChain: null });
    expect(normalizeParseOutput({ ...base, chain: "other" }, { hasImage: false })).toMatchObject({ kind: "unsupported_chain" });
  });

  it("normalises a bridge and asks for what is missing", () => {
    const bridge: ParseOutput = { ...base, kind: "bridge", trade_side: null, ticker: null, chain: "arbitrum", trade_amount: "0.1 ETH" };
    expect(normalizeParseOutput(bridge, { hasImage: false })).toEqual({ kind: "bridge", fromChain: "arbitrum", amount: "0.1", language: "en", reason: "complete buy" });
    expect(normalizeParseOutput({ ...bridge, chain: null }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["bridge_chain"] });
    expect(normalizeParseOutput({ ...bridge, trade_amount: "5 NVDA" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["trade_amount"] });
    expect(normalizeParseOutput({ ...bridge, chain: "other" }, { hasImage: false })).toMatchObject({ kind: "unsupported_chain" });
    expect(normalizeParseOutput({ ...bridge, kind: "clarify", trade_amount: null, missing: ["trade_amount", "bridge_chain"], chain: null, question: "How much, from where?" }, { hasImage: false })).toMatchObject({ kind: "clarify", question: "How much, from where?" });
  });

  it("never produces a recipient or touches launch fields", () => {
    const r = normalizeParseOutput({ ...base, name: "x", pair: "ETH", devbuy_native: "1" }, { hasImage: false });
    expect(r.kind).toBe("trade");
    expect(Object.keys(r)).not.toContain("recipient");
    expect(Object.keys(r)).not.toContain("to");
  });
});
