import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { arc, base, robinhood } from "viem/chains";
import { env } from "./env";

/**
 * Chains o1 launches can run on through o1bot. v1 was Robinhood Chain only
 * (2026-09-07); Base joined on 2026-09-11 and Arc on 2026-09-12. Robinhood
 * stays the default wherever a post names no chain.
 *
 * Arc's gas asset is USDC: the chain's native currency has 18 decimals like
 * ETH, the ERC-20 view of the same balance has six. Everything the bot
 * denominates in "native" (launch fee, dev buy, gas, shortfalls) is USDC
 * there, which is why the native symbol comes from the chain and never
 * from a hardcoded "ETH".
 */
export const CHAIN_KEYS = ["robinhood", "base", "arc"] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];
export const DEFAULT_CHAIN_KEY: ChainKey = "robinhood";
/**
 * Chains the indexer scans and the figures (board, questions from posts,
 * wallet overviews) cover. Arc launches run before Arc is indexed; it joins
 * this list with its indexer cursor and web pages.
 */
export const INDEXED_CHAIN_KEYS: readonly ChainKey[] = ["robinhood", "base"];

export const CHAINS: Record<ChainKey, Chain> = { robinhood, base, arc };

/**
 * Public RPCs tried in order when the chain's RPC_* is unset. The chain's own
 * endpoint is last: some ISPs intercept its TLS. Use a paid RPC in production.
 * Arc ships no public endpoint in viem; thirdweb's is the one open relay
 * found, rate-limited and not always up, so RPC_ARC is effectively required.
 */
export const PUBLIC_RPCS: Record<ChainKey, readonly string[]> = {
  robinhood: [
    "https://robinhood-rpc.publicnode.com",
    "https://rpc.ordofi.network",
    "https://rpc.mainnet.chain.robinhood.com",
  ],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
  arc: ["https://5042.rpc.thirdweb.com"],
};

export function isChainKey(value: string): value is ChainKey {
  return (CHAIN_KEYS as readonly string[]).includes(value);
}

export function chainByKey(key: ChainKey): Chain {
  return CHAINS[key];
}

export function chainKeyById(chainId: number): ChainKey | null {
  for (const key of CHAIN_KEYS) if (CHAINS[key].id === chainId) return key;
  return null;
}

const DISPLAY: Record<ChainKey, string> = { robinhood: "Robinhood", base: "Base", arc: "Arc" };

export function chainDisplayName(key: ChainKey): string {
  return DISPLAY[key];
}

/** The gas asset of a chain as people write it: "ETH" on Robinhood and Base, "USDC" on Arc. */
export function nativeSymbol(key: ChainKey): string {
  return CHAINS[key].nativeCurrency.symbol;
}

function rpcOverride(key: ChainKey): string | undefined {
  const e = env();
  return key === "robinhood" ? e.RPC_ROBINHOOD : key === "base" ? e.RPC_BASE : e.RPC_ARC;
}

/** RPC URLs in priority order: explicit env override, else the public list. */
export function rpcUrls(key: ChainKey): string[] {
  const override = rpcOverride(key);
  return override ? [override] : [...PUBLIC_RPCS[key]];
}

/**
 * Whether the chain can be reached at all: the ETH chains always have public
 * endpoints to fall back on; Arc only counts once RPC_ARC is set, so a
 * deployment without it neither offers Arc launches nor polls it for balances.
 */
export function rpcConfigured(key: ChainKey): boolean {
  return key === "arc" ? Boolean(rpcOverride(key)) : true;
}

const clients = new Map<ChainKey, PublicClient>();

export function publicClient(key: ChainKey): PublicClient {
  const existing = clients.get(key);
  if (existing) return existing;
  const transports = rpcUrls(key).map((url) => http(url, { timeout: 15_000 }));
  const client = createPublicClient({ chain: CHAINS[key], transport: fallback(transports, { rank: false }) });
  clients.set(key, client);
  return client;
}

/**
 * Client for historical `eth_getLogs` scans (indexer). INDEXER_RPC, then
 * RPC_ROBINHOOD, else the public list with ordofi first: publicnode refuses
 * archive log ranges, ordofi serves them.
 */
export function logsClient(key: ChainKey): PublicClient {
  const e = env();
  // INDEXER_RPC is the Robinhood archive endpoint; Base and Arc use their own RPC_* or the public list.
  const override = key === "robinhood" ? (e.INDEXER_RPC ?? e.RPC_ROBINHOOD) : key === "base" ? e.RPC_BASE : e.RPC_ARC;
  const ordofi = "https://rpc.ordofi.network";
  const urls = override ? [override] : key === "robinhood" ? [ordofi, ...PUBLIC_RPCS[key].filter((u) => u !== ordofi)] : [...PUBLIC_RPCS[key]];
  return createPublicClient({ chain: CHAINS[key], transport: fallback(urls.map((u) => http(u, { timeout: 30_000 })), { rank: false }) });
}
