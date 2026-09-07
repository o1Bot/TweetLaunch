import type { Address, Hash, Hex } from "viem";
import { db } from "@o1bot/db";
import { e18ToDecimalString } from "@o1bot/market";
import { logger } from "@o1bot/shared";

export type PoolRecord = {
  token: Address;
  poolId: Hex;
  chainId: number;
  factory: Address;
  hook: Address;
  quoteAddress: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  tokenIsCurrency0: boolean;
  tickSpacing: number;
  creatorWallet: Address;
  launchSupply: bigint;
  launchBlock: bigint;
  launchTxHash: Hash;
  launchedAt: Date;
  name: string;
  symbol: string;
  imageUri: string | null;
  metadataUri: string | null;
  source: "BOT" | "DEV";
  launchId: string | null;
};

export type SwapRecord = {
  id: string;
  token: Address;
  poolId: Hex;
  blockNumber: bigint;
  txHash: Hash;
  logIndex: number;
  timestamp: Date;
  trader: Address;
  side: "BUY" | "SELL";
  amountToken: bigint;
  amountQuote: bigint;
  priceQuoteE18: bigint;
  sqrtPriceX96: bigint;
  referrer: Address | null;
  feeQuote: bigint | null;
  comment: string | null;
};

export type BotLaunch = {
  launchId: string;
  token: Address;
  launchTxHash: Hash;
  name: string;
  symbol: string;
  imageUri: string | null;
  metadataUri: string | null;
};

export interface Store {
  getCursor(id: string): Promise<bigint | null>;
  listPools(): Promise<PoolRecord[]>;
  upsertPool(pool: PoolRecord): Promise<void>;
  /** Launches the bot confirmed on chain; the only non-DEV source of tracked tokens. */
  botLaunches(): Promise<BotLaunch[]>;
  /** Persist swaps and advance the cursor atomically (idempotent on swap id). */
  commit(swaps: SwapRecord[], cursorId: string, cursor: bigint): Promise<number>;
}

const CONFIRMED_STATUSES = ["CONFIRMED", "FEE_RECIPIENT_PENDING", "REPLIED"] as const;

export class PrismaStore implements Store {
  async getCursor(id: string): Promise<bigint | null> {
    const row = await db().indexerCursor.findUnique({ where: { id } });
    return row ? BigInt(row.blockNumber.toString()) : null;
  }

  async listPools(): Promise<PoolRecord[]> {
    const rows = await db().pool.findMany();
    return rows.map((r) => ({
      token: r.token as Address,
      poolId: r.poolId as Hex,
      chainId: r.chainId,
      factory: r.factory as Address,
      hook: r.hook as Address,
      quoteAddress: r.quoteAddress as Address,
      quoteSymbol: r.quoteSymbol,
      quoteDecimals: r.quoteDecimals,
      tokenIsCurrency0: r.tokenIsCurrency0,
      tickSpacing: r.tickSpacing,
      creatorWallet: r.creatorWallet as Address,
      launchSupply: BigInt(r.launchSupply.toFixed(0)),
      launchBlock: BigInt(r.launchBlock.toString()),
      launchTxHash: r.launchTxHash as Hash,
      launchedAt: r.launchedAt,
      name: r.name,
      symbol: r.symbol,
      imageUri: r.imageUri,
      metadataUri: r.metadataUri,
      source: r.source,
      launchId: r.launchId,
    }));
  }

  async upsertPool(p: PoolRecord): Promise<void> {
    const data = {
      poolId: p.poolId,
      chainId: p.chainId,
      factory: p.factory,
      hook: p.hook,
      quoteAddress: p.quoteAddress,
      quoteSymbol: p.quoteSymbol,
      quoteDecimals: p.quoteDecimals,
      tokenIsCurrency0: p.tokenIsCurrency0,
      tickSpacing: p.tickSpacing,
      creatorWallet: p.creatorWallet,
      launchSupply: p.launchSupply.toString(),
      launchBlock: p.launchBlock,
      launchTxHash: p.launchTxHash,
      launchedAt: p.launchedAt,
      name: p.name,
      symbol: p.symbol,
      imageUri: p.imageUri,
      metadataUri: p.metadataUri,
      source: p.source,
      launchId: p.launchId,
    };
    await db().pool.upsert({ where: { token: p.token }, create: { token: p.token, ...data }, update: data });
  }

  async botLaunches(): Promise<BotLaunch[]> {
    const rows = await db().launch.findMany({
      where: { status: { in: [...CONFIRMED_STATUSES] }, tokenAddress: { not: null }, launchTxHash: { not: null } },
      select: { id: true, tokenAddress: true, launchTxHash: true, name: true, ticker: true, imageUri: true, metadataUri: true },
    });
    return rows.map((r) => ({
      launchId: r.id,
      token: r.tokenAddress as Address,
      launchTxHash: r.launchTxHash as Hash,
      name: r.name,
      symbol: r.ticker,
      imageUri: r.imageUri,
      metadataUri: r.metadataUri,
    }));
  }

  async commit(swaps: SwapRecord[], cursorId: string, cursor: bigint): Promise<number> {
    const data = swaps.map((s) => ({
      id: s.id,
      token: s.token,
      poolId: s.poolId,
      blockNumber: s.blockNumber,
      txHash: s.txHash,
      logIndex: s.logIndex,
      timestamp: s.timestamp,
      trader: s.trader,
      side: s.side,
      amountToken: s.amountToken.toString(),
      amountQuote: s.amountQuote.toString(),
      priceQuote: e18ToDecimalString(s.priceQuoteE18),
      sqrtPriceX96: s.sqrtPriceX96.toString(),
      referrer: s.referrer,
      feeQuote: s.feeQuote === null ? null : s.feeQuote.toString(),
      comment: s.comment,
    }));
    const [created] = await db().$transaction([
      db().swap.createMany({ data, skipDuplicates: true }),
      db().indexerCursor.upsert({ where: { id: cursorId }, create: { id: cursorId, blockNumber: cursor }, update: { blockNumber: cursor } }),
    ]);
    return created.count;
  }
}

/** In-memory store for `--dry` runs: nothing is persisted, everything is logged. */
export class MemoryStore implements Store {
  pools = new Map<Address, PoolRecord>();
  swaps: SwapRecord[] = [];
  cursors = new Map<string, bigint>();

  async getCursor(id: string): Promise<bigint | null> {
    return this.cursors.get(id) ?? null;
  }
  async listPools(): Promise<PoolRecord[]> {
    return [...this.pools.values()];
  }
  async upsertPool(p: PoolRecord): Promise<void> {
    this.pools.set(p.token, p);
  }
  async botLaunches(): Promise<BotLaunch[]> {
    return [];
  }
  async commit(swaps: SwapRecord[], cursorId: string, cursor: bigint): Promise<number> {
    const seen = new Set(this.swaps.map((s) => s.id));
    const fresh = swaps.filter((s) => !seen.has(s.id));
    this.swaps.push(...fresh);
    this.cursors.set(cursorId, cursor);
    if (fresh.length) logger.info({ inserted: fresh.length, cursor: cursor.toString() }, "dry commit");
    return fresh.length;
  }
}
