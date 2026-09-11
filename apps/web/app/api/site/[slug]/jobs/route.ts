import { userFromRequest } from "@o1bot/wallet";
import { queueSiteJob, siteForOwner } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INSTRUCTION_MAX = 2000;

/**
 * POST /api/site/:slug/jobs — ask the agent to change the site (or to build
 * it again). Body: { instruction: string, baseN?: number }. The bot worker
 * runs the job; poll GET /api/site/:slug/jobs/:id for the outcome.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { slug } = await params;
  const site = await siteForOwner(slug, user.xUserId);
  if (!site) return Response.json({ error: "not found" }, { status: 404 });

  let body: { instruction?: unknown; baseN?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, INSTRUCTION_MAX) : "";
  const baseN = typeof body.baseN === "number" && Number.isInteger(body.baseN) && body.baseN > 0 ? body.baseN : null;
  // No instruction means "build it from scratch": allowed only when there is nothing yet or the last build failed.
  if (!instruction && site.publishedN !== null) return Response.json({ error: "instruction required" }, { status: 400 });

  const queued = await queueSiteJob(site, { instruction: instruction || null, baseN: instruction ? baseN : null });
  if (!queued.ok) {
    const status = queued.reason === "limit" ? 429 : queued.reason === "busy" ? 409 : 400;
    return Response.json({ error: queued.reason }, { status });
  }
  return Response.json({ id: queued.id }, { status: 202 });
}
