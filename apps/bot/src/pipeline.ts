import { getAddress, type Address, type Hex } from "viem";
import type { LaunchPlan, LaunchRequest, PlanResult, PreparedMetadata, TokenMetadataInput } from "@o1bot/executor";
import { ParserError, type ComposeInput, type LaunchCommand, type MentionInput, type ParsedMention } from "@o1bot/parser";
import { activeFactory, chainByKey, chainDisplayName, DEFAULT_CHAIN_KEY, findQuote, logger, tickerCollidesWithStock } from "@o1bot/shared";
import { checkSlug, slugFromTicker } from "@o1bot/sites";
import type { EnsureWalletInput, LinkedUser, LinkStatus } from "@o1bot/wallet";
import { stripLeadingMentions, XPostError, type XClient, type XMention } from "@o1bot/x";
import { noAlerts, postUrl, type Alerter } from "./alerts";
import type { AskData } from "./ask-data";
import { handleAsk } from "./ask-handler";
import type { BridgeChain } from "./bridge-core";
import { handleBridge } from "./bridge-handler";
import type { BotConfig } from "./config";
import type { AuditSink, ExecutionResult, WalletRef } from "./execute";
import { runLaunch } from "./launch-core";
import { clampReply, formatEthCeil, replies, stripBareAddresses } from "./replies";
import type { O1TokenSource } from "./o1-tokens";
import type { RelayClient } from "./relay";
import { tokenSiteUrl, type SiteGenerator } from "./site-core";
import { handleSite } from "./site-handler";
import type { SiteStore } from "./site-store";
import type { BotStore, MentionStatusValue } from "./store";
import type { TradeChain } from "./trade-core";
import { handleTrade } from "./trade-handler";
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
  /** Chain reads and the signing of a trade from a post. */
  trade: TradeChain;
  /** o1's token directory, for trading tokens the bot did not launch. */
  o1Tokens: O1TokenSource;
  /** Origin-chain reads and the Relay deposit for a bridge from a post. */
  bridge: BridgeChain;
  relay: RelayClient;
  /** Figures behind questions from posts: statistics, tokens, the poster's wallet, launches and trades. */
  askData: AskData;
  /** Token sites: reservations, versions and build jobs. */
  sites: SiteStore;
  /** The agent that writes a site; the worker runs it, the pipeline only queues jobs. */
  generateSite: SiteGenerator;
  /** Phrases the answer to a question from the facts, in the post's language; null means "use the template". Absent in tests. */
  compose?: (input: ComposeInput) => Promise<string | null>;
  /** Operator alerts; absent in tests and dry runs. */
  alerts?: Alerter;
  now?: () => Date;
};

export type PipelineOutcome =
  | { outcome: "duplicate" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "replied"; kind: "help" | "ask" | "site" | "clarify" | "unsupported_chain" | "not_registered" | "rejected"; reply: string | null }
  | { outcome: "dry_run"; launchId: string; token: Address; reply: string }
  | { outcome: "launched"; launchId: string; token: Address; txHash: Hex; feeRecipientTxHash: Hex | null; reply: string | null }
  | { outcome: "trade_dry_run"; tradeId: string; reply: string }
  | { outcome: "traded"; tradeId: string; txHash: Hex; reply: string | null }
  | { outcome: "bridge_dry_run"; bridgeId: string; reply: string }
  | { outcome: "bridged"; bridgeId: string; depositTxHash: Hex; fillTxHash: Hex | null; reply: string | null }
  | { outcome: "failed"; error: string; reply: string | null; launchId: string | null };

type ReplyResult = { text: string; tweetId: string | null; posted: boolean; error: string | null };

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Handles X prepends to a reply, lowercased and without the @, in order. */
export function leadingHandles(text: string): string[] {
  const m = text.match(/^(\s*@\w{1,15}\s+)+/);
  if (!m) return [];
  return [...m[0].matchAll(/@(\w{1,15})/g)].map((x) => x[1]!.toLowerCase());
}

