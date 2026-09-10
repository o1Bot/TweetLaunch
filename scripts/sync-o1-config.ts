/**
 * Sync `config/o1.json` (plus the two stock-quote catalogs) from o1's
 * published machine-readable docs. Re-run whenever o1 rotates a factory or
 * changes a fee: `pnpm o1:sync`.
 *
 * Everything written here is a DATED SNAPSHOT. The executor still reads the
 * active factory on-chain immediately before building a transaction and
 * refuses to run if the live registry disagrees with this file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAddress, isAddress } from "viem";

/**
 * o1 publishes some addresses in mixed case that is not a valid EIP-55
 * checksum (the same address appears with different casing across their
 * files). Case carries no information beyond the checksum, so normalise via
 * lowercase → checksum and let downstream strict validation pass.
 */
function checksum(value: string, where: string): string {
  if (!isAddress(value, { strict: false })) throw new Error(`${where}: not an address: ${value}`);
  return getAddress(value.toLowerCase());
}
function checksumRecord(rec: Record<string, string>, where: string): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, checksum(v, `${where}.${k}`)]));
}

const DOCS = "https://docs.o1.exchange";
const SOURCES = {
  suites: `${DOCS}/launchpad/reference/launch-contract-suites.json`,
  deployments: `${DOCS}/launchpad/reference/production-deployments.json`,
  robinhoodStocks: `${DOCS}/launchpad/reference/robinhood-stock-quotes.json`,
  baseStocks: `${DOCS}/launchpad/reference/base-stock-quotes.json`,
} as const;

/** Chains o1bot supports: Robinhood Chain (v1, 2026-09-07) and Base (2026-09-11). Monad is out of scope. */
type SupportedKey = "robinhood" | "base";
const SUPPORTED: Record<number, SupportedKey> = { 4663: "robinhood", 8453: "base" };
const STOCK_SOURCES: Record<SupportedKey, string> = { robinhood: SOURCES.robinhoodStocks, base: SOURCES.baseStocks };

