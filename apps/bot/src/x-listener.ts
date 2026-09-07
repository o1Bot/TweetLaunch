import { logger } from "@o1bot/shared";
import { filterMention, XRateLimitError, type XClient } from "@o1bot/x";
import type { JobQueue } from "./queue";
import type { BotStore } from "./store";

/**
 * Polls X for mentions of the bot and hands each new one to the queue. The
 * cursor (`since_id`) only moves forward after every mention in a page was
 * queued, so a crash mid-page re-fetches the page; the queue and the
 * Mention.tweetId constraint make that harmless.
 */

export const SINCE_ID_CURSOR = "x:since_id";

export type ListenerDeps = {
  x: XClient;
  store: BotStore;
  queue: JobQueue;
  /** The bot's own X user id, used to skip its own posts and quotes of them. */
  botUserId: string | null;
};

export type PollStats = { fetched: number; enqueued: number; duplicates: number; filtered: number; sinceId: string | null; newestId: string | null };

export async function pollOnce(deps: ListenerDeps): Promise<PollStats> {
  const sinceId = await deps.store.getCursor(SINCE_ID_CURSOR);
  const mentions = await deps.x.fetchMentions(sinceId ?? undefined);
  const stats: PollStats = { fetched: mentions.length, enqueued: 0, duplicates: 0, filtered: 0, sinceId, newestId: sinceId };

  for (const mention of mentions) {
    const verdict = filterMention(mention, deps.botUserId ?? "");
    if (!verdict.ok) {
      stats.filtered++;
      logger.debug({ tweetId: mention.id, reason: verdict.reason }, "mention skipped");
    } else {
      const result = await deps.queue.enqueue({ mention });
      if (result === "queued") stats.enqueued++;
      else stats.duplicates++;
    }
    if (!stats.newestId || BigInt(mention.id) > BigInt(stats.newestId)) stats.newestId = mention.id;
  }

  if (stats.newestId && stats.newestId !== sinceId) await deps.store.setCursor(SINCE_ID_CURSOR, stats.newestId);
  return stats;
}

export type Poller = { stop(): Promise<void> };

/**
 * Delay before the next poll. A 429 from X carries the time its 15-minute
 * window resets, so the poller sleeps until then instead of hammering the
 * endpoint; any other error just waits the normal interval.
 */
export function nextDelayMs(err: unknown, pollMs: number, now = Date.now()): number {
  if (err instanceof XRateLimitError) return Math.max(pollMs, err.resetAt - now + 1_000);
  return pollMs;
}

/** Poll forever. Errors are logged and the next tick still runs; rate limits are honoured. */
export function startPolling(deps: ListenerDeps, pollMs: number): Poller {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async () => {
    if (stopped) return;
    let delay = pollMs;
    try {
      const stats = await pollOnce(deps);
      if (stats.fetched > 0) logger.info(stats, "polled mentions");
      else logger.debug(stats, "polled mentions");
    } catch (err) {
      delay = nextDelayMs(err, pollMs);
      if (err instanceof XRateLimitError) logger.warn({ resetAt: new Date(err.resetAt).toISOString(), waitMs: delay }, "X rate limit on mentions; waiting for the window to reset");
      else logger.warn({ err: err instanceof Error ? err.message : String(err) }, "mention poll failed; retrying next tick");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        inFlight = tick();
      }, delay);
    }
  };

  inFlight = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
