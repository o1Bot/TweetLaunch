"use client";

import { createLighterClient } from "@o1bot/lighter";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LinkStatus } from "@/lib/account";
import { price as fmtPrice, usdExact } from "@/lib/format";
import { vaultKey } from "@/lib/register";
import { NoKeyError, submitOrder } from "@/lib/submit";
import { quote, type Market } from "@/lib/ticket";

const LEVERAGES = [1, 2, 3, 5, 10, 20] as const;

export function Ticket({ market, mark, maxLeverage }: { market: Market; mark: number; maxLeverage: number }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];

  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [leverage, setLeverage] = useState(2);
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const address = wallet?.address;

  useEffect(() => {
    if (!address) {
      setStatus(null);
      return;
    }
    let alive = true;
    fetch(`/api/account?address=${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((s: LinkStatus) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [address]);

  const accountIndex = status?.state === "linked" ? status.account.index : null;

  useEffect(() => {
    if (accountIndex === null) {
      setHasKey(false);
      return;
    }
    try {
      setHasKey(localStorage.getItem(vaultKey(accountIndex)) !== null);
    } catch {
      setHasKey(false);
    }
  }, [accountIndex]);

  const entry = type === "limit" ? Number(limitPrice) || 0 : mark;
  const notional = Number(amount) || 0;

  // One quote feeds the ledger and the order. If this throws, the order cannot
  // be built, so there is nothing to show and nothing to send.
  const q = useMemo(() => {
    if (notional <= 0 || entry <= 0) return null;
    try {
      return quote({ side, type, notionalUsd: notional, price: entry, leverage, market });
    } catch (e) {
      return e instanceof Error ? e.message : "cannot build this order";
    }
  }, [side, type, notional, entry, leverage, market]);

  const q0 = typeof q === "object" && q !== null ? q : null;

  async function send() {
    if (!q0 || !wallet || accountIndex === null || busy) return;
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
    } catch (e) {
      setError(
        e instanceof NoKeyError
          ? "No signing key on this device. Register one on the start page first."
          : e instanceof Error
            ? e.message
            : "order failed",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <div className="panel ticket"><p className="muted">Loading…</p></div>;

  return (
    <div className="panel ticket">
      <div className="boxh">
        <h2>Place an order</h2>
      </div>

      <div className="tbody">
        <div className="sides">
          {(["long", "short"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`side ${s}${side === s ? " on" : ""}`}
              onClick={() => setSide(s)}
            >
              {s === "long" ? "Long" : "Short"}
            </button>
          ))}
        </div>

        <div className="chips">
          {(["market", "limit"] as const).map((t) => (
            <button key={t} type="button" className={`chip${type === t ? " on" : ""}`} onClick={() => setType(t)}>
              {t === "market" ? "Market" : "Limit"}
            </button>
          ))}
        </div>

        {type === "limit" && (
          <label className="field">
            <span>Limit price</span>
            <input
              className="chip amt"
              inputMode="decimal"
              placeholder={fmtPrice(mark)}
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
          </label>
        )}

        <label className="field">
          <span>Size (USDC)</span>
          <input
            className="chip amt"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        <div className="chips">
          {LEVERAGES.filter((l) => l <= maxLeverage).map((l) => (
            <button key={l} type="button" className={`chip${leverage === l ? " on" : ""}`} onClick={() => setLeverage(l)}>
              {l}x
            </button>
          ))}
        </div>

        {typeof q === "string" && <p className="down">{q}</p>}

        {/* The ledger is the product: it shows the whole price of the order
            before the button is usable, and it describes the order that will
            actually be sent, not the one that was typed. */}
        {q0 && (
          <dl className="ledger">
            <div>
              <dt>Size</dt>
              <dd>
                {q0.built.contracts}
                {q0.shortfallPct > 0.01 && (
                  <span className="muted"> · {q0.shortfallPct.toFixed(2)}% below your request</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Notional</dt>
              <dd>{usdExact(q0.effectiveNotionalUsd)}</dd>
            </div>
            <div>
              <dt>Margin at {leverage}x</dt>
              <dd>{usdExact(q0.ledger.marginUsd)}</dd>
            </div>
            <div>
              <dt>Venue fee</dt>
              <dd>{usdExact(q0.ledger.lighterFeeUsd)}</dd>
            </div>
            <div>
              <dt>o1bot fee</dt>
              <dd>{usdExact(q0.ledger.integratorFeeUsd)}</dd>
            </div>
            <div>
              <dt>Liquidation (est.)</dt>
              <dd>{fmtPrice(q0.ledger.liqPrice)}</dd>
            </div>
            <div className="total">
              <dt>Total debited</dt>
              <dd>{usdExact(q0.ledger.totalDebitedUsd)}</dd>
            </div>
          </dl>
        )}

        {!authenticated ? (
          <button type="button" className="btn wide" onClick={login}>
            Sign in to trade
          </button>
        ) : accountIndex === null ? (
          <p className="fine">
            No Lighter account for this wallet yet. <Link href="/start">Set one up</Link>.
          </p>
        ) : !hasKey ? (
          <p className="fine">
            No signing key on this device. <Link href="/start">Register one</Link>.
          </p>
        ) : (
          <button
            type="button"
            className={`btn wide ${side}`}
            onClick={() => void send()}
            disabled={busy || !q0}
          >
            {busy ? "Signing…" : side === "long" ? "Place long order" : "Place short order"}
          </button>
        )}

        {sent && <p className="up">Order sent. Hash {sent.slice(0, 14)}…</p>}
        {error && <p className="down">{error}</p>}

        <p className="fine">
          Lighter matches and settles this order and holds the collateral. Fills are never
          guaranteed, and a limit order may not execute at all.
        </p>
      </div>
    </div>
  );
}
