import { formatEther, parseEther, type Address, type Hex } from "viem";
import { bridgeChainByKey, bridgeChainDisplayName, RELAY_DEPOSITORY, type BridgeChainKey } from "@o1bot/shared";
import { noAlerts, postUrl, txUrl, type Alerter } from "./alerts";
import type { BotConfig } from "./config";
import type { AuditSink, WalletRef } from "./execute";
import type { RelayClient } from "./relay";
import { formatEthCeil, replies } from "./replies";
import type { BotStore } from "./store";
import { checkRate, startOfUtcDay } from "./validator";

/**
 * "bridge 0.1 ETH from base": move ETH from the user's wallet on another
 * chain to the same wallet on Robinhood, through Relay. The command names
 * an amount and an origin chain; the recipient is always the signing wallet
 * itself (Relay is asked for exactly that), the deposit goes to Relay's
 * pinned depository, and the allow-list checks the wallet, the request id
 * and the value inside the calldata before anything is signed. Chain reads
 * and signing go through `BridgeChain`, so the flow runs in tests with a
 * fake.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
/** Gas limit for Relay's depositNative; observed under 60k, generous on purpose. */
export const DEPOSIT_GAS = 120_000n;
/** How long the bot waits for Relay to pay out before replying that it is still on its way. */
export const FILL_TIMEOUT_MS = 120_000;
export const FILL_POLL_MS = 2_000;
/** A buy-after-bridge asks Relay for a little more, so Relay's fee and the swap's gas do not eat the buy. */
export const BUY_HEADROOM_BPS = 60n;
export const BUY_GAS_RESERVE_WEI = parseEther("0.0004");

