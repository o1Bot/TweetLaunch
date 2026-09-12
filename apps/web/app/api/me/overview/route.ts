import { erc20Abi, formatUnits, getAddress, zeroAddress, type Address } from "viem";
import { db, dbConfigured } from "@o1bot/db";
import { feeEscrowAbi } from "@o1bot/executor";
import {
  activeFeeEscrow,
  BRIDGE_CHAIN_KEYS,
  bridgeChainDisplayName,
  bridgeClient,
  chainKeyById,
  FEE_SPLIT_BPS,
  feeSplitterAbi,
  feeSplitterFactory,
  findQuote,
  logger,
  nativeSymbol,
  parseFeeSplitConfig,
  publicClient,
  recipientShareOf,
  recipientSharePct,
  type ChainKey,
  type FeeSplitConfig,
} from "@o1bot/shared";
import { userFromRequest } from "@o1bot/wallet";
import { ipfsToHttp } from "@/lib/ipfs";
import { listBoardTokens } from "@/lib/market";
import { quoteUsd } from "@/lib/quote-usd";
import { sitesForLaunches, type LaunchSiteInfo } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/overview — everything the profile page shows: the wallet's
 * holdings in ETH, USDG and every token launched through o1bot, the user's
 * launches (as creator or as fee recipient) with what their fee splitters
 * can pay out, and the creator-fee balances waiting in o1's escrow for the
 * wallet itself (launches made before the splitter existed).
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
type FeeSplit = {
  /** The launch's fee splitter clone, o1's creator fee recipient for the token. */
  splitter: string;
  /** The factory that deploys the clone, when this deployment knows it; the first claim deploys through it. */
  factory: string | null;
  /** False until the clone has code: claiming then starts with a one-time deployment. */
  deployed: boolean;
  config: FeeSplitConfig;
  /** The recipients' part of every claim in whole percent (80 with a 2 000 bps platform share). */
  sharePct: number;
  /** The paired asset the fees accrue in. */
  currency: string;
  symbol: string;
  decimals: number;
  /** What a claim would pay the recipients now, in human units; null when the chain could not be read. */
  claimable: string | null;
  claimableUsd: number | null;
};
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
  /** The creator's half of the hook fees on the token so far, less the platform share where a splitter is in place; null unless live. */
  feesEarnedQuote: number | null;
  feesEarnedUsd: number | null;
  /** The token's website on the sandbox domain, in any state short of released; null when none was asked for. */
  site: LaunchSiteInfo | null;
  /** o1bot's fee splitter for the launch; null for launches that keep the wallet itself as o1's fee recipient. */
  feeSplit: FeeSplit | null;
};

type QuoteInfo = { address: Address; symbol: string; decimals: number };
type SplitterRead = { deployed: boolean; gross: bigint | null };

const STABLE_SYMBOLS = new Set(["USDG", "USDC"]);

/** The paired asset of a launch on its chain: the native currency for the zero address, else a registered quote. */
function quoteOf(key: ChainKey, address: string): QuoteInfo | null {
  const a = getAddress(address);
  if (a === zeroAddress) return { address: zeroAddress, symbol: nativeSymbol(key), decimals: 18 };
  const q = findQuote(key, a);
  return q ? { address: getAddress(q.address), symbol: q.symbol, decimals: q.decimals } : null;
}

/**
 * What each launch's splitter clone could pay out now, read on the launch's
 * chain: the clone's own view when it is deployed, else what o1's escrow
 * owes the address the clone will have. A clone without code answers
 * nothing, which is how "not deployed yet" is told apart.
 */
async function readSplitters(rows: Array<{ id: string; chainId: number; splitter: Address; currency: Address }>): Promise<Map<string, SplitterRead>> {
  const out = new Map<string, SplitterRead>();
  const byChain = new Map<ChainKey, typeof rows>();
  for (const r of rows) {
    const key = chainKeyById(r.chainId);
    if (key) byChain.set(key, [...(byChain.get(key) ?? []), r]);
  }
  await Promise.all(
    [...byChain].map(async ([key, list]) => {
      try {
        const escrow = activeFeeEscrow(key);
        const results = await publicClient(key).multicall({
          allowFailure: true,
          contracts: list.flatMap((r) => [
            { address: r.splitter, abi: feeSplitterAbi, functionName: "claimable", args: [r.currency] } as const,
            { address: escrow, abi: feeEscrowAbi, functionName: "owed", args: [r.splitter, r.currency] } as const,
          ]),
        });
        list.forEach((r, i) => {
          const viaClone = results[2 * i];
          const viaEscrow = results[2 * i + 1];
          const deployed = viaClone?.status === "success";
          const gross = deployed ? (viaClone.result as bigint) : viaEscrow?.status === "success" ? (viaEscrow.result as bigint) : null;
          out.set(r.id, { deployed, gross });
        });
      } catch (err) {
        logger.warn({ chain: key, err: err instanceof Error ? err.message : String(err) }, "fee splitter read failed; claimables unknown");
      }
    }),
  );
  return out;
}

