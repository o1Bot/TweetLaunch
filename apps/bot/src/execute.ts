import { createWalletClient, fallback, getAddress, http, parseEventLogs, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { factoryAbiFor, type LaunchPlan } from "@o1bot/executor";
import { activeFeeEscrow, buildAllowlist, chainByKey, chainKeyById, DEFAULT_CHAIN_KEY, logger, publicClient, rpcUrls, type ChainKey, type TxAllowlist } from "@o1bot/shared";
import { guardedAccount, type SignAudit } from "@o1bot/wallet";

/**
 * The only place in the bot that signs and broadcasts. A plan from
 * `planLaunch` is executed verbatim through the user's Privy wallet, wrapped
 * in the allow-list guard so nothing but the launch call (or the fee
 * recipient update) can ever be signed. Every signature is audited before it
 * happens.
 */

export type WalletRef = { walletId: string; address: Address };
export type AuditSink = (record: SignAudit) => Promise<void>;

export type ExecutionResult = {
  txHash: Hex;
  token: Address;
  poolId: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
};

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly txHash: Hex | null,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

const RECEIPT_TIMEOUT_MS = 180_000;
/** The launch chain behind a chain id; anything unknown is treated as Robinhood and fails the allow-list there. */
const keyOf = (chainId: number): ChainKey => chainKeyById(chainId) ?? DEFAULT_CHAIN_KEY;

/** The user's wallet behind the allow-list guard on any chain; every signature goes through `audit` first. */
export async function walletClientOn(wallet: WalletRef, allowlist: TxAllowlist, audit: AuditSink, chain: Chain, urls: string[]) {
  const account = await guardedAccount({ walletId: wallet.walletId, address: wallet.address, allowlist, audit });
  return createWalletClient({ account, chain, transport: fallback(urls.map((u) => http(u, { timeout: 20_000 })), { rank: false }) });
}

/** The same, on Robinhood. */
export function walletClientFor(wallet: WalletRef, allowlist: TxAllowlist, audit: AuditSink) {
  return walletClientOn(wallet, allowlist, audit, chainByKey(DEFAULT_CHAIN_KEY), rpcUrls(DEFAULT_CHAIN_KEY));
}

/** The wallet on the launch chain the plan was built for, allowed to touch that chain's factory and escrow only. */
async function walletFor(wallet: WalletRef, factory: Address, chainId: number, audit: AuditSink) {
  const key = keyOf(chainId);
  return walletClientOn(wallet, buildAllowlist({ chainId, factory, feeEscrow: activeFeeEscrow(key) }), audit, chainByKey(key), rpcUrls(key));
}

export async function executeLaunchPlan(plan: LaunchPlan, wallet: WalletRef, audit: AuditSink, opts: { client?: PublicClient } = {}): Promise<ExecutionResult> {
  const key = keyOf(plan.chainId);
  const client = opts.client ?? publicClient(key);
  const abi = factoryAbiFor(key);
  const walletClient = await walletFor(wallet, plan.factory, plan.chainId, audit);
  // Gas limit and fee cap come from the plan, so the transaction can never
  // cost more than what the funding check verified against the balance.
  const common = {
    address: plan.factory,
    abi,
    value: plan.call.value,
    gas: plan.simulation.gas,
    maxFeePerGas: plan.funding.maxFeePerGas,
    maxPriorityFeePerGas: plan.funding.maxPriorityFeePerGas,
  } as const;

  let txHash: Hex;
  try {
    txHash =
      plan.call.functionName === "createLaunch"
        ? await walletClient.writeContract({ ...common, functionName: "createLaunch", args: plan.call.args })
        : await walletClient.writeContract({ ...common, functionName: "createLaunchAndBuy", args: plan.call.args });
  } catch (err) {
    throw new ExecutionError(`broadcast failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
  }
  logger.info({ txHash, wallet: wallet.address, fn: plan.call.functionName, token: plan.salt.token }, "launch broadcast");

  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new ExecutionError("launch transaction reverted on chain", txHash);

  const launched = parseEventLogs({ abi, eventName: "Launched", logs: receipt.logs }).find((l) => getAddress(l.address) === getAddress(plan.factory));
  if (!launched) throw new ExecutionError("launch confirmed but no Launched event was found in the receipt", txHash);
  const token = getAddress(launched.args.token);
  if (token !== plan.salt.token) {
    logger.error({ txHash, predicted: plan.salt.token, actual: token }, "deployed token differs from the predicted address");
  }
  return { txHash, token, poolId: launched.args.poolId, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}

/** Second transaction for `fees to @b`: point the creator fee share at the recipient's wallet. */
export async function setCreatorFeeRecipient(
  input: { factory: Address; chainId: number; token: Address; recipient: Address },
  wallet: WalletRef,
  audit: AuditSink,
  opts: { client?: PublicClient } = {},
): Promise<Hex> {
  const key = keyOf(input.chainId);
  const client = opts.client ?? publicClient(key);
  const abi = factoryAbiFor(key);
  const args = [getAddress(input.token), getAddress(input.recipient)] as const;
  // Simulate first so a revert (wrong creator, unknown token) never costs gas.
  await client.simulateContract({ address: input.factory, abi, functionName: "setCreatorFeeRecipient", args, account: wallet.address });
  const walletClient = await walletFor(wallet, input.factory, input.chainId, audit);
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({ address: input.factory, abi, functionName: "setCreatorFeeRecipient", args });
  } catch (err) {
    throw new ExecutionError(`fee recipient broadcast failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
  }
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new ExecutionError("setCreatorFeeRecipient reverted on chain", txHash);
  logger.info({ txHash, token: input.token, recipient: input.recipient }, "creator fee recipient set");
  return txHash;
}
