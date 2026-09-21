"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createLighterClient } from "@o1bot/lighter";
import { useEffect, useState } from "react";
import type { LinkStatus } from "@/lib/account";
import { registerApiKey, vaultKey } from "@/lib/register";
import { usd } from "@/lib/format";

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * An embedded wallet is one o1bot can sign for, so that account can also be
 * driven from a post. A wallet the visitor connected cannot be, and saying so
 * is the whole reason both are offered.
 */
function canSignFromAPost(walletClientType: string | undefined): boolean {
  return walletClientType === "privy";
}

export function LinkAccount() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallet = wallets[0];
  const address = wallet?.address;

  useEffect(() => {
    if (!address) {
      setStatus(null);
      return;
    }
    let alive = true;
    setChecking(true);
    fetch(`/api/account?address=${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: LinkStatus) => alive && setStatus(s))
      .catch(() => alive && setStatus({ state: "error", message: "could not reach the venue" }))
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [address]);

  const accountIndex = status?.state === "linked" ? status.account.index : null;

  useEffect(() => {
    if (accountIndex === null) {
      setRegistered(false);
      return;
    }
    try {
      setRegistered(localStorage.getItem(vaultKey(accountIndex)) !== null);
    } catch {
      setRegistered(false);
    }
  }, [accountIndex]);

  async function register() {
    if (accountIndex === null || !wallet || busy) return;
    setBusy(true);
    setError(null);
    try {
      const provider = await wallet.getEthereumProvider();
      const signMessage = (message: string) =>
        provider.request({ method: "personal_sign", params: [message, wallet.address] }) as Promise<string>;

      await registerApiKey({
        client: createLighterClient(),
        accountIndex,
        signMessage,
      });
      setRegistered(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "registration failed");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="muted">Loading…</p>;

  if (!authenticated || !address) {
    return (
      <div className="linkrow">
        <button type="button" className="btn" onClick={login}>
          Sign in with X or connect a wallet
        </button>
        <span className="fine">
          Signing in with X gets a wallet o1bot can sign for. Connecting your own keeps the keys
          with you.
        </span>
      </div>
    );
  }

  const fromPost = canSignFromAPost(wallet?.walletClientType);

  return (
    <div className="linked">
      <div className="linkrow">
        <span className="addr">{short(address)}</span>
        <span className={`tag ${fromPost ? "perp" : "spot"}`}>
          {fromPost ? "Terminal + from a post" : "Terminal only"}
        </span>
        <button type="button" className="chip" onClick={logout}>
          Disconnect
        </button>
      </div>

      {user?.twitter?.username && <p className="fine">Signed in as @{user.twitter.username}</p>}

      {checking && <p className="muted">Checking for a Lighter account…</p>}

      {status?.state === "none" && (
        <p>
          No Lighter account for this address yet. One is created the first time you deposit
          through the venue.
        </p>
      )}

      {status?.state === "linked" && (
        <p>
          Lighter account <strong>#{status.account.index}</strong> — available{" "}
          <strong>{usd(status.account.availableBalance)}</strong> of{" "}
          {usd(status.account.totalAssetValue)}.
        </p>
      )}

      {status?.state === "unusable" && (
        <p>
          This address has a Lighter account of a kind this app does not trade (type{" "}
          {status.types.join(", ")}). Nothing here will act on it.
        </p>
      )}

      {status?.state === "error" && (
        <p className="down">Could not check with the venue: {status.message}.</p>
      )}

      {status?.state === "linked" &&
        (registered ? (
          <p className="up">A signing key is registered for this account on this device.</p>
        ) : (
          <div className="linkrow">
            <button type="button" className="btn" onClick={() => void register()} disabled={busy}>
              {busy ? "Waiting for two signatures…" : "Register a signing key"}
            </button>
            <span className="fine">
              Two signatures: one derives the local encryption key and authorises nothing, one
              registers the key with the venue. The key is encrypted in this browser and never
              sent anywhere.
            </span>
          </div>
        ))}

      {error && <p className="down">Registration failed: {error}</p>}
    </div>
  );
}
