"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { ChainIcon } from "@/components/ChainIcons";
import { SwapPanel } from "@/components/SwapPanel";
import { CHAIN_IDS, CHAIN_SHORT, EXPLORER, o1TokenUrl, type ChainKey } from "@/lib/chains-web";
import { symbolColor } from "@/lib/ipfs";

/**
 * Swap any token on a chain: ETH, USDG, every stock o1 registers, every
 * token launched through o1bot, or a pasted address. Pairs that involve an
 * o1bot launch use the o1 pool route through the existing panel; every
 * other pair is routed by LI.FI. The quote API prepares the transaction and
 * the user's embedded wallet signs it in the browser.
 */

type Tok = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  kind: "native" | "crypto" | "stock" | "o1" | "custom";
  imageUrl: string | null;
  balance: string | null;
  o1: { quoteAddress: Address; quoteSymbol: string; quoteKind: "eth" | "usd" | "stk"; launchedAt: string } | null;
};

type Quote =
  | { kind: "o1"; chain: ChainKey; token: Address; symbol: string; side: "buy" | "sell"; quoteSymbol: string; quoteKind: "eth" | "usd" | "stk"; launchedAt: string; available: boolean }
  | {
      kind: "lifi";
      chain: ChainKey;
      tokenIn: { address: Address; symbol: string; decimals: number };
      tokenOut: { address: Address; symbol: string; decimals: number };
      slippageBps: number;
      amountIn: string;
      amountOut: string | null;
      amountOutMin?: string;
      amountOutHuman?: string;
      amountOutMinHuman?: string;
      usdIn?: number | null;
      usdOut?: number | null;
      tool?: string;
      toolName?: string;
      gasUsd?: number | null;
      feeUsd?: number | null;
      seconds?: number | null;
      approval?: { spender: Address; needed: boolean } | null;
      balances?: { in: string; native: string } | null;
      tx?: { to: Address; data: Hex; value: string } | null;
      quoteError?: string;
    };

const SWAP_CHAINS: ChainKey[] = ["robinhood", "base", "arc"];
const SLIPPAGES = [50, 100, 300, 1000];
const GROUPS: Array<{ kind: Tok["kind"]; label: string }> = [
  { kind: "native", label: "Gas" },
  { kind: "crypto", label: "Stablecoins" },
  { kind: "stock", label: "Stocks" },
  { kind: "o1", label: "Launched on o1bot" },
  { kind: "custom", label: "Custom" },
];

