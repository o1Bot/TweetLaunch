import { getAddress, type Address, type Hex } from "viem";
import { classifyError, type LaunchErrorKind, type LaunchPlan, type LaunchRequest, type PlanResult, type PreparedMetadata, type TokenMetadataInput } from "@o1bot/executor";
import { ParserError, type LaunchCommand, type MentionInput, type ParsedMention } from "@o1bot/parser";
import { activeFactory, findQuote, logger, tickerCollidesWithStock, type AllowedTxKind } from "@o1bot/shared";
import type { EnsureWalletInput, LinkedUser, LinkStatus, SignAudit } from "@o1bot/wallet";
import { stripLeadingMentions, XPostError, type XClient, type XMention } from "@o1bot/x";
import type { BotConfig } from "./config";
import { ExecutionError, type AuditSink, type ExecutionResult, type WalletRef } from "./execute";
import { clampReply, formatEthCeil, replies } from "./replies";
import type { BotStore, MentionStatusValue, SignedTxKindValue } from "./store";
import { checkDevBuy, checkFeesToHandle, checkRate, startOfUtcDay } from "./validator";

/**
 * One mention, end to end: dedupe → parse → validate → plan → (dry run |
 * sign + broadcast + fee recipient) → reply. Every external effect goes
 * through `PipelineDeps`, so the whole flow runs in tests with fakes and in
 * dry runs without X write access, Privy or a database.
 *
 * DRY_RUN means no signatures and no posts on X: replies are logged in full
 * instead of sent, launches are recorded with status DRY_RUN and the
 * predicted token address.
 */

const CHAIN_KEY = "robinhood" as const;

export type PipelineDeps = {
  store: BotStore;
  x: XClient;
  config: BotConfig;
  parse: (input: MentionInput) => Promise<ParsedMention>;
  /** Translate an English template into the post's language (identity for English). */
  localize: (text: string, language: string | null) => Promise<string>;
  resolveLink: (xUserId: string) => Promise<LinkStatus>;
  ensureRecipientWallet: (input: EnsureWalletInput) => Promise<LinkedUser>;
  prepareMetadata: (input: TokenMetadataInput) => Promise<PreparedMetadata>;
  plan: (req: LaunchRequest) => Promise<PlanResult>;
  execute: (plan: LaunchPlan, wallet: WalletRef, audit: AuditSink) => Promise<ExecutionResult>;
  setFeeRecipient: (input: { factory: Address; chainId: number; token: Address; recipient: Address }, wallet: WalletRef, audit: AuditSink) => Promise<Hex>;
  now?: () => Date;
};

export type PipelineOutcome =
  | { outcome: "duplicate" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "replied"; kind: "help" | "clarify" | "unsupported_chain" | "not_registered" | "rejected"; reply: string | null }
  | { outcome: "dry_run"; launchId: string; token: Address; reply: string }
  | { outcome: "launched"; launchId: string; token: Address; txHash: Hex; feeRecipientTxHash: Hex | null; reply: string | null }
  | { outcome: "failed"; error: string; reply: string | null; launchId: string | null };

type ReplyResult = { text: string; tweetId: string | null; posted: boolean; error: string | null };

const SIGNED_KIND: Record<AllowedTxKind, SignedTxKindValue> = {
  createLaunch: "CREATE_LAUNCH",
  createLaunchAndBuy: "CREATE_LAUNCH_AND_BUY",
  erc20Approve: "ERC20_APPROVE",
  setCreatorFeeRecipient: "SET_CREATOR_FEE_RECIPIENT",
  feeClaimFor: "FEE_CLAIM",
  feeClaimTo: "FEE_CLAIM",
};

