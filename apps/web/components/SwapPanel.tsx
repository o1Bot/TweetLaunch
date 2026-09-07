"use client";

import { useEffect, useState } from "react";
import { symbolColor } from "@/lib/ipfs";

const ANTI_SNIPE_SECONDS = 20;

/**
 * Swap panel. Shows a price-based estimate and the anti-snipe countdown;
 * execution through o1's pool with o1bot as referrer lands in the next step,
 * so the button is disabled until then.
 */
export function SwapPanel({ symbol, quoteSymbol, quoteKind, priceQuote, launchedAt }: { symbol: string; quoteSymbol: string; quoteKind: "eth" | "usd" | "stk"; priceQuote: number | null; launchedAt: string }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0.1");
  const [left, setLeft] = useState(() => Math.max(0, ANTI_SNIPE_SECONDS - Math.floor((Date.now() - new Date(launchedAt).getTime()) / 1000)));

  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [left]);

  const a = Number(amount) || 0;
  const out = priceQuote && priceQuote > 0 ? (side === "buy" ? (a / priceQuote) * 0.99 : a * priceQuote * 0.99) : 0;
  const fee = left > 0 ? Math.round(1 + (98 * left) / ANTI_SNIPE_SECONDS) : 1;
  const quoteChip = (
    <span className="asset">
      <span className="c" style={{ background: quoteKind === "stk" ? "var(--stock)" : quoteKind === "usd" ? "var(--up)" : "var(--blue)" }}>
        {quoteKind === "stk" ? quoteSymbol[0] : quoteKind === "usd" ? "$" : "Ξ"}
      </span>
      {quoteSymbol}
    </span>
  );
  const tokenChip = (
    <span className="asset">
      <span className="c" style={{ background: symbolColor(symbol) }}>{symbol[0]}</span>
      {symbol}
    </span>
  );

  return (
    <div className="swap">
      <div className="seg">
        <button className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      {left > 0 && (
        <div className="snipe">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          Anti-snipe: {fee}% fee for {left}s more
        </div>
      )}
      <div className="field">
        <div className="l">
          <span>You pay</span>
          <span>Balance —</span>
        </div>
        <div className="in">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
          {side === "buy" ? quoteChip : tokenChip}
        </div>
      </div>
      <div className="quick">
        {["0.05", "0.1", "0.5", "1"].map((v) => (
          <button key={v} onClick={() => setAmount(v)}>
            {v}
          </button>
        ))}
      </div>
      <div className="field">
        <div className="l">
          <span>You receive</span>
          <span>est.</span>
        </div>
        <div className="in">
          <input value={out ? (out > 1000 ? out.toLocaleString(undefined, { maximumFractionDigits: 0 }) : out.toPrecision(5)) : "0"} readOnly aria-label="Estimated output" />
          {side === "buy" ? tokenChip : quoteChip}
        </div>
      </div>
      <div className="kv">
        <span>Pool fee</span>
        <b>1% in {quoteSymbol}</b>
      </div>
      <div className="kv">
        <span>Route</span>
        <b>o1 hook · Uniswap v4</b>
      </div>
      <button className={`cta ${side === "sell" ? "sell" : ""}`} disabled>
        Swap coming soon
      </button>
      <div className="note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
        <span>Swaps will be signed by your o1bot wallet and routed through o1&apos;s launch pool. 0.5% of every trade goes to the creator, 0.2% to o1bot as referrer. Until then, trade this token on o1.</span>
      </div>
    </div>
  );
}
