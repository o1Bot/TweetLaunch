export const TIMEFRAMES = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export function isTimeframe(v: string): v is Timeframe {
  return v in TIMEFRAMES;
}

export type PricePoint = {
  /** Unix seconds. */
  ts: number;
  /** Quote per token, human units. */
  price: number;
  /** Quote volume of the trade, human units. */
  volumeQuote: number;
};

export type Candle = {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Quote volume in the bucket. */
  v: number;
  /** Number of trades in the bucket (0 for filled gaps). */
  n: number;
};

/**
 * OHLCV candles from trade points. Trades are bucketed by
 * floor(ts / interval); with `fill`, empty buckets between the first and
 * last trade (or up to `to`) become flat candles at the previous close so
 * charts render continuous time.
 */
export function buildCandles(points: PricePoint[], intervalSec: number, opts: { fill?: boolean; to?: number } = {}): Candle[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const p of sorted) {
    const t = Math.floor(p.ts / intervalSec) * intervalSec;
    if (!cur || cur.t !== t) {
      if (cur) out.push(cur);
      const open: number = opts.fill && cur ? cur.c : p.price;
      cur = { t, o: open, h: Math.max(open, p.price), l: Math.min(open, p.price), c: p.price, v: p.volumeQuote, n: 1 };
    } else {
      cur.h = Math.max(cur.h, p.price);
      cur.l = Math.min(cur.l, p.price);
      cur.c = p.price;
      cur.v += p.volumeQuote;
      cur.n += 1;
    }
  }
  if (cur) out.push(cur);
  if (!opts.fill) return out;

  const filled: Candle[] = [];
  const end = opts.to !== undefined ? Math.floor(opts.to / intervalSec) * intervalSec : out[out.length - 1]!.t;
  let i = 0;
  let prevClose = out[0]!.o;
  for (let t = out[0]!.t; t <= end; t += intervalSec) {
    const c = out[i];
    if (c && c.t === t) {
      filled.push(c);
      prevClose = c.c;
      i++;
    } else {
      filled.push({ t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0, n: 0 });
    }
  }
  return filled;
}
