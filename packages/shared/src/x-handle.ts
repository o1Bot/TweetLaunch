/** X usernames: 1-15 chars, letters, digits, underscore. Stored lowercase. */
const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

export function normalizeHandle(raw: string): string | null {
  const clean = raw.trim().replace(/^@/, "").toLowerCase();
  return HANDLE_RE.test(clean) ? clean : null;
}

/** Handles the bot must never accept as a `fees to` target. */
export function isReservedHandle(handle: string, reserved: readonly string[]): boolean {
  const h = normalizeHandle(handle);
  if (!h) return true;
  return reserved.some((r) => normalizeHandle(r) === h);
}

/** Known o1 and o1bot accounts. Extend from env at runtime, never shrink. */
export const RESERVED_HANDLES: readonly string[] = ["o1bot_exchange", "o1bot", "1o_exchange", "o1exchange", "o1_exchange", "o1launchpad"];