export async function GET(req: Request) {
  if (!dbConfigured()) return Response.json({ error: "database not configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.wallet) return Response.json({ wallet: null, assets: [], launches: [], trades: [], gas: [], fees: { escrow: activeFeeEscrow("robinhood"), positions: [] } });
  const wallet = getAddress(user.wallet.address);
  const client = publicClient("robinhood");
  const ethUsd = await quoteUsd(zeroAddress, 18).catch(() => null);

  // One price per paired asset per chain for the whole response.
  const prices = new Map<string, Promise<number | null>>([[`robinhood:${zeroAddress}`, Promise.resolve(ethUsd)]]);
  const priceOf = (key: ChainKey, q: QuoteInfo): Promise<number | null> => {
    const id = `${key}:${q.address}`;
    let p = prices.get(id);
    if (!p) {
      p = STABLE_SYMBOLS.has(q.symbol) ? Promise.resolve(1) : quoteUsd(q.address, q.decimals, key).catch(() => null);
      prices.set(id, p);
    }
    return p;
  };

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
  const sites = await sitesForLaunches(rows.map((l) => l.id));
  const splitRows = rows.flatMap((l) => (l.feeSplitter && l.tokenAddress ? [{ id: l.id, chainId: l.chainId, splitter: getAddress(l.feeSplitter), currency: getAddress(l.quoteAddress) }] : []));
  const splitReads = splitRows.length ? await readSplitters(splitRows) : new Map<string, SplitterRead>();
  const launches: LaunchRow[] = [];
  for (const l of rows) {
    const key = chainKeyById(l.chainId) ?? "robinhood";
    const q = quoteOf(key, l.quoteAddress);
    const px = q ? await priceOf(key, q) : null;
    const config = l.feeSplitter ? parseFeeSplitConfig(l.feeSplitterConfig) : null;
    const feeRaw = l.tokenAddress ? feesByToken.get(l.tokenAddress.toLowerCase()) : undefined;
    const recipientsPart = config ? (FEE_SPLIT_BPS - config.platformBps) / FEE_SPLIT_BPS : 1;
    const feesEarnedQuote = feeRaw !== undefined && q ? ((feeRaw / 2) * recipientsPart) / 10 ** q.decimals : null;
    let feeSplit: FeeSplit | null = null;
    if (l.feeSplitter && l.tokenAddress && config && q) {
      const read = splitReads.get(l.id);
      const claimable = read?.gross === undefined || read.gross === null ? null : formatUnits(recipientShareOf(read.gross, config.platformBps), q.decimals);
      feeSplit = {
        splitter: getAddress(l.feeSplitter),
        factory: feeSplitterFactory(key),
        deployed: read?.deployed ?? false,
        config,
        sharePct: recipientSharePct(config.platformBps),
        currency: q.address,
        symbol: q.symbol,
        decimals: q.decimals,
        claimable,
        claimableUsd: claimable === null || px === null ? null : Number(claimable) * px,
      };
    }
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
      site: sites.get(l.id) ?? null,
      feeSplit,
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

  // Holdings: ETH, the quote assets this account has touched on Robinhood, and every o1bot token.
  const board = await listBoardTokens().catch(() => []);
  const usdg = findQuote("robinhood", "USDG");
  const quoteAddresses = new Set<string>([...(usdg ? [usdg.address] : []), ...rows.filter((l) => chainKeyById(l.chainId) === "robinhood").map((l) => getAddress(l.quoteAddress))]);
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
      const px = await priceOf("robinhood", { address: getAddress(q.address), symbol: q.symbol, decimals: q.decimals });
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

  // Creator fees o1's escrow owes the wallet itself: launches made before the splitter, and any recipient set to the wallet directly.
  const escrow = activeFeeEscrow("robinhood");
  const currencies = [...new Set<string>([zeroAddress, ...quoteAddresses])];
  const owed = await client.multicall({
    allowFailure: true,
    contracts: currencies.map((c) => ({ address: escrow, abi: feeEscrowAbi, functionName: "owed", args: [wallet, c as Address] }) as const),
  });
  const positions: FeePosition[] = [];
  for (const [i, currency] of currencies.entries()) {
    const r = owed[i];
    if (!r || r.status !== "success" || (r.result as bigint) === 0n) continue;
    const amount = r.result as bigint;
    const q = quoteOf("robinhood", currency);
    if (!q) continue;
    const human = formatUnits(amount, q.decimals);
    const px = await priceOf("robinhood", q);
    positions.push({ currency, symbol: q.symbol, decimals: q.decimals, owed: human, usd: px === null ? null : Number(human) * px });
  }

  logger.debug({ xUserId: user.xUserId, assets: assets.length, launches: launches.length, trades: trades.length, fees: positions.length, splitters: splitRows.length }, "profile overview");
  return Response.json({ wallet, assets, launches, trades, gas, fees: { escrow, positions } });
}
