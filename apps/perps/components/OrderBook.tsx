"use client";

import { connectOrderBook, type OrderBookState, type OrderBookStatus } from "@o1bot/lighter";
import { useEffect, useRef, useState } from "react";
import { price as fmtPrice } from "@/lib/format";

/** Levels per side. The book runs to ~1700 on BTC; nobody reads past the top. */
const DEPTH = 13;

/**
 * The stream sends about 20 updates a second and the library hands over a
 * freshly sorted book each time (measured 0.78ms per rebuild on BTC, ~1.5% of
 * one core — cheap enough to leave alone). Re-rendering React that often is not
 * cheap, so the book lands in a ref and the component repaints on its own
 * timer. 80ms is 12.5fps: past the point anyone can read a changing number.
 */
const FRAME_MS = 80;

interface Row {
  price: string;
  size: number;
  cumulative: number;
}

function rows(levels: { price: string; size: string }[]): Row[] {
  const out: Row[] = [];
  let cumulative = 0;
  for (const l of levels.slice(0, DEPTH)) {
    const size = Number(l.size);
    if (!Number.isFinite(size)) continue;
    cumulative += size;
    out.push({ price: l.price, size, cumulative });
  }
  return out;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function OrderBook({ marketId, onPick }: { marketId: number; onPick?: (price: string) => void }) {
  const latest = useRef<OrderBookState | null>(null);
  const [book, setBook] = useState<OrderBookState | null>(null);
  const [status, setStatus] = useState<OrderBookStatus>("connecting");

  useEffect(() => {
    latest.current = null;
    setBook(null);
    const disconnect = connectOrderBook(marketId, (b) => (latest.current = b), { onStatus: setStatus });
    const timer = setInterval(() => {
      if (latest.current) setBook(latest.current);
    }, FRAME_MS);
    return () => {
      disconnect();
      clearInterval(timer);
    };
  }, [marketId]);

  const bids = book ? rows(book.bids) : [];
  const asks = book ? rows(book.asks) : [];
  const bestBid = Number(book?.bids[0]?.price);
  const bestAsk = Number(book?.asks[0]?.price);
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : NaN;
  const spreadBps = Number.isFinite(mid) && mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : NaN;

  // Each side scales to itself. A shared scale looked principled until the data
  // showed up: the top of BTC's book swings between sides by up to 50x and
  // flips which side is thicker, so the thinner side rendered as invisible
  // slivers and its distribution — what the bar exists to show — was unreadable.
  const maxBid = Math.max(bids[bids.length - 1]?.cumulative ?? 0, Number.EPSILON);
  const maxAsk = Math.max(asks[asks.length - 1]?.cumulative ?? 0, Number.EPSILON);

  const row = (r: Row, side: "b" | "a", max: number) => (
    <div
      key={r.price}
      className={`obr ${side}`}
      onClick={onPick ? () => onPick(r.price) : undefined}
      style={onPick ? { cursor: "pointer" } : undefined}
    >
      <span className="bar" style={{ width: `${Math.min(100, (r.cumulative / max) * 100)}%` }} aria-hidden />
      <b>{fmtPrice(r.price)}</b>
      <span>{num(r.size)}</span>
      <span>{num(r.cumulative)}</span>
    </div>
  );

  return (
    <section className="tcol obcol">
      <div className="ch">
        Order book <span className="grow" />
        <span className={`status ${status}`}>{status}</span>
      </div>
      <div className="obh">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      <div className="ob">
        <div className="obside ask">
          {/* Best ask nearest the spread, so the column reads outward from the
              middle in both directions. */}
          {[...asks].reverse().map((r) => row(r, "a", maxAsk))}
        </div>
        <div className="obspread">
          <b>{Number.isFinite(mid) ? fmtPrice(mid) : "—"}</b>
          {/* One decimal prints "0.0 bps" for every liquid market — BTC's real
              spread is about 0.01 bps — so tight spreads get the precision. */}
          <span>
            {Number.isFinite(spreadBps) ? `spread ${spreadBps.toFixed(spreadBps < 1 ? 3 : 1)} bps` : "—"}
          </span>
        </div>
        <div className="obside">{bids.map((r) => row(r, "b", maxBid))}</div>
      </div>
    </section>
  );
}