export async function processMention(mention: XMention, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const alerts = deps.alerts ?? noAlerts;
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
    // A user who asked for English on the profile gets English, whatever language they posted in.
    const prefs = await store.userPrefs(mention.authorId);
    const replyLanguage = prefs.replyLanguage === "en" ? "en" : language;
    const localized = clampReply(opts.raw ? text : await deps.localize(text, replyLanguage));
    try {
      const tweetId = await deps.x.postReply(localized, mention.id);
      await store.updateMention(mentionId, { replyTweetId: tweetId });
      return { text: localized, tweetId, posted: true, error: null };
    } catch (err) {
      // X blocks bare crypto addresses from young authentications. Use the reply's own address-free
      // variant when it has one; otherwise strip the addresses out of the text that was refused.
      if (err instanceof XPostError && err.cryptoAddressBlocked) {
        const safe = opts.safe ? clampReply(await deps.localize(opts.safe, replyLanguage)) : stripBareAddresses(localized);
        if (safe !== localized) {
          log.warn({ own: Boolean(opts.safe) }, "X refused a crypto address in the reply; sending the address-free variant");
          try {
            const tweetId = await deps.x.postReply(safe, mention.id);
            await store.updateMention(mentionId, { replyTweetId: tweetId });
            return { text: safe, tweetId, posted: true, error: null };
          } catch (err2) {
            err = err2;
          }
        }
      }
      const error = `reply failed: ${errMessage(err)}`;
      log.error({ err: errMessage(err) }, "could not post reply");
      alerts.send({ kind: "reply_failed", title: "X refused a reply", key: `reply:${mention.authorId}`, fields: [["User", `@${mention.authorHandle}`], ["Post", postUrl(mention.authorHandle, mention.id)], ["Reply", localized], ["Error", errMessage(err)]] });
      await store.updateMention(mentionId, { error });
      return { text: localized, tweetId: null, posted: false, error };
    }
  };

  // 2. Parse.
  let parsed: ParsedMention;
  try {
    parsed = await deps.parse({
      text: stripLeadingMentions(mention.text),
      authorHandle: mention.authorHandle,
      hasImage: Boolean(mention.imageUrl),
      tweetId: mention.id,
      alsoTagged: leadingHandles(mention.text).filter((h) => h !== config.botHandle.toLowerCase() && h !== mention.authorHandle.toLowerCase()),
      isReply: mention.referenced.some((r) => r.type === "replied_to"),
    });
  } catch (err) {
    const error = err instanceof ParserError ? `parser: ${err.message}` : `parser: ${errMessage(err)}`;
    log.error({ err: errMessage(err) }, "parse failed");
    alerts.send({ kind: "parser_failed", title: "Parser failed", key: "parser", fields: [["User", `@${mention.authorHandle}`], ["Post", postUrl(mention.authorHandle, mention.id)], ["Error", errMessage(err)]] });
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
    case "ask":
      return handleAsk(result, { mention, mentionId, deps, now, log, reply, setMention });
    case "site":
      return handleSite(result, { mention, mentionId, deps, now, log, reply, setMention });
    case "launch":
      return handleLaunch(result, { mention, mentionId, deps, now, log, reply, setMention });
    case "trade":
      return handleTrade(result, { mention, mentionId, deps, now, log, reply, setMention });
    case "bridge":
      return handleBridge(result, { mention, mentionId, deps, now, log, reply, setMention });
  }
}

export type MentionContext = {
  mention: XMention;
  mentionId: string;
  deps: PipelineDeps;
  now: () => Date;
  log: typeof logger;
  reply: (text: string, opts?: { safe?: string; raw?: boolean }) => Promise<ReplyResult>;
  setMention: (status: MentionStatusValue, extra?: { error?: string | null }) => Promise<void>;
};

