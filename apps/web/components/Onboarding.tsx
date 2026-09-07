"use client";

import { useDelegatedActions, usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The demo's "Launch a token" modal as a page: link X → fund wallet → post.
 * Step 2 also asks the user to delegate signing to o1bot; without it the bot
 * cannot sign a launch from their wallet.
 */

type Me = {
  xUserId: string;
  xHandle: string | null;
  wallet: { address: string; walletId: string | null; delegated: boolean } | null;
  linked: boolean;
  reason: string | null;
  balances: Array<{ chain: "robinhood"; eth: string | null; error: string | null }>;
  requiredEth: string;
  creationFeeEth: string;
};

const X_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.9 2H22l-7.2 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.1l7.7-8.8L1.6 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.1 3.9H5.2L17.7 20z" />
  </svg>
);

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function Onboarding() {
  const { ready, authenticated, user, login, logout, getAccessToken, exportWallet } = usePrivy();
  const { wallets } = useWallets();
  const { delegateWallet } = useDelegatedActions();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const embedded = useMemo(() => wallets.find((w) => w.walletClientType === "privy") ?? null, [wallets]);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    const res = await fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setError(`Could not load your wallet (HTTP ${res.status}).`);
      return;
    }
    setMe((await res.json()) as Me);
  }, [getAccessToken]);

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setMe(null);
      setStep(1);
      return;
    }
    setStep((s) => (s === 1 ? 2 : s));
    void refresh();
  }, [ready, authenticated, refresh]);

  const delegate = useCallback(async () => {
    if (!embedded) return;
    setBusy("delegate");
    setError(null);
    try {
      await delegateWallet({ address: embedded.address, chainType: "ethereum" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delegation was cancelled.");
    } finally {
      setBusy(null);
    }
  }, [embedded, delegateWallet, refresh]);

  const copy = useCallback(async () => {
    if (!me?.wallet) return;
    await navigator.clipboard.writeText(me.wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [me]);

  const balance = (chain: "robinhood") => me?.balances.find((b) => b.chain === chain) ?? null;
  const enough = (chain: "robinhood") => {
    const b = balance(chain);
    return b?.eth !== null && b !== null && Number(b.eth) >= Number(me?.requiredEth ?? "0");
  };

  const handle = me?.xHandle ?? user?.twitter?.username ?? null;

  return (
    <section className="sheet" aria-label="Launch a token">
      <div className="sheet-h">
        <h2 className="grad">Launch a token</h2>
        <p>Three things, once. After that every launch is one post.</p>
      </div>

      <div className="steps">
        <button className={`step ${step === 1 ? "on" : ""} ${authenticated ? "done" : ""}`} onClick={() => setStep(1)}>
          <span className="n">1</span>
          <span>
            <b>Link your X account</b>
            <small>Creates your wallet</small>
          </span>
        </button>
        <button
          className={`step ${step === 2 ? "on" : ""} ${me?.linked ? "done" : ""}`}
          onClick={() => authenticated && setStep(2)}
          disabled={!authenticated}
        >
          <span className="n">2</span>
          <span>
            <b>Top up the launch fee</b>
            <small>{me?.creationFeeEth ?? "0.001"} ETH + gas</small>
          </span>
        </button>
        <button className={`step ${step === 3 ? "on" : ""}`} onClick={() => authenticated && setStep(3)} disabled={!authenticated}>
          <span className="n">3</span>
          <span>
            <b>Post the command</b>
            <small>Mention the bot</small>
          </span>
        </button>
      </div>

      {step === 1 && (
        <div className="sp">
          <p>
            Sign in with the X account you will post from. o1bot creates a wallet for it. The bot signs launches with
            this wallet, so the token&apos;s creator address and its trading fees are yours, not ours.
          </p>
          {!authenticated ? (
            <button className="btn-p wide" onClick={login} disabled={!ready}>
              {X_ICON}
              Continue with X
            </button>
          ) : (
            <div className="two">
              <button className="btn-s" onClick={logout}>
                Sign out
              </button>
              <button className="btn-p" onClick={() => setStep(2)}>
                Linked as @{handle} · Continue
              </button>
            </div>
          )}
          <div className="fine">Wallet is created and secured by Privy. You can export the key any time.</div>
        </div>
      )}

      {step === 2 && (
        <div className="sp">
          <p>
            o1 charges {me?.creationFeeEth ?? "0.001"} ETH per launch, plus gas. Send at least that to your o1bot wallet
            on Robinhood Chain. The bot will not post a launch it cannot pay for. It replies telling you the balance is
            short instead.
          </p>
          <div className="walletbox">
            <div className="wb-row">
              <span>Your wallet</span>
              <b>
                {me?.wallet ? short(me.wallet.address) : "…"}
                {me?.wallet && (
                  <span className="cp" onClick={copy} role="button">
                    {copied ? "copied" : "copy"}
                  </span>
                )}
              </b>
            </div>
            {(["robinhood"] as const).map((chain) => {
              const b = balance(chain);
              return (
                <div className="wb-row" key={chain}>
                  <span>Robinhood Chain</span>
                  <b>
                    {b?.eth !== null && b?.eth !== undefined ? `${Number(b.eth).toFixed(4)} ETH` : "—"}
                    {b?.error ? (
                      <span className="need">rpc error</span>
                    ) : enough(chain) ? (
                      <span className="ok">ready</span>
                    ) : (
                      <span className="need">need {me?.requiredEth ?? "0.0015"}</span>
                    )}
                  </b>
                </div>
              );
            })}
            <div className="wb-row">
              <span>Bot signing</span>
              <b>
                {me?.wallet?.delegated ? (
                  <span className="ok">allowed</span>
                ) : (
                  <span className="need">not allowed yet</span>
                )}
              </b>
            </div>
          </div>

          {!me?.wallet?.delegated && (
            <button className="btn-p wide" onClick={delegate} disabled={!embedded || busy !== null}>
              {busy === "delegate" ? "Waiting for Privy…" : "Allow o1bot to sign launches from this wallet"}
            </button>
          )}
          {error && <div className="alert">{error}</div>}

          <div className="two" style={{ marginTop: 12 }}>
            <button className="btn-s" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn-p" onClick={() => setStep(3)}>
              I&apos;ve sent it
            </button>
          </div>
          <div className="fine">
            Top up once for several launches. Stock-paired launches on Robinhood also pay {me?.creationFeeEth ?? "0.001"}{" "}
            ETH, not the stock token.{" "}
            <span className="cp" onClick={() => exportWallet()} role="button">
              Export private key
            </span>
            {" · "}
            <span className="cp" onClick={() => void refresh()} role="button">
              Refresh balances
            </span>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="sp">
          <p>Post this from your linked account. Attach an image to the post and it becomes the token logo.</p>
          <div className="cmdbox">
            <div className="cmd-l">Crypto pair</div>
            <div className="cmd">
              <b>@o1bot_exchange</b> launch <em>$TICKER</em> &quot;Token name&quot; pair <em>ETH</em> on <em>robinhood</em>
            </div>
            <div className="cmd-l">Stock pair, fees paid in the stock</div>
            <div className="cmd">
              <b>@o1bot_exchange</b> launch <em>$TICKER</em> &quot;Token name&quot; pair <em>NVDA</em> on <em>robinhood</em>
            </div>
            <div className="cmd-l">Optional extras</div>
            <div className="cmd-opts">
              <em>devbuy 0.05</em> buys at launch without the anti-snipe surcharge · <em>fees to @someone</em> sends
              creator fees to another X account
            </div>
            <div className="cmd-l">Pairs</div>
            <div className="cmd-opts">ETH · USDG · any of the 194 registered stock tokens on Robinhood Chain</div>
          </div>
          {me && !me.linked && (
            <div className="notice">
              Your account is not ready for launches yet ({me.reason}). Finish step 2 first.
            </div>
          )}
          <div className="two">
            <button className="btn-s" onClick={() => setStep(2)}>
              Back
            </button>
            <a
              className="btn-p"
              href={`https://x.com/intent/post?text=${encodeURIComponent('@o1bot_exchange launch $TICKER "Token name" pair ETH on robinhood')}`}
              target="_blank"
              rel="noreferrer"
            >
              {X_ICON}
              Open X and post
            </a>
          </div>
          <div className="fine">
            The bot replies to your post with the token address and o1 link within about a minute. Trading opens
            immediately with o1&apos;s 20-second anti-snipe fee.
          </div>
        </div>
      )}
    </section>
  );
}
