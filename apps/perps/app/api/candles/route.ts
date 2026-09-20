import { NextResponse } from "next/server";
import { MAX_BARS, isResolution, toBars, windowFor } from "@/lib/candles";
import { lighter } from "@/lib/lighter";

/** Serves timeframe switches on the chart. Kept server-side so the venue's base
 *  URL and any future key stay out of the browser. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const marketId = Number(url.searchParams.get("market"));
  const resolution = url.searchParams.get("resolution") ?? "";

  if (!Number.isInteger(marketId) || marketId < 0) {
    return NextResponse.json({ error: "bad market" }, { status: 400 });
  }
  if (!isResolution(resolution)) {
    return NextResponse.json({ error: "bad resolution" }, { status: 400 });
  }

  const { startMs, endMs } = windowFor(resolution, MAX_BARS);
  try {
    const res = await lighter.candles(marketId, resolution, startMs, endMs, MAX_BARS, {
      // A timeframe switch must show current bars, so this one is not cached.
      cache: "no-store",
    });
    return NextResponse.json({ bars: toBars(res.c) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "candles unavailable" },
      { status: 502 },
    );
  }
}
