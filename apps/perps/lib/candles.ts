import type { ApiCandle, CandleResolution } from "@o1bot/lighter";

export const RESOLUTIONS: CandleResolution[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

/** Bucket length per resolution, in seconds. */
export const SECONDS: Record<CandleResolution, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export function isResolution(v: string): v is CandleResolution {
  return (RESOLUTIONS as string[]).includes(v);
}

/** One bar for the chart. lightweight-charts wants seconds, the venue sends ms. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const MAX_BARS = 500;

/**
 * Verified live on 2026-09-20: /candles returns up to 500 bars ending at
 * `end_timestamp` and ignores both `count_back` and `start_timestamp` — asking
 * for 24 one-hour bars still came back with 500. So request the window, then
 * slice to what the chart should show rather than trusting the count.
 */
export function windowFor(resolution: CandleResolution, bars: number): { startMs: number; endMs: number } {
  const endMs = Date.now();
  return { startMs: endMs - SECONDS[resolution] * 1000 * bars, endMs };
}

export function toBars(candles: ApiCandle[], limit = MAX_BARS): Bar[] {
  const bars = candles
    // `t` is epoch MILLISECONDS; a chart fed milliseconds renders empty with no error.
    .map((c) => ({ time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c, volume: c.V }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time);

  // The venue can repeat the newest bucket across calls; a duplicate timestamp
  // makes lightweight-charts throw on setData.
  const deduped: Bar[] = [];
  for (const b of bars) {
    const last = deduped[deduped.length - 1];
    if (last && last.time === b.time) deduped[deduped.length - 1] = b;
    else deduped.push(b);
  }
  return deduped.slice(-limit);
}

/** The start of the bucket a moment falls in, in epoch seconds. */
export function bucketStart(resolution: CandleResolution, atMs = Date.now()): number {
  const size = SECONDS[resolution];
  return Math.floor(atMs / 1000 / size) * size;
}
