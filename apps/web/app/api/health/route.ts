import { db, dbConfigured } from "@o1bot/db";
import { indexerHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health → whether the market data is fresh.
 *
 * 200 with ok:true when the indexer cursor moved within the last five
 * minutes, 503 otherwise (or when the database is unreachable), so an
 * uptime monitor pointed at this URL alerts on the status code alone. The
 * banner on every page reads the same endpoint.
 */
export async function GET() {
  const now = new Date();
  const headers = { "cache-control": "no-store" };
  if (!dbConfigured()) return Response.json({ ok: false, db: false, indexer: null, now: now.toISOString() }, { status: 503, headers });
  try {
    const [cursor, lastSwap] = await Promise.all([
      db().indexerCursor.findUnique({ where: { id: "swaps" }, select: { blockNumber: true, updatedAt: true } }),
      db().swap.findFirst({ orderBy: [{ blockNumber: "desc" }], select: { timestamp: true } }),
    ]);
    const health = indexerHealth(cursor?.updatedAt ?? null, now);
    const body = {
      ok: health.ok,
      db: true,
      indexer: { ...health, cursorBlock: cursor?.blockNumber.toString() ?? null, cursorAt: cursor?.updatedAt.toISOString() ?? null },
      lastSwapAt: lastSwap?.timestamp.toISOString() ?? null,
      now: now.toISOString(),
    };
    return Response.json(body, { status: health.ok ? 200 : 503, headers });
  } catch {
    return Response.json({ ok: false, db: false, indexer: null, now: now.toISOString() }, { status: 503, headers });
  }
}
