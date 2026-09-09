import { getAddress, isAddress } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { ipfsToHttp } from "@/lib/ipfs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=cat → tokens on the board whose symbol, name or address
 * matches, for the header search box. Only pools the bot launched (plus
 * dev rows when they are shown), at most eight, symbol matches first.
 */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q || !dbConfigured()) return Response.json({ data: [] });
  const where = isAddress(q, { strict: false })
    ? { token: getAddress(q.toLowerCase()) }
    : { OR: [{ symbol: { contains: q, mode: "insensitive" as const } }, { name: { contains: q, mode: "insensitive" as const } }] };
  const rows = await db().pool.findMany({
    where: { source: "BOT", ...where },
    orderBy: { launchedAt: "desc" },
    take: 24,
    select: { token: true, symbol: true, name: true, imageUri: true, quoteSymbol: true },
  });
  const needle = q.toLowerCase();
  const rank = (r: (typeof rows)[number]) => (r.symbol.toLowerCase() === needle ? 0 : r.symbol.toLowerCase().startsWith(needle) ? 1 : r.name.toLowerCase().startsWith(needle) ? 2 : 3);
  const data = rows
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 8)
    .map((r) => ({ token: r.token, symbol: r.symbol, name: r.name, imageUrl: ipfsToHttp(r.imageUri), quoteSymbol: r.quoteSymbol }));
  return Response.json({ data });
}
