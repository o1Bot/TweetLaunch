import { getAddress, isAddress } from "viem";
import { getHolders } from "@/lib/holders";
import { getTokenDetail } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/token/:address/holders — o1 holder snapshot, only for tokens we track. */
export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  if (!isAddress(address, { strict: false })) return Response.json({ error: "not_found" }, { status: 404 });
  const token = getAddress(address.toLowerCase());
  const known = await getTokenDetail(token);
  if (!known) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(await getHolders(token));
}
