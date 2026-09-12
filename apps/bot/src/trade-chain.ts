import { erc20Abi, getAddress, isAddress, maxUint256, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { launchHookAbi, quoteUsd } from "@o1bot/executor";
import { activeFactory, activeFeeEscrow, buildAllowlist, env, logger, o1Chain, publicClient, universalRouterOf } from "@o1bot/shared";
import { encodeExactInputSwap, permit2Abi, v4QuoterAbi } from "@o1bot/swap";
import { ExecutionError, walletClientFor, type AuditSink, type WalletRef } from "./execute";
import type { PoolConfig, TradeChain, TradePlan } from "./trade-core";

/**
 * The chain side of a trade from a post: hook state, balances, quotes, USD
 * prices, fee levels, and the signing of the swap (plus the approvals an
 * ERC-20 input needs) through the guarded wallet. The allow-list built here
 * opens the router, Permit2 and the assets of this one trade, for this trade
 * only.
 */

const KEY = "robinhood" as const;
const RECEIPT_TIMEOUT_MS = 180_000;
const MAX_UINT160 = (1n << 160n) - 1n;
/** Permit2 allowance lifetime for the router; renewed by the next trade after it lapses. */
const PERMIT2_EXPIRATION_SECONDS = 30 * 24 * 3600;
/** Same headroom as the launch plan: only the base fee is charged, the rest of the cap is refunded. */
const FEE_CAP_PCT = 150n;

export function liveTradeChain(opts: { client?: PublicClient } = {}): TradeChain {
  const client = opts.client ?? publicClient(KEY);
  const chain = o1Chain(KEY);
  const { router, permit2 } = universalRouterOf(KEY);
  const quoter = getAddress(chain.uniswapV4.quoter);
  const referrerEnv = env().REFERRER_ADDRESS;
  const referrer = referrerEnv && isAddress(referrerEnv) ? getAddress(referrerEnv) : null;

  const balanceOf = (wallet: Address, asset: Address) => (asset === zeroAddress ? client.getBalance({ address: wallet }) : client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }));

  return {
    addresses: () => ({ router, permit2, referrer }),

    async poolConfig(pool): Promise<PoolConfig> {
      const config = await client.readContract({ address: pool.hook, abi: launchHookAbi, functionName: "poolConfig", args: [pool.poolId] });
      const [initialized, , currentCreator, creatorFeeRecipient, baseFeeBps, antiSnipeStartTotalBps, antiSnipeWindowSeconds, launchTime] = config;
      return {
        initialized,
        currentCreator: getAddress(currentCreator),
        creatorFeeRecipient: getAddress(creatorFeeRecipient),
        baseFeeBps: Number(baseFeeBps),
        antiSnipeStartTotalBps: Number(antiSnipeStartTotalBps),
        antiSnipeWindowSeconds: Number(antiSnipeWindowSeconds),
        launchTime: Number(launchTime),
      };
    },

    async balances(wallet, token, quote) {
      const [eth, tokenBalance, quoteBalance] = await Promise.all([client.getBalance({ address: wallet }), balanceOf(wallet, token), quote === zeroAddress ? null : balanceOf(wallet, quote)]);
      return { eth, token: tokenBalance, quote: quoteBalance ?? eth };
    },

    async approvals(wallet, asset) {
      const [erc20Allowance, permit2Allowance] = await Promise.all([
        client.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [wallet, permit2] }),
        client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [wallet, asset, router] }),
      ]);
      const [p2Amount, p2Expiration] = permit2Allowance;
      const now = Math.floor(Date.now() / 1000);
      return { erc20: erc20Allowance < MAX_UINT160 / 2n, permit2: p2Amount < MAX_UINT160 / 2n || Number(p2Expiration) <= now + 120 };
    },

    async quote(input) {
      const { result } = await client.simulateContract({
        address: quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: input.poolKey, zeroForOne: input.zeroForOne, exactAmount: input.amountIn, hookData: input.hookData }],
      });
      return result[0];
    },

    usdPrice: (asset, decimals) => quoteUsd(asset, decimals),

    async fees() {
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

    async execute(plan, wallet, audit) {
      return executeTrade(plan, wallet, audit, client);
    },
  };
}

