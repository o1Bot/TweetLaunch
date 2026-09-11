import { db, dbConfigured, type Prisma, type TokenSite, type TokenSiteVersion } from "@o1bot/db";
import { filesFromList, renderSite, type LiveData, type SiteFile, type SiteFiles, type SiteMeta } from "@o1bot/sites";
import { chainKeyOf, EXPLORER } from "./chains-web";
import { getHolders } from "./holders";
import { ipfsToHttp } from "./ipfs";
import { getTokenDetail } from "./market";
import { fetchTokenMetadata } from "./metadata";

/**
 * Read side of the token sites: which version is published for a slug, and
 * the live numbers the o1bot blocks show. Everything comes from the same
 * tables and helpers the token page uses, so a site and its token page never
 * disagree.
 */

export const SITES_ROOT_DOMAIN = process.env.SITES_ROOT_DOMAIN ?? "o1bot.exchange";
/** The app's own origin, for links back to the board, token pages and the editor. */
export const APP_ORIGIN = (process.env.SITE_URL ?? `https://${SITES_ROOT_DOMAIN}`).replace(/\/$/, "");

const launchSelect = { name: true, ticker: true, imageUri: true, metadataUri: true, tokenAddress: true, quoteSymbol: true, request: true } as const;
type SiteRow = TokenSite & { launch: { name: string; ticker: string; imageUri: string | null; metadataUri: string | null; tokenAddress: string | null; quoteSymbol: string; request: unknown } | null };

export type SiteLookup =
  | { state: "unknown" }
  | { state: "reserved" | "generating" | "failed" }
  | { state: "live"; site: SiteRow; version: TokenSiteVersion; files: SiteFiles };

export async function lookupSite(slug: string): Promise<SiteLookup> {
  if (!dbConfigured()) return { state: "unknown" };
  const site = await db().tokenSite.findUnique({ where: { slug }, include: { launch: { select: launchSelect } } });
  if (!site || site.status === "RELEASED") return { state: "unknown" };
  if (site.publishedN === null) return { state: site.status === "FAILED" ? "failed" : site.status === "GENERATING" ? "generating" : "reserved" };
  const version = await db().tokenSiteVersion.findUnique({ where: { siteId_n: { siteId: site.id, n: site.publishedN } } });
  if (!version) return { state: "generating" };
  return { state: "live", site, version, files: filesFromList(version.files as SiteFile[]) };
}

const chainLabel = (chain: "robinhood" | "base") => (chain === "base" ? "Base" : "Robinhood Chain");

/** Links the creator gave on the web form, kept on the launch row. */
function requestLinks(request: unknown): { website: string | null; telegram: string | null; x: string | null } {
  const r = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const xHandle = str(r.xHandle);
  return { website: str(r.website), telegram: str(r.telegram), x: xHandle ? `https://x.com/${xHandle.replace(/^@/, "")}` : null };
}

export async function liveDataFor(site: SiteRow): Promise<{ live: LiveData; meta: SiteMeta }> {
  const chain = chainKeyOf(site.chainId);
  const token = site.token ?? site.launch?.tokenAddress ?? null;
  const detail = token ? await getTokenDetail(token).catch(() => null) : null;
  const name = detail?.name ?? site.launch?.name ?? site.slug;
  const symbol = detail?.symbol ?? site.launch?.ticker ?? site.slug.toUpperCase();
  // The configured gateway, as on the token page: o1bot mirrors every launch pin into its own account.
  const logoUrl = detail?.imageUrl ?? ipfsToHttp(site.launch?.imageUri) ?? null;
  const [holders, metadata] = await Promise.all([
    token ? getHolders(token, site.chainId).then((h) => h.total).catch(() => null) : Promise.resolve(null),
    fetchTokenMetadata(detail?.metadataUri ?? site.launch?.metadataUri).catch(() => null),
  ]);
  const fromForm = requestLinks(site.launch?.request);
  const ownSite = `https://${site.slug}.${SITES_ROOT_DOMAIN}`;
  // The metadata's website is this very site; a different one is a link worth showing.
  const website = [metadata?.website, fromForm.website].find((w) => w && !w.startsWith(ownSite)) ?? null;
  const pageUrl = token ? `${APP_ORIGIN}/token/${token}` : APP_ORIGIN;
  const live: LiveData = {
    name,
    symbol,
    chain,
    token,
    status: token ? "live" : "pending",
    priceUsd: detail?.stats.priceUsd ?? null,
    mcapUsd: detail?.stats.mcapUsd ?? null,
    holders,
    volume24hUsd: detail?.stats.volume24hUsd ?? null,
    change24hPct: detail?.stats.change24hPct ?? null,
    pairSymbol: detail?.quoteSymbol ?? site.launch?.quoteSymbol ?? null,
    logoUrl,
    pageUrl,
    buyUrl: pageUrl,
    explorerUrl: token ? `${EXPLORER[chain]}/token/${token}` : null,
    socials: { x: metadata?.x ?? fromForm.x, telegram: metadata?.telegram ?? fromForm.telegram, website },
    launchedAt: detail?.launchedAt ?? null,
  };
  const description = (metadata?.description ?? `$${symbol} on ${chainLabel(chain)}, launched through ${SITES_ROOT_DOMAIN}.`).replace(/\s+/g, " ").slice(0, 160);
  const meta: SiteMeta = { slug: site.slug, rootDomain: SITES_ROOT_DOMAIN, title: `${name} ($${symbol})`, description, lang: "en", ogImage: logoUrl };
  return { live, meta };
}

