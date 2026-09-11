import type { Address, Hex } from "viem";
import { classifyError, type LaunchErrorKind, type PreparedMetadata } from "@o1bot/executor";
import { chainByKey, DEFAULT_CHAIN_KEY, type ChainKey, type O1Quote, type AllowedTxKind } from "@o1bot/shared";
import type { SignAudit } from "@o1bot/wallet";
import { noAlerts, postUrl, txUrl } from "./alerts";
import type { BotConfig } from "./config";
import { ExecutionError, type AuditSink, type ExecutionResult, type WalletRef } from "./execute";
import type { PipelineDeps } from "./pipeline";
import { formatEthCeil, replies } from "./replies";
import type { SignedTxKindValue } from "./store";

/**
 * The part of a launch that is the same whether the request came from a
 * post on X or from the form on the web app: pin metadata, plan against
 * the live factory, check funding, then either record a dry run or sign,
 * broadcast, confirm and redirect creator fees. Everything before this
 * (who is asking, are they linked, rate limits, pair and ticker checks,
 * fees-to resolution) and everything after it (replying on X, showing a
 * status on the web) belongs to the caller.
 */

export type LaunchOrigin = { kind: "x"; tweetId: string; tweetUrl: string } | { kind: "web" };

export type LaunchCoreInput = {
  launchId: string;
  wallet: WalletRef;
  author: { xUserId: string; handle: string };
  quote: O1Quote;
  /** Chain to launch on; Robinhood when the request names none. */
  chain?: ChainKey;
  ticker: string;
  name: string;
  devBuyWei: bigint | null;
  /** Decimal ETH string exactly as the user wrote it, for the success message. */
  devBuyNative: string | null;
  description: string | null;
  website: string | null;
  telegram: string | null;
  /** Project X handle for the metadata; null = the author's own profile. */
  xHandle: string | null;
  /** The token site being built for this launch, named in the success reply; null when none was asked for. */
  tokenSiteUrl?: string | null;
  image: { url?: string | null; bytes?: Uint8Array | null };
  origin: LaunchOrigin;
  recipient: { handle: string; userId: string; address: Address } | null;
};

export type LaunchCoreResult =
  | {
      ok: false;
      /** Mention status the X caller should record; web callers only need the message. */
      terminal: "REJECTED" | "FAILED";
      /** Whether the user asked for something impossible (rejected) or the launch broke (failed). */
      outcome: "rejected" | "failed";
      error: string;
      userText: string;
      /** Address-free variant for accounts X blocks from posting addresses. */
      safeText?: string;
    }
  | { ok: true; dryRun: true; token: Address; userText: string }
  | { ok: true; dryRun: false; token: Address; txHash: Hex; feeRecipientTxHash: Hex | null; feesToFailed: string | null; userText: string };

export type LaunchCoreDeps = Pick<PipelineDeps, "store" | "config" | "prepareMetadata" | "plan" | "execute" | "setFeeRecipient" | "alerts">;

export const SIGNED_KIND: Record<AllowedTxKind, SignedTxKindValue> = {
  createLaunch: "CREATE_LAUNCH",
  createLaunchAndBuy: "CREATE_LAUNCH_AND_BUY",
  erc20Approve: "ERC20_APPROVE",
  setCreatorFeeRecipient: "SET_CREATOR_FEE_RECIPIENT",
  feeClaimFor: "FEE_CLAIM",
  feeClaimTo: "FEE_CLAIM",
  permit2Approve: "PERMIT2_APPROVE",
  routerExecute: "ROUTER_EXECUTE",
  relayDeposit: "RELAY_DEPOSIT",
};

/** Short, user-facing phrasing for plan / execution failures that are not the user's fault. */
export const FAILURE_DETAIL: Partial<Record<LaunchErrorKind, string>> = {
  stale_config: "o1 changed its factory config while I was preparing the launch",
  expired: "the launch deadline passed before it was mined",
  salt_used: "address collision, a retry picks a fresh one",
  creation_disabled: "o1 has paused new launches",
  registry_drift: "o1 rotated its factory and the bot needs an update",
  rpc_error: "the chain RPC did not respond",
  unknown_revert: "the factory rejected the transaction",
  config_error: "factory configuration mismatch",
  token_check_failed: "token address prediction mismatch",
  dev_buy_rejected: "o1 rejected the dev buy",
  bad_payment: "payment amount mismatch",
  bad_suffix: "factory address rules changed",
  unknown: "unexpected error",
};

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Logger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

