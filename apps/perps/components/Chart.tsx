"use client";

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMarketStats } from "@/components/StatsContext";
import { RESOLUTIONS, bucketStart, isResolution, type Bar } from "@/lib/candles";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Chart({
  marketId,
  initialBars,
  initialResolution,
}: {
  marketId: number;
  initialBars: Bar[];
  initialResolution: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [resolution, setResolution] = useState(initialResolution);
  const [bars, setBars] = useState<Bar[]>(initialBars);
  const [loading, setLoading] = useState(false);

  /** The bar currently forming, carried between price ticks. */
  const live = useRef<Bar | null>(null);
  /** Reset the view only when the data set is replaced, never on a price tick. */
  const refit = useRef(true);

  const stats = useMarketStats(marketId);
  const lastPrice = stats ? Number(stats.last_trade_price) : NaN;

  // Build the chart once. Colours are read from the CSS tokens so the chart
  // follows the site rather than carrying its own palette.
  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const line = cssVar("--line", "#34353b");
    const ink3 = cssVar("--ink-3", "#6e7c8f");
    const up = cssVar("--up", "#3ed082");
    const down = cssVar("--down", "#ff6e5e");

    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: ink3,
        attributionLogo: false,
      },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: ink3 }, horzLine: { color: ink3 } },
    });

    candles.current = c.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    });

    // Volume shares the pane but gets its own hidden scale, pinned to the bottom
    // quarter so it never fights the price series for room.
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
    };
  }, []);

  // Feed data whenever it changes.
  useEffect(() => {
    if (!candles.current || !volume.current) return;
    const up = cssVar("--up", "#3ed082");
    const down = cssVar("--down", "#ff6e5e");

    candles.current.setData(bars.map((b) => ({ ...b, time: b.time as Time })));
    volume.current.setData(
      bars.map((b) => ({
        time: b.time as Time,
        value: b.volume,
        // 28% alpha keeps the volume strip readable without competing with price.
        color: `${b.close >= b.open ? up : down}47`,
      })),
    );
    live.current = bars[bars.length - 1] ?? null;
    if (refit.current) {
      chart.current?.timeScale().fitContent();
      refit.current = false;
    }
  }, [bars]);

  /**
   * The chart drew whatever the server rendered and then stopped: the last
   * candle never closed and no new one ever opened, so a market could move for
   * an hour and the chart would not show it.
   *
   * Each price tick extends the bar currently forming — close follows the
   * price, high and low stretch to hold it — and crossing into the next bucket
   * opens a new one. `update` touches a single bar, unlike `setData`, so this
   * costs nothing and does not disturb whatever the user has panned or zoomed
   * to.
   */
  useEffect(() => {
    const series = candles.current;
    if (!series || !Number.isFinite(lastPrice) || lastPrice <= 0) return;
    if (!isResolution(resolution)) return;

    const now = bucketStart(resolution);
    const current = live.current;

    const next: Bar =
      current && current.time === now
        ? {
            ...current,
            close: lastPrice,
            high: Math.max(current.high, lastPrice),
            low: Math.min(current.low, lastPrice),
          }
        : current && now > current.time
          ? { time: now, open: lastPrice, high: lastPrice, low: lastPrice, close: lastPrice, volume: 0 }
          : // A tick older than the last bar belongs to history the server
            // already drew; replaying it would rewrite a closed candle.
            (current as Bar);

    if (!current || next === current) return;
    live.current = next;
    series.update({ ...next, time: next.time as Time });
  }, [lastPrice, resolution]);

  const load = useCallback(
    async (next: string, replace: boolean) => {
      const res = await fetch(`/api/candles?market=${marketId}&resolution=${next}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { bars: Bar[] };
      refit.current = replace;
      setBars(json.bars);
    },
    [marketId],
  );

  /**
   * The live bar is built from prices alone, so it carries no volume and can
   * drift from the venue's own aggregation. A refetch on the minute replaces it
   * with the authoritative bars; the view is left where the user put it.
   */
  useEffect(() => {
    const t = setInterval(() => {
      void load(resolution, false).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(t);
  }, [load, resolution]);

  async function pick(next: string) {
    if (next === resolution || loading) return;
    setResolution(next);
    setLoading(true);
    try {
      await load(next, true);
    } catch {
      // Keep the bars already on screen; a failed switch must not blank the chart.
      setResolution(resolution);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* The chart fills the column; the timeframe buttons float over it rather
          than taking a row, because vertical space is what a chart is for. */}
      <div ref={box} className="chartfill" />
      <div className="tf chartf">
        {RESOLUTIONS.map((r) => (
          <button
            key={r}
            type="button"
            className={r === resolution ? "on" : ""}
            onClick={() => void pick(r)}
            disabled={loading}
          >
            {r}
          </button>
        ))}
      </div>
      {bars.length === 0 && <p className="chartempty">No candles for this market yet.</p>}
    </>
  );
}
