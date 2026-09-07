"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from "viem";
import { symbolColor } from "@/lib/ipfs";
import { ANTI_SNIPE_SECONDS, CHAIN_ID, encodeExactInputSwap, permit2Abi, type PoolKey } from "@/lib/v4-swap";

/**
 * Buy / sell through o1's launch pool. The quote API prepares the pool key,
 * referral hook data, quoter output and approvals; this panel builds the
 * Universal Router calldata and has the user's embedded wallet sign it in
 * the browser. Exact input only, which is what o1's hook allows during the
 * anti-snipe window.
 */

type Quote = {
  side: "buy" | "sell";
  poolKey: PoolKey;
  zeroForOne: boolean;
  currencyIn: Address;
  currencyOut: Address;
  decimalsIn: number;
  decimalsOut: number;
  hookData: Hex;
  referrer: Address | null;
  router: Address;
  permit2: Address;
  antiSnipe: { active: boolean; secondsLeft: number; feeBps: number };
  balances: { in: string; out: string; eth: string } | null;
  approvals: { erc20: boolean; permit2: boolean } | null;
  slippageBps: number;
  amountIn: string;
  amountOut: string | null;
  minAmountOut: string | null;
  amountOutHuman: string | null;
  minAmountOutHuman?: string | null;
  deadline: string | null;
  quoteError?: string;
};

const EXPLORER = "https://robinhoodchain.blockscout.com";
const MAX_UINT160 = (1n << 160n) - 1n;
const QUICK: Record<"eth" | "usd" | "stk", string[]> = { eth: ["0.01", "0.05", "0.1", "0.5"], usd: ["10", "50", "100", "500"], stk: ["0.1", "0.5", "1", "5"] };
const SLIPPAGES = [100, 300, 1000];

const fmt = (v: string | null | undefined, max = 6) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) > 1000 ? 0 : max }));

