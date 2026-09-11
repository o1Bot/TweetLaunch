import { db } from "@o1bot/db";
import { userFromRequest } from "@o1bot/wallet";
import { siteForOwner } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/:slug/jobs/:id — progress of one build or revision. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { slug, id } = await params;
  const site = await siteForOwner(slug, user.xUserId);
  if (!site) return Response.json({ error: "not found" }, { status: 404 });
  const job = await db().tokenSiteJob.findFirst({ where: { id, siteId: site.id }, select: { id: true, status: true, instruction: true, versionN: true, error: true, createdAt: true, finishedAt: true } });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ ...job, createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null });
}
