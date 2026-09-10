"use client";

import Link from "next/link";
import { usePrivy, useSendTransaction } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFunctionData, erc20Abi, isAddress, parseAbi, parseUnits, type Address } from "viem";
import { AssetIcon, CHAIN_NAMES, ChainIcon } from "@/components/ChainIcons";
import { EXT_ICON, TokenLogo, X_ICON } from "@/components/TokenLogo";
import { useGrantSigner, useLinkedRefresh } from "@/lib/use-grant-signer";

/**
 * The signed-in user's page, laid out like the v3 demo: identity, balance,
 * wallet actions and bot permissions on the left; claimable fees, assets,
 * launches, trades and the "from posts" settings on the right. Fee claims
 * and withdrawals are signed in the browser by the user's own embedded
 * wallet; the bot never touches them.
 */

type Me = {
  xHandle: string | null;
  wallet: { address: string; delegated: boolean; signerStale?: boolean } | null;
  linked: boolean;
  reason: string | null;
  balances: Array<{ chain: string; eth: string | null }>;
};

type Asset = { address: string; symbol: string; name: string; imageUrl: string | null; decimals: number; balance: string; usd: number | null; kind: "native" | "quote" | "token"; tokenPage: string | null };
type LaunchRow = { id: string; source: "X" | "WEB"; role: "creator" | "fee_recipient"; ticker: string; name: string; quoteSymbol: string; imageUrl: string | null; chainId: number; status: string; tokenAddress: string | null; launchTxHash: string | null; userMessage: string | null; createdAt: string; feesEarnedUsd: number | null; feesEarnedQuote: number | null };
type TradeRow = { id: string; side: "BUY" | "SELL"; token: string; tokenSymbol: string; quoteSymbol: string; amountIn: string; amountOut: string | null; status: string; txHash: string | null; userMessage: string | null; createdAt: string };
type Overview = {
  wallet: string | null;
  assets: Asset[];
  launches: LaunchRow[];
  trades: TradeRow[];
  fees: { escrow: string; positions: Array<{ currency: string; symbol: string; decimals: number; owed: string; usd: number | null }> };
  gas: Array<{ chain: string; name: string; eth: string; usd: number | null }>;
};
type Settings = { enabled: boolean; maxTradeEth: string | null; defaultCapEth: string; maxCapEth: string; acceptFeeRedirects: boolean; replyLanguage: "auto" | "en" };

const EXPLORER = "https://robinhoodchain.blockscout.com";
const TX_EXPLORER = "https://rh-scan.com/tx";
const CHAIN_ID = 4663;
const escrowAbi = parseAbi(["function claimFor(address recipient, address currency)"]);

const fmt = (n: string | number, max = 6) => Number(n).toLocaleString("en-US", { maximumFractionDigits: max });
const usd = (v: number | null) => (v === null ? "" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const STATUS_LABEL: Record<string, string> = { QUEUED: "queued", SIMULATING: "simulating", SIGNING: "signing", BROADCAST: "broadcast", CONFIRMED: "live", FEE_RECIPIENT_PENDING: "live", REPLIED: "live", DRY_RUN: "dry run", FAILED: "failed" };
const TRADE_LABEL: Record<string, string> = { QUEUED: "queued", SIGNING: "signing", CONFIRMED: "done", REPLIED: "done", DRY_RUN: "dry run", FAILED: "failed" };

const ICON = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  deposit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />
    </svg>
  ),
  withdraw: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V8M7 13l5-5 5 5M4 4h16" />
    </svg>
  ),
  swap: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  ),
};

/** The Robinhood mark in the corner of an asset logo: everything on this page lives on that chain. */
const RH_DOT = (
  <i className="chain" aria-hidden="true">
    <ChainIcon chain="robinhood" size={16} />
  </i>
);

