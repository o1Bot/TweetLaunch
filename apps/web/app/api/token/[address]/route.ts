import { getTokenDetail } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/token/:address — detail, stats and the latest trades of one o1bot launch. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const token = await getTokenDetail(address);
  if (!token) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: token });
}