type Suite = {
  suiteId: string;
  contractVersion: string;
  status: "current" | "historical";
  selectedForNewCreationByPlatform: boolean;
  creationRoutes: string[];
  firstBlock: number;
  contracts: Record<string, string>;
};
type SuitesRegistry = {
  lastUpdatedAt: string;
  chains: Array<{ name: string; chainId: number; tokenMode: string; explorer: string; currentSuiteId: string; suites: Suite[] }>;
};
type Quote = { symbol: string; name?: string; address: string; decimals?: number; startTickToken0Frame: number; quoteRevision: string };
type Deployments = {
  lastUpdatedAt: string;
  governance: Record<string, string>;
  hardCaps: Record<string, unknown>;
  currentDefaults: Record<string, unknown>;
  chains: Array<{
    chainId: number;
    rpc?: string;
    b20?: { factory: string; activationRegistry: string; policyRegistry: string; assetFeature?: string };
    contracts: Record<string, string>;
    uniswapV4: Record<string, string>;
    swapX: Record<string, unknown>;
    feeConfiguration: {
      baseFeeBps: number;
      antiSnipeStartTotalBps: number;
      antiSnipeWindowSeconds: number;
      components: Array<{ componentId: string; recipientKind: string; configuredRecipient?: string; feeBps: number }>;
    };
    onchainCreationEnabled: boolean;
    supportsAtomicLaunchBuy: boolean;
    nativeLaunchFeeRaw: string;
    nativeLaunchFeeDisplay: string;
    lastVerifiedAt: string;
    lastVerifiedBlock: number;
    lastQuoteConfigurationVerifiedAt?: string;
    lastQuoteConfigurationVerifiedBlock?: number;
    standardRoute: { configVersion: string };
    stockRoute?: { quoteDecimals?: number; requiredTokenAddressSuffix?: string; quoteCount?: number };
    quotes: Quote[];
  }>;
};
type StockCatalog = {
  lastUpdatedAt: string;
  lastVerifiedBlock: number;
  chainId: number;
  factory: string;
  quoteDecimals: number;
  configVersion: string;
  registeredQuoteCount?: number;
  quotes: Quote[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(root, "config");
  await mkdir(outDir, { recursive: true });

  const [suites, deployments, rhStocks, baseStocks] = await Promise.all([
    getJson<SuitesRegistry>(SOURCES.suites),
    getJson<Deployments>(SOURCES.deployments),
    getJson<StockCatalog>(SOURCES.robinhoodStocks),
    getJson<StockCatalog>(SOURCES.baseStocks),
  ]);

  const fetchedAt = new Date().toISOString();
  const stockCatalogs: Record<SupportedKey, StockCatalog> = { robinhood: rhStocks, base: baseStocks };
  const chains: Record<string, unknown> = {};

  for (const reg of suites.chains) {
    const key = SUPPORTED[reg.chainId];
    if (!key) continue;
    const dep = deployments.chains.find((c) => c.chainId === reg.chainId);
    if (!dep) throw new Error(`production-deployments.json has no chain ${reg.chainId}`);
    const current = reg.suites.find((s) => s.suiteId === reg.currentSuiteId);
    if (!current || current.status !== "current" || !current.selectedForNewCreationByPlatform) {
      throw new Error(`registry current suite for chain ${reg.chainId} is not marked current/selected`);
    }
    if (current.contracts.factory?.toLowerCase() !== dep.contracts.factory?.toLowerCase()) {
      throw new Error(`factory mismatch between registry and deployments for chain ${reg.chainId}`);
    }
    const stocks = stockCatalogs[key];
    if (stocks.chainId !== reg.chainId || stocks.factory.toLowerCase() !== current.contracts.factory.toLowerCase()) {
      throw new Error(`stock catalog for ${key} does not match the active factory`);
    }

    const stockFile = `o1-stocks.${key}.json`;
    await writeFile(
      path.join(outDir, stockFile),
      JSON.stringify(
        {
          fetchedAt,
          source: STOCK_SOURCES[key],
          o1LastUpdatedAt: stocks.lastUpdatedAt,
          o1LastVerifiedBlock: stocks.lastVerifiedBlock,
          chainId: stocks.chainId,
          factory: checksum(stocks.factory, `${key}.stocks.factory`),
          quoteDecimals: stocks.quoteDecimals,
          configVersionAtSnapshot: stocks.configVersion,
          quotes: stocks.quotes.map((q) => ({
            symbol: q.symbol,
            name: q.name ?? null,
            address: checksum(q.address, `${key}.stocks.${q.symbol}`),
            decimals: stocks.quoteDecimals,
            startTickToken0Frame: q.startTickToken0Frame,
            quoteRevision: q.quoteRevision,
          })),
        },
        null,
        2,
      ) + "\n",
    );

    chains[key] = {
      key,
      chainId: reg.chainId,
      name: reg.name,
      tokenMode: reg.tokenMode,
      explorer: reg.explorer,
      rpc: dep.rpc ?? null,
      currentSuiteId: reg.currentSuiteId,
      contracts: checksumRecord({ ...current.contracts, ...dep.contracts }, `${key}.contracts`),
      uniswapV4: checksumRecord(dep.uniswapV4, `${key}.uniswapV4`),
      swapX: dep.swapX,
      b20: dep.b20 ? checksumRecord({ factory: dep.b20.factory, activationRegistry: dep.b20.activationRegistry, policyRegistry: dep.b20.policyRegistry }, `${key}.b20`) : null,
      requiredTokenAddressSuffix: dep.stockRoute?.requiredTokenAddressSuffix ?? "01",
      feeConfiguration: {
        ...dep.feeConfiguration,
        components: dep.feeConfiguration.components.map((c) => ({
          ...c,
          ...(c.configuredRecipient
            ? { configuredRecipient: checksum(c.configuredRecipient, `${key}.fee.${c.componentId}`) }
            : {}),
        })),
      },
      snapshot: {
        configVersion: dep.standardRoute.configVersion,
        nativeLaunchFeeRaw: dep.nativeLaunchFeeRaw,
        nativeLaunchFeeDisplay: dep.nativeLaunchFeeDisplay,
        onchainCreationEnabled: dep.onchainCreationEnabled,
        supportsAtomicLaunchBuy: dep.supportsAtomicLaunchBuy,
        lastVerifiedAt: dep.lastVerifiedAt,
        lastVerifiedBlock: dep.lastVerifiedBlock,
        lastQuoteConfigurationVerifiedAt: dep.lastQuoteConfigurationVerifiedAt ?? null,
        lastQuoteConfigurationVerifiedBlock: dep.lastQuoteConfigurationVerifiedBlock ?? null,
      },
      quotes: {
        crypto: dep.quotes.map((q) => ({
          symbol: q.symbol,
          address: checksum(q.address, `${key}.quotes.${q.symbol}`),
          decimals: q.decimals ?? 18,
          startTickToken0Frame: q.startTickToken0Frame,
          quoteRevision: q.quoteRevision,
        })),
        stocks: { count: stocks.quotes.length, decimals: stocks.quoteDecimals, file: stockFile },
      },
      suites: reg.suites.map((s) => ({ ...s, contracts: checksumRecord(s.contracts, `${key}.${s.suiteId}`) })),
    };
  }

  const out = {
    fetchedAt,
    sources: SOURCES,
    o1LastUpdatedAt: { suites: suites.lastUpdatedAt, deployments: deployments.lastUpdatedAt },
    note:
      "Dated snapshot generated by scripts/sync-o1-config.ts. Never build a transaction from these numbers alone: read configVersion, nativeLaunchFee, launchCreationEnabled and quoteConfig from the active factory at execution time.",
    governance: deployments.governance,
    hardCaps: deployments.hardCaps,
    defaults: deployments.currentDefaults,
    chains,
  };
  await writeFile(path.join(outDir, "o1.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote config/o1.json (${Object.keys(chains).join(", ")}) at ${fetchedAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
