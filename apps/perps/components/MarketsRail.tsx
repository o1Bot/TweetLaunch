"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MarketLogo } from "@/components/MarketLogo";
import { changePct, price } from "@/lib/format";

export interface RailMarket {
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

  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return markets.filter(
      (m) => (filter === "all" || m.kind === filter) && (!needle || m.symbol.includes(needle)),
    );
  }, [markets, q, filter]);

  return (
    <section className="tcol mktcol">
      <div className="ch">
        Markets <span className="grow" />
        <span>{shown.length}</span>
      </div>

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
          const c = changePct(m.changePct);
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
                <b>{price(m.lastPrice)}</b>
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
