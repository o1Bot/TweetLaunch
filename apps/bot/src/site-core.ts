import { filesFromList, filesToList, logoPalette, siteUrl, type GenerateInput, type SiteBrief, type SiteFiles } from "@o1bot/sites";
import { logger } from "@o1bot/shared";
import type { XClient } from "@o1bot/x";
import { noAlerts, type Alerter } from "./alerts";
import type { BotConfig } from "./config";
import { clampReply, replies } from "./replies";
import type { SiteJobRecord, SiteLaunchInfo, SiteRecord, SiteStore } from "./site-store";
import type { BotStore } from "./store";
import { startOfUtcDay } from "./validator";

/**
 * Building a token site, wherever the request came from (a launch command
 * with "site", the site command on X, or the editor on the web): read the
 * launch behind the site, brief the agent, store what it wrote, publish
 * the first build, and tell the poster under their post when there is one.
 * Runs in the bot worker because a build takes a minute or two.
 */

/** What the agent returns, as the core needs it; `generateSite` from @o1bot/sites in production, a fake in tests. */
export type SiteGenerator = (input: GenerateInput) => Promise<{ html: string; css: string; title: string; description: string; summary: string }>;

export type SiteCoreDeps = {
  sites: SiteStore;
  store: BotStore;
  config: BotConfig;
  x: XClient;
  localize: (text: string, language: string | null) => Promise<string>;
  generateSite: SiteGenerator;
  alerts?: Alerter;
  now?: () => Date;
  fetchImpl?: typeof fetch;
};

/** Reservations that never saw a confirmed launch are freed after this long. */
export const RESERVATION_TTL_MS = 30 * 60_000;
const PUBLIC_GATEWAY = "https://gateway.pinata.cloud/ipfs";

type Logger = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const tokenSiteUrl = (config: BotConfig, slug: string) => siteUrl(slug, config.sitesRootDomain);
export const siteEditorUrl = (config: BotConfig, slug: string) => `${config.siteUrl}/site/${slug}`;

/** `ipfs://CID` on the public gateway; the dedicated one is metered and can refuse. */
export function publicLogoUrl(uri: string | null): string | null {
  if (!uri) return null;
  const path = uri.startsWith("ipfs://") ? uri.slice(7) : uri.match(/\/ipfs\/(.+)$/)?.[1];
  return path ? `${PUBLIC_GATEWAY}/${path}` : uri;
}

export async function buildBrief(site: SiteRecord, info: SiteLaunchInfo, language: string, deps: SiteCoreDeps): Promise<SiteBrief> {
  const { config } = deps;
  const logoUrl = publicLogoUrl(info.imageUri);
  let palette: string[] | null = null;
  if (logoUrl) {
    try {
      const res = await (deps.fetchImpl ?? fetch)(logoUrl, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) palette = await logoPalette(new Uint8Array(await res.arrayBuffer()));
    } catch {
      palette = null;
    }
  }
  const own = tokenSiteUrl(config, site.slug);
  const website = info.extras.website && !info.extras.website.startsWith(own) ? info.extras.website : null;
  const xHandle = (info.extras.xHandle ?? info.creator.xHandle).replace(/^@/, "");
  return {
    slug: site.slug,
    rootDomain: config.sitesRootDomain,
    name: info.name,
    symbol: info.ticker,
    chain: info.chainId === 8453 ? "base" : "robinhood",
    pairSymbol: info.quoteSymbol,
    description: info.extras.description,
    originPost: info.originPost,
    creatorHandle: info.creator.xHandle || null,
    logoUrl,
    palette: palette && palette.length ? palette : null,
    socials: { x: xHandle ? `https://x.com/${xHandle}` : null, telegram: info.extras.telegram, website },
    language,
  };
}

export type SiteJobOutcome = { ok: true; versionN: number; published: boolean; url: string } | { ok: false; error: string };

/**
 * One job: the site's first build (published as soon as it exists) or a
 * revision from the editor (stored, published by the creator). A failure
 * leaves a site that never had a version as FAILED and a live site as it
 * was; either way the creator can try again from the editor.
 */
