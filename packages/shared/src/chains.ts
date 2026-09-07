import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { robinhood } from "viem/chains";
import { env } from "./env";

/**
 * v1 targets Robinhood Chain only (decided 2026-09-07). The key/record shape
 * is kept so a second chain can be added without touching call sites.
 */
export const CHAIN_KEYS = ["robinhood"] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];

export const CHAINS: Record<ChainKey, Chain> = { robinhood };

/**
 * Public RPCs tried in order when RPC_ROBINHOOD is unset. The chain's own
 * endpoint is last: some ISPs intercept its TLS. Use a paid RPC in production.
 */
export const PUBLIC_RPCS: Record<ChainKey, readonly string[]> = {
  robinhood: [
    "https://robinhood-rpc.publicnode.com",
    "https://rpc.ordofi.network",
    "https://rpc.mainnet.chain.robinhood.com",
  ],
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

export function chainDisplayName(key: ChainKey): string {
  return key === "robinhood" ? "Robinhood" : key;
}

/** RPC URLs in priority order: explicit env override, else the public list. */
export function rpcUrls(key: ChainKey): string[] {
  const override = key === "robinhood" ? env().RPC_ROBINHOOD : undefined;
  return override ? [override] : [...PUBLIC_RPCS[key]];
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