/** Approvals for the ERC-20 the router will pull (if any), then the swap; the output is measured as the wallet's balance change. */
export async function executeTrade(plan: TradePlan, wallet: WalletRef, audit: AuditSink, client: PublicClient): Promise<{ txHash: Hex; amountOut: bigint }> {
  const allowlist = buildAllowlist({
    chainId: plan.chainId,
    factory: activeFactory(KEY),
    feeEscrow: activeFeeEscrow(KEY),
    trade: { router: plan.router, permit2: plan.permit2, hook: plan.hook, referrer: plan.referrer, maxValueWei: plan.maxValueWei, pools: [plan.pool] },
  });
  const walletClient = await walletClientFor(wallet, allowlist, audit);
  const fees = { maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas } as const;

  const asset = plan.approvalAsset;
  if (asset && plan.approvals.erc20) {
    let hash: Hex;
    try {
      hash = await walletClient.writeContract({ address: asset, abi: erc20Abi, functionName: "approve", args: [plan.permit2, maxUint256], ...fees });
    } catch (err) {
      throw new ExecutionError(`token approval failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
    }
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new ExecutionError("token approval reverted", hash);
    logger.info({ hash, asset, wallet: wallet.address }, "asset approved to Permit2");
  }
  if (asset && plan.approvals.permit2) {
    const expiration = Math.floor(Date.now() / 1000) + PERMIT2_EXPIRATION_SECONDS;
    let hash: Hex;
    try {
      hash = await walletClient.writeContract({ address: plan.permit2, abi: permit2Abi, functionName: "approve", args: [asset, plan.router, MAX_UINT160, expiration], ...fees });
    } catch (err) {
      throw new ExecutionError(`Permit2 approval failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
    }
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new ExecutionError("Permit2 approval reverted", hash);
    logger.info({ hash, asset, wallet: wallet.address }, "router allowed through Permit2");
  }

  const currencyOut = plan.zeroForOne ? plan.poolKey.currency1 : plan.poolKey.currency0;
  const readOut = () => (currencyOut === zeroAddress ? client.getBalance({ address: wallet.address }) : client.readContract({ address: currencyOut, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }));
  const before = await readOut();

  const enc = encodeExactInputSwap({ router: plan.router, poolKey: plan.poolKey, zeroForOne: plan.zeroForOne, amountIn: plan.amountIn, minAmountOut: plan.minAmountOut, hookData: plan.hookData, deadline: plan.deadline });
  let txHash: Hex;
  try {
    txHash = await walletClient.sendTransaction({ to: enc.to, data: enc.data, value: enc.value, gas: plan.gas, ...fees });
  } catch (err) {
    throw new ExecutionError(`swap broadcast failed: ${err instanceof Error ? err.message : String(err)}`, null, err);
  }
  logger.info({ txHash, wallet: wallet.address, side: plan.side, token: plan.pool.token, amountIn: plan.amountIn.toString() }, "swap broadcast");
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new ExecutionError("swap reverted on chain", txHash);

  const after = await readOut();
  // Selling into ETH pays gas from the same ETH the sale brings in; add it back so the reply shows what the pool paid.
  const gasPaid = currencyOut === zeroAddress ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
  const amountOut = after - before + gasPaid;
  return { txHash, amountOut: amountOut > 0n ? amountOut : plan.minAmountOut };
}

/** Stand-in for dry runs without a chain: fixed prices, a generous wallet, no signing. */
export function dryRunTradeChain(): TradeChain {
  const chain = o1Chain(KEY);
  return {
    addresses: () => ({ ...universalRouterOf(KEY), referrer: null }),
    async poolConfig() {
      return { initialized: true, currentCreator: zeroAddress, creatorFeeRecipient: zeroAddress, baseFeeBps: 100, antiSnipeStartTotalBps: 9900, antiSnipeWindowSeconds: 20, launchTime: 0 };
    },
    async balances() {
      return { eth: 10n ** 18n, token: 10n ** 24n, quote: 10n ** 24n };
    },
    async approvals() {
      return { erc20: true, permit2: true };
    },
    async quote(input) {
      return input.amountIn * 1000n;
    },
    async usdPrice(asset) {
      return asset === zeroAddress ? 2500 : 1;
    },
    async fees() {
      return { maxFeePerGas: 500_000_000n, maxPriorityFeePerGas: 0n };
    },
    async execute() {
      throw new Error("dry run: trades are never signed");
    },
  };
}
