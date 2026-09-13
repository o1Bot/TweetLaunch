import type { EarlierAttempt } from "@o1bot/parser";
import type { XMention } from "@o1bot/x";
import type { BotStore } from "./store";

/**
 * When a poster answers the bot's clarify question by replying to it, the
 * parser gets the bot's earlier reading of their command, so a bare "Vly AI"
 * or "pair ETH" completes the launch instead of starting a new, emptier
 * attempt. Only the same poster's own clarified attempt counts.
 */

/** The command fields the parser fills; other keys of the stored output (reason, question, language) are not carried. */
const FIELDS = ["ticker", "name", "pair", "chain", "devbuy_native", "fees_to_handle", "description", "website", "telegram", "x_handle", "site_slug", "trade_side", "trade_amount"] as const;

/** The earlier reading from a stored parser output, or null when it was not a clarify or holds nothing usable. */
export function earlierAttemptFromParse(parse: unknown): EarlierAttempt | null {
  if (!parse || typeof parse !== "object") return null;
  const raw = parse as Record<string, unknown>;
  if (raw.kind !== "clarify") return null;
  const fields: Record<string, string | null> = {};
  for (const key of FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") fields[key] = v;
    else if (v === null || v === "") fields[key] = null;
  }
  const missing = Array.isArray(raw.missing) ? raw.missing.filter((m): m is string => typeof m === "string") : [];
  if (Object.values(fields).every((v) => v === null)) return null;
  return { fields, missing };
}

/** The bot's clarified reading of this poster's previous attempt, when the post replies to that clarify. */
export async function findEarlierAttempt(store: Pick<BotStore, "mentionByReplyTweetId">, mention: XMention): Promise<EarlierAttempt | undefined> {
  const repliedTo = mention.referenced.find((r) => r.type === "replied_to")?.id;
  if (!repliedTo) return undefined;
  const earlier = await store.mentionByReplyTweetId(repliedTo);
  if (!earlier || earlier.authorXUserId !== mention.authorId || earlier.status !== "CLARIFY") return undefined;
  return earlierAttemptFromParse(earlier.parse) ?? undefined;
}
