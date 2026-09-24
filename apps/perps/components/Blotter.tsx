"use client";

import { createLighterClient, type AccountPosition } from "@o1bot/lighter";
import { useWallets } from "@privy-io/react-auth";
import { useState } from "react";
import { useAccount } from "@/components/AccountContext";
import { CloseError, closeOrderFor } from "@/lib/close";
import { price, usdExact } from "@/lib/format";
import type { PerpRow } from "@/lib/markets";
import { NoKeyError, submitOrder } from "@/lib/submit";

type Tab = "pos" | "fil" | "ord" | "fee";

function time(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

function size(v: string | undefined): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—";
}

export function Blotter({ markets }: { markets: PerpRow[] }) {
  const { authenticated, accountIndex, hasKey, state, stream, refresh } = useAccount();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const [tab, setTab] = useState<Tab>("pos");
  const [closing, setClosing] = useState<number | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  async function close(p: AccountPosition) {
    if (accountIndex === null || !wallet || closing !== null) return;
    setClosing(p.market_id);
    setCloseError(null);
    try {
      const built = closeOrderFor(p, markets);
      const provider = await wallet.getEthereumProvider();
      const signMessage = (message: string) =>
        provider.request({ method: "personal_sign", params: [message, wallet.address] }) as Promise<string>;
      await submitOrder({ client: createLighterClient(), accountIndex, built, signMessage });
      refresh();
    } catch (e) {
      setCloseError(
        e instanceof NoKeyError
          ? "No signing key on this device — register one first."
          : e instanceof CloseError || e instanceof Error
            ? e.message
            : "could not close",
      );
    } finally {
      setClosing(null);
    }
  }

  const positions = state?.positions() ?? [];
  const fills = state?.fills(60) ?? [];

  const connected = accountIndex !== null;

  return (
    <div className="btabs">
      <div className="bar">
        <button type="button" className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>
          Positions{positions.length > 0 && <i>{positions.length}</i>}
        </button>
        <button type="button" className={tab === "ord" ? "on" : ""} onClick={() => setTab("ord")}>
          Open orders
        </button>
        <button type="button" className={tab === "fil" ? "on" : ""} onClick={() => setTab("fil")}>
          Fills{fills.length > 0 && <i>{fills.length}</i>}
        </button>
        <button type="button" className={tab === "fee" ? "on" : ""} onClick={() => setTab("fee")}>
          Fee share
        </button>
        <div className="grow" />
        {connected && <span className={`status ${stream}`}>{stream}</span>}
      </div>

      {!authenticated || !connected ? (
        <div className="pane">
          <p className="bempty">
            {authenticated
              ? "No Lighter account for this wallet yet."
              : "Sign in to see your positions and fills."}
          </p>
        </div>
      ) : tab === "pos" ? (
        <div className="pane pos">
          <div className="tr hd">
            <span>Market</span>
            <span>Side</span>
            <span>Size</span>
            <span>Entry</span>
            <span>Value</span>
            <span>Liq. price</span>
            <span>Unrealised</span>
            <span />
          </div>
          {positions.map((p) => {
            const pnl = Number(p.unrealized_pnl || 0);
            const liq = Number(p.liquidation_price || 0);
            return (
              <div className="tr" key={`${p.market_id}-${p.symbol}`}>
                <span>{p.symbol}</span>
                <span>
                  <span className={`sidetag ${p.sign === 1 ? "l" : "s"}`}>
                    {p.sign === 1 ? "Long" : "Short"}
                  </span>
                </span>
                <span>{size(p.position)}</span>
                <span>{price(p.avg_entry_price)}</span>
                <span>{usdExact(Number(p.position_value || 0))}</span>
                {/* The venue reports 0 when it has not computed one; showing
                    "0" would read as "liquidates at zero", which is the most
                    reassuring possible lie. */}
                <span className={liq > 0 ? "down" : "muted"}>{liq > 0 ? price(liq) : "—"}</span>
                <span className={pnl > 0 ? "up" : pnl < 0 ? "down" : ""}>
                  {pnl >= 0 ? "+" : "-"}
                  {usdExact(Math.abs(pnl))}
                </span>
                <span>
                  <button
                    type="button"
                    className="tbtn"
                    onClick={() => void close(p)}
                    disabled={closing !== null || !hasKey}
                    title={hasKey ? "Close at market, reduce-only" : "Register a signing key first"}
                  >
                    {closing === p.market_id ? "Closing…" : "Close"}
                  </button>
                </span>
              </div>
            );
          })}
          {positions.length === 0 && <p className="bempty">No open positions.</p>}
          {closeError && <p className="bempty down">{closeError}</p>}
        </div>
      ) : tab === "fil" ? (
        <div className="pane fil">
          <div className="tr hd">
            <span>Market</span>
            <span>Size</span>
            <span>Price</span>
            <span>Value</span>
            <span>Time</span>
          </div>
          {fills.map((f, i) => (
            <div className="tr" key={f.trade_id ?? i}>
              <span>{f.market_id ?? "—"}</span>
              <span>{size(f.size)}</span>
              <span>{price(f.price ?? 0)}</span>
              <span>{usdExact(Number(f.usd_amount || 0))}</span>
              <span className="muted">{time(f.timestamp)}</span>
            </div>
          ))}
          {fills.length === 0 && <p className="bempty">No fills in this session.</p>}
        </div>
      ) : tab === "ord" ? (
        <div className="pane">
          {/* The positions and fills channel is public; open orders are not, and
              need an auth token this app does not request yet. Saying so beats
              an empty table that looks like "you have no orders". */}
          <p className="bempty">
            Open orders need an authenticated stream, which is not wired up yet. This will show
            nothing even if you have orders resting — check the venue directly for now.
          </p>
        </div>
      ) : (
        <div className="pane">
          <p className="bempty">
            Fee share reports what o1bot routed and where it went. There is nothing to report: o1bot
            has no integrator account on the venue yet, so orders placed here carry no fee at all.
          </p>
        </div>
      )}
    </div>
  );
}
