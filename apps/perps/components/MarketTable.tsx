"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { changePct, leverage, price, usd } from "@/lib/format";

export interface MarketRow {
  marketId: number;
  symbol: string;
  type: "perp" | "spot";
  lastPrice: number;
  /** Percent change over 24h, as the venue reports it. */
  changePct: number;
  volumeUsd: number;
  /** Perps only; spot has no leverage. */
  maxLeverage: number | null;
}

type Filter = "all" | "perp" | "spot";

export function MarketTable({ rows }: { rows: MarketRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(
    () => ({
      all: rows.length,
      perp: rows.filter((r) => r.type === "perp").length,
      spot: rows.filter((r) => r.type === "spot").length,
    }),
    [rows],
  );

  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter(
      (r) => (filter === "all" || r.type === filter) && (!q || r.symbol.toUpperCase().includes(q)),
    );
  }, [rows, filter, query]);

  return (
    <>
      <div className="chips">
        {(["all", "perp", "spot"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`chip${filter === f ? " on" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "perp" ? "Perps" : "Spot"} <span className="n">{counts[f]}</span>
          </button>
        ))}
        <input
          className="chip"
          style={{ minWidth: 160, color: "var(--ink)" }}
          placeholder="Search symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search symbol"
        />
      </div>

      <div className="panel">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Last</th>
                <th>24h</th>
                <th>24h volume</th>
                <th>Max leverage</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const c = changePct(r.changePct);
                return (
                  // Both books can carry the same symbol, so the key is never the symbol alone.
                  <tr key={`${r.symbol}-${r.type}-${r.marketId}`}>
                    <td>
                      {/* Spot symbols carry a quote suffix ("LIT/USDC"); the route
                          only wants the base, and the detail page matches either. */}
                      <Link
                        className="sym"
                        href={`/${r.type === "perp" ? "perps" : "spot"}/${encodeURIComponent(r.symbol.split("/")[0] ?? r.symbol)}`}
                      >
                        <b>{r.symbol}</b>
                        <span className={`tag ${r.type}`}>{r.type === "perp" ? "PERP" : "SPOT"}</span>
                      </Link>
                    </td>
                    <td>{price(r.lastPrice)}</td>
                    <td className={c.cls}>{c.text}</td>
                    <td>{usd(r.volumeUsd)}</td>
                    <td className={r.maxLeverage ? "" : "muted"}>{leverage(r.maxLeverage)}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: "center", padding: "28px 16px" }}>
                    No market matches “{query}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
