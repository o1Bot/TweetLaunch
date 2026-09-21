"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useEffect, useState } from "react";
import type { LinkStatus } from "@/lib/account";
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

      <p className="fine">
        Registering a signing key is the next step and is not built yet — nothing here signs
        anything.
      </p>
    </div>
  );
}
