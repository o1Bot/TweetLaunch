import { listBoardTokens } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/tokens — board rows for every token launched through o1bot. */
export async function GET() {
  const rows = await listBoardTokens();
  return Response.json({ data: rows, generatedAt: new Date().toISOString() });
}
