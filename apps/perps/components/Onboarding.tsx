"use client";

import { createLighterClient } from "@o1bot/lighter";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { Deposit } from "@/components/Deposit";
import type { LinkStatus } from "@/lib/account";
import { usd } from "@/lib/format";
import { registerApiKey, vaultKey } from "@/lib/register";

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

/**
 * Steps 2 to 4 share one wallet and one view of the account, so they live in
 * one component: depositing is what creates the account that step 2 then finds,
 * and splitting them would mean two copies of that state disagreeing.
 */
export function Onboarding() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallet = wallets[0];
  const address = wallet?.address;

  const check = useCallback(async () => {
    if (!address) {
      setStatus(null);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch(`/api/account?address=${address}`);
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as LinkStatus);
    } catch {
      setStatus({ state: "error", message: "could not reach the venue" });
    } finally {
      setChecking(false);
    }
  }, [address]);

  useEffect(() => {
    void check();
  }, [check]);

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
        provider.request({
          method: "personal_sign",
          params: [message, wallet.address],
        }) as Promise<string>;

      await registerApiKey({ client: createLighterClient(), accountIndex, signMessage });
      setRegistered(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "registration failed");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <p className="muted">Loading…</p>;

  const fromPost = canSignFromAPost(wallet?.walletClientType);

  return (
    <>
      <section className="panel gate">
        <div className="gateh">
          <h2>2. Link a Lighter account</h2>
        </div>

        {!authenticated || !address ? (
          <>
            <p>Two ways in. They give you different things, so pick on that basis.</p>
            <div className="linkrow">
              <button type="button" className="btn" onClick={login}>
                Sign in with X or connect a wallet
              </button>
            </div>
            <p className="fine">
              Signing in with X gets a wallet o1bot can sign for, so orders can come from a post.
              Connecting your own keeps the keys with you, and only the terminal works.
            </p>
          </>
        ) : (
          <>
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
            {checking && <p className="muted">Checking with the venue…</p>}

            {status?.state === "none" && (
              <p>No Lighter account for this address yet — the deposit below creates one.</p>
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
                <>
                  <div className="linkrow">
                    <button type="button" className="btn" onClick={() => void register()} disabled={busy}>
                      {busy ? "Waiting for two signatures…" : "Register a signing key"}
                    </button>
                  </div>
                  <p className="fine">
                    Two signatures: one derives the local encryption key and authorises nothing, one
                    registers the key with the venue. The key is encrypted in this browser and never
                    sent anywhere.
                  </p>
                </>
              ))}

            {error && <p className="down">Registration failed: {error}</p>}
          </>
        )}

        <p className="fine">
          Each wallet is its own Lighter account with its own collateral. Using both does not pool
          them.
        </p>
      </section>

      <section className={`panel gate${authenticated && address ? "" : " pending"}`}>
        <div className="gateh">
          <h2>3. Fund it</h2>
          {!(authenticated && address) && <span className="soon">connect first</span>}
        </div>
        <p>
          Deposit USDC from Ethereum. Your collateral sits with the venue — o1bot never holds it and
          cannot withdraw it.
        </p>
        {authenticated && wallet ? (
          <Deposit wallet={wallet} onDeposited={() => void check()} />
        ) : (
          <p className="fine">
            Only the direct Ethereum route is offered here. Depositing from another chain is
            cheaper, but it runs through an address the venue mints from an endpoint it does not
            document, and that is not something to guess at with someone's money.
          </p>
        )}
      </section>
    </>
  );
}