/* ── The editor: owner-only reads and writes ─────────────────────────── */

/** Builds and revisions a site may ask the agent for per UTC day. */
export const SITE_JOBS_PER_DAY = 30;

const ownerInclude = { launch: { select: launchSelect }, owner: { select: { xUserId: true } } } as const;
export type OwnerSiteRow = Prisma.TokenSiteGetPayload<{ include: typeof ownerInclude }>;

export type OwnerSiteView = {
  slug: string;
  status: string;
  url: string;
  publishedN: number | null;
  token: string | null;
  chainId: number;
  launch: { name: string; ticker: string; logoUrl: string | null } | null;
  versions: Array<{ n: number; summary: string | null; prompt: string | null; createdAt: string }>;
  jobs: Array<{ id: string; status: string; instruction: string | null; versionN: number | null; error: string | null; createdAt: string }>;
  jobsToday: number;
  jobsPerDay: number;
};

/** The site with this slug when the caller owns it; null otherwise (the API answers 404 either way). */
export async function siteForOwner(slug: string, xUserId: string): Promise<OwnerSiteRow | null> {
  if (!dbConfigured()) return null;
  const site = await db().tokenSite.findUnique({ where: { slug }, include: ownerInclude });
  if (!site || site.status === "RELEASED" || site.owner.xUserId !== xUserId) return null;
  return site;
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export async function ownerSiteView(site: OwnerSiteRow): Promise<OwnerSiteView> {
  const [versions, jobs, jobsToday] = await Promise.all([
    db().tokenSiteVersion.findMany({ where: { siteId: site.id }, orderBy: { n: "desc" }, select: { n: true, summary: true, prompt: true, createdAt: true } }),
    db().tokenSiteJob.findMany({ where: { siteId: site.id }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, status: true, instruction: true, versionN: true, error: true, createdAt: true } }),
    db().tokenSiteJob.count({ where: { siteId: site.id, createdAt: { gte: startOfUtcDay(new Date()) } } }),
  ]);
  return {
    slug: site.slug,
    status: site.status,
    url: `https://${site.slug}.${SITES_ROOT_DOMAIN}`,
    publishedN: site.publishedN,
    token: site.token,
    chainId: site.chainId,
    launch: site.launch ? { name: site.launch.name, ticker: site.launch.ticker, logoUrl: ipfsToHttp(site.launch.imageUri) } : null,
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    jobs: jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString() })),
    jobsToday,
    jobsPerDay: SITE_JOBS_PER_DAY,
  };
}

export type QueueResult = { ok: true; id: string } | { ok: false; reason: "limit" | "busy" | "no_version" };

/** Ask the agent for a revision (or the first build again); the bot worker runs it. One job at a time per site. */
export async function queueSiteJob(site: OwnerSiteRow, input: { instruction: string | null; baseN: number | null }): Promise<QueueResult> {
  const [today, active] = await Promise.all([
    db().tokenSiteJob.count({ where: { siteId: site.id, createdAt: { gte: startOfUtcDay(new Date()) } } }),
    db().tokenSiteJob.count({ where: { siteId: site.id, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  if (today >= SITE_JOBS_PER_DAY) return { ok: false, reason: "limit" };
  if (active > 0) return { ok: false, reason: "busy" };
  if (input.baseN !== null && !(await db().tokenSiteVersion.findUnique({ where: { siteId_n: { siteId: site.id, n: input.baseN } }, select: { n: true } }))) return { ok: false, reason: "no_version" };
  const job = await db().tokenSiteJob.create({ data: { siteId: site.id, instruction: input.instruction, baseN: input.baseN, createdById: site.ownerId } });
  return { ok: true, id: job.id };
}

export async function publishSiteVersion(site: OwnerSiteRow, n: number): Promise<boolean> {
  const version = await db().tokenSiteVersion.findUnique({ where: { siteId_n: { siteId: site.id, n } }, select: { n: true } });
  if (!version) return false;
  await db().tokenSite.update({ where: { id: site.id }, data: { publishedN: n, status: "LIVE", error: null } });
  return true;
}

/** The document a version renders to, with the live numbers of the moment; what the editor previews. */
export async function renderSiteVersion(site: OwnerSiteRow, n: number): Promise<string | null> {
  const version = await db().tokenSiteVersion.findUnique({ where: { siteId_n: { siteId: site.id, n } } });
  if (!version) return null;
  const { live, meta } = await liveDataFor(site);
  return renderSite(filesFromList(version.files as SiteFile[]), meta, live);
}
