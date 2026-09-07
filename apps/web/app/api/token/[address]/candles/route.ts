import { isTimeframe } from "@o1bot/market";
import { getCandles } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/token/:address/candles?tf=15m — OHLCV in the pair asset, gaps filled. */
export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const tf = new URL(req.url).searchParams.get("tf") ?? "15m";
  if (!isTimeframe(tf)) return Response.json({ error: "bad_timeframe" }, { status: 400 });
  const result = await getCandles(address, tf);
  if (!result) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ data: result.candles, quoteSymbol: result.quoteSymbol, tf });
}
