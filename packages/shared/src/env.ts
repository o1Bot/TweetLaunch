import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
const bool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && v !== "" && v !== "false" && v !== "0");

/**
 * Every variable is optional at parse time so that any process (web build,
 * unit tests, the bot) can boot with a partial environment. Call
 * `requireEnv("NAME")` at the point of use to fail loudly when a value is
 * actually needed.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  LOG_PRETTY: bool,

  /** When true (default) the bot parses, validates and simulates but never broadcasts or replies. */
  DRY_RUN: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  SITE_URL: z.url().default("http://localhost:3000"),
  /** Public docs URL the bot may link in help replies. Defaults to the site's how-it-works page. */
  DOCS_URL: z.url().optional(),
  /** Domain under which agent-built token sites are served (<slug>.<domain>); the web project needs the wildcard domain attached. */
  SITES_ROOT_DOMAIN: z.string().default("o1bot.exchange"),
  /** Model that writes token sites; defaults to claude-sonnet-4-6. */
  SITES_MODEL: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  /** Private key of the app's key quorum ("wallet-auth:…"); signs wallet API requests on behalf of users. */
  PRIVY_AUTHORIZATION_PRIVATE_KEY: z.string().optional(),
  /** Key quorum id of that key; users add it as a signer on their wallet, the bot checks for it. */
  PRIVY_SIGNER_ID: z.string().optional(),
  /** Policy users attach to the signer; the enclave enforces it, signer.ts is the second layer. */
  PRIVY_POLICY_ID: z.string().optional(),
  NEXT_PUBLIC_PRIVY_APP_ID: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Parser model; defaults to claude-sonnet-4-6. */
  PARSER_MODEL: z.string().optional(),
  PINATA_JWT: z.string().optional(),

  X_BEARER_TOKEN: z.string().optional(),
  X_APP_KEY: z.string().optional(),
  X_APP_SECRET: z.string().optional(),
  X_APP_ACCESS_TOKEN: z.string().optional(),
  X_APP_ACCESS_TOKEN_SECRET: z.string().optional(),
  X_BOT_USER_ID: z.string().optional(),
  X_BOT_HANDLE: z.string().default("o1bot_exchange"),
  /** Mentions poll interval. Pay-per-use bills per mention read, not per poll; a 429 pauses polling until X's window resets. */
  X_POLL_MS: z.coerce.number().int().positive().default(30_000),
  /** Replies of any kind (help, questions, errors, success) per X account per UTC day. */
  MAX_REPLIES_PER_USER_PER_DAY: z.coerce.number().int().positive().default(8),
  /** Largest dev buy the bot will sign, in ETH. */
  MAX_DEV_BUY_ETH: z.string().default("1"),
  /** Slippage tolerance applied to the simulated dev-buy output, in basis points. */
  DEV_BUY_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(5000).default(500),
  QUEUE_DRIVER: z.enum(["memory", "redis"]).default("memory"),

  RPC_ROBINHOOD: z.string().optional(),
  /** Origin chains for bridging from a post; public RPCs are used when unset. */
  RPC_BASE: z.string().optional(),
  RPC_ETHEREUM: z.string().optional(),
  RPC_ARBITRUM: z.string().optional(),
  RPC_OPTIMISM: z.string().optional(),

  TREASURY_ADDRESS: address.optional(),
  REFERRER_ADDRESS: address.optional(),

  /** o1 Public API (read side only: holder snapshots). */
  O1_API_URL: z.string().default("https://api.launch.o1.exchange/v1"),
  O1_API_KEY: z.string().optional(),

  /** Indexer. RPC must support eth_getLogs over historical ranges. */
  INDEXER_RPC: z.string().optional(),
  INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().optional(),
  /** Stop at this block instead of the chain tip (bounded dry runs). */
  INDEXER_END_BLOCK: z.coerce.number().int().nonnegative().optional(),
  /** Comma-separated token addresses to track without a bot launch (local testing only). */
  INDEXER_DEV_TOKENS: z.string().optional(),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(3000),
  /** Show INDEXER_DEV_TOKENS pools in the web app (local previews only). */
  SHOW_DEV_TOKENS: bool,
  IPFS_GATEWAY: z.string().default("https://gateway.pinata.cloud/ipfs/"),

  MAX_LAUNCHES_PER_USER_PER_DAY: z.coerce.number().int().positive().default(5),
  LAUNCH_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(600),

  /** Trades from posts. The hard per-trade cap in ETH; a user's own cap can only be lower. */
  MAX_TRADE_ETH: z.string().default("0.5"),
  /** Per-trade cap applied when a user enables trading without setting one, in ETH. */
  DEFAULT_USER_TRADE_CAP_ETH: z.string().default("0.1"),
  TRADE_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),
  MAX_TRADES_PER_USER_PER_DAY: z.coerce.number().int().positive().default(20),
  /** Slippage applied to a trade from a post when the user names none, in basis points. */
  TRADE_SLIPPAGE_BPS: z.coerce.number().int().min(10).max(1000).default(300),

  /** Bridging from a post through Relay: the largest deposit the bot signs on an origin chain, in ETH. */
  MAX_BRIDGE_ETH: z.string().default("1"),
  RELAY_API_URL: z.string().default("https://api.relay.link"),
  /** Optional: Relay app key, attributes volume to o1bot for fee sharing. Quotes work without it. */
  RELAY_API_KEY: z.string().optional(),

  /** Operator alerts on Telegram (failed launches and trades, refused replies, the poller failing, crashes). */
  ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** An empty value in .env means "unset": defaults and optional checks must treat it that way. */
function withoutEmpty(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]));
}

export function env(): Env {
  if (!cached) cached = schema.parse(withoutEmpty(process.env));
  return cached;
}

/** Test helper: drop the cached parse so a test can mutate process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<Env[K]>;
}
