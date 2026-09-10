import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { CHAIN_KEYS, type ChainKey } from "./chains";
import o1Raw from "../../../config/o1.json" with { type: "json" };
import robinhoodStocksRaw from "../../../config/o1-stocks.robinhood.json" with { type: "json" };
import baseStocksRaw from "../../../config/o1-stocks.base.json" with { type: "json" };

const STOCK_FILES: Record<ChainKey, unknown> = { robinhood: robinhoodStocksRaw, base: baseStocksRaw };

/**
 * Typed access to the dated o1 snapshot in `config/o1.json`, plus a live
 * check against o1's published registry so a rotated factory is caught
 * before any transaction is built. Never hardcode a factory elsewhere.
 */

/**
 * Accept any 20-byte hex address regardless of casing (o1 publishes some
 * addresses with a non-EIP-55 mixed case) and normalise to a checksum.
 */
const addressSchema = z
  .string()
  .refine((a) => isAddress(a, { strict: false }), "invalid address")
  .transform((a) => getAddress(a.toLowerCase()));

const SuiteSchema = z.object({
  suiteId: z.string(),
  contractVersion: z.string(),
  status: z.enum(["current", "historical"]),
  selectedForNewCreationByPlatform: z.boolean(),
  creationRoutes: z.array(z.string()),
  firstBlock: z.number().int(),
  contracts: z.record(z.string(), addressSchema),
});
export type O1Suite = z.infer<typeof SuiteSchema>;

const QuoteSchema = z.object({
  symbol: z.string(),
  name: z.string().nullable().optional(),
  address: addressSchema,
  decimals: z.number().int(),
  startTickToken0Frame: z.number().int(),
  quoteRevision: z.string(),
});
export type O1Quote = z.infer<typeof QuoteSchema> & { kind: "crypto" | "stock" };

const ChainSchema = z.object({
  key: z.enum(CHAIN_KEYS),
  chainId: z.number().int(),
  name: z.string(),
  tokenMode: z.enum(["b20", "erc20"]),
  explorer: z.string(),
  rpc: z.string().nullable(),
  currentSuiteId: z.string(),
  contracts: z.record(z.string(), addressSchema),
  uniswapV4: z.object({
    poolManager: addressSchema,
    quoter: addressSchema,
    stateView: addressSchema,
    universalRouter: addressSchema,
    permit2: addressSchema,
  }),
  swapX: z.record(z.string(), z.unknown()),
  /** Base only: the B20 precompiles the factory mints through and predicts addresses with. */
  b20: z.object({ factory: addressSchema, activationRegistry: addressSchema, policyRegistry: addressSchema }).nullable().optional(),
  requiredTokenAddressSuffix: z.string(),
  feeConfiguration: z.object({
    baseFeeBps: z.number().int(),
    antiSnipeStartTotalBps: z.number().int(),
    antiSnipeWindowSeconds: z.number().int(),
    components: z.array(
      z.object({
        componentId: z.string(),
        recipientKind: z.string(),
        configuredRecipient: addressSchema.optional(),
        feeBps: z.number().int(),
      }),
    ),
  }),
  snapshot: z.object({
    configVersion: z.string(),
    nativeLaunchFeeRaw: z.string(),
    nativeLaunchFeeDisplay: z.string(),
    onchainCreationEnabled: z.boolean(),
    supportsAtomicLaunchBuy: z.boolean(),
    lastVerifiedAt: z.string(),
    lastVerifiedBlock: z.number().int(),
    lastQuoteConfigurationVerifiedAt: z.string().nullable(),
    lastQuoteConfigurationVerifiedBlock: z.number().int().nullable(),
  }),
  quotes: z.object({
    crypto: z.array(QuoteSchema),
    stocks: z.object({ count: z.number().int(), decimals: z.number().int(), file: z.string() }),
  }),
  suites: z.array(SuiteSchema),
});
export type O1Chain = z.infer<typeof ChainSchema>;

const ConfigSchema = z.object({
  fetchedAt: z.string(),
  sources: z.record(z.string(), z.string()),
  o1LastUpdatedAt: z.record(z.string(), z.string()),
  governance: z.record(z.string(), z.string()),
  hardCaps: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
  chains: z.object({ robinhood: ChainSchema, base: ChainSchema }),
});
export type O1Config = z.infer<typeof ConfigSchema>;

const StockFileSchema = z.object({
  fetchedAt: z.string(),
  chainId: z.number().int(),
  factory: addressSchema,
  quoteDecimals: z.number().int(),
  quotes: z.array(QuoteSchema),
});

let parsed: O1Config | null = null;
const stockCache = new Map<ChainKey, O1Quote[]>();

export function o1Config(): O1Config {
  if (!parsed) parsed = ConfigSchema.parse(o1Raw);
  return parsed;
}

export function o1Chain(key: ChainKey): O1Chain {
  return o1Config().chains[key];
}

export function activeSuite(key: ChainKey): O1Suite {
  const chain = o1Chain(key);
  const suite = chain.suites.find((s) => s.suiteId === chain.currentSuiteId);
  if (!suite || suite.status !== "current" || !suite.selectedForNewCreationByPlatform) {
    throw new Error(`config/o1.json: no current suite for ${key}`);
  }
  return suite;
}

