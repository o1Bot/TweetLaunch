"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChainKey } from "@/lib/chains-web";
import type { TokenRow } from "@/lib/types";
import { BoardTable } from "./BoardTable";

/**
 * The board with its filter chips and sort order. Rows arrive from the
 * server already priced; filtering and sorting happen in the browser so a
 * click is instant. The last choice is remembered per browser.
 */

type Filter = "all" | "new" | "eth" | "usd" | "stk";
type Sort = "vol24" | "volAll" | "mcap" | "change" | "newest";

const filtersFor = (chain: ChainKey): Array<{ id: Filter; label: string }> => [
  { id: "all", label: "All launches" },
  { id: "new", label: "New (24h)" },
  { id: "eth", label: "ETH pairs" },
  { id: "stk", label: "Stock pairs" },
  { id: "usd", label: chain === "base" ? "USDC pairs" : "USDG pairs" },
];

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: "vol24", label: "24h volume" },
  { id: "volAll", label: "All-time volume" },
  { id: "mcap", label: "Market cap" },
  { id: "change", label: "24h change" },
  { id: "newest", label: "Newest" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "o1bot:board";

const usdOrQuote = (usd: number | null, quote: number | null) => usd ?? quote ?? 0;

export function Board({ rows, chain = "robinhood" }: { rows: TokenRow[]; chain?: ChainKey }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("vol24");
  const FILTERS = filtersFor(chain);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { filter?: Filter; sort?: Sort };
      if (saved.filter && FILTERS.some((f) => f.id === saved.filter)) setFilter(saved.filter);
      if (saved.sort && SORTS.some((s) => s.id === saved.sort)) setSort(saved.sort);
    } catch {
      // No storage, no memory: defaults are fine.
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter, sort }));
    } catch {
      // Ignore.
    }
  }, [filter, sort]);

  const counts = useMemo(() => {
    const now = Date.now();
    return {
      all: rows.length,
      new: rows.filter((r) => now - new Date(r.launchedAt).getTime() < DAY_MS).length,
      eth: rows.filter((r) => r.quoteKind === "eth").length,
      usd: rows.filter((r) => r.quoteKind === "usd").length,
      stk: rows.filter((r) => r.quoteKind === "stk").length,
    } satisfies Record<Filter, number>;
  }, [rows]);

  const shown = useMemo(() => {
    const now = Date.now();
    const kept = rows.filter((r) => {
      if (filter === "new") return now - new Date(r.launchedAt).getTime() < DAY_MS;
      if (filter === "all") return true;
      return r.quoteKind === filter;
    });
    const key = (r: TokenRow): number => {
      switch (sort) {
        case "vol24":
          return usdOrQuote(r.stats.volume24hUsd, r.stats.volume24hQuote);
        case "volAll":
          return usdOrQuote(r.stats.volumeAllUsd, r.stats.volumeAllQuote);
        case "mcap":
          return usdOrQuote(r.stats.mcapUsd, r.stats.mcapQuote);
        case "change":
          return r.stats.change24hPct ?? Number.NEGATIVE_INFINITY;
        case "newest":
          return new Date(r.launchedAt).getTime();
      }
    };
    return [...kept].sort((a, b) => key(b) - key(a) || b.launchedAt.localeCompare(a.launchedAt));
  }, [rows, filter, sort]);

  return (
    <>
      <div className="toolbar">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip${filter === f.id ? " on" : ""}`} onClick={() => setFilter(f.id)} type="button" aria-pressed={filter === f.id}>
            {f.label}
            {counts[f.id] > 0 && <span className="n">{counts[f.id]}</span>}
          </button>
        ))}
        <div className="grow" />
        <label className="sort">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort the board">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <BoardTable rows={shown} emptyText={filter === "all" ? undefined : `No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} yet.`} />
    </>
  );
}
