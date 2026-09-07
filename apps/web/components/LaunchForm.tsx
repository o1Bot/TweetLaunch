"use client";

import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * The web way to launch: same checks, same wallet, same signing path as a
 * post on X. The form only records the request; the bot worker processes
 * it and this page polls the outcome.
 */

type Me = {
  xHandle: string | null;
  wallet: { address: string; delegated: boolean } | null;
  linked: boolean;
  reason: string | null;
  balances: Array<{ chain: string; eth: string | null }>;
  creationFeeEth: string;
};

type LaunchStatus = {
  id: string;
  status: string;
  ticker: string;
  tokenAddress: string | null;
  launchTxHash: string | null;
  feeRecipientTxHash: string | null;
  userMessage: string | null;
};

const PAIRS = ["ETH", "USDG"];
const EXPLORER = "https://robinhoodchain.blockscout.com";
const STEPS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "queued", label: "Queued for the bot", statuses: ["QUEUED"] },
  { key: "metadata", label: "Pinning logo and metadata, simulating on the live factory", statuses: ["SIMULATING"] },
  { key: "signing", label: "Signing from your wallet and broadcasting", statuses: ["SIGNING", "BROADCAST"] },
  { key: "fees", label: "Setting the fee recipient", statuses: ["FEE_RECIPIENT_PENDING"] },
  { key: "done", label: "Confirmed", statuses: ["CONFIRMED", "REPLIED", "DRY_RUN"] },
];
const FINAL = new Set(["CONFIRMED", "REPLIED", "DRY_RUN", "FAILED"]);

