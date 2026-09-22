"use client";

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { RESOLUTIONS, type Bar } from "@/lib/candles";

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
    chart.current?.timeScale().fitContent();
  }, [bars]);

  async function pick(next: string) {
    if (next === resolution || loading) return;
    setResolution(next);
    setLoading(true);
    try {
      const res = await fetch(`/api/candles?market=${marketId}&resolution=${next}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { bars: Bar[] };
      setBars(json.bars);
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
