import { getAddress, isAddress } from "viem";
import { getTrades } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/token/:address/trades?limit=50 — newest first. */
export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) return Response.json({ error: "not_found" }, { status: 404 });
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const data = await getTrades(getAddress(address.toLowerCase()), Number.isFinite(limit) ? limit : 50);
  return Response.json({ data });
}
