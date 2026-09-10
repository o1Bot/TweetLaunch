/**
 * The launch chains as the web app names them. Kept free of `@o1bot/shared`
 * so client components can import it; the ids and explorers are fixed
 * facts about the two chains, not configuration.
 */

export type ChainKey = "robinhood" | "base";

export const CHAIN_KEYS: readonly ChainKey[] = ["robinhood", "base"];
export const DEFAULT_CHAIN: ChainKey = "robinhood";

export const CHAIN_IDS: Record<ChainKey, number> = { robinhood: 4663, base: 8453 };
export const CHAIN_LABEL: Record<ChainKey, string> = { robinhood: "Robinhood Chain", base: "Base" };
export const CHAIN_SHORT: Record<ChainKey, string> = { robinhood: "Robinhood", base: "Base" };

/** Block explorer for addresses and tokens. */
export const EXPLORER: Record<ChainKey, string> = { robinhood: "https://robinhoodchain.blockscout.com", base: "https://basescan.org" };
/** Transaction links: the founder's pick on Robinhood, Basescan on Base. */
export const TX_EXPLORER: Record<ChainKey, string> = { robinhood: "https://rh-scan.com/tx", base: "https://basescan.org/tx" };

/** The cookie that remembers the chain the visitor last picked on the board. */
export const CHAIN_COOKIE = "o1bot-chain";

export function isChainKey(value: unknown): value is ChainKey {
  return value === "robinhood" || value === "base";
}

/** Chain key for a chain id; unknown ids fall back to Robinhood. */
export function chainKeyOf(chainId: number): ChainKey {
  return chainId === CHAIN_IDS.base ? "base" : "robinhood";
}

export function o1TokenUrl(token: string, chain: ChainKey): string {
  return `https://launch.o1.exchange/token/${token.toLowerCase()}?chain=${CHAIN_IDS[chain]}`;
}
