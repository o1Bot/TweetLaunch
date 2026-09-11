import { userFromRequest } from "@o1bot/wallet";
import { ownerSiteView, siteForOwner } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/:slug — one of the caller's own token sites: status, versions, recent jobs. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { slug } = await params;
  const site = await siteForOwner(slug, user.xUserId);
  if (!site) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(await ownerSiteView(site));
}