export type BridgePlan = {
  originKey: BridgeChainKey;
  chainId: number;
  wallet: Address;
  to: Address;
  data: Hex;
  value: bigint;
  requestId: Hex;
  depositId: Hex;
  amountOut: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type BridgeChain = {
  balance(key: BridgeChainKey, wallet: Address): Promise<bigint>;
  fees(key: BridgeChainKey): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Sign and send the deposit on the origin chain; resolves once it is mined. */
  deposit(plan: BridgePlan, wallet: WalletRef, audit: AuditSink): Promise<{ txHash: Hex }>;
  sleep(ms: number): Promise<void>;
};

export type BridgeCoreInput = {
  mentionId: string;
  tweetId: string;
  userId: string;
  xUserId: string;
  handle: string;
  wallet: WalletRef;
  originKey: BridgeChainKey;
  /** ETH to move, in wei, as the user asked. */
  amountWei: bigint;
  /** True when a buy follows: the deposit is padded so the buy amount arrives intact. */
  forBuy: boolean;
};

export type BridgeCoreDeps = { store: BotStore; config: BotConfig; bridge: BridgeChain; relay: RelayClient; alerts?: Alerter; now: () => Date };

export type BridgeCoreResult =
  | { ok: false; outcome: "rejected"; error: string; userText: string }
  | { ok: false; outcome: "failed"; error: string; userText: string; bridgeId: string | null }
  | { ok: true; dryRun: true; bridgeId: string; userText: string }
  | { ok: true; dryRun: false; bridgeId: string; depositTxHash: Hex; fillTxHash: Hex | null; amountOut: bigint; filled: boolean; userText: string };

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What to deposit so that `amountWei` is still there for the buy after Relay's fee and the swap's gas. */
export function depositForBuy(amountWei: bigint): bigint {
  return amountWei + (amountWei * BUY_HEADROOM_BPS) / 10_000n + BUY_GAS_RESERVE_WEI;
}

export async function runBridge(input: BridgeCoreInput, deps: BridgeCoreDeps, log: Logger): Promise<BridgeCoreResult> {
  const { store, config, bridge, relay } = deps;
  const { wallet, originKey } = input;
  const siteUrl = config.siteUrl;
  const chainName = bridgeChainDisplayName(originKey);
  const chainId = bridgeChainByKey(originKey).id;
  const rejected = (error: string, userText: string): BridgeCoreResult => ({ ok: false, outcome: "rejected", error, userText });

  // 1. Same opt-in as trading: the bot signs from the wallet.
  const settings = await store.tradingSettings(input.xUserId);
  if (!settings?.enabled) return rejected("trading not enabled", replies.tradeDisabled(siteUrl));

  // 2. Amount and cap.
  const depositWei = input.forBuy ? depositForBuy(input.amountWei) : input.amountWei;
  if (depositWei <= 0n) return rejected("zero amount", replies.bridgeFailed("the amount is zero"));
  if (depositWei > config.maxBridgeWei) return rejected(`above bridge cap: ${depositWei} > ${config.maxBridgeWei}`, replies.bridgeTooLarge(formatEther(config.maxBridgeWei)));

  // 3. Rate limits, shared with trades.
  const now = deps.now();
  const rate = checkRate({
    lastLaunchAt: await store.lastBridgeAt(input.xUserId),
    launchesToday: await store.bridgeCountSince(input.xUserId, startOfUtcDay(now)),
    now,
    cooldownSeconds: config.tradeCooldownSeconds,
    maxPerDay: config.maxTradesPerDay,
  });
  if (!rate.ok) return rejected(`rate limit: ${rate.reason}`, rate.reason === "cooldown" ? replies.tradeSlowDown(rate.retryAfterSeconds) : replies.tradeDailyCap());

  // 4. Quote from Relay, for this wallet to this wallet; the deposit must be the one the bot pins.
  let quote;
  try {
    quote = await relay.quote({ user: wallet.address, originChainId: chainId, destinationChainId: ROBINHOOD_CHAIN_ID, amountWei: depositWei });
  } catch (err) {
    log.warn({ err: errMessage(err), originKey }, "relay quote failed");
    return rejected(`relay quote: ${errMessage(err)}`, replies.bridgeFailed("Relay could not quote this route right now"));
  }
  if (quote.to !== RELAY_DEPOSITORY || quote.chainId !== chainId || quote.value !== depositWei) {
    return rejected(`relay quote mismatch: to ${quote.to} chain ${quote.chainId} value ${quote.value}`, replies.bridgeFailed("Relay returned a deposit the bot does not recognise"));
  }

  // 5. Funding on the origin chain: the deposit plus its gas at the fee cap.
  const [balance, fees] = await Promise.all([bridge.balance(originKey, wallet.address), bridge.fees(originKey)]);
  const requiredWei = depositWei + DEPOSIT_GAS * fees.maxFeePerGas;
  if (balance < requiredWei) {
    return rejected(`insufficient on ${originKey}: have ${balance}, need ${requiredWei}`, replies.bridgeInsufficient(chainName, formatEthCeil(requiredWei - balance), siteUrl));
  }

  const plan: BridgePlan = {
    originKey,
    chainId,
    wallet: wallet.address,
    to: quote.to,
    data: quote.data,
    value: quote.value,
    requestId: quote.requestId,
    depositId: quote.depositId,
    amountOut: quote.amountOut,
    gas: DEPOSIT_GAS,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  // 6. Record, then sign (or, in dry run, stop).
  const created = await store.createBridge({ mentionId: input.mentionId, userId: input.userId, originChainId: chainId, amountInWei: depositWei, requestId: quote.requestId, status: "QUEUED" });
  const bridgeId = created.id;
  const inHuman = formatEther(depositWei);
  const outHuman = (wei: bigint) => Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 5 });

  if (config.dryRun) {
    const userText = replies.bridgeSuccess({ chainName, amountIn: inHuman, amountOut: outHuman(quote.amountOut), fillTxHash: null, siteUrl });
    await store.updateBridge(bridgeId, { status: "DRY_RUN", amountOutWei: quote.amountOut, userMessage: userText });
    log.info({ bridgeId, originKey, depositWei: depositWei.toString(), amountOut: quote.amountOut.toString(), requestId: quote.requestId }, "dry run: would sign the Relay deposit");
    return { ok: true, dryRun: true, bridgeId, userText };
  }

  await store.updateBridge(bridgeId, { status: "SIGNING" });
  const audit: AuditSink = async (rec) =>
    store.recordSignedTx({ launchId: null, tweetId: input.tweetId, xUserId: input.xUserId, wallet: rec.wallet, chainId: rec.chainId, kind: "RELAY_DEPOSIT", to: rec.to, calldataHash: rec.calldataHash, valueWei: rec.valueWei });
  let depositTxHash: Hex;
  try {
    depositTxHash = (await bridge.deposit(plan, wallet, audit)).txHash;
  } catch (err) {
    const message = errMessage(err);
    const error = `deposit: ${message}`;
    const userText = replies.bridgeFailed(/insufficient funds/i.test(message) ? `your ${chainName} wallet ran short of ETH for gas` : "the deposit could not be sent");
    await store.updateBridge(bridgeId, { status: "FAILED", error, userMessage: userText });
    log.error({ bridgeId, error }, "bridge deposit failed");
    (deps.alerts ?? noAlerts).send({ kind: "trade_failed", title: `Bridge failed from ${chainName}`, key: `bridge:${input.xUserId}`, fields: [["User", `@${input.handle}`], ["Post", postUrl(input.handle, input.tweetId)], ["Wallet", wallet.address], ["Amount", `${inHuman} ETH`], ["Error", message]] });
    return { ok: false, outcome: "failed", error, userText, bridgeId };
  }
  await store.updateBridge(bridgeId, { status: "DEPOSITED", depositTxHash });
  log.info({ bridgeId, depositTxHash, requestId: quote.requestId }, "relay deposit mined; waiting for the fill");

  // 7. Wait for Relay to pay out on Robinhood. The clock is the injected one so tests can run it forward.
  const deadline = deps.now().getTime() + FILL_TIMEOUT_MS;
  let fillTxHash: Hex | null = null;
  let filled = false;
  let failed: string | null = null;
  while (deps.now().getTime() < deadline) {
    const s = await relay.status(quote.requestId).catch(() => ({ status: "unknown" as const, fillTxHash: null }));
    if (s.status === "success") {
      filled = true;
      fillTxHash = s.fillTxHash;
      break;
    }
    if (s.status === "failure" || s.status === "refund") {
      failed = s.status;
      break;
    }
    await bridge.sleep(FILL_POLL_MS);
  }
  if (failed) {
    const error = `relay ${failed}`;
    const userText = replies.bridgeFailed(failed === "refund" ? "Relay refunded the deposit on the origin chain" : "Relay could not fill the transfer");
    await store.updateBridge(bridgeId, { status: "FAILED", error, userMessage: userText });
    log.error({ bridgeId, requestId: quote.requestId, failed }, "relay did not fill");
    return { ok: false, outcome: "failed", error, userText, bridgeId };
  }
  const userText = filled
    ? replies.bridgeSuccess({ chainName, amountIn: inHuman, amountOut: outHuman(quote.amountOut), fillTxHash, siteUrl })
    : replies.bridgePending({ chainName, amountIn: inHuman, depositTxHash, siteUrl });
  await store.updateBridge(bridgeId, { status: filled ? "FILLED" : "DEPOSITED", fillTxHash, amountOutWei: quote.amountOut, userMessage: userText });
  log.info({ bridgeId, filled, fillTxHash }, filled ? "bridge filled" : "bridge deposit sent; fill not seen in time");
  return { ok: true, dryRun: false, bridgeId, depositTxHash, fillTxHash, amountOut: quote.amountOut, filled, userText };
}
