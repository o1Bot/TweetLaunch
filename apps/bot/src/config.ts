import { parseEther } from "viem";
import { env, RESERVED_HANDLES, type ChainKey } from "@o1bot/shared";

export type BotConfig = {
  dryRun: boolean;
  pollMs: number;
  cooldownSeconds: number;
  maxLaunchesPerDay: number;
  maxRepliesPerDay: number;
  /** Largest dev buy on the ETH chains (Robinhood, Base), in wei. */
  maxDevBuyWei: bigint;
  /** Largest dev buy on Arc, in native USDC units (18 decimals). */
  maxDevBuyArcWei: bigint;
  /** Trades from posts: hard cap, default per-user cap, cooldown, daily count, default slippage. */
  maxTradeWei: bigint;
  defaultUserTradeCapWei: bigint;
  tradeCooldownSeconds: number;
  maxTradesPerDay: number;
  tradeSlippageBps: number;
  /** Largest Relay deposit the bot signs on an origin chain. */
  maxBridgeWei: bigint;
  siteUrl: string;
  /** Domain the token sites hang under: <slug>.<domain>. */
  sitesRootDomain: string;
  botHandle: string;
  botUserId: string | null;
  reservedHandles: string[];
};

/** The dev-buy cap for a chain, in that chain's native units. */
export function maxDevBuyFor(config: BotConfig, key: ChainKey): bigint {
  return key === "arc" ? config.maxDevBuyArcWei : config.maxDevBuyWei;
}

export function botConfig(): BotConfig {
  const e = env();
  return {
    dryRun: e.DRY_RUN,
    pollMs: e.X_POLL_MS,
    cooldownSeconds: e.LAUNCH_COOLDOWN_SECONDS,
    maxLaunchesPerDay: e.MAX_LAUNCHES_PER_USER_PER_DAY,
    maxRepliesPerDay: e.MAX_REPLIES_PER_USER_PER_DAY,
    maxDevBuyWei: parseEther(e.MAX_DEV_BUY_ETH),
    maxDevBuyArcWei: parseEther(e.MAX_DEV_BUY_USDC),
    maxTradeWei: parseEther(e.MAX_TRADE_ETH),
    defaultUserTradeCapWei: parseEther(e.DEFAULT_USER_TRADE_CAP_ETH),
    tradeCooldownSeconds: e.TRADE_COOLDOWN_SECONDS,
    maxTradesPerDay: e.MAX_TRADES_PER_USER_PER_DAY,
    tradeSlippageBps: e.TRADE_SLIPPAGE_BPS,
    maxBridgeWei: parseEther(e.MAX_BRIDGE_ETH),
    siteUrl: e.SITE_URL.replace(/\/$/, ""),
    sitesRootDomain: e.SITES_ROOT_DOMAIN,
    botHandle: e.X_BOT_HANDLE,
    botUserId: e.X_BOT_USER_ID ?? null,
    reservedHandles: [...RESERVED_HANDLES, e.X_BOT_HANDLE],
  };
}