const fmt = (v: string | number | null | undefined, max = 6) => (v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) > 1000 ? 2 : max }));
const usd = (v: number | null | undefined) => (v === null || v === undefined ? null : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

function Mark({ t }: { t: Tok }) {
  const [broken, setBroken] = useState(false);
  if (t.imageUrl && !broken) return <img className="c" src={t.imageUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  const bg = t.kind === "native" ? "var(--blue)" : t.kind === "crypto" ? "var(--up)" : t.kind === "stock" ? "var(--stock)" : symbolColor(t.symbol);
  return (
    <span className="c" style={{ background: bg }}>
      {t.kind === "crypto" ? "$" : t.symbol.slice(0, 1)}
    </span>
  );
}

function Picker({ chain, tokens, wallet, exclude, onPick, onClose }: { chain: ChainKey; tokens: Tok[]; wallet: Address | null; exclude: Address | null; onPick: (t: Tok) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState<{ state: "idle" | "loading" | "missing"; token: Tok | null }>({ state: "idle", token: null });
  const needle = q.trim().toLowerCase();

  useEffect(() => {
    if (!isAddress(needle, { strict: false })) {
      setCustom({ state: "idle", token: null });
      return;
    }
    if (tokens.some((t) => t.address.toLowerCase() === needle)) return;
    let live = true;
    setCustom({ state: "loading", token: null });
    fetch(`/api/swap/tokens?chain=${chain}&resolve=${needle}${wallet ? `&wallet=${wallet}` : ""}`)
      .then((r) => r.json())
      .then((json: { token?: Tok }) => live && setCustom(json.token ? { state: "idle", token: json.token } : { state: "missing", token: null }))
      .catch(() => live && setCustom({ state: "missing", token: null }));
    return () => {
      live = false;
    };
  }, [needle, chain, tokens, wallet]);

  const shown = useMemo(() => {
    const list = tokens.filter((t) => t.address !== exclude && (!needle || t.symbol.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle) || t.address.toLowerCase() === needle));
    // Held tokens first inside each group, then by symbol.
    return list.sort((a, b) => (Number(b.balance ?? 0) > 0 ? 1 : 0) - (Number(a.balance ?? 0) > 0 ? 1 : 0) || a.symbol.localeCompare(b.symbol));
  }, [tokens, exclude, needle]);

  return (
    <div className="me-sheet-bg" onClick={onClose} role="presentation">
      <div className="me-sheet picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pick a token">
        <h3 className="sora">Pick a token</h3>
        <input className="picker-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ticker, or paste an address" spellCheck={false} />
        <div className="picker-list">
          {custom.token && (
            <button className="picker-row" onClick={() => onPick(custom.token!)}>
              <Mark t={custom.token} />
              <span className="n">
                <b>{custom.token.symbol}</b>
                <small>{custom.token.name} · pasted address</small>
              </span>
              <span className="b">{custom.token.balance ? fmt(custom.token.balance) : ""}</span>
            </button>
          )}
          {custom.state === "loading" && <div className="picker-empty">Reading the token…</div>}
          {custom.state === "missing" && <div className="picker-empty">That address is not a token on {CHAIN_SHORT[chain]}.</div>}
          {GROUPS.map((g) => {
            const rows = shown.filter((t) => t.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <div key={g.kind} className="picker-group">
                <div className="picker-head">
                  {g.label} <span>{rows.length}</span>
                </div>
                {rows.map((t) => (
                  <button key={t.address} className="picker-row" onClick={() => onPick(t)}>
                    <Mark t={t} />
                    <span className="n">
                      <b>{t.symbol}</b>
                      <small>{t.name}</small>
                    </span>
                    <span className="b">{t.balance && Number(t.balance) > 0 ? fmt(t.balance) : ""}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {shown.length === 0 && !custom.token && custom.state === "idle" && <div className="picker-empty">Nothing matches.</div>}
        </div>
        <div className="me-sheet-acts">
          <button className="btn-s" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function SwapAny() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const wallet = useMemo(() => (wallets.find((w) => w.walletClientType === "privy")?.address ?? null) as Address | null, [wallets]);

  const [chain, setChain] = useState<ChainKey>("robinhood");
  const [tokens, setTokens] = useState<Tok[]>([]);
  const [from, setFrom] = useState<Tok | null>(null);
  const [to, setTo] = useState<Tok | null>(null);
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(300);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<{ hash: string; status: "pending" | "success" | "reverted" } | null>(null);
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const seq = useRef(0);
  const chainId = CHAIN_IDS[chain];

  // The token list for the chain, with balances once a wallet is known.
  useEffect(() => {
    let live = true;
    fetch(`/api/swap/tokens?chain=${chain}${wallet ? `&wallet=${wallet}` : ""}`)
      .then((r) => r.json())
      .then((json: { tokens?: Tok[]; error?: string }) => {
        if (!live) return;
        const list = json.tokens ?? [];
        setTokens(list);
        const find = (a: Address | null | undefined) => list.find((t) => t.address === a) ?? null;
        setFrom((cur) => find(cur?.address) ?? find(zeroAddress) ?? list[0] ?? null);
        setTo((cur) => find(cur?.address) ?? list.find((t) => t.kind === "crypto") ?? list.find((t) => t.kind === "stock") ?? null);
      })
      .catch(() => live && setError("Could not load the token list."));
    return () => {
      live = false;
    };
  }, [chain, wallet, tx?.status]);

  const fetchQuote = useCallback(async () => {
    if (!from || !to) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ chain, from: from.address, to: to.address, amount: amount.trim(), slippageBps: String(slippageBps) });
      if (wallet) params.set("wallet", wallet);
      const res = await fetch(`/api/swap/quote?${params}`);
      const json = (await res.json()) as Quote & { error?: string };
      if (mine !== seq.current) return;
      if (!res.ok && res.status !== 429) {
        setQuote(null);
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setQuote(json);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : "Could not fetch a quote.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [chain, from, to, amount, slippageBps, wallet]);

  // Debounced on every change; refreshed every 20 s while the page is visible and an amount is set.
  useEffect(() => {
    setError(null);
    const t = setTimeout(() => void fetchQuote(), 400);
    const refresh = setInterval(() => {
      if (document.visibilityState === "visible" && amount.trim()) void fetchQuote();
    }, 20_000);
    return () => {
      clearTimeout(t);
      clearInterval(refresh);
    };
  }, [fetchQuote, amount]);

  useEffect(() => {
    if (!tx || tx.status !== "pending") return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/tx/${tx.hash}?chain=${chain}`);
      if (!res.ok) return;
      const json = (await res.json()) as { status: "pending" | "success" | "reverted" };
      if (json.status !== "pending") {
        setTx({ hash: tx.hash, status: json.status });
        void fetchQuote();
      }
    }, 2500);
    return () => clearInterval(id);
  }, [tx, chain, fetchQuote]);

  const waitFor = useCallback(
    async (label: string, hash: string) => {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`/api/tx/${hash}?chain=${chain}`);
        const json = (await res.json()) as { status: string };
        if (json.status === "success") return;
        if (json.status === "reverted") throw new Error(`${label} reverted on chain.`);
      }
      throw new Error(`${label} is taking too long; check the explorer.`);
    },
    [chain],
  );

  const swap = useCallback(async () => {
    if (!quote || quote.kind !== "lifi" || !quote.tx || !wallet || !from || !to) return;
    setError(null);
    setTx(null);
    try {
      if (quote.approval?.needed) {
        setStep(`Approve ${from.symbol}`);
        const r = await sendTransaction({ to: from.address, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [quote.approval.spender, BigInt(quote.amountIn)] }), chainId });
        const hash = typeof r === "string" ? r : ((r as { hash?: string }).hash ?? null);
        if (!hash) throw new Error("No transaction hash returned.");
        await waitFor("The approval", hash);
      }
      setStep("Swapping…");
      const r = await sendTransaction({ to: quote.tx.to, data: quote.tx.data, value: BigInt(quote.tx.value), chainId });
      const hash = typeof r === "string" ? r : ((r as { hash?: string }).hash ?? null);
      if (!hash) throw new Error("No transaction hash returned.");
      setTx({ hash, status: "pending" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The swap was cancelled.");
    } finally {
      setStep(null);
    }
  }, [quote, wallet, from, to, sendTransaction, chainId, waitFor]);

  const flip = () => {
    setFrom(to);
    setTo(from);
    setQuote(null);
  };
  const pick = (t: Tok) => {
    if (picker === "from") {
      if (to?.address === t.address) setTo(from);
      setFrom(t);
    } else {
      if (from?.address === t.address) setFrom(to);
      setTo(t);
    }
    setPicker(null);
    setQuote(null);
  };

  const lifi = quote?.kind === "lifi" ? quote : null;
  const balanceIn = lifi?.balances?.in ?? from?.balance ?? null;
  const insufficient = balanceIn !== null && amount.trim() !== "" && Number(amount) > Number(balanceIn);
  const canSwap = Boolean(ready && authenticated && wallet && lifi?.tx && lifi.amountOut && !insufficient && !loading && !step);
  const cost = lifi?.usdIn && lifi.usdOut ? ((lifi.usdIn - lifi.usdOut) / lifi.usdIn) * 100 : null;

  return (
    <div className="swapx">
      <div className="swapx-head">
        <h1 className="sora">Swap</h1>
        <div className="chainsel" role="tablist" aria-label="Chain">
          {SWAP_CHAINS.map((c) => (
            <button key={c} role="tab" aria-selected={chain === c} className={chain === c ? "on" : ""} onClick={() => setChain(c)}>
              <ChainIcon chain={c} size={14} /> {CHAIN_SHORT[c]}
            </button>
          ))}
        </div>
      </div>
      <p className="swapx-sub">Any token with a pool: ETH, stablecoins, every stock on {CHAIN_SHORT[chain]}, every token launched here, or an address you paste. You sign with your own o1bot wallet.</p>

      {quote?.kind === "o1" ? (
        <div className="swapx-o1">
          <div className="note">
            <b>{quote.symbol}</b> was launched through o1bot and trades on its o1 pool against {quote.quoteSymbol}, with the o1bot referral.
          </div>
          {quote.available ? (
            <SwapPanel token={quote.token} chainId={chainId} symbol={quote.symbol} quoteSymbol={quote.quoteSymbol} quoteKind={quote.quoteKind} launchedAt={quote.launchedAt} />
          ) : (
            <a className="btn-p" href={o1TokenUrl(quote.token, chain)} target="_blank" rel="noreferrer">
              Trade {quote.symbol} on o1
            </a>
          )}
          <button className="btn-s" onClick={() => setPicker(from?.kind === "o1" ? "from" : "to")}>
            Pick another token
          </button>
        </div>
      ) : (
        <div className="swap swapx-card">
          <div className="field">
            <div className="l">
              <span>You pay</span>
              <span>Balance {balanceIn === null ? "—" : fmt(balanceIn)}</span>
            </div>
            <div className="in">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" aria-label="Amount" />
              <button className="asset tokbtn" onClick={() => setPicker("from")} aria-label="Pick the token to pay with">
                {from ? (
                  <>
                    <Mark t={from} /> {from.symbol}
                  </>
                ) : (
                  "Select"
                )}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
            {balanceIn !== null && Number(balanceIn) > 0 && (
              <div className="quick">
                {["25%", "50%", "100%"].map((v) => (
                  <button key={v} onClick={() => setAmount(String(Math.floor(Number(balanceIn) * (Number(v.slice(0, -1)) / 100) * 1e6) / 1e6))}>
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="flip" onClick={flip} aria-label="Swap direction">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M6 13l6 6 6-6" />
            </svg>
          </button>
          <div className="field">
            <div className="l">
              <span>You receive</span>
              <span>{loading ? "quoting…" : lifi?.amountOutMinHuman ? `min ${fmt(lifi.amountOutMinHuman)}` : "est."}</span>
            </div>
            <div className="in">
              <input value={lifi?.amountOutHuman ? fmt(lifi.amountOutHuman) : "0"} readOnly aria-label="Estimated output" />
              <button className="asset tokbtn" onClick={() => setPicker("to")} aria-label="Pick the token to receive">
                {to ? (
                  <>
                    <Mark t={to} /> {to.symbol}
                  </>
                ) : (
                  "Select"
                )}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
            {lifi?.usdOut !== null && lifi?.usdOut !== undefined && (
              <div className="l">
                <span />
                <span>
                  {usd(lifi.usdOut)}
                  {cost !== null && cost > 0.05 ? ` · ${cost.toFixed(2)}% below what you pay` : ""}
                </span>
              </div>
            )}
          </div>
          <div className="kv">
            <span>Route</span>
            <b>{lifi?.toolName ? `${lifi.toolName} via LI.FI` : "LI.FI"}</b>
          </div>
          <div className="kv">
            <span>Slippage</span>
            <b className="slip">
              {SLIPPAGES.map((s) => (
                <button key={s} className={slippageBps === s ? "on" : ""} onClick={() => setSlippageBps(s)}>
                  {s / 100}%
                </button>
              ))}
            </b>
          </div>
          {lifi?.gasUsd !== null && lifi?.gasUsd !== undefined && (
            <div className="kv">
              <span>Gas and fees</span>
              <b>
                {usd(lifi.gasUsd)} gas{lifi.feeUsd ? ` · ${usd(lifi.feeUsd)} fees` : ""}
              </b>
            </div>
          )}
          {!ready ? null : !authenticated ? (
            <button className="cta" onClick={() => login()}>
              Connect with X to swap
            </button>
          ) : (
            <button className="cta" disabled={!canSwap} onClick={() => void swap()}>
              {step ?? (insufficient ? `Not enough ${from?.symbol ?? ""}` : lifi?.approval?.needed ? `Approve and swap` : `Swap ${from?.symbol ?? ""} for ${to?.symbol ?? ""}`)}
            </button>
          )}
          {lifi?.quoteError && amount && <div className="note warn">{lifi.quoteError}</div>}
          {error && <div className="note warn">{error}</div>}
          {tx && (
            <div className={`note ${tx.status === "success" ? "ok" : tx.status === "reverted" ? "warn" : ""}`}>
              {tx.status === "pending" ? "Waiting for confirmation…" : tx.status === "success" ? "Swap confirmed." : "Swap reverted."}{" "}
              <a href={`${EXPLORER[chain]}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
                {tx.hash.slice(0, 10)}…
              </a>
            </div>
          )}
          <div className="note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16h.01" />
            </svg>
            <span>Routed by LI.FI across the pools on {CHAIN_SHORT[chain]}, signed by your o1bot wallet. The transaction is checked against your request before you sign it. Tokens launched through o1bot use their o1 pool instead.</span>
          </div>
        </div>
      )}

      {picker && <Picker chain={chain} tokens={tokens} wallet={wallet} exclude={picker === "from" ? (to?.address ?? null) : (from?.address ?? null)} onPick={pick} onClose={() => setPicker(null)} />}
    </div>
  );
}
