import { createWalletClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainByKey, chainKeyById, env, feeSplitterAbi, feeSplitterFactory, feeSplitterFactoryAbi, logger, publicClient, rpcUrls, type FeeSplitConfig } from "@o1bot/shared";

/**
 * The bot's side of the fee splitter: predict the clone a launch will use as
 * o1's creator fee recipient (a read on the factory), and deploy that clone
 * afterwards from o1bot's gas wallet. Both are per chain and both are absent
 * where no factory is configured, in which case launches keep the creator's
 * wallet as the recipient.
 */

export type FeeSplitterOps = {
  /** The clone address and the platform share it is registered with; null when the chain has no factory. */
  predict(input: { chainId: number; token: Address; recipients: Address[]; shares: number[] }): Promise<{ splitter: Address; platformBps: number } | null>;
  /**
   * Deploy the clone (idempotent on chain). Returns the transaction hash, or null when no gas wallet is
   * configured or the clone already exists; a failure is logged and returns null, the first claim registers it.
   */
  register(input: { chainId: number; token: Address } & FeeSplitConfig): Promise<Hex | null>;
};

/** Stand-in for tests and chains without a factory. */
export const noFeeSplitter: FeeSplitterOps = { predict: async () => null, register: async () => null };

const RECEIPT_TIMEOUT_MS = 120_000;

export function liveFeeSplitter(): FeeSplitterOps {
  return {
    async predict(input) {
      const key = chainKeyById(input.chainId);
      const factory = key ? feeSplitterFactory(key) : null;
      if (!key || !factory) return null;
      const client = publicClient(key);
      const platformBps = await client.readContract({ address: factory, abi: feeSplitterFactoryAbi, functionName: "platformBps" });
      const splitter = await client.readContract({
        address: factory,
        abi: feeSplitterFactoryAbi,
        functionName: "predict",
        args: [getAddress(input.token), input.recipients.map((r) => getAddress(r)), input.shares, platformBps],
      });
      return { splitter: getAddress(splitter), platformBps };
    },

    async register(input) {
      const key = chainKeyById(input.chainId);
      const factory = key ? feeSplitterFactory(key) : null;
      const gasKey = env().FEE_SPLITTER_GAS_KEY;
      if (!key || !factory || !gasKey) return null;
      const client = publicClient(key);
      const args = [getAddress(input.token), input.recipients.map((r) => getAddress(r)), input.shares, input.platformBps] as const;
      try {
        const predicted = await client.readContract({ address: factory, abi: feeSplitterFactoryAbi, functionName: "predict", args });
        if (await client.getCode({ address: predicted }).then((c) => Boolean(c && c !== "0x"))) return null;
        const account = privateKeyToAccount(gasKey as Hex);
        // registerWith pins the platform share the launch was announced with, whatever the factory says now.
        const { request } = await client.simulateContract({ address: factory, abi: feeSplitterFactoryAbi, functionName: "registerWith", args, account });
        const wallet = createWalletClient({ account, chain: chainByKey(key), transport: http(rpcUrls(key)[0]) });
        const hash = await wallet.writeContract(request);
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        if (receipt.status !== "success") throw new Error(`register reverted on chain: ${hash}`);
        logger.info({ chain: key, token: input.token, splitter: predicted, hash }, "fee splitter registered");
        return hash;
      } catch (err) {
        logger.error({ chain: key, token: input.token, err: err instanceof Error ? err.message : String(err) }, "fee splitter register failed; the first claim will deploy it");
        return null;
      }
    },
  };
}

/** What a splitter holds for a currency right now: owed in o1's escrow plus anything already pulled. */
export async function splitterClaimable(chainId: number, splitter: Address, currency: Address): Promise<bigint> {
  const key = chainKeyById(chainId);
  if (!key) return 0n;
  return publicClient(key).readContract({ address: splitter, abi: feeSplitterAbi, functionName: "claimable", args: [currency] });
}