export function SwapPanel({ token, symbol, quoteSymbol, quoteKind, launchedAt }: { token: string; symbol: string; quoteSymbol: string; quoteKind: "eth" | "usd" | "stk"; launchedAt: string }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const wallet = useMemo(() => wallets.find((w) => w.walletClientType === "privy")?.address ?? null, [wallets]);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(300);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<{ hash: string; status: "pending" | "success" | "reverted" } | null>(null);
  const [left, setLeft] = useState(() => Math.max(0, ANTI_SNIPE_SECONDS - Math.floor((Date.now() - new Date(launchedAt).getTime()) / 1000)));
  const seq = useRef(0);

  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [left]);

  const fetchQuote = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ side, amount: amount.trim(), slippageBps: String(slippageBps) });
      if (wallet) params.set("wallet", wallet);
      const res = await fetch(`/api/token/${token}/quote?${params}`);
      const json = (await res.json()) as Quote & { error?: string };
      if (mine !== seq.current) return;
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setQuote(json);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : "Could not fetch a quote.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [token, side, amount, slippageBps, wallet]);

  // Debounced quote on every input change; refreshed every 10 s while an amount is set.
  useEffect(() => {
    setError(null);
    const t = setTimeout(() => void fetchQuote(), 350);
    const refresh = setInterval(() => void fetchQuote(), 10_000);
    return () => {
      clearTimeout(t);
      clearInterval(refresh);
    };
  }, [fetchQuote]);

  // Poll the receipt of the last transaction.
  useEffect(() => {
    if (!tx || tx.status !== "pending") return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/tx/${tx.hash}`);
      if (!res.ok) return;
      const json = (await res.json()) as { status: "pending" | "success" | "reverted" };
      if (json.status !== "pending") {
        setTx({ hash: tx.hash, status: json.status });
        void fetchQuote();
      }
    }, 2500);
    return () => clearInterval(id);
  }, [tx, fetchQuote]);

  const send = useCallback(
    async (label: string, to: Address, data: Hex, value: bigint) => {
      setStep(label);
      const result = await sendTransaction({ to, data, value, chainId: CHAIN_ID });
      const hash = typeof result === "string" ? result : ((result as { hash?: string }).hash ?? null);
      if (!hash) throw new Error("No transaction hash returned.");
      // Wait for the receipt before the next step.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`/api/tx/${hash}`);
        const json = (await res.json()) as { status: string };
        if (json.status === "success") return hash;
        if (json.status === "reverted") throw new Error(`${label} reverted on chain.`);
      }
      throw new Error(`${label} is taking too long; check the explorer.`);
    },
    [sendTransaction],
  );

  const swap = useCallback(async () => {
    if (!quote || !quote.amountOut || !quote.minAmountOut || !quote.deadline || !wallet) return;
    setError(null);
    setTx(null);
    try {
      const amountIn = BigInt(quote.amountIn);
      if (quote.approvals?.erc20) {
        await send(`Approve ${side === "buy" ? quoteSymbol : symbol}`, quote.currencyIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [quote.permit2, maxUint256] }), 0n);
      }
      if (quote.approvals?.permit2) {
        const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
        await send("Allow the router", quote.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [quote.currencyIn, quote.router, MAX_UINT160, expiration] }), 0n);
      }
      const enc = encodeExactInputSwap({
        router: quote.router,
        poolKey: quote.poolKey,
        zeroForOne: quote.zeroForOne,
        amountIn,
        minAmountOut: BigInt(quote.minAmountOut),
        hookData: quote.hookData,
        deadline: BigInt(quote.deadline),
      });
      setStep(side === "buy" ? "Buying…" : "Selling…");
      const result = await sendTransaction({ to: enc.to, data: enc.data, value: enc.value, chainId: CHAIN_ID });
      const hash = typeof result === "string" ? result : ((result as { hash?: string }).hash ?? null);
      if (!hash) throw new Error("No transaction hash returned.");
      setTx({ hash, status: "pending" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The swap was cancelled.");
    } finally {
      setStep(null);
    }
  }, [quote, wallet, side, symbol, quoteSymbol, send, sendTransaction]);

  const feePct = quote ? quote.antiSnipe.feeBps / 100 : left > 0 ? Math.round(1 + (98 * left) / ANTI_SNIPE_SECONDS) : 1;
  const secondsLeft = quote?.antiSnipe.active ? quote.antiSnipe.secondsLeft : left;
  const balanceIn = quote?.balances?.in ?? null;
  const insufficient = balanceIn !== null && amount !== "" && Number(amount) > Number(balanceIn);
  const canSwap = Boolean(ready && authenticated && wallet && quote?.amountOut && !insufficient && !loading && !step);

  const chip = (kind: "quote" | "token") =>
    kind === "quote" ? (
      <span className="asset">
        <span className="c" style={{ background: quoteKind === "stk" ? "var(--stock)" : quoteKind === "usd" ? "var(--up)" : "var(--blue)" }}>
          {quoteKind === "stk" ? quoteSymbol[0] : quoteKind === "usd" ? "$" : "Ξ"}
        </span>
        {quoteSymbol}
      </span>
    ) : (
      <span className="asset">
        <span className="c" style={{ background: symbolColor(symbol) }}>{symbol[0]}</span>
        {symbol}
      </span>
    );

  const quickButtons = side === "buy" ? QUICK[quoteKind] : ["25%", "50%", "100%"];
  const pick = (v: string) => {
    if (v.endsWith("%")) {
      const bal = Number(quote?.balances?.in ?? 0);
      const pct = Number(v.slice(0, -1)) / 100;
      setAmount(bal > 0 ? String(Math.floor(bal * pct * 1e6) / 1e6) : "");
    } else setAmount(v);
  };

  return (
    <div className="swap">
      <div className="seg">
        <button className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      {secondsLeft > 0 && (
        <div className="snipe">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          Anti-snipe: {feePct}% fee for {secondsLeft}s more
        </div>
      )}
      <div className="field">
        <div className="l">
          <span>You pay</span>
          <span>Balance {balanceIn === null ? "—" : fmt(balanceIn)}</span>
        </div>
        <div className="in">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" aria-label="Amount" />
          {side === "buy" ? chip("quote") : chip("token")}
        </div>
      </div>
      <div className="quick">
        {quickButtons.map((v) => (
          <button key={v} onClick={() => pick(v)}>
            {v}
          </button>
        ))}
      </div>
      <div className="field">
        <div className="l">
          <span>You receive</span>
          <span>{loading ? "quoting…" : quote?.minAmountOutHuman ? `min ${fmt(quote.minAmountOutHuman)}` : "est."}</span>
        </div>
        <div className="in">
          <input value={quote?.amountOutHuman ? fmt(quote.amountOutHuman) : "0"} readOnly aria-label="Estimated output" />
          {side === "buy" ? chip("token") : chip("quote")}
        </div>
      </div>
      <div className="kv">
        <span>Pool fee</span>
        <b>
          {feePct}% in {quoteSymbol}
        </b>
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
      <div className="kv">
        <span>Route</span>
        <b>o1 hook · Uniswap v4{quote?.referrer ? " · o1bot referral" : ""}</b>
      </div>

      {!ready ? null : !authenticated ? (
        <button className="cta" onClick={() => login()}>
          Connect with X to trade
        </button>
      ) : (
        <button className={`cta ${side === "sell" ? "sell" : ""}`} disabled={!canSwap} onClick={() => void swap()}>
          {step ?? (insufficient ? `Not enough ${side === "buy" ? quoteSymbol : symbol}` : quote?.approvals?.erc20 || quote?.approvals?.permit2 ? `Approve and ${side}` : side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`)}
        </button>
      )}
      {quote?.quoteError && amount && <div className="note warn">Quote failed: {quote.quoteError}</div>}
      {error && <div className="note warn">{error}</div>}
      {tx && (
        <div className={`note ${tx.status === "success" ? "ok" : tx.status === "reverted" ? "warn" : ""}`}>
          {tx.status === "pending" ? "Waiting for confirmation…" : tx.status === "success" ? "Swap confirmed." : "Swap reverted."}{" "}
          <a href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
            {tx.hash.slice(0, 10)}…
          </a>
        </div>
      )}
      <div className="note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
        <span>Signed by your o1bot wallet, routed through o1&apos;s launch pool. Of the 1% fee, 0.5% goes to the creator and 0.2% to o1bot as referrer. Gas is paid in ETH.</span>
      </div>
    </div>
  );
}
