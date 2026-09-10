import { erc20Abi, formatUnits, getAddress, zeroAddress, type Address } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { feeEscrowAbi } from "@o1bot/executor";
import { activeFeeEscrow, BRIDGE_CHAIN_KEYS, bridgeChainDisplayName, bridgeClient, findQuote, logger, publicClient } from "@o1bot/shared";
import { userFromRequest } from "@o1bot/wallet";
import { ipfsToHttp } from "@/lib/ipfs";
import { listBoardTokens } from "@/lib/market";
import { quoteUsd } from "@/lib/quote-usd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/overview — everything the profile page shows: the wallet's
 * holdings in ETH, USDG and every token launched through o1bot, the user's
 * launches (as creator or as fee recipient), and the creator-fee balances
 * waiting in o1's escrow per paired asset.
 */

type Asset = { address: string; symbol: string; name: string; imageUrl: string | null; decimals: number; balance: string; usd: number | null; kind: "native" | "quote" | "token"; tokenPage: string | null };
type FeePosition = { currency: string; symbol: string; decimals: number; owed: string; usd: number | null };
type TradeHistoryRow = {
  id: string;
  side: "BUY" | "SELL";
  token: string;
  tokenSymbol: string;
  quoteSymbol: string;
  /** Human units: quote for buys, tokens for sells. */
  amountIn: string;
  /** Human units of what came out; null until confirmed. */
  amountOut: string | null;
  status: string;
  txHash: string | null;
  userMessage: string | null;
  createdAt: string;
};
type GasRow = { chain: string; name: string; eth: string; usd: number | null };
type LaunchRow = {
  id: string;
  source: "X" | "WEB";
  role: "creator" | "fee_recipient";
  ticker: string;
  name: string;
  quoteSymbol: string;
  imageUrl: string | null;
  chainId: number;
  status: string;
  tokenAddress: string | null;
  launchTxHash: string | null;
  userMessage: string | null;
  createdAt: string;
  /** The creator's half of the hook fees on the token so far, when it is live. */
  feesEarnedQuote: number | null;
  feesEarnedUsd: number | null;
};

