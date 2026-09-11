import { describe, expect, it } from "vitest";
import { ASK_TOKEN_QUESTION, normalizeParseOutput } from "../src/normalize";
import type { ParseOutput } from "../src/schema";

const base: ParseOutput = {
  kind: "ask",
  language: "en",
  topic: "stats",
  ticker: null,
  name: null,
  pair: null,
  chain: null,
  devbuy_native: null,
  fees_to_handle: null,
  description: null,
  website: null,
  telegram: null,
  x_handle: null,
  trade_side: null,
  trade_amount: null,
  trade_slippage_pct: null,
  missing: [],
  question: null,
  reply: null,
  reason: "test",
};
const norm = (over: Partial<ParseOutput>) => normalizeParseOutput({ ...base, ...over }, { hasImage: false });

describe("normalizeParseOutput for questions", () => {
  it("passes the topic and the chain scope through", () => {
    expect(norm({ topic: "stats", chain: "base" })).toMatchObject({ kind: "ask", topic: "stats", chain: "base", ticker: null, tokenAddress: null });
    expect(norm({ topic: "top" })).toMatchObject({ kind: "ask", topic: "top", chain: null });
  });

  it("scopes only to chains the bot runs on", () => {
    expect(norm({ topic: "stats", chain: "arbitrum" })).toMatchObject({ kind: "ask", chain: null });
    expect(norm({ topic: "wallet", chain: "other" })).toMatchObject({ kind: "ask", chain: null });
  });

  it("keeps the ticker only for token questions", () => {
    expect(norm({ topic: "token", ticker: "$cat" })).toMatchObject({ kind: "ask", topic: "token", ticker: "CAT", tokenAddress: null });
    expect(norm({ topic: "wallet", ticker: "CAT" })).toMatchObject({ kind: "ask", topic: "wallet", ticker: null, tokenAddress: null });
  });

  it("takes an address instead of a ticker for a token question", () => {
    const addr = "0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01";
    expect(norm({ topic: "token", ticker: addr })).toMatchObject({ kind: "ask", topic: "token", ticker: null, tokenAddress: addr });
  });

  it("asks which token when a token question names none or names it badly", () => {
    expect(norm({ topic: "token", ticker: null })).toEqual({ kind: "clarify", question: ASK_TOKEN_QUESTION, missing: ["trade_token"], language: "en", reason: "test" });
    expect(norm({ topic: "token", ticker: "not a ticker!" })).toMatchObject({ kind: "clarify", missing: ["trade_token"] });
    expect(norm({ topic: "token", ticker: null, question: "Which token exactly?" })).toMatchObject({ kind: "clarify", question: "Which token exactly?" });
  });

  it("treats ask without a topic as help when the model wrote a reply, else ignores it", () => {
    expect(norm({ topic: "none", reply: "Ask me about a token or your wallet." })).toEqual({ kind: "help", reply: "Ask me about a token or your wallet.", language: "en", reason: "test" });
    expect(norm({ topic: "none" })).toMatchObject({ kind: "ignore" });
  });

  it("ignores a topic on every other kind", () => {
    expect(norm({ kind: "help", topic: "stats", reply: "hello" })).toMatchObject({ kind: "help", reply: "hello" });
    expect(norm({ kind: "ignore", topic: "wallet" })).toMatchObject({ kind: "ignore" });
  });
});
