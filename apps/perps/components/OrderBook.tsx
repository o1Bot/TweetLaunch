"use client";

import {
  connectOrderBook,
  type OrderBookState,
  type OrderBookStatus,
} from "@o1bot/lighter";
import { useEffect, useRef, useState } from "react";
import { price as fmtPrice } from "@/lib/format";

/** Levels shown per side. The book itself runs to ~1700 levels on BTC; nobody
 *  reads past the top of it. */
const DEPTH = 9;

/**
 * The stream delivers ~20 updates a second and the library hands over a fresh
 * sorted book each time (measured 0.78ms per rebuild on BTC, ~1.5% of one core —
 * cheap enough to leave alone). What is not cheap is re-rendering React 20 times
 * a second, so the book lands in a ref and the component repaints on its own
 * timer. 80ms is 12.5fps: past the point anyone can read a changing number.
 */
const FRAME_MS = 80;

interface Row {
  price: string;
  size: number;
  /** Running total from the top of the book, for the depth bar. */
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

function size(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function OrderBook({ marketId }: { marketId: number }) {
  const latest = useRef<OrderBookState | null>(null);
  const [book, setBook] = useState<OrderBookState | null>(null);
  const [status, setStatus] = useState<OrderBookStatus>("connecting");

  useEffect(() => {
    latest.current = null;
    setBook(null);

    const disconnect = connectOrderBook(
      marketId,
      (b) => {
        // Deliberately not setState: see FRAME_MS.
        latest.current = b;
      },
      { onStatus: setStatus },
    );

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

  // Each side gets its own scale. A shared one looked principled until the data
  // showed up: the top of BTC's book swings between sides by 50x, so whichever
  // side is thinner at that moment renders as invisible slivers and its
  // distribution — the thing a depth bar is for — cannot be read at all. The
  // numbers still carry the comparison between sides.
  const maxBid = Math.max(bids[bids.length - 1]?.cumulative ?? 0, Number.EPSILON);
  const maxAsk = Math.max(asks[asks.length - 1]?.cumulative ?? 0, Number.EPSILON);

  return (
    <div className="panel bookbox">
      <div className="boxh bookh">
        <h2>Order book</h2>
        <span className={`status ${status}`}>{status}</span>
      </div>

      {!book ? (
        <p className="muted empty">Connecting to the stream…</p>
      ) : (
        <>
          {/* Asks are listed with the best (lowest) price nearest the spread,
              so the column reads outward from the middle in both directions. */}
          <Side rows={[...asks].reverse()} side="ask" max={maxAsk} />

          <div className="spread">
            <span className="mid">{Number.isFinite(mid) ? fmtPrice(mid) : "—"}</span>
            <span className="muted">
              {Number.isFinite(spreadBps)
                ? `${spreadBps.toFixed(spreadBps < 1 ? 3 : 1)} bps`
                : "—"}
            </span>
          </div>

          <Side rows={bids} side="bid" max={maxBid} />
        </>
      )}
    </div>
  );
}

function Side({ rows: list, side, max }: { rows: Row[]; side: "bid" | "ask"; max: number }) {
  return (
    <div className="bside">
      {list.map((r) => (
        <div key={r.price} className="brow">
          <span
            className={`bar ${side}`}
            style={{ width: `${Math.min(100, (r.cumulative / max) * 100)}%` }}
            aria-hidden
          />
          <span className={side === "bid" ? "up" : "down"}>{fmtPrice(r.price)}</span>
          <span>{size(r.size)}</span>
          <span className="muted">{size(r.cumulative)}</span>
        </div>
      ))}
      {list.length === 0 && <p className="muted empty">No levels.</p>}
    </div>
  );
}
