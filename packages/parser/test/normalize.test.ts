import { describe, expect, it } from "vitest";
import { normalizeParseOutput, cleanDescription, cleanWebsite, cleanTelegram, cleanXHandle, oneLinkOnly } from "../src/normalize";
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

describe("metadata extras", () => {
  it("keeps a description verbatim, unquoted and capped at o1's byte limit", () => {
    expect(cleanDescription(' "Cats, but on chain." ')).toBe("Cats, but on chain.");
    expect(cleanDescription(null)).toBeNull();
    expect(Buffer.byteLength(cleanDescription("é".repeat(1500))!, "utf8")).toBeLessThanOrEqual(2000);
  });

  it("accepts http(s) websites only and adds the scheme when missing", () => {
    expect(cleanWebsite("cashcat.xyz")).toBe("https://cashcat.xyz");
    expect(cleanWebsite("https://cashcat.xyz/")).toBe("https://cashcat.xyz");
    expect(cleanWebsite("ftp://cashcat.xyz")).toBeNull();
    expect(cleanWebsite("not a url")).toBeNull();
  });

  it("turns telegram handles and links into t.me URLs", () => {
    expect(cleanTelegram("@cashcat_chat")).toBe("https://t.me/cashcat_chat");
    expect(cleanTelegram("t.me/cashcat_chat")).toBe("https://t.me/cashcat_chat");
    expect(cleanTelegram("https://t.me/+AbCdEf123")).toBe("https://t.me/+AbCdEf123");
    expect(cleanTelegram("nope!")).toBeNull();
  });

  it("extracts an X handle from a handle or a profile link", () => {
    expect(cleanXHandle("@CashCatToken")).toBe("cashcattoken");
    expect(cleanXHandle("https://x.com/CashCatToken")).toBe("cashcattoken");
    expect(cleanXHandle("https://twitter.com/CashCatToken/")).toBe("cashcattoken");
    expect(cleanXHandle("this is not a handle")).toBeNull();
  });
});

describe("oneLinkOnly", () => {
  it("keeps the first link and drops the rest", () => {
    expect(oneLinkOnly("Sign in at https://o1bot.exchange then post. See https://o1bot.exchange/how-it-works")).toBe("Sign in at https://o1bot.exchange then post.");
    expect(oneLinkOnly("Docs: https://docs.o1bot.exchange")).toBe("Docs: https://docs.o1bot.exchange");
    expect(oneLinkOnly("no links here")).toBe("no links here");
    const r = normalizeParseOutput({ ...base, kind: "help", reply: "One https://a.example/x and two https://b.example/y." }, { hasImage: false });
    expect(r.kind === "help" && (r.reply.match(/https?:\/\//g) ?? []).length).toBe(1);
  });
});
