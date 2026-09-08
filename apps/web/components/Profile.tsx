"use client";

import Link from "next/link";
import { usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { TokenLogo } from "@/components/TokenLogo";
import { useGrantSigner, useLinkedRefresh } from "@/lib/use-grant-signer";

/**
 * The signed-in user's page: wallet, holdings, launches and creator fees.
 * Fee claims are signed in the browser by the user's own embedded wallet
 * (claimFor pays the recorded recipient, which is this wallet), so the bot
 * never touches them.
 */

type Me = {
  xHandle: string | null;
  wallet: { address: string; delegated: boolean; signerStale?: boolean } | null;
  linked: boolean;
  reason: string | null;
  balances: Array<{ chain: string; eth: string | null }>;
};

type Trading = { enabled: boolean; maxTradeEth: string | null; defaultCapEth: string; maxCapEth: string };

type Overview = {
  wallet: string | null;
  assets: Array<{ address: string; symbol: string; name: string; imageUrl: string | null; balance: string; usd: number | null; kind: "native" | "quote" | "token"; tokenPage: string | null }>;
  launches: Array<{ id: string; source: "X" | "WEB"; role: "creator" | "fee_recipient"; ticker: string; name: string; quoteSymbol: string; status: string; tokenAddress: string | null; launchTxHash: string | null; userMessage: string | null; createdAt: string }>;
  fees: { escrow: string; positions: Array<{ currency: string; symbol: string; owed: string; usd: number | null }> };
};

const EXPLORER = "https://robinhoodchain.blockscout.com";
const CHAIN_ID = 4663;
const escrowAbi = parseAbi(["function claimFor(address recipient, address currency)"]);

const fmt = (n: string | number, max = 6) => Number(n).toLocaleString("en-US", { maximumFractionDigits: max });
const usd = (v: number | null) => (v === null ? "" : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const STATUS_LABEL: Record<string, string> = {
  QUEUED: "queued",
  SIMULATING: "simulating",
  SIGNING: "signing",
  BROADCAST: "broadcast",
  CONFIRMED: "live",
  FEE_RECIPIENT_PENDING: "live",
  REPLIED: "live",
  DRY_RUN: "dry run",
  FAILED: "failed",
};

export function Profile() {
  const { ready, authenticated, user, login, logout, getAccessToken, exportWallet } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const signer = useGrantSigner();
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimTx, setClaimTx] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [trading, setTrading] = useState<Trading | null>(null);
  const [capDraft, setCapDraft] = useState<string>("");
  const [savingTrading, setSavingTrading] = useState(false);

  const load = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    const headers = { authorization: `Bearer ${token}` };
    const [meRes, ovRes, trRes] = await Promise.all([fetch("/api/me", { headers }), fetch("/api/me/overview", { headers }), fetch("/api/me/trading", { headers })]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
    if (ovRes.ok) setOverview((await ovRes.json()) as Overview);
    else setError(`Could not load your profile (HTTP ${ovRes.status}).`);
    if (trRes.ok) {
      const t = (await trRes.json()) as Trading;
      setTrading(t);
      setCapDraft(t.maxTradeEth ?? "");
    }
  }, [getAccessToken]);

  const saveTrading = useCallback(
    async (patch: { enabled?: boolean; maxTradeEth?: string | null }) => {
      const token = await getAccessToken();
      if (!token) return;
      setSavingTrading(true);
      setError(null);
      try {
        const res = await fetch("/api/me/trading", { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(patch) });
        const json = (await res.json()) as Trading & { error?: string };
        if (!res.ok) {
          setError(json.error ?? `Could not save (HTTP ${res.status}).`);
          return;
        }
        setTrading(json);
        setCapDraft(json.maxTradeEth ?? "");
      } finally {
        setSavingTrading(false);
      }
    },
    [getAccessToken],
  );

  useEffect(() => {
    if (ready && authenticated) void load();
    if (ready && !authenticated) {
      setMe(null);
      setOverview(null);
    }
  }, [ready, authenticated, load]);
  useLinkedRefresh(load);

  const claim = useCallback(
    async (currency: string, symbol: string) => {
      if (!overview?.wallet) return;
      setClaiming(currency);
      setError(null);
      setClaimTx(null);
      try {
        const data = encodeFunctionData({ abi: escrowAbi, functionName: "claimFor", args: [overview.wallet as Address, currency as Address] });
        // Privy shows its own confirmation for `claimFor(this wallet, currency)` on o1's escrow.
        void symbol;
        const result = await sendTransaction({ to: overview.fees.escrow as Address, data, chainId: CHAIN_ID });
        const hash = typeof result === "string" ? result : ((result as { hash?: string }).hash ?? null);
        setClaimTx(hash);
        setTimeout(() => void load(), 4000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The claim was cancelled.");
      } finally {
        setClaiming(null);
      }
    },
    [overview, sendTransaction, load],
  );

  const copy = useCallback(async () => {
    if (!overview?.wallet) return;
    await navigator.clipboard.writeText(overview.wallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [overview]);

  if (!ready) return <div className="card">Loading…</div>;
  if (!authenticated) {
    return (
      <div className="card">
        <h1 className="grad">Profile</h1>
        <p className="sub">Sign in with X to see your wallet, holdings, launches and creator fees.</p>
        <button className="btn-p" onClick={() => login()}>
          Sign in with X
        </button>
      </div>
    );
  }

  const handle = me?.xHandle ?? user?.twitter?.username ?? null;
  const avatar = user?.twitter?.profilePictureUrl ?? null;
  const eth = me?.balances.find((b) => b.chain === "robinhood")?.eth ?? null;
  const totalUsd = overview?.assets.reduce((s, a) => s + (a.usd ?? 0), 0) ?? 0;
  const feeUsd = overview?.fees.positions.reduce((s, p) => s + (p.usd ?? 0), 0) ?? 0;

  return (
    <>
      <div className="card me-head">
        <div className="who">
          <div className="av">{avatar ? <img src={avatar} alt="" /> : (handle ?? "?").slice(0, 1).toUpperCase()}</div>
          <div>
            <h1 className="grad">{handle ? `@${handle}` : "Your profile"}</h1>
            <div className="sub">
              {overview?.wallet ? (
                <>
                  Wallet <b>{short(overview.wallet)}</b>{" "}
                  <span className="cp" role="button" onClick={copy}>
                    {copied ? "copied" : "copy"}
                  </span>{" "}
                  · <a href={`${EXPLORER}/address/${overview.wallet}`} target="_blank" rel="noreferrer">explorer</a> ·{" "}
                  <span className="cp" role="button" onClick={() => exportWallet()}>
                    export key
                  </span>
                </>
              ) : (
                "No wallet yet"
              )}
            </div>
          </div>
        </div>
        <div className="stats">
          <div>
            <div className="k">Holdings</div>
            <div className="v">{usd(totalUsd) || "—"}</div>
          </div>
          <div>
            <div className="k">Claimable fees</div>
            <div className="v">{usd(feeUsd) || "—"}</div>
          </div>
          <div>
            <div className="k">Bot signing</div>
            <div className="v">
              {me?.linked ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                  <span className="ok">allowed</span>
                  <button
                    className="btn-s"
                    disabled={signer.busy || !signer.embedded}
                    title="Remove o1bot's signer from your wallet. Launches from posts stop until you allow it again."
                    onClick={async () => {
                      if (await signer.revoke()) await load();
                    }}
                  >
                    {signer.busy ? "Waiting for Privy…" : "Revoke"}
                  </button>
                </span>
              ) : (
                <button
                  className="btn-s"
                  disabled={signer.busy || !signer.embedded}
                  title={me?.wallet?.signerStale ? "Your earlier permission predates the signing policy. Grant it again so Privy enforces the limits." : undefined}
                  onClick={async () => {
                    if (await signer.grant({ replace: Boolean(me?.wallet?.signerStale) })) await load();
                  }}
                >
                  {signer.busy ? "Waiting for Privy…" : me?.wallet?.signerStale ? "Update permission" : "Allow"}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="actions">
          <Link className="btn-p" href="/launch">
            Launch a token
          </Link>
          <button className="btn-s" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="me-grid">
        <section className="card">
          <h2>Creator fees</h2>
          <p className="sub">Half of every 1% swap fee on your tokens, paid in the paired asset and held in o1's escrow until you claim it.</p>
          {overview === null ? (
            <div className="hint">Loading…</div>
          ) : overview.fees.positions.length === 0 ? (
            <div className="hint">Nothing to claim yet.</div>
          ) : (
            <table>
              <tbody>
                {overview.fees.positions.map((p) => (
                  <tr key={p.currency}>
                    <td>
                      <b>
                        {fmt(p.owed)} {p.symbol}
                      </b>
                      <div className="hint">{usd(p.usd)}</div>
                    </td>
                    <td className="r">
                      <button className="btn-p" disabled={claiming !== null} onClick={() => claim(p.currency, p.symbol)}>
                        {claiming === p.currency ? "Confirm in wallet…" : "Claim"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {eth !== null && Number(eth) === 0 && overview?.fees.positions.length ? <div className="hint">Claiming is a transaction from your wallet, so it needs a little ETH for gas.</div> : null}
          {claimTx && (
            <div className="hint">
              Claim sent:{" "}
              <a href={`${EXPLORER}/tx/${claimTx}`} target="_blank" rel="noreferrer">
                {short(claimTx)}
              </a>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Holdings</h2>
          {overview === null ? (
            <div className="hint">Loading…</div>
          ) : (
            <table>
              <tbody>
                {overview.assets.map((a) => (
                  <tr key={a.address}>
                    <td className="tk">
                      {a.kind === "token" ? <TokenLogo symbol={a.symbol} imageUrl={a.imageUrl} className="logo sm" /> : <span className="dot">{a.symbol.slice(0, 1)}</span>}
                      <div>
                        {a.tokenPage ? <Link href={a.tokenPage}>{a.symbol}</Link> : <b>{a.symbol}</b>}
                        <div className="hint">{a.name}</div>
                      </div>
                    </td>
                    <td className="r">
                      <b>{fmt(a.balance, a.kind === "token" ? 2 : 6)}</b>
                      <div className="hint">{usd(a.usd)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Your launches</h2>
        {overview === null ? (
          <div className="hint">Loading…</div>
        ) : overview.launches.length === 0 ? (
          <div className="hint">
            None yet. <Link href="/launch">Launch one from here</Link> or post the command on X.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Pair</th>
                <th>Via</th>
                <th>Status</th>
                <th className="r">When</th>
              </tr>
            </thead>
            <tbody>
              {overview.launches.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.tokenAddress && l.status !== "DRY_RUN" && l.status !== "FAILED" ? <Link href={`/token/${l.tokenAddress}`}>${l.ticker}</Link> : <b>${l.ticker}</b>}
                    <div className="hint">
                      {l.name}
                      {l.role === "fee_recipient" ? " · fees directed to you" : ""}
                    </div>
                  </td>
                  <td>{l.quoteSymbol}</td>
                  <td>{l.source === "WEB" ? "web" : "X"}</td>
                  <td>
                    <span className={l.status === "FAILED" ? "need" : STATUS_LABEL[l.status] === "live" ? "ok" : ""}>{STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</span>
                    {l.status === "FAILED" && l.userMessage ? <div className="hint">{l.userMessage}</div> : null}
                  </td>
                  <td className="r">{new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Trading from posts</h2>
        <p className="sub">
          Off by default. When on, a post like <b>@o1bot_exchange buy 0.05 ETH of $CAT</b> or <b>sell half of $CAT</b> trades from this wallet, on ETH pools of tokens launched here, up to
          your cap per trade. The output always lands in this wallet; the bot cannot send funds anywhere.
        </p>
        {trading === null ? (
          <div className="hint">Loading…</div>
        ) : (
          <div className="trade-set">
            <label className="switch">
              <input type="checkbox" checked={trading.enabled} disabled={savingTrading || !me?.linked} onChange={(e) => void saveTrading({ enabled: e.target.checked })} />
              <span>{trading.enabled ? "On" : "Off"}</span>
              {!me?.linked && <span className="hint">Allow bot signing above first.</span>}
            </label>
            <div className="cap">
              <span>Per-trade cap</span>
              <input
                inputMode="decimal"
                placeholder={trading.defaultCapEth}
                value={capDraft}
                disabled={savingTrading}
                onChange={(e) => setCapDraft(e.target.value)}
                aria-label="Per-trade cap in ETH"
              />
              <span>ETH</span>
              <button className="btn-s" disabled={savingTrading || capDraft === (trading.maxTradeEth ?? "")} onClick={() => void saveTrading({ maxTradeEth: capDraft.trim() === "" ? null : capDraft.trim() })}>
                {savingTrading ? "Saving…" : "Save"}
              </button>
              <span className="hint">Empty = {trading.defaultCapEth} ETH. Ceiling {trading.maxCapEth} ETH.</span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
