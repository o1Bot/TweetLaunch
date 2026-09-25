"use client";

import { connectAllMarketStats, type MarketStats } from "@o1bot/lighter";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Live prices for every market, on one subscription.
 *
 * Without this the terminal showed whatever the server rendered and never moved
 * again: a price frozen until someone reloaded. On a trading screen that is not
 * a cosmetic problem — the order ticket takes its mark from here, and a market
 * order's slippage guard is priced off a mark that is minutes old.
 *
 * The venue sends a snapshot of all 235 markets then partial updates, several
 * times a second. Those land in a ref and the tree repaints on a timer, the
 * same way the order book does: re-rendering a 200-row rail on every tick
 * drops frames for no benefit, since nobody reads a number changing that fast.
 */
const FRAME_MS = 500;

const Ctx = createContext<Map<number, MarketStats> | null>(null);

export function useStats(): Map<number, MarketStats> | null {
  return useContext(Ctx);
}

/** One market's live stats, or null before the venue has answered. */
export function useMarketStats(marketId: number | null | undefined): MarketStats | null {
  const all = useStats();
  if (all === null || marketId === null || marketId === undefined) return null;
  return all.get(marketId) ?? null;
}

export function StatsProvider({ children }: { children: ReactNode }) {
  const latest = useRef<Map<number, MarketStats> | null>(null);
  const [stats, setStats] = useState<Map<number, MarketStats> | null>(null);

  useEffect(() => {
    const disconnect = connectAllMarketStats((m) => {
      latest.current = m;
    });
    const timer = setInterval(() => {
      // A new Map each tick so consumers re-render; the entries are shared.
      if (latest.current) setStats(new Map(latest.current));
    }, FRAME_MS);
    return () => {
      disconnect();
      clearInterval(timer);
    };
  }, []);

  return <Ctx.Provider value={stats}>{children}</Ctx.Provider>;
}
