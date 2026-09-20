"use client";

import { useMemo, useState } from "react";

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

/** Prices span from sub-cent memecoins to five-figure indices, so the number of
 *  decimals has to follow the magnitude rather than be fixed. */
function price(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const decimals = n >= 1000 ? 2 : n >= 1 ? 3 : n >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function volume(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** maxLeverage() returns the exact ratio 10000/margin_fraction, which is what
 *  margin math needs but not a label: NEAR comes out 15.015015…x. Floor it —
 *  rounding up would advertise more leverage than the venue actually allows. */
function leverage(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 1) return "—";
  return `${Math.floor(n)}x`;
}

function change(n: number): { text: string; cls: string } {
  if (!Number.isFinite(n) || n === 0) return { text: "0.00%", cls: "muted" };
  return { text: `${n > 0 ? "+" : ""}${n.toFixed(2)}%`, cls: n > 0 ? "up" : "down" };
}

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
                const c = change(r.changePct);
                return (
                  // Both books can carry the same symbol, so the key is never the symbol alone.
                  <tr key={`${r.symbol}-${r.type}-${r.marketId}`}>
                    <td>
                      <span className="sym">
                        <b>{r.symbol}</b>
                        <span className={`tag ${r.type}`}>{r.type === "perp" ? "PERP" : "SPOT"}</span>
                      </span>
                    </td>
                    <td>{price(r.lastPrice)}</td>
                    <td className={c.cls}>{c.text}</td>
                    <td>{volume(r.volumeUsd)}</td>
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
