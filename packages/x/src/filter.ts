import type { XMention } from "./types";

export type MentionFilter = { ok: true } | { ok: false; reason: "self" | "retweet" | "quote_of_bot" | "empty" };

/**
 * Which mentions deserve processing: not the bot's own posts, not retweets,
 * not quote-posts of the bot's replies (people quoting a success reply
 * would otherwise trigger a parse for nothing).
 */
export function filterMention(m: XMention, botUserId: string): MentionFilter {
  if (m.authorId === botUserId) return { ok: false, reason: "self" };
  if (m.referenced.some((r) => r.type === "retweeted")) return { ok: false, reason: "retweet" };
  if (m.referenced.some((r) => r.type === "quoted" && r.authorId === botUserId)) return { ok: false, reason: "quote_of_bot" };
  if (!m.text.trim()) return { ok: false, reason: "empty" };
  return { ok: true };
}

/** Remove leading @mentions X prepends to replies so the parser sees the command. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(\s*@\w{1,15}\s+)+/, "").trim();
}
