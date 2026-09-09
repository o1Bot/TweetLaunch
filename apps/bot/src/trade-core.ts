import { formatEther, formatUnits, getAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";
import type { TradeCommand } from "@o1bot/parser";
import { antiSnipeFeeBps, applySlippage, encodeHookData, launchPoolKey, type PoolKey } from "@o1bot/swap";
import type { BotConfig } from "./config";
import { ExecutionError, type AuditSink, type WalletRef } from "./execute";
import { formatEthCeil, replies, tokenPageUrl } from "./replies";
import type { BotStore, TradableToken } from "./store";
import { checkRate, startOfUtcDay } from "./validator";

/**
 * A buy or sell asked for in a post, from the poster's own wallet, on a pool
 * the bot launched. The command names a side, a token and an amount; nothing
 * else in the post can influence what is signed. The output of the swap
 * always goes to the signing wallet (TAKE_ALL pays msg.sender), the router
 * call is decoded and pinned by the signer allow-list, and Privy's policy
 * bounds the value. Everything chain-facing goes through `TradeChain`, so
 * the flow runs in tests with a fake.
 */

export const CHAIN_ID = 4663;
/** Gas limits for the swap and for each approval a sell may need; generous, only the base fee is charged. */
export const SWAP_GAS = 450_000n;
export const APPROVAL_GAS = 80_000n;
const DEADLINE_SECONDS = 180;

export type PoolConfig = {
  currentCreator: Address;
  creatorFeeRecipient: Address;
  baseFeeBps: number;
  antiSnipeStartTotalBps: number;
  antiSnipeWindowSeconds: number;
  launchTime: number;
};

export type TradePlan = {
  chainId: number;
  router: Address;
  permit2: Address;
  hook: Address;
  /** Referrer carried in the hook data; null when the hook would reject it (creator or fee recipient). */
  referrer: Address | null;
  pool: { token: Address; quote: Address; tickSpacing: number; poolId: Hex };
  side: "buy" | "sell";
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  expectedOut: bigint;
  minAmountOut: bigint;
  hookData: Hex;
  deadline: bigint;
  /** Native value the router call carries (a buy's ETH) and the cap the allow-list enforces on it. */
  value: bigint;
  maxValueWei: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Approvals a sell still needs before the swap. */
  approvals: { erc20: boolean; permit2: boolean };
};

export type TradeChain = {
  addresses(): { router: Address; permit2: Address; referrer: Address | null };
  poolConfig(pool: { poolId: Hex; hook: Address }): Promise<PoolConfig>;
  balances(wallet: Address, token: Address): Promise<{ eth: bigint; token: bigint }>;
  /** Which approvals a sell of `token` from `wallet` still needs. */
  approvals(wallet: Address, token: Address): Promise<{ erc20: boolean; permit2: boolean }>;
  quote(input: { poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; hookData: Hex }): Promise<bigint>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  execute(plan: TradePlan, wallet: WalletRef, audit: AuditSink): Promise<{ txHash: Hex; amountOut: bigint }>;
};

export type TradeCoreInput = {
  mentionId: string;
  tweetId: string;
  userId: string;
  xUserId: string;
  handle: string;
  wallet: WalletRef;
  cmd: TradeCommand;
};

export type TradeCoreDeps = { store: BotStore; config: BotConfig; trade: TradeChain; now: () => Date };

export type TradeCoreResult =
  | { ok: false; outcome: "rejected"; error: string; userText: string }
  | { ok: false; outcome: "failed"; error: string; userText: string; tradeId: string | null }
  | { ok: true; dryRun: true; tradeId: string; userText: string }
  | { ok: true; dryRun: false; tradeId: string; txHash: Hex; userText: string; safeText: string };

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Human amount for a reply: whole tokens with separators above 1000, else up to 4 decimals; ETH up to 5 decimals. */
export function humanAmount(raw: bigint, decimals: number, kind: "eth" | "token"): string {
  const n = Number(formatUnits(raw, decimals));
  if (kind === "token" && n >= 1000) return Math.round(n).toLocaleString("en-US");
  const max = kind === "eth" ? 5 : 4;
  const s = n.toLocaleString("en-US", { maximumFractionDigits: max });
  return s === "0" && raw > 0n ? `<0.${"0".repeat(max - 1)}1` : s;
}

/** Which portion of a holding a sell command asks for, in raw units. */
export function sellAmount(balance: bigint, portion: TradeCommand["sellPortion"]): bigint {
  if (!portion) return 0n;
  if (portion.kind === "all") return balance;
  const bps = BigInt(Math.round(portion.value * 100));
  return (balance * bps) / 10_000n;
}

export async function runTrade(input: TradeCoreInput, deps: TradeCoreDeps, log: Logger): Promise<TradeCoreResult> {
  const { store, config, trade } = deps;
  const { cmd, wallet } = input;
  const siteUrl = config.siteUrl;
  const rejected = (error: string, userText: string): TradeCoreResult => ({ ok: false, outcome: "rejected", error, userText });
  const label = cmd.ticker ?? (cmd.tokenAddress ? `${cmd.tokenAddress.slice(0, 6)}…` : "?");

  // 1. Opt-in and the user's own cap.
  const settings = await store.tradingSettings(input.xUserId);
  if (!settings?.enabled) return rejected("trading not enabled", replies.tradeDisabled(siteUrl));
  const capWei = settings.maxTradeWei !== null && settings.maxTradeWei > 0n ? (settings.maxTradeWei < config.maxTradeWei ? settings.maxTradeWei : config.maxTradeWei) : config.defaultUserTradeCapWei < config.maxTradeWei ? config.defaultUserTradeCapWei : config.maxTradeWei;

  // 2. The token: only pools the bot launched, one match, ETH-paired.
  const matches = await store.findTradableTokens(cmd.tokenAddress ? { address: cmd.tokenAddress } : { ticker: cmd.ticker });
  if (matches.length === 0) return rejected(`unknown token ${label}`, replies.tradeUnknownToken(label, siteUrl));
  if (matches.length > 1) {
    return rejected(`ambiguous ticker ${label} (${matches.length} pools)`, replies.tradeAmbiguous(label, matches.slice(0, 2).map((m) => tokenPageUrl(siteUrl, m.token))));
  }
  const pool: TradableToken = matches[0]!;
  const ticker = pool.symbol.toUpperCase();
  if (getAddress(pool.quoteAddress) !== zeroAddress) return rejected(`not an ETH pool: ${ticker}`, replies.tradeNotEthPool(ticker, siteUrl));
  const token = getAddress(pool.token);

  // 3. Rate limits, before anything touches the chain.
  const now = deps.now();
  const rate = checkRate({
    lastLaunchAt: await store.lastTradeAt(input.xUserId),
    launchesToday: await store.tradeCountSince(input.xUserId, startOfUtcDay(now)),
    now,
    cooldownSeconds: config.tradeCooldownSeconds,
    maxPerDay: config.maxTradesPerDay,
  });
  if (!rate.ok) return rejected(`rate limit: ${rate.reason}`, rate.reason === "cooldown" ? replies.tradeSlowDown(rate.retryAfterSeconds) : replies.tradeDailyCap());

  // 4. Pool state: anti-snipe window (buys) and whether the hook accepts our referrer.
  const addresses = trade.addresses();
  let poolConfig: PoolConfig;
  try {
    poolConfig = await trade.poolConfig({ poolId: pool.poolId as Hex, hook: getAddress(pool.hook) });
  } catch (err) {
    return { ok: false, outcome: "failed", error: `pool config: ${errMessage(err)}`, userText: replies.tradeFailed("the chain RPC did not respond"), tradeId: null };
  }
  const antiSnipe = antiSnipeFeeBps(Math.floor(now.getTime() / 1000), poolConfig.launchTime, poolConfig.antiSnipeWindowSeconds, poolConfig.antiSnipeStartTotalBps, poolConfig.baseFeeBps);
  if (cmd.side === "buy" && antiSnipe.active) return rejected(`anti-snipe active (${antiSnipe.secondsLeft}s)`, replies.tradeAntiSnipe(ticker, antiSnipe.secondsLeft));
  const referrer = addresses.referrer && addresses.referrer !== getAddress(poolConfig.currentCreator) && addresses.referrer !== getAddress(poolConfig.creatorFeeRecipient) ? addresses.referrer : null;
  const hookData = encodeHookData(referrer);

  // 5. Amounts from the wallet's real balances.
  const balances = await trade.balances(wallet.address, token);
  let amountIn: bigint;
  if (cmd.side === "buy") {
    try {
      amountIn = parseEther(cmd.amountEth ?? "0");
    } catch {
      return rejected(`bad amount ${cmd.amountEth}`, replies.tradeFailed("the ETH amount could not be read"));
    }
    if (amountIn <= 0n) return rejected("zero amount", replies.tradeFailed("the ETH amount is zero"));
    if (amountIn > capWei) return rejected(`above cap: ${amountIn} > ${capWei}`, replies.tradeTooLarge(formatEther(capWei), siteUrl));
  } else {
    amountIn = sellAmount(balances.token, cmd.sellPortion);
    if (amountIn <= 0n) return rejected("nothing to sell", replies.tradeNothingToSell(ticker));
  }
  const approvals = cmd.side === "sell" ? await trade.approvals(wallet.address, token) : { erc20: false, permit2: false };

  // 6. Quote and the swap itself.
  const poolKey = launchPoolKey(token, zeroAddress, pool.tickSpacing, getAddress(pool.hook));
  const tokenIsCurrency0 = poolKey.currency0 === token;
  const zeroForOne = cmd.side === "buy" ? !tokenIsCurrency0 : tokenIsCurrency0;
  let expectedOut: bigint;
  try {
    expectedOut = await trade.quote({ poolKey, zeroForOne, amountIn, hookData });
  } catch (err) {
    log.warn({ err: errMessage(err), token }, "quote failed");
    return rejected(`quote failed: ${errMessage(err)}`, replies.tradeNoQuote(ticker));
  }
  if (expectedOut <= 0n) return rejected("quote returned zero", replies.tradeNoQuote(ticker));
  const slippageBps = cmd.slippageBps ?? config.tradeSlippageBps;
  const minAmountOut = applySlippage(expectedOut, slippageBps);

  // 7. Funding: the swap value (buys) plus gas for the swap and any approvals, at the pinned fee cap.
  const fees = await trade.fees();
  const gas = SWAP_GAS;
  const approvalCount = BigInt((approvals.erc20 ? 1 : 0) + (approvals.permit2 ? 1 : 0));
  const value = cmd.side === "buy" ? amountIn : 0n;
  const requiredWei = value + (gas + approvalCount * APPROVAL_GAS) * fees.maxFeePerGas;
  if (balances.eth < requiredWei) {
    return rejected(`insufficient: have ${balances.eth}, need ${requiredWei}`, replies.tradeInsufficient(formatEthCeil(requiredWei - balances.eth), siteUrl));
  }

  const plan: TradePlan = {
    chainId: CHAIN_ID,
    router: addresses.router,
    permit2: addresses.permit2,
    hook: getAddress(pool.hook),
    referrer,
    pool: { token, quote: zeroAddress, tickSpacing: pool.tickSpacing, poolId: pool.poolId as Hex },
    side: cmd.side,
    poolKey,
    zeroForOne,
    amountIn,
    expectedOut,
    minAmountOut,
    hookData,
    deadline: BigInt(Math.floor(now.getTime() / 1000) + DEADLINE_SECONDS),
    value,
    maxValueWei: capWei,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    approvals,
  };

  // 8. Record, then sign (or, in dry run, stop).
  const created = await store.createTrade({
    mentionId: input.mentionId,
    userId: input.userId,
    chainId: CHAIN_ID,
    token,
    side: cmd.side === "buy" ? "BUY" : "SELL",
    amountInWei: amountIn,
    minAmountOut,
    slippageBps,
    status: "QUEUED",
  });
  const tradeId = created.id;
  const inHuman = cmd.side === "buy" ? humanAmount(amountIn, 18, "eth") : humanAmount(amountIn, 18, "token");
  const successText = (out: bigint, txHash: Hex | null) =>
    replies.tradeSuccess({ side: cmd.side, ticker, amountIn: inHuman, amountOut: cmd.side === "buy" ? humanAmount(out, 18, "token") : humanAmount(out, 18, "eth"), token, siteUrl, txHash });

  if (config.dryRun) {
    const userText = successText(expectedOut, null).text;
    await store.updateTrade(tradeId, { status: "DRY_RUN", userMessage: userText });
    log.info({ tradeId, side: cmd.side, token, amountIn: amountIn.toString(), expectedOut: expectedOut.toString(), minAmountOut: minAmountOut.toString(), approvals }, "dry run: would sign the swap");
    return { ok: true, dryRun: true, tradeId, userText };
  }

  await store.updateTrade(tradeId, { status: "SIGNING" });
  const audit: AuditSink = async (rec) =>
    store.recordSignedTx({
      launchId: null,
      tweetId: input.tweetId,
      xUserId: input.xUserId,
      wallet: rec.wallet,
      chainId: rec.chainId,
      kind: rec.kind === "routerExecute" ? "ROUTER_EXECUTE" : rec.kind === "permit2Approve" ? "PERMIT2_APPROVE" : "ERC20_APPROVE",
      to: rec.to,
      calldataHash: rec.calldataHash,
      valueWei: rec.valueWei,
    });
  try {
    const done = await trade.execute(plan, wallet, audit);
    const { text: userText, safe: safeText } = successText(done.amountOut, done.txHash);
    await store.updateTrade(tradeId, { status: "CONFIRMED", txHash: done.txHash, amountOut: done.amountOut, userMessage: userText });
    log.info({ tradeId, txHash: done.txHash, amountOut: done.amountOut.toString() }, "trade confirmed");
    return { ok: true, dryRun: false, tradeId, txHash: done.txHash, userText, safeText };
  } catch (err) {
    const message = errMessage(err);
    const txHash = err instanceof ExecutionError ? err.txHash : null;
    const error = `execute: ${message}${txHash ? ` (${txHash})` : ""}`;
    const detail = txHash
      ? "the swap reverted on chain"
      : /insufficient funds/i.test(message)
        ? "the wallet ran short of ETH for gas"
        : /slippage|TooLittleReceived|V4TooLittleReceived/i.test(message)
          ? "the price moved past your slippage"
          : "the transaction could not be sent";
    const userText = replies.tradeFailed(detail);
    await store.updateTrade(tradeId, { status: "FAILED", error, txHash, userMessage: userText });
    log.error({ tradeId, error, txHash }, "trade failed");
    return { ok: false, outcome: "failed", error, userText, tradeId };
  }
}
