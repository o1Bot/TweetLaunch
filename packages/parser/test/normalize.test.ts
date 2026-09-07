import { describe, expect, it } from "vitest";
import { normalizeParseOutput } from "../src/normalize";
import type { ParseOutput } from "../src/schema";

const base: ParseOutput = {
  kind: "launch",
  language: "en",
  ticker: "RUGRAT",
  name: "Rugrat",
  pair: "ETH",
  chain: "robinhood",
  devbuy_native: null,
  fees_to_handle: null,
  missing: [],
  question: null,
  reply: null,
  reason: "complete command",
};

describe("normalizeParseOutput", () => {
  it("passes a complete launch through", () => {
    const r = normalizeParseOutput(base, { hasImage: true });
    expect(r).toMatchObject({ kind: "launch", ticker: "RUGRAT", name: "Rugrat", pair: "ETH", chain: "robinhood", imageFromTweet: true, devBuyNative: null, feesToHandle: null });
  });

  it("cleans ticker, name, pair, amount and handle", () => {
    const r = normalizeParseOutput(
      { ...base, ticker: "$rugrat", name: "“Rugrat”", pair: "$usdg", devbuy_native: "0,05 ETH", fees_to_handle: "@Alice_Web3" },
      { hasImage: false },
    );
    expect(r).toMatchObject({ kind: "launch", ticker: "RUGRAT", name: "Rugrat", pair: "USDG", devBuyNative: "0.05", feesToHandle: "alice_web3" });
  });

  it("downgrades a launch with a bad ticker, missing name or missing pair to clarify", () => {
    expect(normalizeParseOutput({ ...base, ticker: "ABCDEFGHIJKL" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["ticker"] });
    expect(normalizeParseOutput({ ...base, ticker: "RUG-RAT" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["ticker"] });
    expect(normalizeParseOutput({ ...base, name: null }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["name"] });
    expect(normalizeParseOutput({ ...base, name: "x".repeat(51) }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["name"] });
    expect(normalizeParseOutput({ ...base, pair: null }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["pair"] });
  });

  it("rejects non-ETH or zero dev-buy amounts and malformed handles", () => {
    expect(normalizeParseOutput({ ...base, devbuy_native: "$50" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["devbuy_amount"] });
    expect(normalizeParseOutput({ ...base, devbuy_native: "0" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["devbuy_amount"] });
    expect(normalizeParseOutput({ ...base, devbuy_native: "1e-3" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["devbuy_amount"] });
    expect(normalizeParseOutput({ ...base, fees_to_handle: "not a handle" }, { hasImage: false })).toMatchObject({ kind: "clarify", missing: ["fees_to_handle"] });
  });

  it("keeps the model's question when present and builds one otherwise", () => {
    const withQ = normalizeParseOutput({ ...base, kind: "clarify", pair: null, missing: ["pair"], question: "Pair apa?" }, { hasImage: false });
    expect(withQ).toMatchObject({ kind: "clarify", question: "Pair apa?" });
    const noQ = normalizeParseOutput({ ...base, pair: null }, { hasImage: false });
    expect(noQ.kind === "clarify" && noQ.question.length > 10).toBe(true);
  });

  it("flags other chains and accepts an unstated chain", () => {
    expect(normalizeParseOutput({ ...base, chain: "base" }, { hasImage: false })).toMatchObject({ kind: "unsupported_chain", chain: "base" });
    expect(normalizeParseOutput({ ...base, chain: null }, { hasImage: false })).toMatchObject({ kind: "launch", chain: null });
  });

  it("maps help and ignore, dropping empty help replies", () => {
    expect(normalizeParseOutput({ ...base, kind: "help", reply: "Post: launch $T \"Name\" pair ETH on robinhood" }, { hasImage: false })).toMatchObject({ kind: "help" });
    expect(normalizeParseOutput({ ...base, kind: "help", reply: "   " }, { hasImage: false })).toMatchObject({ kind: "ignore" });
    expect(normalizeParseOutput({ ...base, kind: "ignore" }, { hasImage: false })).toMatchObject({ kind: "ignore" });
  });
});
