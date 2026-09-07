import { parseDecimalToRaw } from "@o1bot/market";
import { isReservedHandle, normalizeHandle } from "@o1bot/shared";

/** Deterministic checks that run before any chain read. Pure, so they are unit-tested. */

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type RateCheck = { ok: true } | { ok: false; reason: "cooldown" | "daily_cap"; retryAfterSeconds: number };

export function checkRate(input: { lastLaunchAt: Date | null; launchesToday: number; now: Date; cooldownSeconds: number; maxPerDay: number }): RateCheck {
  if (input.launchesToday >= input.maxPerDay) {
    const tomorrow = startOfUtcDay(input.now).getTime() + 24 * 3600 * 1000;
    return { ok: false, reason: "daily_cap", retryAfterSeconds: Math.max(1, Math.ceil((tomorrow - input.now.getTime()) / 1000)) };
  }
  if (input.lastLaunchAt) {
    const elapsed = (input.now.getTime() - input.lastLaunchAt.getTime()) / 1000;
    if (elapsed < input.cooldownSeconds) return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil(input.cooldownSeconds - elapsed) };
  }
  return { ok: true };
}

export type DevBuyCheck = { ok: true; wei: bigint | null } | { ok: false; reason: "invalid" | "too_large" };

export function checkDevBuy(devBuyNative: string | null, maxWei: bigint): DevBuyCheck {
  if (devBuyNative === null) return { ok: true, wei: null };
  let wei: bigint;
  try {
    wei = parseDecimalToRaw(devBuyNative, 18);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (wei <= 0n) return { ok: false, reason: "invalid" };
  if (wei > maxWei) return { ok: false, reason: "too_large" };
  return { ok: true, wei };
}

export type FeesToCheck = { ok: true; handle: string | null } | { ok: false; reason: "reserved" | "invalid" };

export function checkFeesToHandle(handle: string | null, reserved: readonly string[], authorHandle: string): FeesToCheck {
  if (handle === null) return { ok: true, handle: null };
  const clean = normalizeHandle(handle);
  if (!clean) return { ok: false, reason: "invalid" };
  if (isReservedHandle(clean, reserved)) return { ok: false, reason: "reserved" };
  // Directing fees to yourself is the default; treat it as no redirect.
  if (clean === normalizeHandle(authorHandle)) return { ok: true, handle: null };
  return { ok: true, handle: clean };
}
