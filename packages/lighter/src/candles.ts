// Candle aggregation from the trade tape.
//
// The REST candlesticks endpoint on the RH instance returns 403 and there is no
// candlestick WS channel (verified 2026-07-29) — so candles are built from real
// prints: REST recentTrades (max 100) + the trade/{marketId} stream. This is exactly
// the role this app takes on ("candle aggregation"). Liquidations are
// counted too — they are real prints on the book.

export interface TapeTrade {
  trade_id: number;
  price: string;
  size: string;
  usd_amount?: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface Candle {
  /** Epoch seconds, start of the bucket. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote volume (USDG) in this bucket. */
  volumeQuote: number;
}

/** Pure aggregation — input may be unordered; output is always sorted ascending by time. */
export function aggregateCandles(
  trades: Iterable<TapeTrade>,
  resolutionSec: number,
): Candle[] {
  if (!Number.isInteger(resolutionSec) || resolutionSec <= 0) {
    throw new Error(`invalid resolution: ${resolutionSec}`);
  }
  type Working = Candle & { firstTs: number; lastTs: number };
  const buckets = new Map<number, Working>();

  for (const t of trades) {
    const price = Number(t.price);
    const volume = t.usd_amount !== undefined ? Number(t.usd_amount) : price * Number(t.size);
    const time = Math.floor(t.timestamp / 1000 / resolutionSec) * resolutionSec;
    const c = buckets.get(time);
    if (!c) {
      buckets.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeQuote: volume,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
      });
    } else {
      if (t.timestamp < c.firstTs) {
        c.open = price;
        c.firstTs = t.timestamp;
      }
      if (t.timestamp >= c.lastTs) {
        c.close = price;
        c.lastTs = t.timestamp;
      }
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.volumeQuote += volume;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ firstTs: _f, lastTs: _l, ...candle }) => candle);
}

export interface FillOptions {
  /** Fill flat buckets up to this time (epoch seconds) — usually "now". */
  untilSec?: number;
  /** Cap on the maximum bucket count (default 20,000). */
  maxBuckets?: number;
}

/**
 * Fill empty buckets with a flat candle at the previous close (volume 0) — the
 * standard way every exchange chart represents intervals without trades. Factual:
 * the last price truly does not change while no one trades. Without this,
 * thin-tape charts have holes.
 */
export function fillCandles(
  candles: Candle[],
  resolutionSec: number,
  opts: FillOptions = {},
): Candle[] {
  if (candles.length === 0) return candles;
  const maxBuckets = opts.maxBuckets ?? 20_000;
  const alignedUntil = opts.untilSec
    ? Math.floor(opts.untilSec / resolutionSec) * resolutionSec
    : 0;
  const end = Math.max(candles[candles.length - 1]!.time, alignedUntil);
  let start = candles[0]!.time;
  if ((end - start) / resolutionSec > maxBuckets) {
    start = end - maxBuckets * resolutionSec;
  }

  const byTime = new Map(candles.map((c) => [c.time, c]));
  const out: Candle[] = [];
  // Seed from the last real candle BEFORE the cutoff — the clamp must not
  // lose the price level carried into the window.
  let prevClose: number | undefined;
  for (const c of candles) {
    if (c.time < start) prevClose = c.close;
    else break;
  }
  for (let t = start; t <= end; t += resolutionSec) {
    const c = byTime.get(t);
    if (c) {
      out.push(c);
      prevClose = c.close;
    } else if (prevClose !== undefined) {
      out.push({
        time: t,
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        volumeQuote: 0,
      });
    }
  }
  return out;
}

interface FundingLike {
  timestamp: number;
  value: string;
  rate: string;
}

/**
 * Derive historical price points from funding history: value = mark × rate% →
 * mark = value / (rate/100). Precision depends on rate ≠ 0; unhealthy points are
 * skipped. The synthetic trade_id is negative and deterministic so it never
 * collides with real prints and dedupes safely across fetches.
 */
export function fundingPricePoints(fundings: FundingLike[]): TapeTrade[] {
  const out: TapeTrade[] = [];
  for (const f of fundings) {
    const rate = Number(f.rate);
    const value = Number(f.value);
    if (!(rate > 0) || !Number.isFinite(value) || value <= 0) continue;
    const price = value / (rate / 100);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      trade_id: -(f.timestamp * 1000 + 1),
      price: String(price),
      size: "0",
      usd_amount: "0",
      timestamp: f.timestamp * 1000,
    });
  }
  return out;
}

/** Tape with dedupe by trade_id — REST and WS snapshots may overlap. */
export class TradeTape {
  private byId = new Map<number, TapeTrade>();

  /** `true` if there is a new print never seen before. */
  add(trades: TapeTrade[]): boolean {
    let added = false;
    for (const t of trades) {
      if (!this.byId.has(t.trade_id)) {
        this.byId.set(t.trade_id, t);
        added = true;
      }
    }
    return added;
  }

  candles(resolutionSec: number): Candle[] {
    return aggregateCandles(this.byId.values(), resolutionSec);
  }

  /** All prints sorted ascending by time — for persistence. `cap` = keep the newest N. */
  toArray(cap?: number): TapeTrade[] {
    const all = [...this.byId.values()].sort((a, b) => a.timestamp - b.timestamp);
    return cap && all.length > cap ? all.slice(all.length - cap) : all;
  }

  /** Drop the oldest prints down to `cap` — memory guard for long sessions. */
  prune(cap: number): void {
    if (this.byId.size <= cap) return;
    const keep = this.toArray(cap);
    this.byId.clear();
    for (const t of keep) this.byId.set(t.trade_id, t);
  }

  get size(): number {
    return this.byId.size;
  }
}
