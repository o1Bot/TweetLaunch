import { describe, expect, it } from "vitest";
import { buildUserMessage } from "../src/prompt";

describe("the user message", () => {
  it("wraps the post with its author and flags", () => {
    const msg = buildUserMessage({ text: 'launch $CAT "Cash Cat" pair ETH', authorHandle: "alice", hasImage: false });
    expect(msg).toBe('<post author="@alice" has_image="false" also_tagged="none" is_reply="false">\nlaunch $CAT "Cash Cat" pair ETH\n</post>');
  });

  it("adds the bot's earlier reading when the post answers a clarify question", () => {
    const msg = buildUserMessage({
      text: "Vly AI",
      authorHandle: "sapri",
      hasImage: false,
      isReply: true,
      previous: { fields: { ticker: "VLY", name: null, pair: "ETH", chain: "base", devbuy_native: null }, missing: ["name"] },
    });
    expect(msg).toContain("<earlier_attempt>");
    expect(msg).toContain('ticker="VLY", pair="ETH", chain="base"');
    expect(msg).not.toContain("name=");
    expect(msg).toContain("It asked for: name.");
    expect(msg).toContain("merge what it adds into that command");
  });
});
