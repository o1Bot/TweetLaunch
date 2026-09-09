"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { TokenLogo } from "./TokenLogo";

/**
 * Header search: type a ticker, a name or an address and jump to the token
 * page. Results come from /api/search (tokens on the board); an address
 * that is not on the board still opens its page, which 404s cleanly.
 */

type Hit = { token: string; symbol: string; name: string; imageUrl: string | null; quoteSymbol: string };

export function SearchBox({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const needle = q.trim();
    if (!needle) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(needle)}`);
        const json = (await res.json()) as { data: Hit[] };
        setHits(json.data);
        setActive(0);
        setOpen(true);
      } catch {
        setHits([]);
      }
    }, 180);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const go = (hit: Hit | null) => {
    const needle = q.trim();
    if (hit) router.push(`/token/${hit.token}`);
    else if (isAddress(needle, { strict: false })) router.push(`/token/${needle}`);
    else return;
    setOpen(false);
    setQ("");
  };

  return (
    <div className={`search${compact ? " compact" : ""}`} ref={wrap} role="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        value={q}
        placeholder="Search tokens"
        aria-label="Search tokens by ticker, name or address"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(hits[active] ?? null);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && q.trim() && (
        <div className="search-hits" role="listbox">
          {hits.length === 0 ? (
            <div className="none">{isAddress(q.trim(), { strict: false }) ? "Press Enter to open this address" : "No token on the board matches"}</div>
          ) : (
            hits.map((h, i) => (
              <button key={h.token} className={i === active ? "on" : ""} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)}>
                <TokenLogo symbol={h.symbol} imageUrl={h.imageUrl} className="logo xs" />
                <span className="s">{h.symbol}</span>
                <span className="n">{h.name}</span>
                <span className="p">{h.quoteSymbol}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
