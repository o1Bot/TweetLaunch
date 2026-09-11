import type { NextRequest } from "next/server";
import { placeholderPage, renderSite, siteCsp } from "@o1bot/sites";
import { APP_ORIGIN, liveDataFor, lookupSite, SITES_ROOT_DOMAIN } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must match the headers the proxy sets; a request that reaches this route any other way is refused. */
const SITE_HEADER = "x-o1bot-site";
const SITE_PATH_HEADER = "x-o1bot-site-path";

/**
 * Serves `<slug>.o1bot.app`. The proxy rewrites every request on a site
 * host here with the original path in a header; only the root path (and
 * robots.txt) exist on a site. The page is rendered from the published
 * version with the live numbers of the moment and cached at the edge for a
 * minute, so a popular site costs one render per minute, not one per visit.
 */

function htmlResponse(html: string, status: number, cache: string, imageOrigins: Array<string | null> = []): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": siteCsp({ rootDomain: SITES_ROOT_DOMAIN, appUrl: APP_ORIGIN, imageOrigins }),
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-robots-tag": status === 200 ? "all" : "noindex",
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (req.headers.get(SITE_HEADER) !== slug) return new Response("Not found", { status: 404 });
  const path = req.headers.get(SITE_PATH_HEADER) || "/";
  if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (path !== "/" && path !== "/index.html") return htmlResponse(placeholderPage(slug, SITES_ROOT_DOMAIN, "unknown", APP_ORIGIN), 404, "public, s-maxage=60");

  const found = await lookupSite(slug);
  if (found.state !== "live") {
    const status = found.state === "unknown" ? 404 : found.state === "suspended" ? 410 : 200;
    return htmlResponse(placeholderPage(slug, SITES_ROOT_DOMAIN, found.state, APP_ORIGIN), status, "public, s-maxage=30, stale-while-revalidate=60");
  }
  const { live, meta } = await liveDataFor(found.site);
  return htmlResponse(renderSite(found.files, meta, live), 200, "public, s-maxage=60, stale-while-revalidate=600", [live.logoUrl, meta.ogImage]);
}
