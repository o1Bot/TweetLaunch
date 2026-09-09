"use client";

import Link from "next/link";
import { usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { EXT_ICON, TokenLogo, X_ICON } from "@/components/TokenLogo";
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

const ICON = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  ),
  key: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M14 9l3 3" />
    </svg>
  ),
  rocket: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 15l-2 6 6-2M14 4c3-1 6-1 7 0 1 1 1 4 0 7l-8 8-7-7 8-8z" />
      <circle cx="15" cy="9" r="1.5" />
    </svg>
  ),
  out: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
    </svg>
  ),
  check: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
};

const STATUS_CLASS = (status: string) => (status === "FAILED" ? "bad" : STATUS_LABEL[status] === "live" ? "live" : "wait");

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

  if (!ready) return <div className="card me-empty">Loading…</div>;
  if (!authenticated) {
    return (
      <div className="card me-empty">
        <div className="me-empty-icon">{X_ICON}</div>
        <h1 className="grad">Your profile</h1>
        <p className="sub">Sign in with X to see your wallet, holdings, launches and creator fees.</p>
        <button className="btn-p" onClick={() => login()}>
          {X_ICON} Sign in with X
        </button>
      </div>
    );
  }

  const handle = me?.xHandle ?? user?.twitter?.username ?? null;
  const avatar = user?.twitter?.profilePictureUrl ?? null;
  const eth = me?.balances.find((b) => b.chain === "robinhood")?.eth ?? null;
  const totalUsd = overview?.assets.reduce((s, a) => s + (a.usd ?? 0), 0) ?? 0;
  const feeUsd = overview?.fees.positions.reduce((s, p) => s + (p.usd ?? 0), 0) ?? 0;
  const stale = Boolean(me?.wallet?.signerStale);

  return (
    <>
      <div className="card me-head">
        <div className="who">
          <div className="av">{avatar ? <img src={avatar} alt="" /> : (handle ?? "?").slice(0, 1).toUpperCase()}</div>
          <div className="id">
            <h1 className="grad">{handle ? `@${handle}` : "Your profile"}</h1>
            {overview?.wallet ? (
              <div className="wallet">
                <code className="addr" title={overview.wallet}>
                  {short(overview.wallet)}
                </code>
                <button className="pill" onClick={copy} title="Copy the full wallet address">
                  {copied ? ICON.check : ICON.copy}
                  {copied ? "Copied" : "Copy"}
                </button>
                <a className="pill" href={`${EXPLORER}/address/${overview.wallet}`} target="_blank" rel="noreferrer">
                  {EXT_ICON}
                  Explorer
                </a>
                <button className="pill" onClick={() => exportWallet()} title="Reveal the private key of this wallet through Privy">
                  {ICON.key}
                  Export key
                </button>
              </div>
            ) : (
              <div className="hint">No wallet yet. It is created on your first sign-in.</div>
            )}
          </div>
        </div>

        <div className="tiles">
          <div className="tile">
            <span className="k">Holdings</span>
            <span className="v">{usd(totalUsd) || "—"}</span>
            <span className="hint">{eth !== null ? `${fmt(eth, 5)} ETH on Robinhood` : ""}</span>
          </div>
          <div className="tile">
            <span className="k">Claimable fees</span>
            <span className="v">{usd(feeUsd) || "—"}</span>
            <span className="hint">{overview ? `${overview.fees.positions.length} position${overview.fees.positions.length === 1 ? "" : "s"}` : ""}</span>
          </div>
          <div className="tile">
            <span className="k">Bot signing</span>
            {me?.linked ? (
              <span className="v row">
                <span className="badge live">{ICON.check} Allowed</span>
                <button
                  className="btn-s xs"
                  disabled={signer.busy || !signer.embedded}
                  title="Remove o1bot's signer from your wallet. Launches and trades from posts stop until you allow it again."
                  onClick={async () => {
                    if (await signer.revoke()) await load();
                  }}
                >
                  {signer.busy ? "Waiting…" : "Revoke"}
                </button>
              </span>
            ) : (
              <span className="v row">
                <span className={`badge ${stale ? "wait" : "off"}`}>{stale ? "Needs update" : "Off"}</span>
                <button
                  className="btn-p xs"
                  disabled={signer.busy || !signer.embedded}
                  title={stale ? "Your earlier permission predates the signing policy. Grant it again so Privy enforces the limits." : "Let o1bot sign launches and trades from this wallet, within Privy's policy."}
                  onClick={async () => {
                    if (await signer.grant({ replace: stale })) await load();
                  }}
                >
                  {signer.busy ? "Waiting for Privy…" : stale ? "Update permission" : "Allow"}
                </button>
              </span>
            )}
            <span className="hint">{me?.linked ? "Launch and trade from a post" : "Needed for posts to work"}</span>
          </div>
        </div>

        <div className="actions">
          <Link className="btn-p" href="/launch">
            {ICON.rocket} Launch a token
          </Link>
          <Link className="btn-s" href="/">
            Board
          </Link>
          <button className="btn-s ghost" onClick={() => logout()}>
            {ICON.out} Sign out
          </button>
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {signer.error && <div className="alert">{signer.error}</div>}

      <div className="me-grid">
        <section className="card">
          <div className="card-h">
            <h2>Creator fees</h2>
            <span className="hint">0.5% of every trade on your tokens</span>
          </div>
          <p className="sub">Paid in the paired asset and held in o1's escrow until you claim it. Claiming is a transaction from your wallet.</p>
          {overview === null ? (
            <div className="empty">Loading…</div>
          ) : overview.fees.positions.length === 0 ? (
            <div className="empty">Nothing to claim yet. Fees appear here as soon as your tokens trade.</div>
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
                      <button className="btn-p sm" disabled={claiming !== null} onClick={() => claim(p.currency, p.symbol)}>
                        {claiming === p.currency ? "Confirm in wallet…" : "Claim"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {eth !== null && Number(eth) === 0 && overview?.fees.positions.length ? <div className="notice">Your wallet has no ETH for gas, so a claim cannot be sent yet. Top it up first.</div> : null}
          {claimTx && (
            <div className="notice">
              Claim sent:{" "}
              <a href={`${EXPLORER}/tx/${claimTx}`} target="_blank" rel="noreferrer">
                {short(claimTx)} {EXT_ICON}
              </a>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-h">
            <h2>Holdings</h2>
            <span className="hint">{overview ? `${overview.assets.length} asset${overview.assets.length === 1 ? "" : "s"}` : ""}</span>
          </div>
          {overview === null ? (
            <div className="empty">Loading…</div>
          ) : overview.assets.length === 0 ? (
            <div className="empty">Nothing here yet. Send ETH on Robinhood Chain to your wallet address above.</div>
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
        <div className="card-h">
          <h2>Trading from posts</h2>
          <span className="hint">Opt-in, with your own cap</span>
        </div>
        <p className="sub">
          When on, a post like <b>@o1bot_exchange buy 0.05 ETH of $CAT</b> or <b>sell half of $CAT</b> trades from this wallet on any o1 Launchpad pool, up to your cap per trade. The output always lands in this
          wallet; the bot cannot send funds anywhere.
        </p>
        {trading === null ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="trade-set">
            <label className={`toggle${trading.enabled ? " on" : ""}${savingTrading || !me?.linked ? " disabled" : ""}`}>
              <input type="checkbox" checked={trading.enabled} disabled={savingTrading || !me?.linked} onChange={(e) => void saveTrading({ enabled: e.target.checked })} />
              <span className="track">
                <span className="thumb" />
              </span>
              <span className="lbl">{trading.enabled ? "On" : "Off"}</span>
              {!me?.linked && <span className="hint">Allow bot signing above first.</span>}
            </label>
            <div className="cap">
              <span className="k">Per-trade cap</span>
              <span className="field">
                <input inputMode="decimal" placeholder={trading.defaultCapEth} value={capDraft} disabled={savingTrading} onChange={(e) => setCapDraft(e.target.value)} aria-label="Per-trade cap in ETH" />
                <span className="suffix">ETH</span>
              </span>
              <button className="btn-p sm" disabled={savingTrading || capDraft === (trading.maxTradeEth ?? "")} onClick={() => void saveTrading({ maxTradeEth: capDraft.trim() === "" ? null : capDraft.trim() })}>
                {savingTrading ? "Saving…" : "Save"}
              </button>
              <span className="hint">
                Empty = {trading.defaultCapEth} ETH. Ceiling {trading.maxCapEth} ETH.
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-h">
          <h2>Your launches</h2>
          <span className="hint">{overview ? `${overview.launches.length} total` : ""}</span>
        </div>
        {overview === null ? (
          <div className="empty">Loading…</div>
        ) : overview.launches.length === 0 ? (
          <div className="empty">
            None yet. <Link href="/launch">Launch one from here</Link> or post the command on X.
          </div>
        ) : (
          <div className="tbl">
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
                      <span className={`badge ${STATUS_CLASS(l.status)}`}>{STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</span>
                      {l.status === "FAILED" && l.userMessage ? <div className="hint">{l.userMessage}</div> : null}
                    </td>
                    <td className="r">{new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