/** Short, user-facing phrasing for plan / execution failures that are not the user's fault. */
const FAILURE_DETAIL: Partial<Record<LaunchErrorKind, string>> = {
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

export async function processMention(mention: XMention, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = logger.child({ tweetId: mention.id, author: mention.authorHandle });

  // 1. Dedupe on the tweet id. The unique constraint makes this safe across workers.
  const inserted = await store.insertMention({
    tweetId: mention.id,
    authorXUserId: mention.authorId,
    authorHandle: mention.authorHandle,
    text: mention.text,
    mediaUrl: mention.imageUrl,
    language: mention.lang,
    postedAt: mention.createdAt ? new Date(mention.createdAt) : null,
  });
  if (!inserted.created) {
    log.debug("mention already processed");
    return { outcome: "duplicate" };
  }
  const mentionId = inserted.id;
  let language: string | null = mention.lang;

  const setMention = (status: MentionStatusValue, extra: { error?: string | null } = {}) => store.updateMention(mentionId, { status, ...extra });

  /**
   * Post (or, in dry run, log) a reply. `safe` is an alternative without a
   * crypto address for accounts X blocks from posting addresses. The per-day
   * reply cap protects the X quota from a single spammer.
   */
  const reply = async (text: string, opts: { safe?: string; raw?: boolean } = {}): Promise<ReplyResult> => {
    if (config.dryRun) {
      log.info({ reply: text }, "dry run: would reply");
      return { text, tweetId: null, posted: false, error: null };
    }
    const sent = await store.replyCountSince(mention.authorId, startOfUtcDay(now()));
    if (sent >= config.maxRepliesPerDay) {
      log.warn({ sent }, "reply cap reached for this account; not replying");
      await store.updateMention(mentionId, { error: "reply cap reached" });
      return { text, tweetId: null, posted: false, error: "reply cap reached" };
    }
    const localized = clampReply(opts.raw ? text : await deps.localize(text, language));
    try {
      const tweetId = await deps.x.postReply(localized, mention.id);
      await store.updateMention(mentionId, { replyTweetId: tweetId });
      return { text: localized, tweetId, posted: true, error: null };
    } catch (err) {
      if (err instanceof XPostError && err.cryptoAddressBlocked && opts.safe) {
        log.warn("X refused a crypto address in the reply; sending the address-free variant");
        const safe = clampReply(await deps.localize(opts.safe, language));
        try {
          const tweetId = await deps.x.postReply(safe, mention.id);
          await store.updateMention(mentionId, { replyTweetId: tweetId });
          return { text: safe, tweetId, posted: true, error: null };
        } catch (err2) {
          err = err2;
        }
      }
      const error = `reply failed: ${errMessage(err)}`;
      log.error({ err: errMessage(err) }, "could not post reply");
      await store.updateMention(mentionId, { error });
      return { text: localized, tweetId: null, posted: false, error };
    }
  };

  // 2. Parse.
  let parsed: ParsedMention;
  try {
    parsed = await deps.parse({ text: stripLeadingMentions(mention.text), authorHandle: mention.authorHandle, hasImage: Boolean(mention.imageUrl), tweetId: mention.id });
  } catch (err) {
    const error = err instanceof ParserError ? `parser: ${err.message}` : `parser: ${errMessage(err)}`;
    log.error({ err: errMessage(err) }, "parse failed");
    await setMention("FAILED", { error });
    return { outcome: "failed", error, reply: null, launchId: null };
  }
  const result = parsed.result;
  language = result.language || language;
  await store.updateMention(mentionId, { status: "PARSED", parse: parsed.raw, language });

  // 3. Everything that is not a launch is a single reply (or silence).
  switch (result.kind) {
    case "ignore": {
      await setMention("DONE", { error: null });
      log.info({ reason: result.reason }, "ignored");
      return { outcome: "ignored", reason: result.reason };
    }
    case "help": {
      const r = await reply(result.reply, { raw: true });
      await setMention("DONE");
      return { outcome: "replied", kind: "help", reply: r.posted || config.dryRun ? r.text : null };
    }
    case "clarify": {
      const r = await reply(result.question, { raw: true });
      await setMention("CLARIFY");
      return { outcome: "replied", kind: "clarify", reply: r.posted || config.dryRun ? r.text : null };
    }
    case "unsupported_chain": {
      const r = await reply(replies.unsupportedChain());
      await setMention("REJECTED", { error: `unsupported chain: ${result.chain}` });
      return { outcome: "replied", kind: "unsupported_chain", reply: r.posted || config.dryRun ? r.text : null };
    }
    case "launch":
      return handleLaunch(result, { mention, mentionId, deps, now, log, reply, setMention });
  }
}

type LaunchContext = {
  mention: XMention;
  mentionId: string;
  deps: PipelineDeps;
  now: () => Date;
  log: typeof logger;
  reply: (text: string, opts?: { safe?: string; raw?: boolean }) => Promise<ReplyResult>;
  setMention: (status: MentionStatusValue, extra?: { error?: string | null }) => Promise<void>;
};

async function handleLaunch(cmd: LaunchCommand, ctx: LaunchContext): Promise<PipelineOutcome> {
  const { mention, mentionId, deps, now, log, reply, setMention } = ctx;
  const { store, config } = deps;

  const rejected = async (text: string, error: string, opts: { safe?: string } = {}): Promise<PipelineOutcome> => {
    const r = await reply(text, opts);
    await setMention("REJECTED", { error });
    return { outcome: "replied", kind: "rejected", reply: r.posted || config.dryRun ? r.text : null };
  };

  // 4. The poster must have linked X on o1bot and delegated signing.
  const link = await deps.resolveLink(mention.authorId);
  if (!link.linked) {
    log.info({ reason: link.reason }, "poster is not registered");
    const r = await reply(replies.notRegistered(config.siteUrl));
    await setMention("NOT_REGISTERED", { error: link.reason });
    return { outcome: "replied", kind: "not_registered", reply: r.posted || config.dryRun ? r.text : null };
  }
  const wallet: WalletRef = { walletId: link.wallet.walletId!, address: link.wallet.address };
  const authorHandle = mention.authorHandle || link.user.xHandle || "unknown";
  const creator = await store.upsertUser({
    xUserId: mention.authorId,
    xHandle: authorHandle,
    xName: mention.authorName ?? link.user.xName,
    xAvatarUrl: mention.authorImage ?? link.user.xAvatarUrl,
    privyUserId: link.user.privyUserId,
    walletAddress: wallet.address,
    walletId: wallet.walletId,
    pregenerated: false,
    delegated: true,
  });

  // 5. Abuse limits: cooldown and daily cap, enforced here and not only by o1.
  const today = startOfUtcDay(now());
  const rate = checkRate({
    lastLaunchAt: await store.lastLaunchAt(mention.authorId),
    launchesToday: await store.launchCountSince(mention.authorId, today),
    now: now(),
    cooldownSeconds: config.cooldownSeconds,
    maxPerDay: config.maxLaunchesPerDay,
  });
  if (!rate.ok) return rejected(replies.slowDown(rate.reason, rate.retryAfterSeconds, config.cooldownSeconds), `rate limit: ${rate.reason}`);

  // 6. Pair and ticker against the o1 snapshot (the plan re-checks them live).
  const quote = findQuote(CHAIN_KEY, cmd.pair);
  if (!quote) return rejected(replies.pairUnavailable(cmd.pair, config.siteUrl), `pair not registered: ${cmd.pair}`);
  if (tickerCollidesWithStock(CHAIN_KEY, cmd.ticker)) return rejected(replies.tickerCollides(cmd.ticker), `ticker collides with stock: ${cmd.ticker}`);

  // 7. Dev buy amount within the bot's cap.
  const devBuy = checkDevBuy(cmd.devBuyNative, config.maxDevBuyWei);
  if (!devBuy.ok) {
    return devBuy.reason === "invalid"
      ? rejected(replies.devBuyInvalid(), `dev buy invalid: ${cmd.devBuyNative}`)
      : rejected(replies.devBuyTooLarge(formatEthCeil(config.maxDevBuyWei)), `dev buy above cap: ${cmd.devBuyNative}`);
  }

  // 8. `fees to @b`: resolve the handle to a stable X user id, then to a wallet.
  const feesTo = checkFeesToHandle(cmd.feesToHandle, config.reservedHandles, authorHandle);
  if (!feesTo.ok) return rejected(replies.feesToRejected(cmd.feesToHandle ?? "", feesTo.reason), `fees to rejected: ${feesTo.reason}`);
  let recipient: { handle: string; userId: string; address: Address } | null = null;
  if (feesTo.handle) {
    const lookup = await deps.x.lookupUser(feesTo.handle);
    if (!lookup.found) return rejected(replies.feesToRejected(feesTo.handle, lookup.reason), `fees to ${lookup.reason}: ${feesTo.handle}`);
    if (lookup.user.id !== mention.authorId) {
      let target: LinkedUser;
      try {
        target = await deps.ensureRecipientWallet({ xUserId: lookup.user.id, username: lookup.user.username, name: lookup.user.name, avatarUrl: lookup.user.profileImageUrl });
      } catch (err) {
        const error = `fee recipient wallet: ${errMessage(err)}`;
        log.error({ err: errMessage(err) }, "could not prepare the fee recipient wallet");
        await reply(replies.launchFailed("the fee recipient wallet could not be prepared"));
        await setMention("FAILED", { error });
        return { outcome: "failed", error, reply: null, launchId: null };
      }
      if (!target.wallet) {
        const error = "fee recipient has no wallet";
        await reply(replies.launchFailed("the fee recipient wallet could not be prepared"));
        await setMention("FAILED", { error });
        return { outcome: "failed", error, reply: null, launchId: null };
      }
      const targetUser = await store.upsertUser({
        xUserId: target.xUserId,
        xHandle: target.xHandle ?? lookup.user.username.toLowerCase(),
        xName: target.xName ?? lookup.user.name,
        xAvatarUrl: target.xAvatarUrl ?? lookup.user.profileImageUrl,
        privyUserId: target.privyUserId,
        walletAddress: target.wallet.address,
        walletId: target.wallet.walletId,
        pregenerated: target.pregenerated,
        delegated: target.wallet.delegated,
      });
      if (getAddress(target.wallet.address) !== getAddress(wallet.address)) {
        recipient = { handle: lookup.user.username.toLowerCase(), userId: targetUser.id, address: target.wallet.address };
      }
    }
  }

  // 9. Persist the launch before anything slow or irreversible happens.
  const launch = await store.createLaunch({
    mentionId,
    creatorUserId: creator.id,
    feeRecipientUserId: recipient?.userId ?? null,
    chainId: 4663,
    factory: activeFactory(CHAIN_KEY),
    quoteAddress: quote.address,
    quoteSymbol: quote.symbol,
    ticker: cmd.ticker,
    name: cmd.name,
    devBuyWei: devBuy.wei,
    imageUri: null,
    metadataUri: null,
    status: "QUEUED",
  });
  const launchId = launch.id;
  await setMention("QUEUED");

  const failed = async (error: string, text: string, status: MentionStatusValue = "FAILED", patch: Parameters<BotStore["updateLaunch"]>[1] = {}): Promise<PipelineOutcome> => {
    log.error({ error }, "launch failed");
    await store.updateLaunch(launchId, { status: "FAILED", error, ...patch });
    const r = await reply(text);
    await setMention(status, { error });
    return { outcome: "failed", error, reply: r.posted || config.dryRun ? r.text : null, launchId };
  };

  // 10. Image + ERC-7572 metadata on IPFS.
  let metadata: PreparedMetadata;
  try {
    metadata = await deps.prepareMetadata({
      name: cmd.name,
      symbol: cmd.ticker,
      description: cmd.description ?? `${cmd.name} ($${cmd.ticker}) was launched on o1 Launchpad from a post by @${authorHandle}.`,
      externalLink: config.siteUrl,
      launchedBy: { xHandle: authorHandle, xUserId: mention.authorId, tweetId: mention.id, tweetUrl: `https://x.com/${authorHandle}/status/${mention.id}` },
      imageUrl: cmd.imageFromTweet ? mention.imageUrl : null,
      website: cmd.website,
      // The project's X profile: the handle the user named, else the poster's own account.
      x: `https://x.com/${cmd.xHandle ?? authorHandle}`,
      telegram: cmd.telegram,
    });
  } catch (err) {
    return failed(`metadata: ${errMessage(err)}`, replies.launchFailed("the image or metadata upload failed"));
  }
  await store.updateLaunch(launchId, { imageUri: metadata.imageUri, metadataUri: metadata.uri, status: "SIMULATING" });

  // 11. Plan: live factory reads, salt, route, simulation, funding.
  const planned = await deps.plan({
    creator: wallet.address,
    name: cmd.name,
    symbol: cmd.ticker,
    tokenContractURI: metadata.uri,
    pair: quote.address,
    devBuyWei: devBuy.wei ?? undefined,
  });
  if (!planned.ok) {
    const { kind, message } = planned.error;
    const error = `plan/${planned.stage}: ${kind}: ${message}`;
    switch (kind) {
      case "dev_buy_no_route":
        return failed(error, replies.devBuyNoRoute(quote.symbol), "REJECTED");
      case "pair_not_registered":
        return failed(error, replies.pairUnavailable(quote.symbol, config.siteUrl), "REJECTED");
      case "ticker_collides_with_stock":
        return failed(error, replies.tickerCollides(cmd.ticker), "REJECTED");
      case "bad_token_fields":
        return failed(error, replies.launchFailed(message), "REJECTED");
      case "insufficient_balance":
        return failed(error, replies.insufficientUnknown(wallet.address), "REJECTED");
      default:
        return failed(error, replies.launchFailed(FAILURE_DETAIL[kind] ?? kind));
    }
  }
  const plan = planned.plan;
  await store.updateLaunch(launchId, { creatorSalt: plan.salt.creatorSalt, tokenAddress: plan.salt.token, poolId: plan.simulation.poolId });

  // 12. Funding: exact shortfall in the reply, deposit address included when X allows it.
  if (plan.funding.shortfallWei > 0n) {
    const short = formatEthCeil(plan.funding.shortfallWei);
    log.info({ shortfallWei: plan.funding.shortfallWei.toString(), wallet: wallet.address }, "insufficient balance");
    await store.updateLaunch(launchId, { status: "FAILED", error: `insufficient balance: short ${plan.funding.shortfallWei} wei` });
    return rejected(replies.insufficient(short, wallet.address), "insufficient balance", { safe: replies.insufficientSafe(short, config.siteUrl) });
  }

  const successText = (extra: { feesToFailed?: string | null } = {}) =>
    replies.success({
      ticker: cmd.ticker,
      name: cmd.name,
      pair: quote.symbol,
      token: plan.salt.token,
      siteUrl: config.siteUrl,
      devBuyEth: cmd.devBuyNative,
      feesTo: extra.feesToFailed ? null : (recipient?.handle ?? null),
      feesToFailed: extra.feesToFailed ?? null,
    });

  // 13. Dry run stops here: record what would be signed, log the reply, sign nothing.
  if (config.dryRun) {
    await store.updateLaunch(launchId, { status: "DRY_RUN" });
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
    const r = await reply(successText());
    await setMention("DONE");
    return { outcome: "dry_run", launchId, token: plan.salt.token, reply: r.text };
  }

  // 14. Sign + broadcast from the user's wallet; every signature is audited first.
  const audit: AuditSink = async (rec: SignAudit) =>
    store.recordSignedTx({
      launchId,
      tweetId: mention.id,
      xUserId: mention.authorId,
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
      const detail = err.txHash ? "the transaction reverted on chain" : FAILURE_DETAIL[classifyError(err.cause).kind] ?? "the transaction could not be sent";
      return failed(`execute: ${err.message}`, replies.launchFailed(detail), "FAILED", { launchTxHash: err.txHash });
    }
    const classified = classifyError(err);
    return failed(`execute: ${classified.kind}: ${classified.message}`, replies.launchFailed(FAILURE_DETAIL[classified.kind] ?? classified.kind));
  }
  await store.updateLaunch(launchId, { status: "CONFIRMED", tokenAddress: executed.token, poolId: executed.poolId, launchTxHash: executed.txHash });
  log.info({ launchId, token: executed.token, txHash: executed.txHash }, "launch confirmed");

  // 15. Optional second transaction: redirect creator fees.
  let feeRecipientTxHash: Hex | null = null;
  let feesToFailed: string | null = null;
  if (recipient) {
    await store.updateLaunch(launchId, { status: "FEE_RECIPIENT_PENDING" });
    try {
      feeRecipientTxHash = await deps.setFeeRecipient({ factory: plan.factory, chainId: plan.chainId, token: executed.token, recipient: recipient.address }, wallet, audit);
      await store.updateLaunch(launchId, { status: "CONFIRMED", feeRecipientTxHash });
    } catch (err) {
      feesToFailed = recipient.handle;
      log.error({ err: errMessage(err), recipient: recipient.address }, "setCreatorFeeRecipient failed; fees stay with the creator");
      await store.updateLaunch(launchId, { status: "CONFIRMED", error: `fee recipient: ${errMessage(err)}` });
    }
  }

  // 16. Success reply. A failed post never undoes the launch.
  const r = await reply(successText({ feesToFailed }));
  if (r.posted) {
    await store.updateLaunch(launchId, { status: "REPLIED" });
    await setMention("DONE");
  } else {
    await setMention("FAILED", { error: r.error ?? "reply not posted" });
  }
  return { outcome: "launched", launchId, token: executed.token, txHash: executed.txHash, feeRecipientTxHash, reply: r.posted ? r.text : null };
}