export function LaunchForm() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchStatus | null>(null);
  const [pairMode, setPairMode] = useState<"ETH" | "USDG" | "stock">("ETH");
  const [stock, setStock] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    const res = await fetch("/api/me", { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) setMe((await res.json()) as Me);
  }, [getAccessToken]);

  useEffect(() => {
    if (ready && authenticated) void refresh();
    if (ready && !authenticated) setMe(null);
  }, [ready, authenticated, refresh]);

  // Poll the launch until it reaches a final state.
  useEffect(() => {
    if (!launch || FINAL.has(launch.status)) return;
    const t = setInterval(async () => {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch(`/api/launch/${launch.id}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) setLaunch((await res.json()) as LaunchStatus);
    }, 2500);
    return () => clearInterval(t);
  }, [launch, getAccessToken]);

  const balance = useMemo(() => me?.balances.find((b) => b.chain === "robinhood")?.eth ?? null, [me]);

  const submit = useCallback(
    async (ev: React.FormEvent<HTMLFormElement>) => {
      ev.preventDefault();
      if (!formRef.current) return;
      setBusy(true);
      setError(null);
      setLaunch(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Sign in first.");
        const form = new FormData(formRef.current);
        form.set("pair", pairMode === "stock" ? stock.trim().toUpperCase() : pairMode);
        const res = await fetch("/api/launch", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
        const json = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !json.id) throw new Error(json.error ?? `HTTP ${res.status}`);
        setLaunch({ id: json.id, status: "QUEUED", ticker: String(form.get("ticker") ?? ""), tokenAddress: null, launchTxHash: null, feeRecipientTxHash: null, userMessage: null });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not submit the launch.");
      } finally {
        setBusy(false);
      }
    },
    [getAccessToken, pairMode, stock],
  );

  if (!ready) return <div className="card">Loading…</div>;

  if (!authenticated) {
    return (
      <div className="card">
        <h1 className="grad">Launch a token</h1>
        <p className="sub">Same wallet, same rules as launching from a post on X. Sign in with X to start.</p>
        <button className="btn-p" onClick={() => login()}>
          Sign in with X
        </button>
      </div>
    );
  }

  if (me && !me.linked) {
    return (
      <div className="card">
        <h1 className="grad">Launch a token</h1>
        <p className="sub">Your wallet is not set up for the bot yet ({me.reason ?? "not linked"}).</p>
        <Link className="btn-p" href="/start">
          Finish linking your account
        </Link>
      </div>
    );
  }

  const stepIndex = launch ? STEPS.findIndex((s) => s.statuses.includes(launch.status)) : -1;
  const failed = launch?.status === "FAILED";
  const done = launch ? launch.status !== "FAILED" && FINAL.has(launch.status) : false;

  return (
    <div className="card">
      <h1 className="grad">Launch a token</h1>
      <p className="sub">
        Signed from your wallet {me?.wallet ? <b>{me.wallet.address.slice(0, 6)}…{me.wallet.address.slice(-4)}</b> : null}
        {balance !== null && <> · balance {Number(balance).toFixed(4)} ETH</>} · creation fee {me?.creationFeeEth ?? "0.001"} ETH plus gas and the dev buy.
      </p>

      <form ref={formRef} onSubmit={submit}>
        <div className="lf-grid">
          <label>
            <b>Ticker</b>
            <input name="ticker" placeholder="CASHCAT" maxLength={11} required pattern="[A-Za-z0-9$]{1,12}" disabled={busy} />
            <span className="hint">1 to 11 letters or digits. Stock symbols are refused.</span>
          </label>
          <label>
            <b>Name</b>
            <input name="name" placeholder="Cash Cat" maxLength={50} required disabled={busy} />
          </label>
          <label>
            <b>Pair</b>
            <select value={pairMode} onChange={(e) => setPairMode(e.target.value as "ETH" | "USDG" | "stock")} disabled={busy}>
              {PAIRS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value="stock">Stock token…</option>
            </select>
          </label>
          <label>
            <b>{pairMode === "stock" ? "Stock symbol" : "Dev buy (ETH, optional)"}</b>
            {pairMode === "stock" ? (
              <input value={stock} onChange={(e) => setStock(e.target.value)} placeholder="NVDA" required disabled={busy} />
            ) : (
              <input name="devBuyNative" placeholder="0.05" inputMode="decimal" disabled={busy} />
            )}
            <span className="hint">{pairMode === "stock" ? "Creator fees are paid in the stock token." : "Buys inside the launch transaction, exempt from the anti-snipe fee."}</span>
          </label>
          {pairMode === "stock" && (
            <label>
              <b>Dev buy (ETH, optional)</b>
              <input name="devBuyNative" placeholder="0.05" inputMode="decimal" disabled={busy} />
            </label>
          )}
          <label className="full">
            <b>Logo (optional)</b>
            <input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} />
            <span className="hint">PNG, JPEG, WebP or GIF up to 2 MB. A placeholder is used otherwise.</span>
          </label>
          <label className="full">
            <b>Description (optional)</b>
            <textarea name="description" maxLength={2000} placeholder="What the token is about." disabled={busy} />
          </label>
          <label>
            <b>Website (optional)</b>
            <input name="website" placeholder="https://…" disabled={busy} />
          </label>
          <label>
            <b>Telegram (optional)</b>
            <input name="telegram" placeholder="@group or t.me link" disabled={busy} />
          </label>
          <label>
            <b>X account for the token (optional)</b>
            <input name="xHandle" placeholder={me?.xHandle ? `@${me.xHandle}` : "@handle"} disabled={busy} />
            <span className="hint">Defaults to your own account.</span>
          </label>
          <label>
            <b>Send creator fees to (optional)</b>
            <input name="feesToHandle" placeholder="@someone" disabled={busy} />
            <span className="hint">They claim from this site after signing in with X.</span>
          </label>
        </div>
        <div className="actions">
          <button className="btn-p" type="submit" disabled={busy || (launch !== null && !FINAL.has(launch.status))}>
            {busy ? "Submitting…" : "Launch"}
          </button>
          <span className="hint">You pay the creation fee, gas and the dev buy from your own wallet. Nothing is charged by o1bot.</span>
        </div>
        {error && <div className="alert">{error}</div>}
      </form>

      {launch && (
        <div className="status">
          <b>${launch.ticker}</b>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={s.key} className={`step ${i < stepIndex || done ? "done" : i === stepIndex ? "on" : ""}`}>
                <i />
                {s.label}
              </div>
            ))}
          </div>
          {failed && <div className="alert">{launch.userMessage ?? "The launch failed."}</div>}
          {done && (
            <>
              <div className="result">{launch.userMessage}</div>
              {launch.status === "DRY_RUN" && <div className="hint">Dry run: the bot is not signing yet, so this token was only simulated.</div>}
              <div className="links">
                {launch.tokenAddress && launch.status !== "DRY_RUN" && (
                  <Link className="btn-p" href={`/token/${launch.tokenAddress}`}>
                    Open token page
                  </Link>
                )}
                {launch.launchTxHash && (
                  <a className="btn-s" href={`${EXPLORER}/tx/${launch.launchTxHash}`} target="_blank" rel="noreferrer">
                    Launch transaction
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
