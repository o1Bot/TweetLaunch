"use client";

import { RESTRICTED_COUNTRIES, countryName } from "@o1bot/lighter";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { useAccount } from "@/components/AccountContext";

/** The main site, which owns the user table and the bot's signer grant; the opt-in API lives there. */
const WEB = process.env.NEXT_PUBLIC_WEB_ORIGIN || "https://o1bot.exchange";

type View = {
  status: "none" | "PENDING" | "RUNNING" | "ACTIVE" | "FAILED" | "DISABLED";
  blocker: "sign_in" | "no_wallet" | "not_delegated" | null;
  accountIndex: string | null;
  maxNotionalUsd: string;
  maxLeverage: number;
  registerTxHash: string | null;
  error: string | null;
  limits: { maxNotionalUsd: string; maxLeverage: number };
};

function label(s: View["status"]): string {
  switch (s) {
    case "ACTIVE":
      return "on";
    case "PENDING":
    case "RUNNING":
      return "registering";
    case "FAILED":
      return "failed";
    case "DISABLED":
      return "off";
    default:
      return "not set up";
  }
}

/**
 * Step 4: let the bot trade perps from this user's posts.
 *
 * Only a wallet o1bot can sign for qualifies — the embedded one from an X
 * login. Enabling registers the bot's own key on the user's Lighter account
 * (the bot's worker does it; this panel asks and watches), within caps the
 * user sets here. The commands themselves ship in the next release, so the
 * copy says so rather than implying a post already trades.
 */
export function FromPost({ country }: { country: string | null }) {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets[0];
  const embedded = wallet?.walletClientType === "privy";
  const { accountIndex } = useAccount();

  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxNotional, setMaxNotional] = useState("100");
  const [maxLeverage, setMaxLeverage] = useState("5");
  const [attest, setAttest] = useState(false);

  const call = useCallback(
    async (method: "GET" | "POST" | "DELETE", body?: unknown): Promise<View> => {
      const token = await getAccessToken();
      if (!token) throw new Error("not signed in");
      const res = await fetch(`${WEB}/api/me/perps`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => null)) as (View & { error?: string }) | null;
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      if (!json) throw new Error("empty answer from the site");
      return json;
    },
    [getAccessToken],
  );

  const load = useCallback(async () => {
    try {
      const v = await call("GET");
      setView(v);
      if (v.status !== "none") {
        setMaxNotional(v.maxNotionalUsd);
        setMaxLeverage(String(v.maxLeverage));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load");
    }
  }, [call]);

  useEffect(() => {
    if (ready && authenticated && embedded) void load();
  }, [ready, authenticated, embedded, load]);

  // A registration in flight is the bot's job; watch it rather than make the user reload.
  const inFlight = view?.status === "PENDING" || view?.status === "RUNNING";
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function submit(method: "POST" | "DELETE") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const v = await call(
        method,
        method === "POST" ? { maxNotionalUsd: maxNotional.trim(), maxLeverage: Number(maxLeverage), country, attest } : undefined,
      );
      setView(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  const open = ready && authenticated && embedded;
  const active = view?.status === "ACTIVE";
  const blocked = Boolean(view?.blocker);

  return (
    <section className={`panel gate${open ? "" : " pending"}`}>
      <div className="gateh">
        <h2>4. Trade from a post</h2>
        {!ready || !authenticated ? (
          <span className="soon">connect first</span>
        ) : !embedded ? (
          <span className="soon">X login only</span>
        ) : view ? (
          <span className={`status ${active ? "live" : inFlight ? "reconnecting" : ""}`}>{label(view.status)}</span>
        ) : null}
      </div>

      {!open ? (
        <p>
          Only a wallet o1bot can sign for can trade from a post — the one you get by signing in with X.
          A wallet you connected yourself stays terminal-only, by design.
        </p>
      ) : (
        <>
          <p>
            o1bot registers its own key on your Lighter account, in its own slot, and may then place the
            orders you post — up to the caps below, never more. The commands themselves ship in the next
            release; enabling now means you are ready the day they do.
          </p>

          {view?.blocker === "not_delegated" && (
            <p className="down">
              Grant o1bot signing on <a href={WEB}>o1bot.exchange</a> first — it happens when you sign in
              there.
            </p>
          )}
          {accountIndex === null && (
            <p className="fine">Deposit first (step 3): the account has to exist before a key can be registered on it.</p>
          )}

          <div className="linkrow">
            <label className="fine">
              Max per order{" "}
              <input
                className="chip amt"
                inputMode="decimal"
                value={maxNotional}
                onChange={(e) => setMaxNotional(e.target.value)}
                aria-label="Maximum order size in USDC"
              />{" "}
              USDC
            </label>
            <label className="fine">
              Max leverage{" "}
              <input
                className="chip amt"
                inputMode="numeric"
                value={maxLeverage}
                onChange={(e) => setMaxLeverage(e.target.value)}
                aria-label="Maximum leverage"
              />
              x
            </label>
          </div>
          {view && (
            <p className="fine">
              This deployment allows at most {view.limits.maxNotionalUsd} USDC per order and {view.limits.maxLeverage}x.
            </p>
          )}

          {!active && (
            <label className="check">
              <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
              <span>
                I confirm I do not reside in, and am not accessing this from,{" "}
                {RESTRICTED_COUNTRIES.map(countryName).join(", ")}, or any jurisdiction under comprehensive
                sanctions.
                {country ? ` This request looks like it comes from ${countryName(country)}.` : ""}
              </span>
            </label>
          )}

          <div className="linkrow">
            <button
              type="button"
              className="btn"
              onClick={() => void submit("POST")}
              disabled={busy || (!active && !attest) || blocked}
            >
              {busy ? "Saving…" : active ? "Update caps" : view?.status === "FAILED" ? "Try again" : "Enable"}
            </button>
            {(active || inFlight) && (
              <button type="button" className="chip" onClick={() => void submit("DELETE")} disabled={busy}>
                Disable
              </button>
            )}
          </div>

          {view?.status === "FAILED" && view.error && <p className="down">{view.error}</p>}
          {inFlight && <p className="muted">Registering the key on your account — this takes the bot a minute.</p>}
          {active && (
            <p className="up">
              On. Key registered{view?.registerTxHash ? ` · ${view.registerTxHash.slice(0, 12)}…` : ""}. Your wallet
              signed one message to register it. A Lighter key can trade and withdraw only to your own address;
              it cannot send funds anywhere else.
            </p>
          )}
          {error && <p className="down">{error}</p>}
        </>
      )}
    </section>
  );
}
