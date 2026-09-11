import { siteCsp } from "@o1bot/sites";
import { userFromRequest } from "@o1bot/wallet";
import { APP_ORIGIN, renderSiteVersion, siteForOwner, SITES_ROOT_DOMAIN } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/site/:slug/preview?n=2 — the document version n renders to, for
 * the editor's preview frame. The same renderer and the same live numbers
 * as the public site, so the creator sees what visitors will.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await userFromRequest(req);
  if (!user) return new Response("unauthenticated", { status: 401 });
  const { slug } = await params;
  const site = await siteForOwner(slug, user.xUserId);
  if (!site) return new Response("not found", { status: 404 });
  const n = Number(new URL(req.url).searchParams.get("n") ?? site.publishedN ?? 0);
  if (!Number.isInteger(n) || n <= 0) return new Response("no version", { status: 404 });
  const html = await renderSiteVersion(site, n);
  if (html === null) return new Response("no such version", { status: 404 });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": siteCsp({ rootDomain: SITES_ROOT_DOMAIN, appUrl: APP_ORIGIN }), "cache-control": "no-store" } });
}
