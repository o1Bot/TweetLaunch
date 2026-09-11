import { db, dbConfigured } from "@o1bot/db";
import { userFromRequest } from "@o1bot/wallet";
import { sitesForLaunches } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/launch/:id — progress of one of the caller's own launches, with its site when one was asked for. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!dbConfigured()) return Response.json({ error: "database not configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const launch = await db().launch.findFirst({
    where: { id, creator: { xUserId: user.xUserId } },
    select: { id: true, status: true, ticker: true, name: true, quoteSymbol: true, tokenAddress: true, launchTxHash: true, feeRecipientTxHash: true, userMessage: true, createdAt: true, updatedAt: true },
  });
  if (!launch) return Response.json({ error: "not found" }, { status: 404 });
  const sites = await sitesForLaunches([launch.id]);
  return Response.json({ ...launch, site: sites.get(launch.id) ?? null });
}