export async function runSiteJob(job: SiteJobRecord, deps: SiteCoreDeps, log: Logger): Promise<SiteJobOutcome> {
  const { sites, config } = deps;
  const site = await sites.byId(job.siteId);
  if (!site) {
    await sites.finishJob(job.id, { error: "site not found" });
    return { ok: false, error: "site not found" };
  }
  const url = tokenSiteUrl(config, site.slug);
  const fail = async (error: string): Promise<SiteJobOutcome> => {
    log.error({ siteId: site.id, slug: site.slug, jobId: job.id, error }, "site build failed");
    await sites.finishJob(job.id, { error });
    if (site.publishedN === null) await sites.update(site.id, { status: "FAILED", error: error.slice(0, 500) });
    (deps.alerts ?? noAlerts).send({ kind: "site_failed", title: `Site build failed: ${site.slug}`, key: `site:${site.id}`, fields: [["Site", url], ["Job", job.id], ["Error", error]] });
    await notify(job, site, { ok: false, error }, deps, log);
    return { ok: false, error };
  };

  try {
    const info = site.launchId ? await sites.launchInfo(site.launchId) : site.token ? await sites.launchByToken(site.token) : null;
    if (!info) return fail("no launch behind this site");
    if (site.status !== "LIVE") await sites.update(site.id, { status: "GENERATING", error: null });
    const baseN = job.baseN ?? site.publishedN;
    const current: SiteFiles | null = baseN !== null ? await sites.version(site.id, baseN).then((v) => (v ? filesFromList(v.files) : null)) : null;
    const mention = job.mentionId ? await deps.store.getMention(job.mentionId) : null;
    const brief = await buildBrief(site, info, mention?.language ?? "en", deps);
    const out = await deps.generateSite({ brief, current, instruction: job.instruction });
    const version = await sites.addVersion(site.id, { files: filesToList({ html: out.html, css: out.css }), brief, prompt: job.instruction, summary: out.summary, createdById: job.createdById });
    // The first build goes live at once; revisions wait for the creator to publish them from the editor.
    const publish = site.publishedN === null || job.instruction === null;
    if (publish) await sites.update(site.id, { status: "LIVE", publishedN: version.n, token: site.token ?? info.tokenAddress, error: null });
    await sites.finishJob(job.id, { versionN: version.n });
    log.info({ siteId: site.id, slug: site.slug, jobId: job.id, versionN: version.n, published: publish }, publish ? "site published" : "site revision stored");
    const outcome: SiteJobOutcome = { ok: true, versionN: version.n, published: publish, url };
    await notify(job, site, outcome, deps, log);
    return outcome;
  } catch (err) {
    return fail(errMsg(err));
  }
}

/** Reply under the post that asked, once, within the poster's daily reply cap. Web-only jobs have no post. */
async function notify(job: SiteJobRecord, site: SiteRecord, outcome: SiteJobOutcome, deps: SiteCoreDeps, log: Logger): Promise<void> {
  if (!job.mentionId) return;
  const mention = await deps.store.getMention(job.mentionId);
  if (!mention) return;
  const { config, store } = deps;
  const text = outcome.ok ? replies.siteLive(outcome.url, siteEditorUrl(config, site.slug)) : replies.siteFailed(siteEditorUrl(config, site.slug));
  if (config.dryRun) {
    log.info({ reply: text, tweetId: mention.tweetId }, "dry run: would reply");
    return;
  }
  const now = deps.now ?? (() => new Date());
  const sent = await store.replyCountSince(mention.authorXUserId, startOfUtcDay(now()));
  if (sent >= config.maxRepliesPerDay) {
    log.warn({ sent }, "reply cap reached for this account; not announcing the site");
    return;
  }
  const prefs = await store.userPrefs(mention.authorXUserId);
  const localized = clampReply(await deps.localize(text, prefs.replyLanguage === "en" ? "en" : mention.language));
  try {
    const tweetId = await deps.x.postReply(localized, mention.tweetId);
    await store.updateMention(mention.id, { replyTweetId: tweetId });
  } catch (err) {
    log.error({ err: errMsg(err) }, "could not announce the site");
  }
}

/** Run queued jobs one at a time, oldest first. Returns how many ran. */
export async function drainSiteJobs(deps: SiteCoreDeps, max = 5): Promise<number> {
  let ran = 0;
  while (ran < max) {
    const job = await deps.sites.claimJob();
    if (!job) break;
    ran++;
    const log = logger.child({ jobId: job.id, siteId: job.siteId });
    try {
      await runSiteJob(job, deps, log);
    } catch (err) {
      log.error({ err: errMsg(err) }, "site job crashed");
      await deps.sites.finishJob(job.id, { error: `worker: ${errMsg(err)}` }).catch(() => undefined);
    }
  }
  return ran;
}

export type SiteJobPoller = { stop(): Promise<void> };

/** Poll the database for queued site jobs and free stale reservations. Independent of the X poller. */
export function startSiteJobPolling(deps: SiteCoreDeps, pollMs: number): SiteJobPoller {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const now = deps.now ?? (() => new Date());
  const tick = async () => {
    if (stopped) return;
    try {
      const freed = await deps.sites.expireReservations(new Date(now().getTime() - RESERVATION_TTL_MS));
      if (freed) logger.info({ freed }, "expired site reservations released");
      await drainSiteJobs(deps);
    } catch (err) {
      logger.warn({ err: errMsg(err) }, "site job poll failed; retrying next tick");
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
