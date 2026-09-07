import { parseEther } from "viem";
import { env, RESERVED_HANDLES } from "@o1bot/shared";

export type BotConfig = {
  dryRun: boolean;
  pollMs: number;
  cooldownSeconds: number;
  maxLaunchesPerDay: number;
  maxRepliesPerDay: number;
  maxDevBuyWei: bigint;
  siteUrl: string;
  botHandle: string;
  botUserId: string | null;
  reservedHandles: string[];
};

export function botConfig(): BotConfig {
  const e = env();
  return {
    dryRun: e.DRY_RUN,
    pollMs: e.X_POLL_MS,
    cooldownSeconds: e.LAUNCH_COOLDOWN_SECONDS,
    maxLaunchesPerDay: e.MAX_LAUNCHES_PER_USER_PER_DAY,
    maxRepliesPerDay: e.MAX_REPLIES_PER_USER_PER_DAY,
    maxDevBuyWei: parseEther(e.MAX_DEV_BUY_ETH),
    siteUrl: e.SITE_URL.replace(/\/$/, ""),
    botHandle: e.X_BOT_HANDLE,
    botUserId: e.X_BOT_USER_ID ?? null,
    reservedHandles: [...RESERVED_HANDLES, e.X_BOT_HANDLE],
  };
}
