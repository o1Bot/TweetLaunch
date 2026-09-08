import { parseEther } from "viem";
import { env, RESERVED_HANDLES } from "@o1bot/shared";

export type BotConfig = {
  dryRun: boolean;
  pollMs: number;
  cooldownSeconds: number;
  maxLaunchesPerDay: number;
  maxRepliesPerDay: number;
  maxDevBuyWei: bigint;
  /** Trades from posts: hard cap, default per-user cap, cooldown, daily count, default slippage. */
  maxTradeWei: bigint;
  defaultUserTradeCapWei: bigint;
  tradeCooldownSeconds: number;
  maxTradesPerDay: number;
  tradeSlippageBps: number;
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
    maxTradeWei: parseEther(e.MAX_TRADE_ETH),
    defaultUserTradeCapWei: parseEther(e.DEFAULT_USER_TRADE_CAP_ETH),
    tradeCooldownSeconds: e.TRADE_COOLDOWN_SECONDS,
    maxTradesPerDay: e.MAX_TRADES_PER_USER_PER_DAY,
    tradeSlippageBps: e.TRADE_SLIPPAGE_BPS,
    siteUrl: e.SITE_URL.replace(/\/$/, ""),
    botHandle: e.X_BOT_HANDLE,
    botUserId: e.X_BOT_USER_ID ?? null,
    reservedHandles: [...RESERVED_HANDLES, e.X_BOT_HANDLE],
  };
}
