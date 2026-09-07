"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatPct, formatPrice, type Candle, type Timeframe } from "@o1bot/market";

const TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Candlestick chart with a volume strip, drawn on canvas in the pair asset. */
export function Chart({ token, quoteSymbol, priceUsd, change24hPct }: { token: string; quoteSymbol: string; priceUsd: number | null; change24hPct: number | null }) {
  const [tf, setTf] = useState<Timeframe>("15m");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    setCandles(null);
    fetch(`/api/token/${token}/candles?tf=${tf}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data: Candle[] }) => alive && setCandles(j.data))
      .catch(() => alive && setCandles([]));
    return () => {
      alive = false;
    };
  }, [token, tf]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || !candles || candles.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = 280;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    const cs = candles.slice(-96);
    const n = cs.length;
    const mn = Math.min(...cs.map((x) => x.l));
    const mx = Math.max(...cs.map((x) => x.h));
    const span = mx - mn || mx || 1;
    const padL = 8;
    const padR = 72;
    const padT = 10;
    const padB = 40;
    const cw = (W - padL - padR) / n;
    const y = (p: number) => padT + (1 - (p - mn) / span) * (H - padT - padB);
    const line = cssVar("--line");
    const ink3 = cssVar("--ink-3");
    const up = cssVar("--up");
    const down = cssVar("--down");
    const upSoft = cssVar("--up-soft");
    const downSoft = cssVar("--down-soft");

    g.clearRect(0, 0, W, H);
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.fillStyle = ink3;
    g.font = "12px Bricolage Grotesque, system-ui, sans-serif";
    g.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const p = mn + (span * i) / 4;
      const yy = y(p);
      g.beginPath();
      g.moveTo(padL, yy);
      g.lineTo(W - padR, yy);
      g.stroke();
      g.fillText(formatPrice(p), W - padR + 8, yy + 4);
    }
    const vmax = Math.max(...cs.map((x) => x.v)) || 1;
    cs.forEach((x, i) => {
      const isUp = x.c >= x.o;
      g.fillStyle = isUp ? upSoft : downSoft;
      const vh = (x.v / vmax) * 26;
      g.fillRect(padL + i * cw + 1, H - padB + 30 - vh, Math.max(cw - 2, 1), vh);
    });
    cs.forEach((x, i) => {
      const isUp = x.c >= x.o;
      const col = isUp ? up : down;
      g.strokeStyle = col;
      g.fillStyle = col;
      const cx = padL + i * cw + cw / 2;
      g.beginPath();
      g.moveTo(cx, y(x.h));
      g.lineTo(cx, y(x.l));
      g.stroke();
      const top = y(Math.max(x.o, x.c));
      const bot = y(Math.min(x.o, x.c));
      g.fillRect(padL + i * cw + 1.5, top, Math.max(cw - 3, 2), Math.max(bot - top, 1.5));
    });
    g.fillStyle = ink3;
    g.font = "12px Bricolage Grotesque, system-ui, sans-serif";
    const first = cs[0]!;
    const last = cs[n - 1]!;
    const fmt = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    g.textAlign = "left";
    g.fillText(fmt(first.t), padL + 4, H - padB + 16);
    g.textAlign = "right";
    g.fillText(fmt(last.t), W - padR - 4, H - padB + 16);
  }, [candles]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  const last = candles && candles.length ? candles[candles.length - 1]!.c : null;

  return (
    <div className="chartbox">
      <div className="ch">
        <span className="price grad">{priceUsd !== null ? `$${priceUsd < 1 ? priceUsd.toPrecision(3) : priceUsd.toFixed(2)}` : formatPrice(last, quoteSymbol)}</span>
        <span className={`pct ${change24hPct !== null && change24hPct < 0 ? "down" : "up"}`}>{formatPct(change24hPct)}</span>
        <span className="grow" />
        <div className="tf" role="tablist" aria-label="Timeframe">
          {TFS.map((k) => (
            <button key={k} className={k === tf ? "on" : ""} onClick={() => setTf(k)} role="tab" aria-selected={k === tf}>
              {k}
            </button>
          ))}
        </div>
      </div>
      {candles === null ? (
        <div className="chart-empty">Loading…</div>
      ) : candles.length === 0 ? (
        <div className="chart-empty">No trades yet. The chart starts with the first swap.</div>
      ) : (
        <canvas ref={canvasRef} aria-label={`${quoteSymbol} price chart`} />
      )}
    </div>
  );
}
