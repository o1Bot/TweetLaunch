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

export type DevBuyCheck = { ok: true; wei: bigint | null } | { ok: false; reason: "invalid" | "too_large" | "too_precise" };

/**
 * `scale` is the smallest native unit the chain's launch-buy adapter accepts
 * (1e12 on Arc, where native USDC has 18 decimals and the pool's USDC six;
 * the adapter rejects anything finer instead of rounding). 1 elsewhere.
 */
export function checkDevBuy(devBuyNative: string | null, maxWei: bigint, opts: { scale?: bigint } = {}): DevBuyCheck {
  if (devBuyNative === null) return { ok: true, wei: null };
  let wei: bigint;
  try {
    wei = parseDecimalToRaw(devBuyNative, 18);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (wei <= 0n) return { ok: false, reason: "invalid" };
  if (wei > maxWei) return { ok: false, reason: "too_large" };
  if ((opts.scale ?? 1n) > 1n && wei % (opts.scale ?? 1n) !== 0n) return { ok: false, reason: "too_precise" };
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
