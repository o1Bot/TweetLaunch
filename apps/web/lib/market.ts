import { getAddress, isAddress, zeroAddress } from "viem";
import { db, dbConfigured, Prisma, type Pool } from "@o1bot/db";
import { buildCandles, computeStats, TIMEFRAMES, type Candle, type Timeframe, type TokenStats } from "@o1bot/market";
import { env } from "@o1bot/shared";
import { ipfsToHttp } from "./ipfs";
import { readBurned } from "./burn";
import { quoteUsd } from "./quote-usd";
import type { Creator, GenesisPost, QuoteKind, TokenDetail, TokenRow, TradeRow } from "./types";

/**
 * Read side of the board and token pages. Everything comes from the tables
 * the indexer fills; only pools the bot launched are ever in there (plus
 * DEV rows, hidden unless SHOW_DEV_TOKENS is set).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const include = { launch: { include: { mention: true, creator: true } } } as const;
type PoolWithLaunch = Prisma.PoolGetPayload<{ include: typeof include }>;

function poolFilter(): Prisma.PoolWhereInput {
  return env().SHOW_DEV_TOKENS ? {} : { source: "BOT" };
}

function quoteKind(address: string, symbol: string): QuoteKind {
  if (address === zeroAddress) return "eth";
  if (symbol.toUpperCase() === "USDG") return "usd";
  return "stk";
}

const toNum = (d: Prisma.Decimal | null | undefined): number | null => (d === null || d === undefined ? null : Number(d.toString()));
const toHuman = (d: Prisma.Decimal | null | undefined, decimals: number): number => (d ? Number(d.toString()) / 10 ** decimals : 0);

type PoolExtra = { stats: TokenStats; tradeCount: number; feesQuoteTotal: number; burnedTokens: number; circulatingTokens: number };

/** `burnedRaw` = tokens at the dead address; market cap is computed on what is left. */
async function statsFor(pool: Pool, burnedRaw = 0n): Promise<PoolExtra> {
  const since = new Date(Date.now() - DAY_MS);
  const token = pool.token;
  const [last, agg24, before24, first, all] = await Promise.all([
    db().swap.findFirst({ where: { token }, orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }], select: { priceQuote: true } }),
    db().swap.aggregate({ where: { token, timestamp: { gte: since } }, _sum: { amountQuote: true } }),
    db().swap.findFirst({ where: { token, timestamp: { lt: since } }, orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }], select: { priceQuote: true } }),
    db().swap.findFirst({ where: { token }, orderBy: [{ timestamp: "asc" }, { logIndex: "asc" }], select: { priceQuote: true } }),
    db().swap.aggregate({ where: { token }, _sum: { feeQuote: true, amountQuote: true }, _count: { _all: true } }),
  ]);
  const usd = await quoteUsd(pool.quoteAddress, pool.quoteDecimals);
  const supplyTokens = Number(pool.launchSupply.toString()) / 1e18;
  const burnedTokens = Math.min(supplyTokens, Number(burnedRaw) / 1e18);
  const circulatingTokens = supplyTokens - burnedTokens;
  const stats = computeStats({
    lastPrice: last ? toNum(last.priceQuote) : null,
    priceAt24hAgo: before24 ? toNum(before24.priceQuote) : null,
    volume24hQuote: toHuman(agg24._sum.amountQuote, pool.quoteDecimals),
    volumeAllQuote: toHuman(all._sum.amountQuote, pool.quoteDecimals),
    supplyTokens: circulatingTokens,
    quoteUsd: usd,
    launchPrice: first ? toNum(first.priceQuote) : null,
  });
  return { stats, tradeCount: all._count._all, feesQuoteTotal: toHuman(all._sum.feeQuote, pool.quoteDecimals), burnedTokens, circulatingTokens };
}

function creatorOf(pool: PoolWithLaunch): Creator {
  const u = pool.launch?.creator;
  return { wallet: pool.creatorWallet, xHandle: u?.xHandle ?? null, xName: u?.xName ?? null, xAvatarUrl: u?.xAvatarUrl ?? null };
}

function postOf(pool: PoolWithLaunch): GenesisPost | null {
  const m = pool.launch?.mention;
  return m ? { tweetId: m.tweetId, text: m.text, postedAt: m.postedAt ? m.postedAt.toISOString() : null } : null;
}

function toRow(pool: PoolWithLaunch, extra: PoolExtra): TokenRow {
  return {
    token: pool.token,
    name: pool.name,
    symbol: pool.symbol,
    imageUrl: ipfsToHttp(pool.imageUri),
    quoteSymbol: pool.quoteSymbol,
    quoteAddress: pool.quoteAddress,
    quoteDecimals: pool.quoteDecimals,
    quoteKind: quoteKind(pool.quoteAddress, pool.quoteSymbol),
    launchedAt: pool.launchedAt.toISOString(),
    launchTxHash: pool.launchTxHash,
    creator: creatorOf(pool),
    post: postOf(pool),
    stats: extra.stats,
    tradeCount: extra.tradeCount,
    source: pool.source,
    burnedTokens: extra.burnedTokens,
    circulatingTokens: extra.circulatingTokens,
  };
}