function requiredContract(key: ChainKey, name: string): Address {
  const address = o1Chain(key).contracts[name];
  if (!address) throw new Error(`config/o1.json: ${key} has no ${name} address`);
  return address;
}

export const activeFactory = (key: ChainKey): Address => requiredContract(key, "factory");
export const activeHook = (key: ChainKey): Address => requiredContract(key, "hook");
export const activeFeeEscrow = (key: ChainKey): Address => requiredContract(key, "feeEscrow");
export const activeLaunchBuyAdapter = (key: ChainKey): Address => requiredContract(key, "launchBuyAdapter");

/** Every LaunchHook o1 has deployed on the chain (current and past suites): a pool on any of them is an o1 launch pool. */
export function knownHooks(key: ChainKey): Address[] {
  const chain = o1Chain(key);
  const hooks = new Set<Address>();
  const current = chain.contracts.hook;
  if (current) hooks.add(getAddress(current));
  for (const suite of chain.suites) {
    const hook = suite.contracts.hook;
    if (hook) hooks.add(getAddress(hook));
  }
  return [...hooks];
}

/** Recognise a historical launch by its originating factory (indexer use). */
export function suiteByFactory(chainId: number, factory: string): { key: ChainKey; suite: O1Suite } | null {
  if (!isAddress(factory, { strict: false })) return null;
  const wanted = getAddress(factory.toLowerCase());
  for (const key of CHAIN_KEYS) {
    const chain = o1Chain(key);
    if (chain.chainId !== chainId) continue;
    const suite = chain.suites.find((s) => s.contracts.factory === wanted);
    if (suite) return { key, suite };
  }
  return null;
}

export function stockQuotes(key: ChainKey): O1Quote[] {
  const cached = stockCache.get(key);
  if (cached) return cached;
  const file = StockFileSchema.parse(STOCK_FILES[key]);
  const chain = o1Chain(key);
  if (file.chainId !== chain.chainId || file.factory !== activeFactory(key)) {
    throw new Error(`config/o1-stocks.${key}.json does not match config/o1.json; re-run pnpm o1:sync`);
  }
  const list = file.quotes.map((q) => ({ ...q, kind: "stock" as const }));
  stockCache.set(key, list);
  return list;
}

export function cryptoQuotes(key: ChainKey): O1Quote[] {
  return o1Chain(key).quotes.crypto.map((q) => ({ ...q, kind: "crypto" as const }));
}

export function allQuotes(key: ChainKey): O1Quote[] {
  return [...cryptoQuotes(key), ...stockQuotes(key)];
}

/** Look a pair up by symbol (case-insensitive, optional leading $) or by address. */
export function findQuote(key: ChainKey, symbolOrAddress: string): O1Quote | null {
  const needle = symbolOrAddress.trim();
  if (!needle) return null;
  if (isAddress(needle, { strict: false })) {
    const addr = getAddress(needle.toLowerCase());
    return allQuotes(key).find((q) => q.address === addr) ?? null;
  }
  const upper = needle.replace(/^\$/, "").toUpperCase();
  return allQuotes(key).find((q) => q.symbol.toUpperCase() === upper) ?? null;
}

/** True when a ticker collides with a registered stock symbol on that factory. */
export function tickerCollidesWithStock(key: ChainKey, ticker: string): boolean {
  const upper = ticker.trim().toUpperCase();
  return stockQuotes(key).some((q) => q.symbol.toUpperCase() === upper);
}

// ── Live registry check ────────────────────────────────────────────

const LiveRegistrySchema = z.object({
  lastUpdatedAt: z.string(),
  chains: z.array(
    z.object({
      chainId: z.number().int(),
      currentSuiteId: z.string(),
      suites: z.array(SuiteSchema),
    }),
  ),
});
export type LiveRegistry = z.infer<typeof LiveRegistrySchema>;

export async function fetchLiveRegistry(url = o1Config().sources.suites): Promise<LiveRegistry> {
  if (!url) throw new Error("config/o1.json has no sources.suites URL");
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`o1 registry fetch failed: HTTP ${res.status}`);
  return LiveRegistrySchema.parse(await res.json());
}

export type RegistryDrift = {
  key: ChainKey;
  snapshotFactory: Address;
  liveFactory: Address | null;
  liveSuiteId: string;
};

/**
 * Compare the snapshot's active factory with o1's live registry. Returns the
 * chains that drifted; an empty list means the snapshot is current. Callers
 * that are about to sign must treat any drift as fatal.
 */
export async function registryDrift(live?: LiveRegistry): Promise<RegistryDrift[]> {
  const registry = live ?? (await fetchLiveRegistry());
  const drift: RegistryDrift[] = [];
  for (const key of CHAIN_KEYS) {
    const chain = o1Chain(key);
    const liveChain = registry.chains.find((c) => c.chainId === chain.chainId);
    if (!liveChain) {
      drift.push({ key, snapshotFactory: activeFactory(key), liveFactory: null, liveSuiteId: "(chain missing)" });
      continue;
    }
    const liveSuite = liveChain.suites.find((s) => s.suiteId === liveChain.currentSuiteId);
    const liveFactory = liveSuite?.contracts.factory ?? null;
    if (liveFactory !== activeFactory(key)) {
      drift.push({ key, snapshotFactory: activeFactory(key), liveFactory, liveSuiteId: liveChain.currentSuiteId });
    }
  }
  return drift;
}