export async function GET(req: Request) {
  if (!dbConfigured()) return Response.json({ error: "database not configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.wallet) return Response.json({ wallet: null, assets: [], launches: [], trades: [], gas: [], fees: { escrow: activeFeeEscrow("robinhood"), positions: [] } });
  const wallet = getAddress(user.wallet.address);
  const client = publicClient("robinhood");

  // Launches where this account is the creator or the fee recipient.
  const rows = await db().launch.findMany({
    where: { OR: [{ creator: { xUserId: user.xUserId } }, { feeRecipient: { xUserId: user.xUserId } }] },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { creator: { select: { xUserId: true } } },
  });
  // Fees the creator's half has earned per live token: half of the hook fees on its swaps.
  const liveTokens = rows.map((l) => l.tokenAddress).filter((t): t is string => Boolean(t));
  const feeSums = liveTokens.length ? await db().swap.groupBy({ by: ["token"], where: { token: { in: liveTokens } }, _sum: { feeQuote: true } }) : [];
  const feesByToken = new Map(feeSums.map((f) => [f.token.toLowerCase(), f._sum.feeQuote ? Number(f._sum.feeQuote.toString()) : 0]));
  const launches: LaunchRow[] = [];
  for (const l of rows) {
    const q = findQuote("robinhood", l.quoteAddress) ?? (getAddress(l.quoteAddress) === zeroAddress ? { symbol: "ETH", decimals: 18, address: zeroAddress } : null);
    const feeRaw = l.tokenAddress ? feesByToken.get(l.tokenAddress.toLowerCase()) : undefined;
    const feesEarnedQuote = feeRaw !== undefined && q ? feeRaw / 2 / 10 ** q.decimals : null;
    const px = feesEarnedQuote === null || !q ? null : q.symbol === "USDG" ? 1 : await quoteUsd(q.address, q.decimals).catch(() => null);
    launches.push({
      id: l.id,
      source: l.source,
      role: l.creator.xUserId === user.xUserId ? "creator" : "fee_recipient",
      ticker: l.ticker,
      name: l.name,
      quoteSymbol: l.quoteSymbol,
      imageUrl: l.imageUri ? (ipfsToHttp(l.imageUri) ?? l.imageUri) : null,
      chainId: l.chainId,
      status: l.status,
      tokenAddress: l.tokenAddress,
      launchTxHash: l.launchTxHash,
      userMessage: l.userMessage,
      createdAt: l.createdAt.toISOString(),
      feesEarnedQuote,
      feesEarnedUsd: feesEarnedQuote !== null && px !== null ? feesEarnedQuote * px : null,
    });
  }

  // Trades asked for in posts, newest first; symbols were recorded at trade time.
  const tradeRows = await db().trade.findMany({ where: { user: { xUserId: user.xUserId } }, orderBy: { createdAt: "desc" }, take: 100 });
  const trades: TradeHistoryRow[] = tradeRows.map((t) => {
    const quoteDecimals = t.quoteDecimals ?? 18;
    const inDecimals = t.side === "BUY" ? quoteDecimals : 18;
    const outDecimals = t.side === "BUY" ? 18 : quoteDecimals;
    return {
      id: t.id,
      side: t.side,
      token: t.token,
      tokenSymbol: t.tokenSymbol ?? `${t.token.slice(0, 6)}…${t.token.slice(-4)}`,
      quoteSymbol: t.quoteSymbol ?? "ETH",
      amountIn: formatUnits(BigInt(t.amountInWei), inDecimals),
      amountOut: t.amountOut ? formatUnits(BigInt(t.amountOut), outDecimals) : null,
      status: t.status,
      txHash: t.txHash,
      userMessage: t.userMessage,
      createdAt: t.createdAt.toISOString(),
    };
  });

  // Holdings: ETH, the quote assets this account has touched, and every o1bot token.
  const board = await listBoardTokens().catch(() => []);
  const usdg = findQuote("robinhood", "USDG");
  const quoteAddresses = new Set<string>([...(usdg ? [usdg.address] : []), ...rows.map((l) => getAddress(l.quoteAddress))]);
  quoteAddresses.delete(zeroAddress);
  const erc20s: Array<{ address: Address; kind: "quote" | "token" }> = [
    ...[...quoteAddresses].map((a) => ({ address: a as Address, kind: "quote" as const })),
    ...board.map((t) => ({ address: getAddress(t.token), kind: "token" as const })),
  ];
  const [ethBalance, balances] = await Promise.all([
    client.getBalance({ address: wallet }),
    erc20s.length
      ? client.multicall({ allowFailure: true, contracts: erc20s.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) as const) })
      : Promise.resolve([]),
  ]);
  const ethUsd = await quoteUsd(zeroAddress, 18).catch(() => null);

  // ETH per chain: Robinhood (gas for everything here) and the chains a post can bridge from.
  const originBalances = await Promise.all(BRIDGE_CHAIN_KEYS.map((key) => bridgeClient(key).getBalance({ address: wallet }).catch(() => null)));
  const gas: GasRow[] = [
    { chain: "robinhood", name: "Robinhood", eth: formatUnits(ethBalance, 18), usd: ethUsd === null ? null : Number(formatUnits(ethBalance, 18)) * ethUsd },
    ...BRIDGE_CHAIN_KEYS.map((key, i) => {
      const bal = originBalances[i] ?? null;
      return { chain: key, name: bridgeChainDisplayName(key), eth: bal === null ? "0" : formatUnits(bal, 18), usd: bal === null || ethUsd === null ? null : Number(formatUnits(bal, 18)) * ethUsd };
    }),
  ];
  const assets: Asset[] = [
    { address: zeroAddress, symbol: "ETH", name: "Ether", imageUrl: null, decimals: 18, balance: formatUnits(ethBalance, 18), usd: ethUsd === null ? null : Number(formatUnits(ethBalance, 18)) * ethUsd, kind: "native", tokenPage: null },
  ];
  for (const [i, t] of erc20s.entries()) {
    const r = balances[i];
    if (!r || r.status !== "success" || (r.result as bigint) === 0n) continue;
    const raw = r.result as bigint;
    if (t.kind === "quote") {
      const q = findQuote("robinhood", t.address);
      if (!q) continue;
      const human = formatUnits(raw, q.decimals);
      const px = q.symbol === "USDG" ? 1 : await quoteUsd(q.address, q.decimals).catch(() => null);
      assets.push({ address: q.address, symbol: q.symbol, name: q.name ?? q.symbol, imageUrl: null, decimals: q.decimals, balance: human, usd: px === null ? null : Number(human) * px, kind: "quote", tokenPage: null });
    } else {
      const row = board.find((b) => getAddress(b.token) === t.address);
      if (!row) continue;
      const human = formatUnits(raw, 18);
      assets.push({
        address: t.address,
        symbol: row.symbol,
        name: row.name,
        imageUrl: row.imageUrl ? (ipfsToHttp(row.imageUrl) ?? row.imageUrl) : null,
        decimals: 18,
        balance: human,
        usd: row.stats.priceUsd === null ? null : Number(human) * row.stats.priceUsd,
        kind: "token",
        tokenPage: `/token/${t.address}`,
      });
    }
  }

  // Creator fees waiting in o1's escrow, per paired asset this account could have earned in.
  const escrow = activeFeeEscrow("robinhood");
  const currencies = [...new Set<string>([zeroAddress, ...(usdg ? [usdg.address] : []), ...rows.map((l) => getAddress(l.quoteAddress))])];
  const owed = await client.multicall({
    allowFailure: true,
    contracts: currencies.map((c) => ({ address: escrow, abi: feeEscrowAbi, functionName: "owed", args: [wallet, c as Address] }) as const),
  });
  const positions: FeePosition[] = [];
  for (const [i, currency] of currencies.entries()) {
    const r = owed[i];
    if (!r || r.status !== "success" || (r.result as bigint) === 0n) continue;
    const amount = r.result as bigint;
    const q = currency === zeroAddress ? { symbol: "ETH", decimals: 18 } : findQuote("robinhood", currency);
    if (!q) continue;
    const human = formatUnits(amount, q.decimals);
    const px = currency === zeroAddress ? ethUsd : q.symbol === "USDG" ? 1 : await quoteUsd(currency, q.decimals).catch(() => null);
    positions.push({ currency, symbol: q.symbol, decimals: q.decimals, owed: human, usd: px === null ? null : Number(human) * px });
  }

  logger.debug({ xUserId: user.xUserId, assets: assets.length, launches: launches.length, trades: trades.length, fees: positions.length }, "profile overview");
  return Response.json({ wallet, assets, launches, trades, gas, fees: { escrow, positions } });
}
