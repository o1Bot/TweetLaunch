"use client";

import { createLighterClient } from "@o1bot/lighter";
import { useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "@/components/AccountContext";
import { useMarketStats } from "@/components/StatsContext";
import { price as fmtPrice, usdExact } from "@/lib/format";
import { NoKeyError, submitOrder } from "@/lib/submit";
import { quote, type Market, type OrderType } from "@/lib/ticket";

const QUICK = [100, 500, 1000] as const;

const TYPES: { key: OrderType; label: string }[] = [
  { key: "market", label: "Market" },
  { key: "limit", label: "Limit" },
  { key: "stopLoss", label: "Stop" },
  { key: "takeProfit", label: "TP" },
];

export function Ticket({
  market,
  symbol,
  mark: markProp,
  maxLeverage,
  fundingRatePct,
}: {
  market: Market;
  symbol: string;
  mark: number;
  maxLeverage: number;
  fundingRatePct?: number;
}) {
  const { ready, authenticated, login, accountIndex, hasKey, availableBalance, refresh } = useAccount();
  const { wallets } = useWallets();
  const wallet = wallets[0];

  // A market order's slippage guard is priced off the mark, so it has to be the
  // live one. Using the server's render meant the guard was set from a price
  // that could be minutes old — the order would still be signed, just against a
  // worst-acceptable price that no longer described the market.
  const live = useMarketStats(market.market_id);
  const mark = live ? Number(live.mark_price) || markProp : markProp;

  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<OrderType>("market");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [trigger, setTrigger] = useState("");
  // A stop or take-profit is almost always closing something. Defaulting to
  // reduce-only means a mis-sized one flattens rather than flipping the
  // position; the box is there for the breakout entry that wants otherwise.
  const [reduceOnly, setReduceOnly] = useState(true);
  const [leverage, setLeverage] = useState(Math.min(10, maxLeverage));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const isTrigger = type === "stopLoss" || type === "takeProfit";
  // A limit rests at its own price; everything else is guarded off the mark,
  // including a stop or take-profit, which becomes a market order when it fires.
  const entry = type === "limit" ? Number(limitPrice) || 0 : mark;
  const notional = Number(amount) || 0;
  const triggerAt = Number(trigger) || 0;

  // One quote feeds the panel and the order — they cannot disagree because
  // nothing is computed twice.
  const q = useMemo(() => {
    if (notional <= 0 || entry <= 0) return null;
    // An empty trigger is a form not yet filled in, not a mistake to flag.
    if (isTrigger && triggerAt <= 0) return null;
    try {
      return quote({
        side,
        type,
        notionalUsd: notional,
        price: entry,
        leverage,
        market,
        ...(isTrigger ? { triggerPrice: triggerAt, reduceOnly } : {}),
        ...(fundingRatePct !== undefined ? { fundingRatePct } : {}),
      });
    } catch (e) {
      return e instanceof Error ? e.message : "cannot build this order";
    }
  }, [side, type, notional, entry, leverage, market, fundingRatePct, isTrigger, triggerAt, reduceOnly]);

  const q0 = typeof q === "object" && q !== null ? q : null;

  async function send() {
    if (!q0 || accountIndex === null || !wallet || busy) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const provider = await wallet.getEthereumProvider();
      const signMessage = (message: string) =>
        provider.request({ method: "personal_sign", params: [message, wallet.address] }) as Promise<string>;

      const { txHash } = await submitOrder({
        client: createLighterClient(),
        accountIndex,
        built: q0.built,
        signMessage,
      });
      setSent(txHash);
      setAmount("");
      refresh();
    } catch (e) {
      setError(
        e instanceof NoKeyError
          ? "No signing key on this device — register one first."
          : e instanceof Error
            ? e.message
            : "order failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tcol ordercol">
      <div className="ch">Order</div>
      <div className="order">
        <div className="seg2">
          <button type="button" className={`l${side === "long" ? " on" : ""}`} onClick={() => setSide("long")}>
            Long
          </button>
          <button type="button" className={`s${side === "short" ? " on" : ""}`} onClick={() => setSide("short")}>
            Short
          </button>
        </div>

        <div className="types">
          {TYPES.map((t) => (
            <button key={t.key} type="button" className={type === t.key ? "on" : ""} onClick={() => setType(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {isTrigger && (
          <>
            <div className="fld">
              <div className="l">
                <span>{type === "stopLoss" ? "Stop" : "Take profit"} at</span>
                <b onClick={() => setTrigger(String(mark))}>Mark</b>
              </div>
              <div className="in">
                <input
                  inputMode="decimal"
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                  placeholder={fmtPrice(mark)}
                  aria-label="Trigger price"
                />
                <span className="u">USDC</span>
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
              <span>Reduce only — never open or flip a position</span>
            </label>
          </>
        )}

        {type === "limit" && (
          <div className="fld">
            <div className="l">
              <span>Limit price</span>
              <b onClick={() => setLimitPrice(String(mark))}>Mark</b>
            </div>
            <div className="in">
              <input
                inputMode="decimal"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder={fmtPrice(mark)}
                aria-label="Limit price"
              />
              <span className="u">USDC</span>
            </div>
          </div>
        )}

        <div className="fld">
          <div className="l">
            <span>Size</span>
            {availableBalance !== null && <b>Free {usdExact(availableBalance)}</b>}
          </div>
          <div className="in">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              aria-label="Order size in USDC"
            />
            <span className="u">USDC</span>
          </div>
          <div className="quick">
            {QUICK.map((v) => (
              <button key={v} type="button" onClick={() => setAmount(String(v))}>
                ${v >= 1000 ? `${v / 1000}k` : v}
              </button>
            ))}
          </div>
        </div>

        <div className="levrow">
          <span>Leverage</span>
          <b>{leverage}x</b>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          aria-label="Leverage"
        />
        <div className="ticks">
          <span>1x</span>
          <span>{Math.round(maxLeverage / 2)}x</span>
          <span>{maxLeverage}x</span>
        </div>

        {typeof q === "string" && (
          <div className="kv2">
            <span className="down">{q}</span>
          </div>
        )}

        {q0 && (
          <>
            <div className="kv2">
              <span>Size</span>
              <b>{q0.built.contracts}</b>
            </div>
            {q0.shortfallPct > 0.01 && (
              <div className="kv2">
                <span>Below your request</span>
                <b className="warn">{q0.shortfallPct.toFixed(2)}%</b>
              </div>
            )}
            <div className="kv2">
              <span>Position size</span>
              <b>{usdExact(q0.effectiveNotionalUsd)}</b>
            </div>
            {isTrigger ? (
              <div className="kv2">
                <span>Fires at</span>
                <b className="warn">{fmtPrice(triggerAt)}</b>
              </div>
            ) : (
              <div className="kv2">
                <span>Entry price</span>
                <b>{fmtPrice(entry)}</b>
              </div>
            )}
            <div className="kv2">
              <span>Liquidation price</span>
              <b className="warn">{fmtPrice(q0.ledger.liqPrice)}</b>
            </div>
            <div className="kv2">
              <span>Margin required</span>
              <b>{usdExact(q0.ledger.marginUsd)}</b>
            </div>
            <div className="kv2">
              <span>Venue fee</span>
              <b>{usdExact(q0.ledger.lighterFeeUsd)}</b>
            </div>
            <div className="kv2">
              <span>o1bot fee</span>
              <b>{usdExact(q0.ledger.integratorFeeUsd)}</b>
            </div>
            {fundingRatePct !== undefined && (
              <div className="kv2">
                <span>Est. funding</span>
                <b>{usdExact(Math.abs(q0.ledger.estFunding8hUsd))}</b>
              </div>
            )}
          </>
        )}

        {!ready ? null : !authenticated ? (
          <button type="button" className="cta neutral" onClick={login}>
            Sign in to trade
          </button>
        ) : accountIndex === null ? (
          <Link className="cta neutral" href="/start" style={{ display: "block", textAlign: "center" }}>
            Set up an account
          </Link>
        ) : !hasKey ? (
          <Link className="cta neutral" href="/start" style={{ display: "block", textAlign: "center" }}>
            Register a signing key
          </Link>
        ) : (
          <button
            type="button"
            className={`cta${side === "short" ? " s" : ""}`}
            onClick={() => void send()}
            disabled={busy || !q0}
          >
            {busy
              ? "Signing…"
              : isTrigger
                ? `${type === "stopLoss" ? "Stop" : "Take profit"} · ${side === "long" ? "buy" : "sell"} ${symbol}`
                : `${side === "long" ? "Long" : "Short"} ${symbol}`}
          </button>
        )}

        {sent && (
          <div className="kv2">
            <span className="up">Order sent · {sent.slice(0, 12)}…</span>
          </div>
        )}
        {error && (
          <div className="kv2">
            <span className="down">{error}</span>
          </div>
        )}

        <div className="hr" />

        <div className="post">
          <div className="h">
            <b>Trade from a post</b>
          </div>
          <div className="cmd">
            <b>@o1bot_exchange</b> long <em>${symbol}</em> 10x with 500 usdc
            <br />
            <b>@o1bot_exchange</b> close my <em>${symbol}</em>
          </div>
          <p className="note">
            Not live yet. It will need a per-trade cap and a leverage limit set here, and it only
            ever works on a wallet o1bot can sign for — a wallet you connected yourself stays
            terminal-only.
          </p>
        </div>
      </div>
    </section>
  );
}
