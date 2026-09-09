"use client";

import { useEffect, useState } from "react";
import { shortAddress, timeAgo } from "@/lib/ipfs";
import type { HoldersResult, TradeRow } from "@/lib/types";

const fmtAmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(3) : n.toPrecision(3));

export function TokenTabs({ token, symbol, quoteSymbol, initialTrades, tradeCount, creatorWallet, explorer }: { token: string; symbol: string; quoteSymbol: string; initialTrades: TradeRow[]; tradeCount: number; creatorWallet: string; explorer: string }) {
  const [tab, setTab] = useState<"trades" | "holders" | "posts">("trades");
  const [trades, setTrades] = useState(initialTrades);
  const [holders, setHolders] = useState<HoldersResult | null>(null);

  useEffect(() => {
    if (tab !== "holders" || holders) return;
    fetch(`/api/token/${token}/holders`)
      .then((r) => r.json())
      .then((j: HoldersResult) => setHolders(j))
      .catch(() => setHolders({ holders: [], total: null, source: "o1", error: "unreachable" }));
  }, [tab, token, holders]);

  useEffect(() => {
    const id = setInterval(() => {
      fetch(`/api/token/${token}/trades?limit=30`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { data: TradeRow[] } | null) => j && setTrades(j.data))
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }, [token]);

  return (
    <>
      <div className="tabs" role="tablist">
        <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")} role="tab" aria-selected={tab === "trades"}>
          Trades<i>{tradeCount.toLocaleString()}</i>
        </button>
        <button className={tab === "holders" ? "on" : ""} onClick={() => setTab("holders")} role="tab" aria-selected={tab === "holders"}>
          Holders{holders?.total !== null && holders?.total !== undefined && <i>{holders.total.toLocaleString()}</i>}
        </button>
        <button className={tab === "posts" ? "on" : ""} onClick={() => setTab("posts")} role="tab" aria-selected={tab === "posts"}>
          Creator posts
        </button>
      </div>

      {tab === "trades" && (
        <div className="pane trades">
          <div className="tr">
            <span>Time</span>
            <span>Side</span>
            <span>{quoteSymbol}</span>
            <span>{symbol}</span>
            <span>Wallet</span>
            <span>Note</span>
          </div>
          {trades.length === 0 && <div className="empty">No trades yet.</div>}
          {trades.map((t) => (
            <div className="tr" key={t.id}>
              <span style={{ color: "var(--ink-3)" }}>{timeAgo(t.time)}</span>
              <span>
                <span className={`side-tag ${t.side === "BUY" ? "b" : "s"}`}>{t.side === "BUY" ? "Buy" : "Sell"}</span>
              </span>
              <span className="mono">{fmtAmt(t.amountQuote)}</span>
              <span className="mono">{fmtAmt(t.amountToken)}</span>
              <a href={`${explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer" style={{ color: "var(--ink-2)" }}>
                {shortAddress(t.trader)}
                {t.trader.toLowerCase() === creatorWallet.toLowerCase() && <span className="tag dev">creator</span>}
                {t.viaPost && (
                  <span className="tag post" title="Asked for in a post on X and signed by o1bot">
                    post
                  </span>
                )}
              </a>
              <span style={{ color: "var(--ink-3)" }}>{t.comment ?? ""}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "holders" && (
        <div className="pane holders">
          <div className="tr">
            <span>#</span>
            <span>Wallet</span>
            <span>Balance</span>
            <span>Share</span>
            <span />
          </div>
          {!holders && <div className="empty">Loading holders…</div>}
          {holders?.error === "not_configured" && <div className="empty">Holder snapshots are not configured on this deployment.</div>}
          {holders && holders.error && holders.error !== "not_configured" && <div className="empty">Holder data is temporarily unavailable.</div>}
          {holders && !holders.error && holders.holders.length === 0 && <div className="empty">No holders reported yet.</div>}
          {holders?.holders.map((h, i) => (
            <div className="tr" key={h.address}>
              <span style={{ color: "var(--ink-3)" }}>{i + 1}</span>
              <span>
                <a href={`${explorer}/address/${h.address}`} target="_blank" rel="noreferrer">
                  {shortAddress(h.address)}
                </a>
                {(h.label === "creator" || h.address.toLowerCase() === creatorWallet.toLowerCase()) && <span className="tag dev">creator</span>}
                {h.label && h.label !== "creator" && <span className="tag">{h.label}</span>}
              </span>
              <span className="mono">{h.balance !== null ? fmtAmt(h.balance) : "—"}</span>
              <span className="mono">{h.percent !== null ? `${h.percent.toFixed(2)}%` : "—"}</span>
              <div className="hbar">
                <i style={{ width: `${Math.min(100, (h.percent ?? 0) * 8)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "posts" && (
        <div className="pane">
          <div className="tr" style={{ gridTemplateColumns: "1fr", color: "var(--ink)" }}>Announcements the creator signs on-chain through o1&apos;s registry show up here.</div>
          <div className="tr" style={{ gridTemplateColumns: "1fr" }}>Nothing yet. The creator has not posted since launch.</div>
        </div>
      )}
    </>
  );
}
