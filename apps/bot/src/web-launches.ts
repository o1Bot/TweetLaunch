import { noAlerts } from "./alerts";
import type { Address } from "viem";
import { chainByKey, findQuote, logger, tickerCollidesWithStock } from "@o1bot/shared";
import { checkSlug } from "@o1bot/sites";
import type { LinkedUser } from "@o1bot/wallet";
import type { WalletRef } from "./execute";
import { runLaunch } from "./launch-core";
import type { PipelineDeps } from "./pipeline";
import { formatEthCeil, replies } from "./replies";
import { tokenSiteUrl } from "./site-core";
import type { WebLaunchJob } from "./store";
import { checkDevBuy, checkFeesToHandle, checkRate, startOfUtcDay } from "./validator";

/**
 * Launches submitted through the web form. The web app only records the
 * request; this worker runs it with the same checks and the same signing
 * path as a post on X, and leaves the outcome on the Launch row for the
 * page to show. Nothing is posted on X for web launches.
 */

const CHAIN_KEY = "robinhood" as const;

export type WebLaunchOutcome = { id: string; outcome: "launched" | "dry_run" | "rejected" | "failed"; token: Address | null; message: string };

export async function processWebLaunch(job: WebLaunchJob, deps: PipelineDeps): Promise<WebLaunchOutcome> {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = logger.child({ launchId: job.id, source: "web", author: job.creator.xHandle });

  const reject = async (error: string, message: string): Promise<WebLaunchOutcome> => {
    log.info({ error }, "web launch rejected");
    await store.updateLaunch(job.id, { status: "FAILED", error, userMessage: message, imageData: null });
    return { id: job.id, outcome: "rejected", token: null, message };
  };

  // 1. The account must still be linked with o1bot's signer on the wallet.
  const link = await deps.resolveLink(job.creator.xUserId);
  if (!link.linked) return reject(`not linked: ${link.reason}`, replies.notRegistered(config.siteUrl));
  const wallet: WalletRef = { walletId: link.wallet.walletId!, address: link.wallet.address };
  const handle = job.creator.xHandle || link.user.xHandle || "unknown";

  // 2. Same abuse limits as on X. The queued row itself is not counted.
  const rate = checkRate({
    lastLaunchAt: await store.lastLaunchAt(job.creator.xUserId),
    launchesToday: await store.launchCountSince(job.creator.xUserId, startOfUtcDay(now())),
    now: now(),
    cooldownSeconds: config.cooldownSeconds,
    maxPerDay: config.maxLaunchesPerDay,
  });
  if (!rate.ok) return reject(`rate limit: ${rate.reason}`, replies.slowDown(rate.reason, rate.retryAfterSeconds, config.cooldownSeconds));

  // 3. Pair, ticker and dev buy, re-checked here even though the form did.
  const quote = findQuote(CHAIN_KEY, job.quoteAddress);
  if (!quote) return reject(`pair not registered: ${job.quoteAddress}`, replies.pairUnavailable(job.quoteAddress, config.siteUrl));
  if (tickerCollidesWithStock(CHAIN_KEY, job.ticker)) return reject(`ticker collides with stock: ${job.ticker}`, replies.tickerCollides(job.ticker));
  const devBuy = checkDevBuy(job.request.devBuyNative, config.maxDevBuyWei);
  if (!devBuy.ok) return reject(`dev buy ${devBuy.reason}`, devBuy.reason === "invalid" ? replies.devBuyInvalid() : replies.devBuyTooLarge(formatEthCeil(config.maxDevBuyWei)));

  // 4. Optional fee recipient, resolved through X and Privy exactly as for a post.
  const feesTo = checkFeesToHandle(job.request.feesToHandle, config.reservedHandles, handle);
  if (!feesTo.ok) return reject(`fees to rejected: ${feesTo.reason}`, replies.feesToRejected(job.request.feesToHandle ?? "", feesTo.reason));
  let recipient: { handle: string; userId: string; address: Address } | null = null;
  if (feesTo.handle) {
    const lookup = await deps.x.lookupUser(feesTo.handle);
    if (!lookup.found) return reject(`fees to ${lookup.reason}: ${feesTo.handle}`, replies.feesToRejected(feesTo.handle, lookup.reason));
    if (lookup.user.id !== job.creator.xUserId) {
      let target: LinkedUser;
      try {
        target = await deps.ensureRecipientWallet({ xUserId: lookup.user.id, username: lookup.user.username, name: lookup.user.name, avatarUrl: lookup.user.profileImageUrl });
      } catch (err) {
        return reject(`fee recipient wallet: ${err instanceof Error ? err.message : String(err)}`, replies.launchFailed("the fee recipient wallet could not be prepared"));
      }
      if (!target.wallet) return reject("fee recipient has no wallet", replies.launchFailed("the fee recipient wallet could not be prepared"));
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
      if (target.wallet.address.toLowerCase() !== wallet.address.toLowerCase()) {
        recipient = { handle: lookup.user.username.toLowerCase(), userId: targetUser.id, address: target.wallet.address };
      }
    }
  }

  // 4b. A website on a subdomain, as for a post: reserve the name before anything is signed, so
  // the metadata can point at it and no other launch can take it in the meantime.
  let site: { id: string; slug: string; url: string } | null = null;
  if (job.request.siteSlug) {
    const check = checkSlug(job.request.siteSlug);
    if (!check.ok) return reject(`site slug ${check.reason}: ${job.request.siteSlug}`, replies.siteInvalid(check.slug || job.request.siteSlug, check.reason));
    const reserved = await deps.sites.reserve({ slug: check.slug, chainId: chainByKey(CHAIN_KEY).id, ownerId: job.creator.id, launchId: job.id });
    if (!reserved.ok) return reject(`site slug taken: ${check.slug}`, replies.siteTakenForm(check.slug, config.sitesRootDomain));
    site = { id: reserved.site.id, slug: check.slug, url: tokenSiteUrl(config, check.slug) };
    log.info({ slug: check.slug, url: site.url }, "site subdomain reserved");
  }

  // 5. Shared core: metadata, plan, funding, dry run or sign + confirm + fee recipient.
  const result = await runLaunch(
    {
      launchId: job.id,
      wallet,
      author: { xUserId: job.creator.xUserId, handle },
      quote,
      ticker: job.ticker,
      name: job.name,
      devBuyWei: devBuy.wei,
      devBuyNative: job.request.devBuyNative,
      description: job.request.description,
      // The token's own site is its website unless the creator gave another.
      website: job.request.website ?? site?.url ?? null,
      telegram: job.request.telegram,
      xHandle: job.request.xHandle,
      image: { bytes: job.imageData },
      origin: { kind: "web" },
      recipient,
      tokenSiteUrl: site?.url ?? null,
    },
    deps,
    log,
  );

  // A launch that did not happen frees its subdomain; one that did gets its site built by the worker.
  if (site && (!result.ok || result.dryRun)) {
    await deps.sites.release(site.id);
  } else if (site && result.ok) {
    await deps.sites.update(site.id, { token: result.token });
    await deps.sites.createJob({ siteId: site.id, instruction: null, baseN: null, mentionId: null, createdById: job.creator.id });
    log.info({ siteId: site.id, slug: site.slug }, "site build queued");
  }

  if (!result.ok) return { id: job.id, outcome: result.outcome, token: null, message: result.userText };
  if (result.dryRun) return { id: job.id, outcome: "dry_run", token: result.token, message: result.userText };
  return { id: job.id, outcome: "launched", token: result.token, message: result.userText };
}

