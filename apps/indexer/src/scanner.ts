import { getAddress, hexToString, parseAbiItem, zeroAddress, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { classifySwap, priceQuotePerTokenE18 } from "@o1bot/market";
import { logger } from "@o1bot/shared";
import { blockTimestamps, txSenders } from "./rpc";
import type { PoolRecord, SwapRecord } from "./store";

/**
 * Incremental eth_getLogs scanner for tracked launch pools.
 *
 * Two topic-filtered queries per range: the v4 PoolManager `Swap` event
 * (singleton contract, so the poolId list IS the filter) and the o1 hook
 * `Trade` event for referrer, fee and comment. Trades are joined to swaps by
 * transaction: the hook emits Trade from afterSwap, so it is the next Trade
 * log for the same pool after the Swap log in that transaction.
 *
 * Range sizing is adaptive: halve on RPC error, grow back on success. Every
 * batch is committed with its cursor, so a crash resumes without gaps, and
 * swap ids (txHash-logIndex) make re-scans idempotent.
 */

export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
export const tradeEvent = parseAbiItem(
  "event Trade(bytes32 indexed poolId, address indexed executor, address indexed referrer, address feeCurrency, uint256 totalFeeAmount, bytes32 comment)",
);

export type ScanConfig = {
  poolManager: Address;
  hook: Address;
  rangeInit: bigint;
  rangeMin: bigint;
  rangeMax: bigint;
};

export const DEFAULT_SCAN: Omit<ScanConfig, "poolManager" | "hook"> = { rangeInit: 10_000n, rangeMin: 200n, rangeMax: 50_000n };

function commentText(raw: Hex): string | null {
  if (!raw || /^0x0*$/.test(raw)) return null;
  try {
    const s = hexToString(raw, { size: 32 }).replace(/\0+$/, "").trim();
    return s.length ? s : null;
  } catch {
    return null;
  }
}

export async function scanRange(client: PublicClient, cfg: ScanConfig, pools: Map<Hex, PoolRecord>, fromBlock: bigint, toBlock: bigint): Promise<SwapRecord[]> {
  const poolIds = [...pools.keys()];
  if (poolIds.length === 0) return [];
  const [swaps, trades] = await Promise.all([
    client.getLogs({ address: cfg.poolManager, event: swapEvent, args: { id: poolIds }, fromBlock, toBlock, strict: true }),
    client.getLogs({ address: cfg.hook, event: tradeEvent, args: { poolId: poolIds }, fromBlock, toBlock, strict: true }),
  ]);
  if (swaps.length === 0) return [];

  const tradesByTx = new Map<Hash, typeof trades>();
  for (const t of trades) {
    const list = tradesByTx.get(t.transactionHash) ?? [];
    list.push(t);
    tradesByTx.set(t.transactionHash, list);
  }
  const consumed = new Set<string>();

  const [stamps, senders] = await Promise.all([
    blockTimestamps(client, swaps.map((s) => s.blockNumber)),
    txSenders(client, swaps.map((s) => s.transactionHash)),
  ]);

  const out: SwapRecord[] = [];
  for (const log of swaps) {
    const pool = pools.get(log.args.id);
    if (!pool) continue;
    const { side, amountToken, amountQuote } = classifySwap({ amount0: log.args.amount0, amount1: log.args.amount1, tokenIsCurrency0: pool.tokenIsCurrency0 });
    const priceQuoteE18 = priceQuotePerTokenE18(log.args.sqrtPriceX96, pool.tokenIsCurrency0, pool.quoteDecimals);

    const trade = (tradesByTx.get(log.transactionHash) ?? [])
      .filter((t) => t.args.poolId === log.args.id && t.logIndex > log.logIndex && !consumed.has(`${t.transactionHash}-${t.logIndex}`))
      .sort((a, b) => a.logIndex - b.logIndex)[0];
    if (trade) consumed.add(`${trade.transactionHash}-${trade.logIndex}`);

    out.push({
      id: `${log.transactionHash}-${log.logIndex}`,
      token: pool.token,
      poolId: log.args.id,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      timestamp: new Date((stamps.get(log.blockNumber) ?? 0) * 1000),
      trader: senders.get(log.transactionHash) ?? getAddress(log.args.sender),
      side,
      amountToken,
      amountQuote,
      priceQuoteE18,
      sqrtPriceX96: log.args.sqrtPriceX96,
      referrer: trade && getAddress(trade.args.referrer) !== zeroAddress ? getAddress(trade.args.referrer) : null,
      feeQuote: trade ? trade.args.totalFeeAmount : null,
      comment: trade ? commentText(trade.args.comment) : null,
    });
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

export type ScanProgress = { range: bigint; ranges: number; errors: number; swaps: number };

/** Scan [from, to] in adaptive ranges, handing each batch (and its cursor) to `onBatch`. */
export async function scanAdaptive(
  client: PublicClient,
  cfg: ScanConfig,
  pools: Map<Hex, PoolRecord>,
  from: bigint,
  to: bigint,
  onBatch: (swaps: SwapRecord[], upTo: bigint) => Promise<void>,
  progress: ScanProgress,
): Promise<void> {
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + progress.range - 1n > to ? to : cursor + progress.range - 1n;
    try {
      const swaps = await scanRange(client, cfg, pools, cursor, end);
      await onBatch(swaps, end);
      progress.ranges++;
      progress.swaps += swaps.length;
      cursor = end + 1n;
      if (progress.range < cfg.rangeMax) progress.range = (progress.range * 3n) / 2n > cfg.rangeMax ? cfg.rangeMax : (progress.range * 3n) / 2n;
    } catch (err) {
      progress.errors++;
      if (progress.range <= cfg.rangeMin) throw err;
      progress.range = progress.range / 2n < cfg.rangeMin ? cfg.rangeMin : progress.range / 2n;
      logger.warn({ from: cursor.toString(), to: end.toString(), range: progress.range.toString(), err: err instanceof Error ? err.message.slice(0, 160) : String(err) }, "range failed; shrinking");
    }
  }
}