async function handleLaunch(cmd: LaunchCommand, ctx: MentionContext): Promise<PipelineOutcome> {
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
  const key = cmd.chain ?? DEFAULT_CHAIN_KEY;
  const quote = findQuote(key, cmd.pair);
  if (!quote) return rejected(replies.pairUnavailable(cmd.pair, config.siteUrl, chainDisplayName(key)), `pair not registered on ${key}: ${cmd.pair}`);
  if (tickerCollidesWithStock(key, cmd.ticker)) return rejected(replies.tickerCollides(cmd.ticker), `ticker collides with stock: ${cmd.ticker}`);

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
      // The recipient may have switched fee redirects off on their profile.
      if (!(await store.userPrefs(target.xUserId)).acceptFeeRedirects) {
        return rejected(replies.feesToRejected(feesTo.handle, "declined"), `fees to declined by recipient: ${feesTo.handle}`);
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

  // 8b. A website on a subdomain: reserve the name before anything is signed, so the
  // metadata can point at it and no other launch can take it in the meantime.
  let site: { id: string; slug: string; url: string } | null = null;
  if (cmd.siteSlug) {
    const check = cmd.siteSlug === "auto" ? slugFromTicker(cmd.ticker) : checkSlug(cmd.siteSlug);
    if (!check.ok) return rejected(replies.siteInvalid(check.slug || cmd.siteSlug, check.reason), `site slug ${check.reason}: ${cmd.siteSlug}`);
    const reserved = await deps.sites.reserve({ slug: check.slug, chainId: chainByKey(key).id, ownerId: creator.id });
    if (!reserved.ok) return rejected(replies.siteTaken(check.slug, config.sitesRootDomain), `site slug taken: ${check.slug}`);
    site = { id: reserved.site.id, slug: check.slug, url: tokenSiteUrl(config, check.slug) };
    log.info({ slug: check.slug, url: site.url }, "site subdomain reserved");
  }

  // 9. Persist the launch, then run the shared core (metadata, plan, funding, signing).
  const launch = await store.createLaunch({
    mentionId,
    source: "X",
    creatorUserId: creator.id,
    feeRecipientUserId: recipient?.userId ?? null,
    chainId: chainByKey(key).id,
    factory: activeFactory(key),
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
  if (site) await deps.sites.update(site.id, { launchId });
  await setMention("QUEUED");

  const result = await runLaunch(
    {
      launchId,
      wallet,
      author: { xUserId: mention.authorId, handle: authorHandle },
      quote,
      chain: key,
      ticker: cmd.ticker,
      name: cmd.name,
      devBuyWei: devBuy.wei,
      devBuyNative: cmd.devBuyNative,
      description: cmd.description,
      // The token's own site is its website unless the creator named another.
      website: cmd.website ?? site?.url ?? null,
      telegram: cmd.telegram,
      xHandle: cmd.xHandle,
      image: { url: cmd.imageFromTweet ? mention.imageUrl : null },
      origin: { kind: "x", tweetId: mention.id, tweetUrl: `https://x.com/${authorHandle}/status/${mention.id}` },
      recipient,
      tokenSiteUrl: site?.url ?? null,
    },
    deps,
    log,
  );

  // A launch that did not happen frees its subdomain; one that did gets its site built by the worker.
  if (site && (!result.ok || result.dryRun)) {
    await deps.sites.release(site.id);
    site = null;
  } else if (site && result.ok) {
    await deps.sites.update(site.id, { token: result.token });
    await deps.sites.createJob({ siteId: site.id, instruction: null, baseN: null, mentionId, createdById: creator.id });
    log.info({ siteId: site.id, slug: site.slug }, "site build queued");
  }

  if (!result.ok) {
    if (result.outcome === "rejected") {
      const r = await reply(result.userText, result.safeText ? { safe: result.safeText } : {});
      await setMention("REJECTED", { error: result.error });
      return { outcome: "replied", kind: "rejected", reply: r.posted || config.dryRun ? r.text : null };
    }
    const r = await reply(result.userText);
    await setMention(result.terminal, { error: result.error });
    return { outcome: "failed", error: result.error, reply: r.posted || config.dryRun ? r.text : null, launchId };
  }

  if (result.dryRun) {
    const r = await reply(result.userText);
    await setMention("DONE");
    return { outcome: "dry_run", launchId, token: result.token, reply: r.text };
  }

  // Success reply. A failed post never undoes the launch.
  const r = await reply(result.userText);
  if (r.posted) {
    await store.updateLaunch(launchId, { status: "REPLIED" });
    await setMention("DONE");
  } else {
    await setMention("FAILED", { error: r.error ?? "reply not posted" });
  }
  return { outcome: "launched", launchId, token: result.token, txHash: result.txHash, feeRecipientTxHash: result.feeRecipientTxHash, reply: r.posted ? r.text : null };
}
