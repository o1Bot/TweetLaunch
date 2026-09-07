"use client";

import { useState } from "react";
import { symbolColor } from "@/lib/ipfs";

/** Public gateway used when the configured one refuses or fails to serve a logo. */
const FALLBACK_GATEWAY = "https://ipfs.io/ipfs/";

/** `…/ipfs/<cid>` on any gateway → the same path on the public fallback; null when not an IPFS URL. */
function fallbackFor(url: string): string | null {
  const m = url.match(/\/ipfs\/([^/?#]+.*)$/);
  return m ? `${FALLBACK_GATEWAY}${m[1]}` : null;
}

export function TokenLogo({ symbol, imageUrl, className = "logo" }: { symbol: string; imageUrl: string | null; className?: string }) {
  const [src, setSrc] = useState(imageUrl);
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;
  return (
    <div className={className} style={{ background: showImage ? "var(--panel-2)" : symbolColor(symbol) }} aria-hidden="true">
      {showImage ? (
        <img
          src={src ?? undefined}
          alt=""
          loading="lazy"
          onError={() => {
            const next = src ? fallbackFor(src) : null;
            if (next && next !== src) setSrc(next);
            else setFailed(true);
          }}
        />
      ) : (
        symbol.slice(0, 2).toUpperCase()
      )}
    </div>
  );
}

export const PAIR_CLASS: Record<"eth" | "usd" | "stk", string> = { eth: "pair eth", usd: "pair usd", stk: "pair stk" };

export const STOCK_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </svg>
);

export const X_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.9 2H22l-7.2 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.1l7.7-8.8L1.6 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20z" />
  </svg>
);

export const EXT_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />
  </svg>
);
