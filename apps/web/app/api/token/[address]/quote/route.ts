import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { launchHookAbi } from "@o1bot/executor";
import { env, o1Chain, publicClient } from "@o1bot/shared";
import { chainKeyOf } from "@/lib/chains-web";
import { antiSnipeFeeBps, applySlippage, encodeHookData, launchPoolKey, permit2Abi, routerLayoutFor, v4QuoterAbi } from "@/lib/v4-swap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/token/:address/quote?side=buy|sell&amount=<human>[&wallet=0x…][&slippageBps=300]
 *
 * Everything the swap panel needs to build one exact-input swap: the pool
 * key, the referral hook data (o1bot's referrer, dropped when it would
 * equal the creator or fee recipient because the hook rejects that), the
 * quoter's output with slippage applied, the current anti-snipe fee, and,
 * when a wallet is given, its balances and the Permit2 approvals it still
 * needs. The browser signs; nothing here does.
 */

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });
const DEADLINE_SECONDS = 180;
const MAX_UINT160 = (1n << 160n) - 1n;

export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }) {
  if (!dbConfigured()) return bad("database not configured", 503);
  const { address } = await params;
  if (!isAddress(address)) return bad("bad token address");
  const token = getAddress(address);
  const url = new URL(req.url);
  const side = url.searchParams.get("side") === "sell" ? "sell" : "buy";
  const amountHuman = (url.searchParams.get("amount") ?? "").trim();
  const walletParam = url.searchParams.get("wallet");
  const wallet = walletParam && isAddress(walletParam) ? getAddress(walletParam) : null;
  const slippageBps = Math.min(5000, Math.max(10, Number(url.searchParams.get("slippageBps") ?? 300) || 300));

  const pool = await db().pool.findUnique({ where: { token } });
  if (!pool) return bad("unknown token", 404);
  const quote = getAddress(pool.quoteAddress) === zeroAddress ? zeroAddress : getAddress(pool.quoteAddress);
  const hook = getAddress(pool.hook);
  const poolKey = launchPoolKey(token, quote, pool.tickSpacing, hook);
  const tokenIsCurrency0 = poolKey.currency0 === token;
  const zeroForOne = side === "buy" ? !tokenIsCurrency0 : tokenIsCurrency0;
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const decimalsIn = side === "buy" ? pool.quoteDecimals : 18;
  const decimalsOut = side === "buy" ? 18 : pool.quoteDecimals;

  const key = chainKeyOf(pool.chainId);
  const client = publicClient(key);
  const chain = o1Chain(key);
  const router = chain.uniswapV4.universalRouter;
  const permit2 = chain.uniswapV4.permit2;

  // Referral: o1bot's wallet in the hook data, unless the hook would reject it.
  const config = await client.readContract({ address: hook, abi: launchHookAbi, functionName: "poolConfig", args: [pool.poolId as `0x${string}`] });
  const [, , currentCreator, creatorFeeRecipient, baseFeeBps, antiSnipeStartTotalBps, antiSnipeWindowSeconds, launchTime] = config;
  const referrerEnv = env().REFERRER_ADDRESS;
  const referrer = referrerEnv && isAddress(referrerEnv) ? getAddress(referrerEnv) : null;
  const referrerAllowed = referrer !== null && referrer !== getAddress(currentCreator) && referrer !== getAddress(creatorFeeRecipient);
  const hookData = encodeHookData(referrerAllowed ? referrer : null);
  const antiSnipe = antiSnipeFeeBps(Math.floor(Date.now() / 1000), Number(launchTime), Number(antiSnipeWindowSeconds), Number(antiSnipeStartTotalBps), Number(baseFeeBps));

  // Balances and approvals for the caller's wallet, when known.
  let balances: { in: string; out: string; eth: string } | null = null;
  let approvals: { erc20: boolean; permit2: boolean } | null = null;
  if (wallet) {
    const [eth, balIn, balOut] = await Promise.all([
      client.getBalance({ address: wallet }),
      currencyIn === zeroAddress ? client.getBalance({ address: wallet }) : client.readContract({ address: currencyIn, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
      currencyOut === zeroAddress ? client.getBalance({ address: wallet }) : client.readContract({ address: currencyOut, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    ]);
    balances = { in: formatUnits(balIn, decimalsIn), out: formatUnits(balOut, decimalsOut), eth: formatUnits(eth, 18) };
    if (currencyIn !== zeroAddress) {
      const [erc20Allowance, permit2Allowance] = await Promise.all([
        client.readContract({ address: currencyIn, abi: erc20Abi, functionName: "allowance", args: [wallet, permit2] }),
        client.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [wallet, currencyIn, router] }),
      ]);
      const [p2Amount, p2Expiration] = permit2Allowance;
      const now = Math.floor(Date.now() / 1000);
      approvals = { erc20: erc20Allowance < MAX_UINT160 / 2n, permit2: p2Amount < MAX_UINT160 / 2n || Number(p2Expiration) <= now + 60 };
    } else {
      approvals = { erc20: false, permit2: false };
    }
  }

  let amountIn = 0n;
  try {
    amountIn = amountHuman ? parseUnits(amountHuman, decimalsIn) : 0n;
  } catch {
    return bad("amount must be a plain decimal number");
  }
  const base = {
    side,
    token,
    chainId: pool.chainId,
    layout: routerLayoutFor(pool.chainId),
    quote,
    poolKey,
    zeroForOne,
    currencyIn,
    currencyOut,
    decimalsIn,
    decimalsOut,
    hookData,
    referrer: referrerAllowed ? referrer : null,
    router,
    permit2,
    antiSnipe,
    balances,
    approvals,
    slippageBps,
  };
  if (amountIn <= 0n) return Response.json({ ...base, amountIn: "0", amountOut: null, minAmountOut: null, amountOutHuman: null, deadline: null });

  try {
    const { result } = await client.simulateContract({
      address: chain.uniswapV4.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData }],
    });
    const [amountOut] = result;
    const minAmountOut = applySlippage(amountOut, slippageBps);
    return Response.json({
      ...base,
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      minAmountOut: minAmountOut.toString(),
      amountOutHuman: formatUnits(amountOut, decimalsOut),
      minAmountOutHuman: formatUnits(minAmountOut, decimalsOut),
      deadline: (Math.floor(Date.now() / 1000) + DEADLINE_SECONDS).toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 160) : String(err);
    return Response.json({ ...base, amountIn: amountIn.toString(), amountOut: null, minAmountOut: null, amountOutHuman: null, deadline: null, quoteError: message });
  }
}
