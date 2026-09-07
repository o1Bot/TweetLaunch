import { formatEther, type Address } from "viem";
import { CHAIN_KEYS, logger, publicClient, type ChainKey } from "@o1bot/shared";

export async function nativeBalance(key: ChainKey, address: Address): Promise<bigint> {
  return publicClient(key).getBalance({ address });
}

export type ChainBalance = { chain: ChainKey; wei: string | null; eth: string | null; error: string | null };

/** Native balance on every supported chain. An RPC failure yields null, never a throw. */
export async function balancesAllChains(address: Address): Promise<ChainBalance[]> {
  return Promise.all(
    CHAIN_KEYS.map(async (chain) => {
      try {
        const wei = await nativeBalance(chain, address);
        return { chain, wei: wei.toString(), eth: formatEther(wei), error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ chain, address, err: message }, "balance read failed");
        return { chain, wei: null, eth: null, error: message };
      }
    }),
  );
}
