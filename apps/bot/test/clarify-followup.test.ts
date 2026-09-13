import type { XMention } from "@o1bot/x";
import { describe, expect, it } from "vitest";
import { earlierAttemptFromParse, findEarlierAttempt } from "../src/clarify-followup";
import { MemoryBotStore } from "../src/store";

const clarifyParse = { kind: "clarify", ticker: "VLY", name: null, pair: "ETH", chain: "base", devbuy_native: null, fees_to_handle: null, missing: ["name"], question: "Which name?", reason: "no name", language: "en" };

const mention = (over: Partial<XMention>): XMention => ({
  id: "2001",
  text: "Vly AI",
  authorId: "777",
  authorHandle: "sapri",
  authorName: null,
  authorImage: null,
  imageUrl: null,
  createdAt: null,
  lang: "en",
  referenced: [{ type: "replied_to", id: "reply-1", authorId: "bot" }],
  ...over,
});

describe("the earlier attempt behind a clarify follow-up", () => {
  it("keeps the command fields and what was asked for", () => {
    expect(earlierAttemptFromParse(clarifyParse)).toEqual({
      fields: { ticker: "VLY", name: null, pair: "ETH", chain: "base", devbuy_native: null, fees_to_handle: null },
      missing: ["name"],
    });
  });

  it("is nothing for outputs that were not a clarify or hold no command", () => {
    expect(earlierAttemptFromParse({ kind: "help", reply: "hi" })).toBeNull();
    expect(earlierAttemptFromParse({ kind: "clarify", missing: ["pair"] })).toBeNull();
    expect(earlierAttemptFromParse(null)).toBeNull();
  });

  it("is found through the bot's reply id, for the same poster only, and only while the attempt is a clarify", async () => {
    const store = new MemoryBotStore();
    const { id } = await store.insertMention({ tweetId: "2000", authorXUserId: "777", authorHandle: "sapri", text: "launch a token vlyai on base ticker $Vly pairing ETH", mediaUrl: null, language: "en", postedAt: null });
    await store.updateMention(id, { status: "CLARIFY", parse: clarifyParse, replyTweetId: "reply-1" });
    expect(await findEarlierAttempt(store, mention({}))).toEqual({ fields: { ticker: "VLY", name: null, pair: "ETH", chain: "base", devbuy_native: null, fees_to_handle: null }, missing: ["name"] });
    expect(await findEarlierAttempt(store, mention({ authorId: "999" }))).toBeUndefined();
    expect(await findEarlierAttempt(store, mention({ referenced: [] }))).toBeUndefined();
    expect(await findEarlierAttempt(store, mention({ referenced: [{ type: "replied_to", id: "reply-9", authorId: "bot" }] }))).toBeUndefined();
    await store.updateMention(id, { status: "DONE" });
    expect(await findEarlierAttempt(store, mention({}))).toBeUndefined();
  });
});
