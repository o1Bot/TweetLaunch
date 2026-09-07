import { describe, expect, it } from "vitest";
import { FakeXClient, XRateLimitError, type XMention } from "@o1bot/x";
import { MemoryQueue } from "../src/queue";
import { MemoryBotStore } from "../src/store";
import { leadingHandles } from "../src/pipeline";
import { nextDelayMs, pollOnce, SINCE_ID_CURSOR } from "../src/x-listener";

const mention = (id: string, over: Partial<XMention> = {}): XMention => ({
  id,
  text: '@o1bot_exchange launch $A "A" pair ETH',
  authorId: "111",
  authorHandle: "alice",
  authorName: null,
  authorImage: null,
  imageUrl: null,
  createdAt: null,
  lang: "en",
  referenced: [],
  ...over,
});

describe("pollOnce", () => {
  it("queues new mentions, skips the bot's own posts and retweets, and advances the cursor", async () => {
    const x = new FakeXClient([
      mention("10"),
      mention("11", { authorId: "999" }),
      mention("12", { referenced: [{ type: "retweeted", id: "1", authorId: null }] }),
      mention("13"),
    ]);
    const store = new MemoryBotStore();
    const queue = new MemoryQueue();
    const seen: string[] = [];
    queue.start(async (job) => {
      seen.push(job.mention.id);
    });
    const stats = await pollOnce({ x, store, queue, botUserId: "999" });
    await queue.drain();
    expect(stats).toMatchObject({ fetched: 4, enqueued: 2, filtered: 2, duplicates: 0, newestId: "13" });
    expect(seen).toEqual(["10", "13"]);
    expect(await store.getCursor(SINCE_ID_CURSOR)).toBe("13");
  });

  it("only asks for mentions newer than the cursor and reports duplicates", async () => {
    const x = new FakeXClient([mention("10"), mention("11")]);
    const store = new MemoryBotStore();
    await store.setCursor(SINCE_ID_CURSOR, "10");
    const queue = new MemoryQueue();
    queue.start(async () => {});
    await queue.enqueue({ mention: mention("11") });
    const stats = await pollOnce({ x, store, queue, botUserId: "999" });
    expect(stats).toMatchObject({ fetched: 1, enqueued: 0, duplicates: 1, sinceId: "10", newestId: "11" });
  });
});

describe("nextDelayMs", () => {
  it("waits for the rate-limit window to reset, never less than the poll interval", () => {
    const now = 1_000_000;
    expect(nextDelayMs(new XRateLimitError("mentions", now + 300_000), 30_000, now)).toBe(301_000);
    expect(nextDelayMs(new XRateLimitError("mentions", now - 5_000), 30_000, now)).toBe(30_000);
  });

  it("keeps the normal interval for other errors", () => {
    expect(nextDelayMs(new Error("boom"), 30_000)).toBe(30_000);
  });
});

describe("leadingHandles", () => {
  it("lists the handles X prepends to a reply, in order and lowercased", () => {
    expect(leadingHandles("@T_McKee @o1bot_exchange yes perfect master")).toEqual(["t_mckee", "o1bot_exchange"]);
    expect(leadingHandles("@o1bot_exchange launch $A \"A\" pair ETH")).toEqual(["o1bot_exchange"]);
    expect(leadingHandles("hello @o1bot_exchange")).toEqual([]);
  });
});