export async function listBoardTokens(): Promise<TokenRow[]> {
  if (!dbConfigured()) return [];
  const pools = await db().pool.findMany({ where: poolFilter(), include, orderBy: { launchedAt: "desc" } });
  const burned = await readBurned(pools.map((p) => p.token));
  const rows = await Promise.all(pools.map(async (p) => toRow(p, await statsFor(p, burned.get(getAddress(p.token)) ?? 0n))));
  const vol = (r: TokenRow) => r.stats.volume24hUsd ?? r.stats.volume24hQuote;
  return rows.sort((a, b) => vol(b) - vol(a) || b.launchedAt.localeCompare(a.launchedAt));
}

export async function getTrades(address: string, limit = 50): Promise<TradeRow[]> {
  const pool = await db().pool.findUnique({ where: { token: address }, select: { quoteDecimals: true } });
  if (!pool) return [];
  const swaps = await db().swap.findMany({ where: { token: address }, orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }], take: Math.min(limit, 500) });
  return swaps.map((s) => ({
    id: s.id,
    time: s.timestamp.toISOString(),
    side: s.side,
    amountToken: toHuman(s.amountToken, 18),
    amountQuote: toHuman(s.amountQuote, pool.quoteDecimals),
    priceQuote: toNum(s.priceQuote) ?? 0,
    trader: s.trader,
    txHash: s.txHash,
    comment: s.comment,
  }));
}

export async function getTokenDetail(address: string): Promise<TokenDetail | null> {
  if (!dbConfigured() || !isAddress(address, { strict: false })) return null;
  const token = getAddress(address.toLowerCase());
  const pool = await db().pool.findUnique({ where: { token }, include });
  if (!pool) return null;
  if (pool.source === "DEV" && !env().SHOW_DEV_TOKENS) return null;
  const burned = await readBurned([token]);
  const [extra, trades] = await Promise.all([statsFor(pool, burned.get(token) ?? 0n), getTrades(token, 30)]);
  return {
    ...toRow(pool, extra),
    poolId: pool.poolId,
    tickSpacing: pool.tickSpacing,
    hook: pool.hook,
    factory: pool.factory,
    launchBlock: pool.launchBlock.toString(),
    supplyTokens: Number(pool.launchSupply.toString()) / 1e18,
    metadataUri: pool.metadataUri,
    feesQuoteTotal: extra.feesQuoteTotal,
    trades,
  };
}

export async function getCandles(address: string, tf: Timeframe): Promise<{ candles: Candle[]; quoteSymbol: string } | null> {
  if (!dbConfigured() || !isAddress(address, { strict: false })) return null;
  const token = getAddress(address.toLowerCase());
  const pool = await db().pool.findUnique({ where: { token }, select: { quoteDecimals: true, quoteSymbol: true, source: true } });
  if (!pool || (pool.source === "DEV" && !env().SHOW_DEV_TOKENS)) return null;
  const interval = TIMEFRAMES[tf];
  const since = new Date(Date.now() - interval * 300 * 1000);
  const select = { timestamp: true, priceQuote: true, amountQuote: true } as const;
  let swaps = await db().swap.findMany({ where: { token, timestamp: { gte: since } }, orderBy: [{ timestamp: "asc" }, { logIndex: "asc" }], select });
  if (swaps.length < 20) {
    const recent = await db().swap.findMany({ where: { token }, orderBy: [{ timestamp: "desc" }, { logIndex: "desc" }], take: 300, select });
    swaps = recent.reverse();
  }
  const points = swaps.map((s) => ({ ts: Math.floor(s.timestamp.getTime() / 1000), price: toNum(s.priceQuote) ?? 0, volumeQuote: toHuman(s.amountQuote, pool.quoteDecimals) }));
  return { candles: buildCandles(points, interval, { fill: true, to: Math.floor(Date.now() / 1000) }), quoteSymbol: pool.quoteSymbol };
}

export async function boardTotals(rows: TokenRow[]): Promise<{ launches: number; volume24hUsd: number | null; volumeAllUsd: number | null; trades: number }> {
  const known24 = rows.filter((r) => r.stats.volume24hUsd !== null);
  const knownAll = rows.filter((r) => r.stats.volumeAllUsd !== null);
  return {
    launches: rows.length,
    volume24hUsd: known24.length ? known24.reduce((s, r) => s + (r.stats.volume24hUsd ?? 0), 0) : null,
    volumeAllUsd: knownAll.length ? knownAll.reduce((s, r) => s + (r.stats.volumeAllUsd ?? 0), 0) : null,
    trades: rows.reduce((s, r) => s + r.tradeCount, 0),
  };
}