export async function runLaunch(input: LaunchCoreInput, deps: LaunchCoreDeps, log: Logger): Promise<LaunchCoreResult> {
  const { store, config } = deps;
  const { launchId, wallet, author, quote, origin, recipient } = input;
  const chain = input.chain ?? DEFAULT_CHAIN_KEY;
  const siteUrl = config.siteUrl;

  /**
   * `terminal` is what the X caller records on the mention (REJECTED when the
   * request itself cannot work, FAILED when the launch broke); every one of
   * these is a "failed" outcome for the launch row. Only a funding shortfall
   * is a plain rejection, handled inline below.
   */
  const fail = async (terminal: "REJECTED" | "FAILED", error: string, userText: string, extra: { safeText?: string; launchTxHash?: Hex | null } = {}): Promise<LaunchCoreResult> => {
    log.error({ launchId, error }, "launch failed");
    (deps.alerts ?? noAlerts).send({
      kind: "launch_failed",
      title: `Launch ${terminal === "REJECTED" ? "rejected" : "failed"}: $${input.ticker}`,
      key: `launch:${author.xUserId}:${error.slice(0, 40)}`,
      fields: [
        ["User", `@${author.handle}`],
        ["Source", origin.kind === "x" ? postUrl(author.handle, origin.tweetId) : `web launch ${launchId}`],
        ["Wallet", wallet.address],
        ["Tx", extra.launchTxHash ? txUrl(extra.launchTxHash, chain) : null],
        ["Error", error],
        ["Told the user", userText],
      ],
    });
    await store.updateLaunch(launchId, { status: "FAILED", error, userMessage: userText, ...(extra.launchTxHash ? { launchTxHash: extra.launchTxHash } : {}) });
    return { ok: false, terminal, outcome: "failed", error, userText, ...(extra.safeText ? { safeText: extra.safeText } : {}) };
  };

  // 1. Image + ERC-7572 metadata on IPFS.
  let metadata: PreparedMetadata;
  try {
    const via = origin.kind === "x" ? "from a post by" : "on o1bot.exchange by";
    metadata = await deps.prepareMetadata({
      name: input.name,
      symbol: input.ticker,
      description: input.description ?? `${input.name} ($${input.ticker}) was launched on o1 Launchpad ${via} @${author.handle}.`,
      externalLink: siteUrl,
      launchedBy: origin.kind === "x" ? { xHandle: author.handle, xUserId: author.xUserId, tweetId: origin.tweetId, tweetUrl: origin.tweetUrl } : { xHandle: author.handle, xUserId: author.xUserId },
      imageUrl: input.image.url ?? null,
      imageBytes: input.image.bytes ?? null,
      website: input.website,
      x: `https://x.com/${input.xHandle ?? author.handle}`,
      telegram: input.telegram,
      o1: { chainId: chainByKey(chain).id, creator: wallet.address, market: quote.kind === "stock" ? "rwa" : "standard", quoteAddress: quote.address },
    });
  } catch (err) {
    const detail = /plan usage limit|FORBIDDEN|429/i.test(errMessage(err)) ? "our IPFS pinning service is over its quota, the team has been alerted, try again later" : "the image or metadata upload failed";
    return fail("FAILED", `metadata: ${errMessage(err)}`, replies.launchFailed(detail));
  }
  await store.updateLaunch(launchId, { imageUri: metadata.imageUri, metadataUri: metadata.uri, status: "SIMULATING", imageData: null });

  // 2. Plan: live factory reads, salt, route, simulation, funding.
  const planned = await deps.plan({
    creator: wallet.address,
    chain,
    name: input.name,
    symbol: input.ticker,
    tokenContractURI: metadata.uri,
    pair: quote.address,
    devBuyWei: input.devBuyWei ?? undefined,
  });
  if (!planned.ok) {
    const { kind, message } = planned.error;
    const error = `plan/${planned.stage}: ${kind}: ${message}`;
    switch (kind) {
      case "dev_buy_no_route":
        return fail("REJECTED", error, replies.devBuyNoRoute(quote.symbol));
      case "pair_not_registered":
        return fail("REJECTED", error, replies.pairUnavailable(quote.symbol, siteUrl));
      case "ticker_collides_with_stock":
        return fail("REJECTED", error, replies.tickerCollides(input.ticker));
      case "bad_token_fields":
        return fail("REJECTED", error, replies.launchFailed(message));
      case "insufficient_balance":
        return fail("REJECTED", error, replies.insufficientUnknown(wallet.address), { safeText: replies.insufficientSafeUnknown(siteUrl) });
      default:
        return fail("FAILED", error, replies.launchFailed(FAILURE_DETAIL[kind] ?? kind));
    }
  }
  const plan = planned.plan;
  await store.updateLaunch(launchId, { creatorSalt: plan.salt.creatorSalt, tokenAddress: plan.salt.token, poolId: plan.simulation.poolId });

  // 3. Funding: exact shortfall, deposit address included where the channel allows it.
  if (plan.funding.shortfallWei > 0n) {
    const short = formatEthCeil(plan.funding.shortfallWei);
    log.info({ launchId, shortfallWei: plan.funding.shortfallWei.toString(), wallet: wallet.address }, "insufficient balance");
    const userText = replies.insufficient(short, wallet.address);
    await store.updateLaunch(launchId, { status: "FAILED", error: `insufficient balance: short ${plan.funding.shortfallWei} wei`, userMessage: userText });
    return { ok: false, terminal: "REJECTED", outcome: "rejected", error: "insufficient balance", userText, safeText: replies.insufficientSafe(short, siteUrl) };
  }

  const successText = (extra: { feesToFailed?: string | null; token?: Address } = {}) =>
    replies.success({
      ticker: input.ticker,
      name: input.name,
      chain,
      pair: quote.symbol,
      token: extra.token ?? plan.salt.token,
      siteUrl,
      devBuyEth: input.devBuyNative,
      feesTo: extra.feesToFailed ? null : (recipient?.handle ?? null),
      feesToFailed: extra.feesToFailed ?? null,
      site: input.tokenSiteUrl ?? null,
    });

  // 4. Dry run stops here: record what would be signed, sign nothing.
  if (config.dryRun) {
    const userText = successText();
    await store.updateLaunch(launchId, { status: "DRY_RUN", userMessage: userText });
    log.info(
      {
        launchId,
        fn: plan.call.functionName,
        factory: plan.factory,
        valueWei: plan.call.value.toString(),
        token: plan.salt.token,
        poolId: plan.simulation.poolId,
        route: plan.route?.label ?? null,
        gas: plan.simulation.gas.toString(),
        feeRecipient: recipient?.address ?? null,
      },
      "dry run: would sign and broadcast",
    );
    return { ok: true, dryRun: true, token: plan.salt.token, userText };
  }

  // 5. Sign + broadcast from the user's wallet; every signature is audited first.
  const auditTweetId = origin.kind === "x" ? origin.tweetId : `web:${launchId}`;
  const audit: AuditSink = async (rec: SignAudit) =>
    store.recordSignedTx({
      launchId,
      tweetId: auditTweetId,
      xUserId: author.xUserId,
      wallet: rec.wallet,
      chainId: rec.chainId,
      kind: SIGNED_KIND[rec.kind],
      to: rec.to,
      calldataHash: rec.calldataHash,
      valueWei: rec.valueWei,
    });
  await store.updateLaunch(launchId, { status: "SIGNING" });
  let executed: ExecutionResult;
  try {
    executed = await deps.execute(plan, wallet, audit);
  } catch (err) {
    if (err instanceof ExecutionError) {
      const kind = err.txHash ? null : classifyError(err.cause).kind;
      // The balance moved between the funding check and the broadcast.
      if (kind === "insufficient_balance") {
        return fail("REJECTED", `execute: ${err.message}`, replies.insufficientUnknown(wallet.address), { safeText: replies.insufficientSafeUnknown(siteUrl) });
      }
      const detail = err.txHash ? "the transaction reverted on chain" : ((kind && FAILURE_DETAIL[kind]) ?? "the transaction could not be sent");
      return fail("FAILED", `execute: ${err.message}`, replies.launchFailed(detail), { launchTxHash: err.txHash });
    }
    const classified = classifyError(err);
    return fail("FAILED", `execute: ${classified.kind}: ${classified.message}`, replies.launchFailed(FAILURE_DETAIL[classified.kind] ?? classified.kind));
  }
  await store.updateLaunch(launchId, { status: "CONFIRMED", tokenAddress: executed.token, poolId: executed.poolId, launchTxHash: executed.txHash });
  log.info({ launchId, token: executed.token, txHash: executed.txHash }, "launch confirmed");

  // 6. Optional second transaction: redirect creator fees.
  let feeRecipientTxHash: Hex | null = null;
  let feesToFailed: string | null = null;
  if (recipient) {
    await store.updateLaunch(launchId, { status: "FEE_RECIPIENT_PENDING" });
    try {
      feeRecipientTxHash = await deps.setFeeRecipient({ factory: plan.factory, chainId: plan.chainId, token: executed.token, recipient: recipient.address }, wallet, audit);
      await store.updateLaunch(launchId, { status: "CONFIRMED", feeRecipientTxHash });
    } catch (err) {
      feesToFailed = recipient.handle;
      log.error({ launchId, err: errMessage(err), recipient: recipient.address }, "setCreatorFeeRecipient failed; fees stay with the creator");
      await store.updateLaunch(launchId, { status: "CONFIRMED", error: `fee recipient: ${errMessage(err)}` });
    }
  }

  const userText = successText({ feesToFailed, token: executed.token });
  await store.updateLaunch(launchId, { userMessage: userText });
  return { ok: true, dryRun: false, token: executed.token, txHash: executed.txHash, feeRecipientTxHash, feesToFailed, userText };
}
