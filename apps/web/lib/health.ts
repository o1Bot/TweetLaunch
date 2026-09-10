/**
 * Freshness of the market data behind the board and token pages.
 *
 * The indexer commits its cursor on every poll, even when a range holds no
 * swaps, so the cursor's `updatedAt` is a liveness signal: if it stops
 * moving, the indexer is down, crash-looping or stuck on a batch. That is
 * exactly what happened on 2026-09-10, when one bad row stalled it for two
 * hours before anyone noticed.
 */

/** How long the cursor may sit still before the data counts as delayed. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

export type IndexerHealth = {
  /** False when the cursor has not moved for STALE_AFTER_MS or there is no cursor at all. */
  ok: boolean;
  /** Seconds since the cursor last moved; null without a cursor. */
  ageSeconds: number | null;
  /** When the data stopped moving, ISO; only set when not ok. */
  since: string | null;
};

export function indexerHealth(cursorAt: Date | null, now: Date = new Date()): IndexerHealth {
  if (!cursorAt) return { ok: false, ageSeconds: null, since: null };
  const ageMs = now.getTime() - cursorAt.getTime();
  const ok = ageMs <= STALE_AFTER_MS;
  return { ok, ageSeconds: Math.max(0, Math.round(ageMs / 1000)), since: ok ? null : cursorAt.toISOString() };
}