/** Process every queued web launch, one at a time, oldest first. Returns how many ran. */
export async function drainWebLaunches(deps: PipelineDeps, max = 20): Promise<number> {
  let ran = 0;
  while (ran < max) {
    const job = await deps.store.claimQueuedWebLaunch();
    if (!job) break;
    ran++;
    try {
      const out = await processWebLaunch(job, deps);
      logger.info({ ...out }, "web launch processed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ launchId: job.id, err: message }, "web launch crashed");
      (deps.alerts ?? noAlerts).send({ kind: "worker_crashed", title: "Web launch worker crashed", key: "web-worker", fields: [["Launch", job.id], ["User", `@${job.creator.xHandle}`], ["Error", message]] });
      await deps.store.updateLaunch(job.id, { status: "FAILED", error: `worker: ${message}`, userMessage: replies.launchFailed("an unexpected error, please try again") });
    }
  }
  return ran;
}

export type WebLaunchPoller = { stop(): Promise<void> };

/** Poll the database for queued web launches. Independent of the X poller. */
export function startWebLaunchPolling(deps: PipelineDeps, pollMs: number): WebLaunchPoller {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    try {
      await drainWebLaunches(deps);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "web launch poll failed; retrying next tick");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        inFlight = tick();
      }, pollMs);
    }
  };
  inFlight = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
