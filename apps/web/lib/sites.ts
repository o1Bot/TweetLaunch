import { db, dbConfigured, type TokenSite, type TokenSiteVersion } from "@o1bot/db";
import { filesFromList, type LiveData, type SiteFile, type SiteFiles, type SiteMeta } from "@o1bot/sites";
import { chainKeyOf, EXPLORER } from "./chains-web";
import { getHolders } from "./holders";
import { publicIpfsUrl } from "./ipfs";
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
  // Served on another origin and fetched by link-preview crawlers: the public gateway, not the metered one.
  const logoUrl = publicIpfsUrl(detail?.imageUrl ?? site.launch?.imageUri) ?? null;
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
