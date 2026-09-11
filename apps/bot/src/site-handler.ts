import type { SiteCommand } from "@o1bot/parser";
import { checkSlug, slugFromTicker } from "@o1bot/sites";
import type { MentionContext, PipelineOutcome } from "./pipeline";
import { replies } from "./replies";
import { siteEditorUrl, tokenSiteUrl } from "./site-core";
import type { SiteLaunchInfo } from "./site-store";

/**
 * "build a site for $CAT": a website for a token that already exists. Only
 * the token's creator may ask. The handler reserves the subdomain and
 * queues the build; the worker writes the site and replies under this post
 * when it is live.
 */
export async function handleSite(cmd: SiteCommand, ctx: MentionContext): Promise<PipelineOutcome> {
  const { mention, mentionId, deps, log, reply, setMention } = ctx;
  const { sites, config } = deps;
  const siteUrl = config.siteUrl;

  const rejected = async (text: string, error: string, opts: { safe?: string } = {}): Promise<PipelineOutcome> => {
    const r = await reply(text, opts);
    await setMention("REJECTED", { error });
    return { outcome: "replied", kind: "rejected", reply: r.posted || config.dryRun ? r.text : null };
  };

  const link = await deps.resolveLink(mention.authorId);
  if (!link.linked) {
    log.info({ reason: link.reason }, "poster is not registered");
    const r = await reply(replies.notRegistered(siteUrl));
    await setMention("NOT_REGISTERED", { error: link.reason });
    return { outcome: "replied", kind: "not_registered", reply: r.posted || config.dryRun ? r.text : null };
  }

  // The token: one of the bot's own launches, live on chain, by this poster.
  const asked = cmd.tokenAddress ?? cmd.ticker ?? "";
  const candidates: SiteLaunchInfo[] = cmd.tokenAddress ? [await sites.launchByToken(cmd.tokenAddress)].filter((l): l is SiteLaunchInfo => l !== null) : await sites.launchesByTicker(cmd.ticker ?? "");
  const own = candidates.filter((c) => c.creator.xUserId === mention.authorId);
  if (candidates.length === 0) return rejected(replies.siteUnknownToken(asked, siteUrl), `site: token not found: ${asked}`);
  if (own.length === 0) return rejected(replies.siteNotCreator(asked), `site: poster is not the creator of ${asked}`);
  if (own.length > 1) {
    const fb = replies.siteAmbiguous(asked, own.map((c) => ({ name: c.name, token: c.tokenAddress ?? "" })));
    return rejected(fb.text, `site: ambiguous ticker ${asked}`, { safe: fb.safe });
  }
  const info = own[0]!;

  // A site that exists already: point at it, or retry a build that failed.
  const existing = await sites.byLaunch(info.launchId);
  if (existing && existing.status === "LIVE") {
    const r = await reply(replies.siteAlreadyLive(info.ticker, tokenSiteUrl(config, existing.slug), siteEditorUrl(config, existing.slug)));
    await setMention("DONE");
    return { outcome: "replied", kind: "site", reply: r.posted || config.dryRun ? r.text : null };
  }
  let slug: string;
  let siteId: string;
  if (existing) {
    slug = existing.slug;
    siteId = existing.id;
  } else {
    const check = cmd.slug ? checkSlug(cmd.slug) : slugFromTicker(info.ticker);
    if (!check.ok) return rejected(replies.siteInvalid(check.slug || cmd.slug || info.ticker, check.reason), `site slug ${check.reason}: ${cmd.slug ?? info.ticker}`);
    const reserved = await sites.reserve({ slug: check.slug, chainId: info.chainId, ownerId: info.creator.id, launchId: info.launchId, token: info.tokenAddress, status: "GENERATING" });
    if (!reserved.ok) return rejected(replies.siteTaken(check.slug, config.sitesRootDomain), `site slug taken: ${check.slug}`);
    slug = check.slug;
    siteId = reserved.site.id;
  }
  await sites.createJob({ siteId, instruction: null, baseN: null, mentionId, createdById: info.creator.id });
  log.info({ siteId, slug, launchId: info.launchId }, "site build queued from a post");
  const r = await reply(replies.siteQueued(info.ticker, tokenSiteUrl(config, slug)));
  await setMention("DONE");
  return { outcome: "replied", kind: "site", reply: r.posted || config.dryRun ? r.text : null };
}
