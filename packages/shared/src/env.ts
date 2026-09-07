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

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
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

  RPC_ROBINHOOD: z.string().optional(),

  TREASURY_ADDRESS: address.optional(),
  REFERRER_ADDRESS: address.optional(),

  MAX_LAUNCHES_PER_USER_PER_DAY: z.coerce.number().int().positive().default(5),
  LAUNCH_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(600),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
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
