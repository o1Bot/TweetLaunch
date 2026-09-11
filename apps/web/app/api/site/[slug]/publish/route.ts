import { userFromRequest } from "@o1bot/wallet";
import { publishSiteVersion, siteForOwner } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/site/:slug/publish — serve version n at the site's address. Body: { n: number }. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { slug } = await params;
  const site = await siteForOwner(slug, user.xUserId);
  if (!site) return Response.json({ error: "not found" }, { status: 404 });
  let n: unknown;
  try {
    n = ((await req.json()) as { n?: unknown }).n;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return Response.json({ error: "invalid version" }, { status: 400 });
  if (!(await publishSiteVersion(site, n))) return Response.json({ error: "no such version" }, { status: 404 });
  return Response.json({ ok: true, publishedN: n });
}
