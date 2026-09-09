import { type Hex } from "viem";
import { bridgeChainByKey, bridgeClient, bridgeRpcUrls, buildBridgeAllowlist, logger, type BridgeChainKey } from "@o1bot/shared";
import type { BridgeChain, BridgePlan } from "./bridge-core";
import { ExecutionError, walletClientOn, type AuditSink, type WalletRef } from "./execute";

/**
 * The origin-chain side of a bridge: balance and fee reads on Base,
 * Ethereum, Arbitrum or Optimism, and the signing of Relay's deposit through
 * the guarded wallet. The allow-list built here admits exactly one call: the
 * pinned depository, `depositNative(wallet, requestId)`, this value.
 */

const RECEIPT_TIMEOUT_MS = 180_000;
/** Same headroom as elsewhere: origin chains refund the unused part of the cap. */
const FEE_CAP_PCT = 150n;

export function liveBridgeChain(): BridgeChain {
  return {
    balance: (key, wallet) => bridgeClient(key).getBalance({ address: wallet }),

    async fees(key) {
      const client = bridgeClient(key);
      let maxFeePerGas: bigint;
      let maxPriorityFeePerGas = 0n;
      try {
        const f = await client.estimateFeesPerGas();
        maxPriorityFeePerGas = f.maxPriorityFeePerGas ?? 0n;
        maxFeePerGas = f.maxFeePerGas ?? (await client.getGasPrice());
      } catch {
        maxFeePerGas = await client.getGasPrice();
      }
      return { maxFeePerGas: (maxFeePerGas * FEE_CAP_PCT) / 100n, maxPriorityFeePerGas };
    },

    async deposit(plan, wallet, audit) {
      return sendDeposit(plan, wallet, audit);
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function sendDeposit(plan: BridgePlan, wallet: WalletRef, audit: AuditSink): Promise<{ txHash: Hex }> {
  const key: BridgeChainKey = plan.originKey;
  const allowlist = buildBridgeAllowlist({ chainId: plan.chainId, depository: plan.to, wallet: plan.wallet, depositId: plan.depositId, amountWei: plan.value });
  const walletClient = await walletClientOn(wallet, allowlist, audit, bridgeChainByKey(key), bridgeRpcUrls(key));
  let txHash: Hex;
  try {
    txHash = await walletClient.sendTransaction({ to: plan.to, data: plan.data, value: plan.value, gas: plan.gas, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas });
  } catch (err) {
    throw new ExecutionError(`relay deposit broadcast failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
  }
  logger.info({ txHash, wallet: wallet.address, chain: key, value: plan.value.toString(), requestId: plan.requestId }, "relay deposit broadcast");
  const receipt = await bridgeClient(key).waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new ExecutionError("relay deposit reverted on chain", txHash);
  return { txHash };
}

/** Stand-in for dry runs: a funded wallet, cheap gas, no signing. */
export function dryRunBridgeChain(): BridgeChain {
  return {
    async balance() {
      return 10n ** 18n;
    },
    async fees() {
      return { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
    },
    async deposit() {
      throw new Error("dry run: deposits are never signed");
    },
    sleep: async () => undefined,
  };
}
