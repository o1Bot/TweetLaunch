import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { publicClient } from "@o1bot/shared";
import { isChainKey, type ChainKey } from "@/lib/chains-web";
import { LifiError, lifiQuote, NOBODY } from "@/lib/lifi";
import { swapsAvailable } from "@/lib/market";
import { findCatalogToken, resolveCustomToken, type CatalogToken } from "@/lib/swap-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/swap/quote?chain=robinhood&from=<address|native>&to=<address|native>&amount=<human>[&wallet=0x…][&slippageBps=300]
 *
 * One quote for a swap between any two tokens on a chain. A pair that
 * involves a token launched through o1bot is answered with `kind: "o1"`:
 * the page then uses the o1 pool route (and its referral) through the
 * existing panel. Every other pair is quoted by LI.FI; the transaction it
 * returns is checked against the request before it reaches the browser,
 * which signs it with the user's own wallet.
 */

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

/** A small guard for the LI.FI key: at most this many quotes per minute per client. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;
const hits = new Map<string, number[]>();
function throttled(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  return recent.length > MAX_PER_WINDOW;
}

const parseToken = (v: string | null): string | null => {
  if (!v) return null;
  if (v.toLowerCase() === "native") return zeroAddress;
  return isAddress(v, { strict: false }) ? getAddress(v.toLowerCase()) : null;
};

async function tokenOf(chain: ChainKey, address: Address): Promise<CatalogToken | null> {
  if (address === zeroAddress) return findCatalogToken(chain, zeroAddress);
  return (await findCatalogToken(chain, address)) ?? (await resolveCustomToken(chain, address));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chain = url.searchParams.get("chain") ?? "robinhood";
  if (!isChainKey(chain)) return bad("unknown chain");
  const from = parseToken(url.searchParams.get("from"));
  const to = parseToken(url.searchParams.get("to"));
  if (!from || !to) return bad("from and to must be token addresses or 'native'");
  if (from === to) return bad("pick two different tokens");
  const amountHuman = (url.searchParams.get("amount") ?? "").trim();
  const walletParam = url.searchParams.get("wallet");
  const wallet = walletParam && isAddress(walletParam, { strict: false }) ? getAddress(walletParam.toLowerCase()) : null;
  const slippageBps = Math.min(5000, Math.max(10, Number(url.searchParams.get("slippageBps") ?? 300) || 300));

  const [tokenIn, tokenOut] = await Promise.all([tokenOf(chain, from as Address), tokenOf(chain, to as Address)]);
  if (!tokenIn) return bad("the input token is not known on this chain", 404);
  if (!tokenOut) return bad("the output token is not known on this chain", 404);

  // A token launched through o1bot trades on its o1 pool, against that pool's asset only.
  const o1Side = tokenIn.kind === "o1" ? tokenIn : tokenOut.kind === "o1" ? tokenOut : null;
  if (o1Side) {
    const other = o1Side === tokenIn ? tokenOut : tokenIn;
    const pair = o1Side.o1!;
    if (other.address !== pair.quoteAddress && !(other.address === zeroAddress && pair.quoteAddress === zeroAddress)) {
      return bad(`${o1Side.symbol} trades against ${pair.quoteSymbol} on its o1 pool. Swap to ${pair.quoteSymbol} first, then ${o1Side.symbol}.`, 409);
    }
    if (tokenIn.kind === "o1" && tokenOut.kind === "o1") return bad("two launched tokens cannot be swapped in one step", 409);
    return Response.json({ kind: "o1", chain, token: o1Side.address, symbol: o1Side.symbol, side: o1Side === tokenIn ? "sell" : "buy", quoteSymbol: pair.quoteSymbol, quoteKind: pair.quoteKind, launchedAt: pair.launchedAt, available: swapsAvailable(chain) });
  }

  let amountIn: bigint;
  try {
    amountIn = amountHuman ? parseUnits(amountHuman, tokenIn.decimals) : 0n;
  } catch {
    return bad("the amount is not a number");
  }
  const base = { kind: "lifi" as const, chain, tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals }, tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals }, slippageBps };
  if (amountIn <= 0n) return Response.json({ ...base, amountIn: "0", amountOut: null });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  if (throttled(`${ip}`)) return bad("too many quotes from this connection; slow down", 429);

  // Balances and the allowance LI.FI's contract still needs, read while the quote is fetched.
  const client = publicClient(chain);
  const reads = wallet
    ? Promise.all([
        tokenIn.address === zeroAddress ? client.getBalance({ address: wallet }) : client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
        client.getBalance({ address: wallet }),
      ]).catch(() => null)
    : Promise.resolve(null);

  try {
    const [quote, balances] = await Promise.all([lifiQuote({ chain, fromToken: tokenIn.address, toToken: tokenOut.address, fromAmount: amountIn, wallet: wallet ?? NOBODY, slippageBps }), reads]);
    let approval: { spender: Address; needed: boolean; allowance: string } | null = null;
    if (wallet && quote.approvalAddress) {
      const allowance = await client.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: "allowance", args: [wallet, quote.approvalAddress] }).catch(() => 0n);
      approval = { spender: quote.approvalAddress, needed: allowance < amountIn, allowance: allowance.toString() };
    }
    return Response.json({
      ...base,
      amountIn: amountIn.toString(),
      amountOut: quote.toAmount.toString(),
      amountOutMin: quote.toAmountMin.toString(),
      amountOutHuman: formatUnits(quote.toAmount, tokenOut.decimals),
      amountOutMinHuman: formatUnits(quote.toAmountMin, tokenOut.decimals),
      usdIn: quote.fromAmountUsd,
      usdOut: quote.toAmountUsd,
      tool: quote.tool,
      toolName: quote.toolName,
      gasUsd: quote.gasUsd,
      feeUsd: quote.feeUsd,
      seconds: quote.executionSeconds,
      approval,
      balances: balances ? { in: formatUnits(balances[0], tokenIn.decimals), native: formatUnits(balances[1], 18) } : null,
      tx: quote.tx ? { to: quote.tx.to, data: quote.tx.data, value: quote.tx.value.toString(), gasLimit: quote.tx.gasLimit?.toString() ?? null } : null,
    });
  } catch (err) {
    if (err instanceof LifiError) return Response.json({ ...base, amountIn: amountIn.toString(), amountOut: null, quoteError: err.message }, { status: err.status === 429 ? 429 : 200 });
    return bad(err instanceof Error ? err.message : "quote failed", 502);
  }
}
