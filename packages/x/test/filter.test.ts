import { describe, expect, it } from "vitest";
import { filterMention, stripLeadingMentions } from "../src/filter";
import type { XMention } from "../src/types";

const BOT = "1000";
const base: XMention = { id: "1", text: "@o1bot_exchange launch $A \"A\" pair ETH", authorId: "42", authorHandle: "alice", authorName: null, authorImage: null, imageUrl: null, createdAt: null, lang: "en", referenced: [] };

describe("filterMention", () => {
  it("accepts ordinary mentions", () => {
    expect(filterMention(base, BOT)).toEqual({ ok: true });
  });
  it("drops the bot's own posts, retweets and quotes of the bot", () => {
    expect(filterMention({ ...base, authorId: BOT }, BOT)).toMatchObject({ ok: false, reason: "self" });
    expect(filterMention({ ...base, referenced: [{ type: "retweeted", id: "9", authorId: "7" }] }, BOT)).toMatchObject({ ok: false, reason: "retweet" });
    expect(filterMention({ ...base, referenced: [{ type: "quoted", id: "9", authorId: BOT }] }, BOT)).toMatchObject({ ok: false, reason: "quote_of_bot" });
    expect(filterMention({ ...base, referenced: [{ type: "quoted", id: "9", authorId: "7" }] }, BOT)).toEqual({ ok: true });
    expect(filterMention({ ...base, referenced: [{ type: "replied_to", id: "9", authorId: BOT }] }, BOT)).toEqual({ ok: true });
  });
});

describe("stripLeadingMentions", () => {
  it("removes the reply-chain mentions X prepends", () => {
    expect(stripLeadingMentions("@o1bot_exchange @alice launch $A \"A\" pair ETH")).toBe('launch $A "A" pair ETH');
    expect(stripLeadingMentions("hey @o1bot_exchange launch")).toBe("hey @o1bot_exchange launch");
  });
});
