"use client";

import { useEffect, useState } from "react";

/**
 * A slim bar under the header while the market data is delayed: the
 * indexer cursor has not moved for five minutes, so prices, charts and
 * trade lists may be behind. Reads /api/health on load and every minute
 * and renders nothing while everything is fresh.
 */

type Health = { ok: boolean; indexer: { since: string | null; ageSeconds: number | null } | null };

const fmt = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function DataStatus() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch("/api/health", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: Health) => alive && setHealth(j))
        .catch(() => undefined);
    check();
    const id = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!health || health.ok) return null;
  const since = health.indexer?.since;
  return (
    <div className="data-delay" role="status">
      <b>Market data is delayed{since ? ` since ${fmt(since)}` : ""}.</b> Prices, charts and trades may be behind. Trading and launches still work.
    </div>
  );
}
