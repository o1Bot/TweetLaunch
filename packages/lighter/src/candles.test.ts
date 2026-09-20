import { describe, expect, it } from "vitest";
import {
  aggregateCandles,
  fillCandles,
  fundingPricePoints,
  TradeTape,
  type TapeTrade,
} from "./candles";

const t = (
  trade_id: number,
  timestampSec: number,
  price: string,
  size = "1",
  usd_amount?: string,
): TapeTrade => ({ trade_id, timestamp: timestampSec * 1000, price, size, usd_amount });

describe("aggregateCandles", () => {
  it("buckets per resolution: 0s,10s,70s @60s → 2 candles", () => {
    const candles = aggregateCandles(
      [t(1, 0, "100"), t(2, 10, "105"), t(3, 70, "103")],
      60,
    );
    expect(candles.map((c) => c.time)).toEqual([0, 60]);
    expect(candles[0]).toMatchObject({ open: 100, high: 105, low: 100, close: 105 });
    expect(candles[1]).toMatchObject({ open: 103, close: 103 });
  });

  it("unordered input stays correct: open from the first print, close from the last", () => {
    const [c] = aggregateCandles(
      [t(2, 30, "99"), t(1, 5, "101"), t(3, 55, "104")],
      60,
    );
    expect(c).toMatchObject({ open: 101, close: 104, high: 104, low: 99 });
  });

  it("quote volume: uses usd_amount, falls back to price*size", () => {
    const [c] = aggregateCandles(
      [t(1, 0, "100", "2", "200.5"), t(2, 1, "100", "3")],
      60,
    );
    expect(c).toBeDefined();
    expect(c!.volumeQuote).toBeCloseTo(200.5 + 300);
  });

  it("output always sorted ascending", () => {
    const candles = aggregateCandles(
      [t(1, 300, "1"), t(2, 0, "2"), t(3, 120, "3")],
      60,
    );
    expect(candles.map((c) => c.time)).toEqual([0, 120, 300]);
  });

  it("invalid resolution rejected", () => {
    expect(() => aggregateCandles([], 0)).toThrow();
    expect(() => aggregateCandles([], 1.5)).toThrow();
  });
});

describe("TradeTape", () => {
  it("dedupe by trade_id — REST and WS snapshots may overlap", () => {
    const tape = new TradeTape();
    expect(tape.add([t(1, 0, "100"), t(2, 10, "101")])).toBe(true);
    expect(tape.add([t(2, 10, "101"), t(1, 0, "100")])).toBe(false);
    expect(tape.size).toBe(2);
    const [c] = tape.candles(60);
    expect(c).toBeDefined();
    expect(c!.volumeQuote).toBeCloseTo(201); // counted once, not twice
  });

  it("one tape, many resolutions", () => {
    const tape = new TradeTape();
    tape.add([t(1, 0, "1"), t(2, 100, "2"), t(3, 700, "3")]);
    expect(tape.candles(60)).toHaveLength(3);
    expect(tape.candles(3600)).toHaveLength(1);
  });

  it("toArray: sorted ascending, cap keeps the newest", () => {
    const tape = new TradeTape();
    tape.add([t(3, 700, "3"), t(1, 0, "1"), t(2, 100, "2")]);
    expect(tape.toArray().map((x) => x.trade_id)).toEqual([1, 2, 3]);
    expect(tape.toArray(2).map((x) => x.trade_id)).toEqual([2, 3]);
  });

  it("prune: drops the oldest, dedupe still works afterwards", () => {
    const tape = new TradeTape();
    tape.add([t(1, 0, "1"), t(2, 100, "2"), t(3, 700, "3")]);
    tape.prune(2);
    expect(tape.size).toBe(2);
    expect(tape.toArray().map((x) => x.trade_id)).toEqual([2, 3]);
    expect(tape.add([t(2, 100, "2")])).toBe(false); // still deduped
  });
});

describe("fillCandles", () => {
  const sparse = aggregateCandles([t(1, 0, "100"), t(2, 30, "104"), t(3, 300, "90")], 60);
  // real buckets: 0 and 300 — buckets 60..240 empty

  it("holes filled with flat candles at the previous close, volume 0", () => {
    const filled = fillCandles(sparse, 60);
    expect(filled.map((c) => c.time)).toEqual([0, 60, 120, 180, 240, 300]);
    const flat = filled[2]!;
    expect(flat).toMatchObject({ open: 104, high: 104, low: 104, close: 104, volumeQuote: 0 });
    expect(filled[5]!.close).toBe(90); // real candles stay intact
  });

  it("untilSec extends the chart up to now", () => {
    const filled = fillCandles(sparse, 60, { untilSec: 500 });
    expect(filled[filled.length - 1]!.time).toBe(480);
    expect(filled[filled.length - 1]!.close).toBe(90);
  });

  it("maxBuckets cap trims from the left instead of blowing up", () => {
    const filled = fillCandles(sparse, 60, { untilSec: 1_000_000, maxBuckets: 10 });
    expect(filled.length).toBeLessThanOrEqual(11);
    expect(filled[filled.length - 1]!.time).toBe(999_960);
  });

  it("empty tape stays empty", () => {
    expect(fillCandles([], 60, { untilSec: 500 })).toEqual([]);
  });
});

describe("fundingPricePoints", () => {
  it("derives mark from value/rate — real numbers from the live API", () => {
    const [p] = fundingPricePoints([
      { timestamp: 1785060000, value: "0.77443560", rate: "0.0012" },
    ]);
    expect(Number(p!.price)).toBeCloseTo(64536.3, 1);
    expect(p!.timestamp).toBe(1785060000000);
    expect(p!.trade_id).toBe(-(1785060000000 + 1));
    expect(p!.usd_amount).toBe("0"); // contributes no volume
  });

  it("rate 0 / unhealthy values skipped instead of producing Infinity", () => {
    const pts = fundingPricePoints([
      { timestamp: 1, value: "0.5", rate: "0" },
      { timestamp: 2, value: "abc", rate: "0.0012" },
      { timestamp: 3, value: "0.77", rate: "0.0012" },
    ]);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.timestamp).toBe(3000);
  });

  it("deterministic — refetches deduped by TradeTape", () => {
    const f = [{ timestamp: 100, value: "0.77", rate: "0.0012" }];
    const tape = new TradeTape();
    expect(tape.add(fundingPricePoints(f))).toBe(true);
    expect(tape.add(fundingPricePoints(f))).toBe(false);
  });
});
