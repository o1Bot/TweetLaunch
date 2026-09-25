"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MarketLogo } from "@/components/MarketLogo";
import { useStats } from "@/components/StatsContext";
import { changePct, price } from "@/lib/format";

export interface RailMarket {
  marketId: number;
  symbol: string;
  href: string;
  lastPrice: number;
  changePct: number;
  volumeUsd: number;
  /** Stocks, indices, commodities and FX are all "rwa" here — the venue does
   *  not label them, so the split is by what the symbol is, not by a field. */
  kind: "crypto" | "rwa";
}

type Filter = "all" | "crypto" | "rwa";

export function MarketsRail({ markets, current }: { markets: RailMarket[]; current: string }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const stats = useStats();
  /**
   * Collapsed on a phone, where the rail sits above the chart: 210 markets
   * stacked there would be a long scroll before reaching anything. The toggle
   * is hidden on a desktop, where the rail is a column and always open.
   */
  const [open, setOpen] = useState(false);

  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return markets.filter(
      (m) => (filter === "all" || m.kind === filter) && (!needle || m.symbol.includes(needle)),
    );
  }, [markets, q, filter]);

  return (
    <section className={`tcol mktcol${open ? " open" : ""}`}>
      <div className="ch">
        Markets <span className="grow" />
        <span>{shown.length}</span>
      </div>

      <button type="button" className="railtoggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>
          {current} <span className="muted">· {shown.length} markets</span>
        </span>
        <span aria-hidden>{open ? "Close" : "Change"}</span>
      </button>

      <label className="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input placeholder="Search market" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search market" />
      </label>

      <div className="segs">
        {(["all", "crypto", "rwa"] as const).map((f) => (
          <button key={f} type="button" className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "crypto" ? "Crypto" : "RWA"}
          </button>
        ))}
      </div>

      <div className="mkts">
        {shown.map((m) => {
          // The stream replaces the server's render as soon as it answers.
          const live = stats?.get(m.marketId);
          const last = live ? Number(live.last_trade_price) || m.lastPrice : m.lastPrice;
          const c = changePct(live ? Number(live.daily_price_change) : m.changePct);
          return (
            <Link key={m.symbol} href={m.href} className={`mkt${m.symbol === current ? " on" : ""}`}>
              <div>
                <div className="s">
                  <MarketLogo symbol={m.symbol} size={20} />
                  {m.symbol}
                </div>
                <div className="f">
                  {m.volumeUsd >= 1e6
                    ? `$${(m.volumeUsd / 1e6).toFixed(1)}M`
                    : `$${(m.volumeUsd / 1e3).toFixed(0)}K`}{" "}
                  24h
                </div>
              </div>
              <div className="r">
                <b>{price(last)}</b>
                <span className={c.cls}>{c.text}</span>
              </div>
            </Link>
          );
        })}
        {shown.length === 0 && <p className="bempty">No market matches “{q}”.</p>}
      </div>
    </section>
  );
}