export function Profile() {
  const { ready, authenticated, user, login, logout, getAccessToken, exportWallet } = usePrivy();
  const { sendTransaction } = useSendTransaction();
  const signer = useGrantSigner();
  const [me, setMe] = useState<Me | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | null>(null);
  const [hideSmall, setHideSmall] = useState(true);
  const [capDraft, setCapDraft] = useState<string | null>(null);

  const auth = useCallback(async () => {
    const token = await getAccessToken();
    return token ? { authorization: `Bearer ${token}` } : null;
  }, [getAccessToken]);

  const load = useCallback(async () => {
    const headers = await auth();
    if (!headers) return;
    const [meRes, ovRes, stRes] = await Promise.all([fetch("/api/me", { headers }), fetch("/api/me/overview", { headers }), fetch("/api/me/trading", { headers })]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
    if (ovRes.ok) setOverview((await ovRes.json()) as Overview);
    else setError(`Could not load your profile (HTTP ${ovRes.status}).`);
    if (stRes.ok) setSettings((await stRes.json()) as Settings);
  }, [auth]);

  useEffect(() => {
    if (ready && authenticated) void load();
    if (ready && !authenticated) {
      setMe(null);
      setOverview(null);
      setSettings(null);
    }
  }, [ready, authenticated, load]);
  useLinkedRefresh(load);

  const save = useCallback(
    async (patch: Partial<Pick<Settings, "enabled" | "maxTradeEth" | "acceptFeeRedirects" | "replyLanguage">>) => {
      const headers = await auth();
      if (!headers) return;
      setBusy("settings");
      setError(null);
      try {
        const res = await fetch("/api/me/trading", { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(patch) });
        const json = (await res.json()) as Settings & { error?: string };
        if (!res.ok) {
          setError(json.error ?? `Could not save (HTTP ${res.status}).`);
          return;
        }
        setSettings(json);
        setCapDraft(null);
      } finally {
        setBusy(null);
      }
    },
    [auth],
  );

  const claim = useCallback(
    async (currency: string) => {
      if (!overview?.wallet) return;
      setBusy(`claim:${currency}`);
      setError(null);
      setLastTx(null);
      try {
        const data = encodeFunctionData({ abi: escrowAbi, functionName: "claimFor", args: [overview.wallet as Address, currency as Address] });
        const result = await sendTransaction({ to: overview.fees.escrow as Address, data, chainId: CHAIN_ID });
        setLastTx(typeof result === "string" ? result : ((result as { hash?: string }).hash ?? null));
        setTimeout(() => void load(), 4000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The claim was cancelled.");
      } finally {
        setBusy(null);
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

  const totalUsd = useMemo(() => overview?.assets.reduce((s, a) => s + (a.usd ?? 0), 0) ?? 0, [overview]);
  const feeUsd = useMemo(() => overview?.fees.positions.reduce((s, p) => s + (p.usd ?? 0), 0) ?? 0, [overview]);
  const shownAssets = useMemo(() => (overview?.assets ?? []).filter((a) => !hideSmall || a.kind === "native" || (a.usd ?? 0) >= 1 || Number(a.balance) > 0), [overview, hideSmall]);

  if (!ready) return <div className="me-empty">Loading…</div>;
  if (!authenticated) {
    return (
      <div className="me-empty">
        <div className="me-empty-icon">{X_ICON}</div>
        <h1 className="sora grad">Your profile</h1>
        <p>Sign in with X to see your wallet, holdings, launches and creator fees.</p>
        <button className="btn-p" onClick={() => login()}>
          {X_ICON} Sign in with X
        </button>
      </div>
    );
  }

  const handle = me?.xHandle ?? user?.twitter?.username ?? null;
  const avatar = user?.twitter?.profilePictureUrl ?? null;
  const stale = Boolean(me?.wallet?.signerStale);
  const assetCount = overview?.assets.filter((a) => Number(a.balance) > 0).length ?? 0;
  const rhEth = overview?.gas.find((g) => g.chain === "robinhood");

  return (
    <div className="me">
      {/* ---- left: identity ---- */}
      <aside className="side">
        <div className="idcard">
          <div className="h">
            <div className="av">{avatar ? <img src={avatar} alt="" /> : (handle ?? "?").slice(0, 1).toUpperCase()}</div>
            <div>
              <b>{handle ? `@${handle}` : "Your profile"}</b>
              <span>
                <i className={me?.linked ? "" : "off"} />
                {me?.linked ? "Bot signing on" : stale ? "Permission needs an update" : "Bot signing off"}
              </span>
            </div>
          </div>
          <div className="bal">
            <div className="k">Total balance</div>
            <div className="v sora grad">{overview ? usd(totalUsd) || "$0.00" : "…"}</div>
            <div className="c">
              {assetCount} asset{assetCount === 1 ? "" : "s"}
              {rhEth ? ` · ${fmt(rhEth.eth, 5)} ETH for gas` : ""}
            </div>
          </div>
          {overview?.wallet ? (
            <div className="addr">
              Wallet <b title={overview.wallet}>{short(overview.wallet)}</b>
              <button title={copied ? "Copied" : "Copy the full address"} onClick={copy}>
                {copied ? ICON.check : ICON.copy}
              </button>
              <a title="Open in the explorer" href={`${EXPLORER}/address/${overview.wallet}`} target="_blank" rel="noreferrer">
                {EXT_ICON}
              </a>
            </div>
          ) : (
            <div className="addr">No wallet yet. It is created on your first sign-in.</div>
          )}
          <div className="acts">
            <Link className="act p" href="/launch">
              {ICON.plus}
              Launch
            </Link>
            <button className="act" onClick={() => setSheet("deposit")}>
              {ICON.deposit}
              Deposit
            </button>
            <button className="act" onClick={() => setSheet("withdraw")} disabled={!overview?.wallet}>
              {ICON.withdraw}
              Withdraw
            </button>
            <Link className="act" href="/">
              {ICON.swap}
              Swap
            </Link>
          </div>
        </div>

        <div className="gas">
          <h3>Gas by chain</h3>
          {overview === null ? (
            <div className="hint">Loading…</div>
          ) : (
            overview.gas.map((g) => {
              const empty = Number(g.eth) === 0;
              return (
                <div className="net" key={g.chain}>
                  <div className="ic">{ChainIcon({ chain: g.chain, size: 30 }) ?? g.name.slice(0, 1)}</div>
                  <div className="n">
                    {g.name}
                    {g.chain === "robinhood" ? <small className={empty ? "warn" : ""}>{empty ? "Fund it to launch or trade" : "Launches, trades and claims"}</small> : <small className={empty ? "" : "ok"}>{empty ? "Send ETH here to bridge from a post" : `Post "bridge ${Math.min(Number(g.eth), 1).toFixed(3)} ETH from ${g.chain}"`}</small>}
                  </div>
                  <div className="b">
                    {fmt(g.eth, 5)} ETH
                    <small>{g.usd === null ? (empty ? "empty" : "") : usd(g.usd)}</small>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="perm">
          <h3>
            Bot signing
            {me?.linked ? <span className="ok">Allowed</span> : <span className={stale ? "warn" : "off"}>{stale ? "Update needed" : "Off"}</span>}
          </h3>
          <p>
            Signs <b>launches, dev buys, fee claims, trades and bridges</b> from this wallet within Privy&apos;s policy. <b>Never a transfer out.</b>
          </p>
          <div className="links">
            {me?.linked ? (
              <button
                className="d"
                disabled={signer.busy || !signer.embedded}
                onClick={async () => {
                  if (await signer.revoke()) await load();
                }}
              >
                {signer.busy ? "Waiting…" : "Revoke"}
              </button>
            ) : (
              <button
                className="p"
                disabled={signer.busy || !signer.embedded}
                onClick={async () => {
                  if (await signer.grant({ replace: stale })) await load();
                }}
              >
                {signer.busy ? "Waiting for Privy…" : stale ? "Update permission" : "Allow"}
              </button>
            )}
            <button onClick={() => exportWallet()}>Export key</button>
            <button onClick={() => logout()}>Sign out</button>
          </div>
          {signer.error && <div className="hint warn">{signer.error}</div>}
        </div>
      </aside>

      {/* ---- right: content ---- */}
      <main className="content">
        {error && <div className="alert">{error}</div>}
        {lastTx && (
          <div className="notice">
            Transaction sent:{" "}
            <a href={`${TX_EXPLORER}/${lastTx}`} target="_blank" rel="noreferrer">
              {short(lastTx)} {EXT_ICON}
            </a>
          </div>
        )}

        {overview && overview.fees.positions.length > 0 && (
          <div className="claim">
            <div className="t">
              <b>{feeUsd > 0 ? `${usd(feeUsd)} in creator fees ready to claim` : "Creator fees ready to claim"}</b>
              <span>
                {overview.fees.positions.map((p) => `${fmt(p.owed)} ${p.symbol}`).join(" · ")} · held in o1&apos;s escrow until you claim
                {rhEth && Number(rhEth.eth) === 0 ? " · needs a little ETH for gas" : ""}
              </span>
            </div>
            <div className="btns">
              {overview.fees.positions.map((p) => (
                <button className="btn" key={p.currency} disabled={busy !== null} onClick={() => claim(p.currency)}>
                  {busy === `claim:${p.currency}` ? "Confirm in wallet…" : overview.fees.positions.length > 1 ? `Claim ${p.symbol}` : "Claim"}
                </button>
              ))}
            </div>
          </div>
        )}

        <section>
          <div className="sec-h">
            <h2 className="sora">Assets</h2>
            <button onClick={() => setHideSmall((v) => !v)}>{hideSmall ? "Show all balances" : "Hide zero balances"}</button>
          </div>
          {overview === null ? (
            <div className="hint">Loading…</div>
          ) : shownAssets.length === 0 ? (
            <div className="hint">Nothing here yet. Use Deposit to fund the wallet.</div>
          ) : (
            shownAssets.map((a) => (
              <div className="row" key={a.address}>
                {a.kind === "token" ? (
                  <TokenLogo symbol={a.symbol} imageUrl={a.imageUrl} className="lg" />
                ) : (
                  <div className="lg mark" aria-hidden="true">
                    <AssetIcon symbol={a.symbol} kind={a.kind} size={44} />
                    {RH_DOT}
                  </div>
                )}
                <div className="n">
                  {a.tokenPage ? <Link href={a.tokenPage}>{a.name}</Link> : <b>{a.name}</b>}
                  <span>
                    {fmt(a.balance, a.kind === "token" ? 2 : 5)} {a.symbol}
                    {a.kind === "native" ? " · Robinhood" : ""}
                  </span>
                </div>
                <div className="v">
                  <b>{usd(a.usd) || "—"}</b>
                  <span>{a.kind === "native" ? "gas" : a.kind === "quote" ? "pair asset" : ""}</span>
                </div>
              </div>
            ))
          )}
        </section>

        <section>
          <div className="sec-h">
            <h2 className="sora">Launches</h2>
            <Link href="/launch">Launch a token</Link>
          </div>
          {overview === null ? (
            <div className="hint">Loading…</div>
          ) : overview.launches.length === 0 ? (
            <div className="hint">
              None yet. <Link href="/launch">Launch one from here</Link> or post the command on X.
            </div>
          ) : (
            overview.launches.map((l) => {
              const live = STATUS_LABEL[l.status] === "live" && l.tokenAddress;
              return (
                <div className="row" key={l.id}>
                  <div className="lg wrap">
                    <TokenLogo symbol={l.ticker} imageUrl={l.imageUrl} className="lg" />
                    {RH_DOT}
                  </div>
                  <div className="n">
                    {live ? (
                      <Link href={`/token/${l.tokenAddress}`}>
                        {l.name}
                        <em>${l.ticker}</em>
                      </Link>
                    ) : (
                      <b>
                        {l.name}
                        <em>${l.ticker}</em>
                      </b>
                    )}
                    <span>
                      {l.quoteSymbol} pool{l.chainId === 8453 ? " on Base" : ""} · from {l.source === "WEB" ? "the web" : "a post"} · {when(l.createdAt)}
                      {l.role === "fee_recipient" ? " · fees directed to you" : ""}
                      {l.status === "FAILED" && l.userMessage ? ` · ${l.userMessage}` : ""}
                    </span>
                  </div>
                  <div className="v">
                    {live ? (
                      <>
                        <b>{l.feesEarnedUsd !== null ? usd(l.feesEarnedUsd) : l.feesEarnedQuote !== null ? `${fmt(l.feesEarnedQuote, 5)} ${l.quoteSymbol}` : "—"}</b>
                        <span>fees earned</span>
                      </>
                    ) : (
                      <span className={l.status === "FAILED" ? "warn" : ""}>{STATUS_LABEL[l.status] ?? l.status.toLowerCase()}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </section>

        {overview && overview.trades.length > 0 && (
          <section>
            <div className="sec-h">
              <h2 className="sora">Trades from posts</h2>
              <span>{overview.trades.length} total</span>
            </div>
            {overview.trades.map((t) => (
              <div className="row" key={t.id}>
                <div className={`lg plain ${t.side === "BUY" ? "buy" : "sell"}`}>{t.side === "BUY" ? "B" : "S"}</div>
                <div className="n">
                  <Link href={`/token/${t.token}`}>
                    {t.side === "BUY" ? "Bought" : "Sold"}
                    <em>${t.tokenSymbol}</em>
                  </Link>
                  <span>
                    {fmt(t.amountIn, t.side === "BUY" ? 5 : 2)} {t.side === "BUY" ? t.quoteSymbol : t.tokenSymbol}
                    {t.amountOut ? ` → ${fmt(t.amountOut, t.side === "BUY" ? 2 : 5)} ${t.side === "BUY" ? t.tokenSymbol : t.quoteSymbol}` : ""} · {when(t.createdAt)}
                    {t.status === "FAILED" && t.userMessage ? ` · ${t.userMessage}` : ""}
                  </span>
                </div>
                <div className="v">
                  {t.txHash ? (
                    <a href={`${TX_EXPLORER}/${t.txHash}`} target="_blank" rel="noreferrer">
                      <b>{TRADE_LABEL[t.status] ?? t.status.toLowerCase()}</b>
                    </a>
                  ) : (
                    <b className={t.status === "FAILED" ? "warn" : ""}>{TRADE_LABEL[t.status] ?? t.status.toLowerCase()}</b>
                  )}
                  <span>{t.txHash ? "view tx" : ""}</span>
                </div>
              </div>
            ))}
          </section>
        )}

        <section>
          <div className="sec-h">
            <h2 className="sora">From posts</h2>
          </div>
          {settings === null ? (
            <div className="hint">Loading…</div>
          ) : (
            <div className="settings">
              <div className="set">
                <div>
                  <b>Trading and bridging from posts</b>
                  <span>buy 0.05 ETH of $CAT, sell half of $CAT, bridge 0.1 ETH from base. Output lands in this wallet.{!me?.linked ? " Allow bot signing first." : ""}</span>
                </div>
                <button className={`tg${settings.enabled ? " on" : ""}`} disabled={busy === "settings" || !me?.linked} aria-pressed={settings.enabled} aria-label="Trading from posts" onClick={() => void save({ enabled: !settings.enabled })} />
              </div>
              <div className="set">
                <div>
                  <b>Per-trade cap</b>
                  <span>The bot refuses a buy above this. Ceiling {settings.maxCapEth} ETH.</span>
                </div>
                {capDraft === null ? (
                  <button className="val" onClick={() => setCapDraft(settings.maxTradeEth ?? settings.defaultCapEth)}>
                    {settings.maxTradeEth ?? settings.defaultCapEth} ETH
                  </button>
                ) : (
                  <span className="edit">
                    <input inputMode="decimal" value={capDraft} onChange={(e) => setCapDraft(e.target.value)} aria-label="Per-trade cap in ETH" autoFocus />
                    <button className="ok" disabled={busy === "settings"} onClick={() => void save({ maxTradeEth: capDraft.trim() === "" ? null : capDraft.trim() })}>
                      Save
                    </button>
                    <button onClick={() => setCapDraft(null)}>Cancel</button>
                  </span>
                )}
              </div>
              <div className="set">
                <div>
                  <b>Accept fees sent to me</b>
                  <span>Others can launch with fees to @{handle ?? "you"}. Off means those launches are refused.</span>
                </div>
                <button className={`tg${settings.acceptFeeRedirects ? " on" : ""}`} disabled={busy === "settings"} aria-pressed={settings.acceptFeeRedirects} aria-label="Accept fees sent to me" onClick={() => void save({ acceptFeeRedirects: !settings.acceptFeeRedirects })} />
              </div>
              <div className="set">
                <div>
                  <b>Reply in my language</b>
                  <span>The bot answers in the language of your post. Off means English.</span>
                </div>
                <button className={`tg${settings.replyLanguage === "auto" ? " on" : ""}`} disabled={busy === "settings"} aria-pressed={settings.replyLanguage === "auto"} aria-label="Reply in my language" onClick={() => void save({ replyLanguage: settings.replyLanguage === "auto" ? "en" : "auto" })} />
              </div>
            </div>
          )}
        </section>
      </main>

      {sheet === "deposit" && overview?.wallet && <DepositSheet wallet={overview.wallet} onClose={() => setSheet(null)} />}
      {sheet === "withdraw" && overview?.wallet && (
        <WithdrawSheet
          assets={overview.assets.filter((a) => Number(a.balance) > 0)}
          onClose={() => setSheet(null)}
          onSent={(hash) => {
            setLastTx(hash);
            setSheet(null);
            setTimeout(() => void load(), 4000);
          }}
          send={async (to, data, value) => {
            const result = await sendTransaction({ to, data, value, chainId: CHAIN_ID });
            return typeof result === "string" ? result : ((result as { hash?: string }).hash ?? "");
          }}
        />
      )}
    </div>
  );
}

function DepositSheet({ wallet, onClose }: { wallet: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="me-sheet-bg" onClick={onClose} role="presentation">
      <div className="me-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Deposit">
        <h3 className="sora">Deposit</h3>
        <p>Send ETH on Robinhood Chain to this address. It is your wallet, the same address on Base, Ethereum, Arbitrum and Optimism, so you can also send ETH there and post &quot;bridge 0.1 ETH from base&quot;.</p>
        <code className="full">{wallet}</code>
        <div className="me-chains" aria-label="Chains that share this address">
          {(["robinhood", "base", "ethereum", "arbitrum", "optimism"] as const).map((c) => (
            <span key={c}>
              <ChainIcon chain={c} size={18} />
              {CHAIN_NAMES[c]}
            </span>
          ))}
        </div>
        <div className="me-sheet-acts">
          <button
            className="btn-p"
            onClick={async () => {
              await navigator.clipboard.writeText(wallet);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <button className="btn-s" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function WithdrawSheet({ assets, onClose, onSent, send }: { assets: Asset[]; onClose: () => void; onSent: (hash: string) => void; send: (to: Address, data: `0x${string}` | undefined, value: bigint | undefined) => Promise<string> }) {
  const [asset, setAsset] = useState(assets[0]?.address ?? "");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = assets.find((a) => a.address === asset) ?? null;

  const submit = async () => {
    if (!chosen) return;
    setError(null);
    if (!isAddress(to)) {
      setError("The destination is not a valid address.");
      return;
    }
    let raw: bigint;
    try {
      raw = parseUnits(amount.trim(), chosen.decimals);
    } catch {
      setError("The amount is not a number.");
      return;
    }
    if (raw <= 0n) {
      setError("The amount must be above zero.");
      return;
    }
    if (raw > parseUnits(chosen.balance, chosen.decimals)) {
      setError(`You hold ${fmt(chosen.balance, 6)} ${chosen.symbol}.`);
      return;
    }
    setBusy(true);
    try {
      // Native ETH is a plain transfer; anything else is an ERC-20 transfer, both signed by the user's own wallet.
      const hash =
        chosen.kind === "native"
          ? await send(to as Address, undefined, raw)
          : await send(chosen.address as Address, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, raw] }), undefined);
      if (hash) onSent(hash);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transfer was cancelled.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="me-sheet-bg" onClick={onClose} role="presentation">
      <div className="me-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Withdraw">
        <h3 className="sora">Withdraw</h3>
        <p>Send an asset from this wallet to another address on Robinhood Chain. You confirm it in the wallet; the bot is not involved.</p>
        <label>
          Asset
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            {assets.map((a) => (
              <option key={a.address} value={a.address}>
                {a.symbol} · {fmt(a.balance, 6)}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </label>
        <label>
          Amount
          <span className="amt">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
            <button type="button" onClick={() => chosen && setAmount(chosen.balance)}>
              Max
            </button>
          </span>
        </label>
        {error && <div className="alert">{error}</div>}
        <div className="me-sheet-acts">
          <button className="btn-p" disabled={busy || !chosen} onClick={() => void submit()}>
            {busy ? "Confirm in wallet…" : `Send ${chosen?.symbol ?? ""}`}
          </button>
          <button className="btn-s" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
