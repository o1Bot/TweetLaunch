import { describe, expect, it } from "vitest";
import { ANSWER_MAX_CHARS, answerIsGrounded, answerSystemPrompt } from "../src/answer";

const facts = [
  "Tokens launched through o1bot: 85 in total (85 on Robinhood Chain, 0 on Base).",
  "Trading volume, last 24 hours: $12.3K. Trading volume, all time: $1.23M.",
  "Newest launch: $CAT on Robinhood Chain, 3 hours ago, by @alice.",
  "Contract address: 0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01",
  "Board with every token: https://o1bot.exchange",
].join("\n");

describe("answerIsGrounded", () => {
  it("accepts a reply that only repeats figures from the facts", () => {
    expect(answerIsGrounded("85 tokens so far, $12.3K traded in the last 24h and $1.23M all time. Board: https://o1bot.exchange", facts)).toBe(true);
  });

  it("matches figures inside longer tokens and ignores trailing punctuation", () => {
    expect(answerIsGrounded("The newest one, $CAT, went live 3 hours ago by @alice.", facts)).toBe(true);
    expect(answerIsGrounded("Total: 85.", facts)).toBe(true);
    expect(answerIsGrounded("Semua 85 token, volume $12.3K, 24 jam terakhir.", facts)).toBe(true);
  });

  it("rejects an invented or reformatted number", () => {
    expect(answerIsGrounded("86 tokens so far.", facts)).toBe(false);
    expect(answerIsGrounded("$12.4K traded today.", facts)).toBe(false);
    expect(answerIsGrounded("About 1,230,000 dollars all time.", facts)).toBe(false);
  });

  it("rejects links, addresses, handles and tickers that are not in the facts", () => {
    expect(answerIsGrounded("See https://example.com", facts)).toBe(false);
    expect(answerIsGrounded("Address 0x1234567890abcdef", facts)).toBe(false);
    expect(answerIsGrounded("Ask @bob", facts)).toBe(false);
    expect(answerIsGrounded("$DOG is up", facts)).toBe(false);
  });

  it("allows handles, tickers and numbers the post itself contains", () => {
    expect(answerIsGrounded("No $DOG came through here, 85 did though.", facts, "how is $DOG doing?")).toBe(true);
    expect(answerIsGrounded("0.05 ETH is what you asked about; nothing on file.", facts, "did my 0.05 eth buy go through")).toBe(true);
  });

  it("compares handles and tickers case-insensitively but keeps addresses exact", () => {
    expect(answerIsGrounded("@Alice launched $cat.", facts)).toBe(true);
    expect(answerIsGrounded("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01 is the address.", facts)).toBe(true);
  });
});

describe("answerSystemPrompt", () => {
  it("names the bot, the site and the length cap", () => {
    const p = answerSystemPrompt("o1bot_exchange", "https://o1bot.exchange");
    expect(p).toContain("@o1bot_exchange");
    expect(p).toContain("https://o1bot.exchange");
    expect(p).toContain(String(ANSWER_MAX_CHARS));
    expect(p).not.toMatch(/—/);
  });
});
