import { createPublicClient, fallback, getAddress, http, type Address, type Chain, type PublicClient } from "viem";
import { arbitrum, base, mainnet, optimism } from "viem/chains";
import { env } from "./env";

/**
 * Chains a user can bridge ETH from into their Robinhood wallet. A Privy
 * embedded wallet has the same address on every EVM chain, so the bot signs
 * the Relay deposit on the origin chain from the user's own wallet and the
 * ETH lands at the same address on Robinhood. Robinhood itself stays the only
 * chain launches and trades run on (`ChainKey`); these are origins only.
 */

export const BRIDGE_CHAIN_KEYS = ["base", "ethereum", "arbitrum", "optimism"] as const;
export type BridgeChainKey = (typeof BRIDGE_CHAIN_KEYS)[number];

export const BRIDGE_CHAINS: Record<BridgeChainKey, Chain> = { base, ethereum: mainnet, arbitrum, optimism };

const DISPLAY: Record<BridgeChainKey, string> = { base: "Base", ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism" };

const PUBLIC_RPCS: Record<BridgeChainKey, readonly string[]> = {
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  optimism: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
};

/**
 * Relay's depository: the contract every deposit quote points at, the same
 * CREATE2 address on Base, Ethereum, Arbitrum and Optimism (checked against
 * live quotes on 2026-09-09). Signing is refused to any other address, so a
 * changed quote fails closed until this constant is updated on purpose.
 */
export const RELAY_DEPOSITORY: Address = getAddress("0x4cd00e387622c35bddb9b4c962c136462338bc31");

export function isBridgeChainKey(value: string): value is BridgeChainKey {
  return (BRIDGE_CHAIN_KEYS as readonly string[]).includes(value);
}

export function bridgeChainByKey(key: BridgeChainKey): Chain {
  return BRIDGE_CHAINS[key];
}

export function bridgeChainDisplayName(key: BridgeChainKey): string {
  return DISPLAY[key];
}

export function bridgeChainKeyById(chainId: number): BridgeChainKey | null {
  for (const key of BRIDGE_CHAIN_KEYS) if (BRIDGE_CHAINS[key].id === chainId) return key;
  return null;
}

/** RPC URLs in priority order: explicit env override, else the public list. */
export function bridgeRpcUrls(key: BridgeChainKey): string[] {
  const e = env();
  const override = { base: e.RPC_BASE, ethereum: e.RPC_ETHEREUM, arbitrum: e.RPC_ARBITRUM, optimism: e.RPC_OPTIMISM }[key];
  return override ? [override] : [...PUBLIC_RPCS[key]];
}

const clients = new Map<BridgeChainKey, PublicClient>();

export function bridgeClient(key: BridgeChainKey): PublicClient {
  const existing = clients.get(key);
  if (existing) return existing;
  const client = createPublicClient({ chain: BRIDGE_CHAINS[key], transport: fallback(bridgeRpcUrls(key).map((url) => http(url, { timeout: 15_000 })), { rank: false }) });
  clients.set(key, client);
  return client;
}
