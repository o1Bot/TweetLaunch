import { symbolColor } from "@/lib/ipfs";

export function TokenLogo({ symbol, imageUrl, className = "logo" }: { symbol: string; imageUrl: string | null; className?: string }) {
  return (
    <div className={className} style={{ background: imageUrl ? "var(--panel-2)" : symbolColor(symbol) }} aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : symbol.slice(0, 2).toUpperCase()}
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
