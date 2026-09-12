import "@o1bot/shared/load-env";
import { fileURLToPath } from "node:url";
import { formatUnits, type Hex } from "viem";
import { dbConfigured } from "@o1bot/db";
import { e18ToDecimalString } from "@o1bot/market";
import { activeHook, env, INDEXED_CHAIN_KEYS, logger, logsClient, o1Chain, type ChainKey } from "@o1bot/shared";
import { DEFAULT_SCAN, scanAdaptive, type ScanConfig, type ScanProgress } from "./scanner";
import { MemoryStore, PrismaStore, type PoolRecord, type Store, type SwapRecord } from "./store";
import { ensurePools, trackedTokens } from "./tracked";

/**
 * o1bot indexer: follows the launch pools of tokens created through the bot
 * (plus INDEXER_DEV_TOKENS for local testing), records every swap with
 * price, side, trader, referrer and fee, and keeps a crash-safe cursor.
 *
 *   pnpm --filter @o1bot/indexer start          # long-running, needs DATABASE_URL
 *   pnpm --filter @o1bot/indexer dry            # no database: scan, print, exit
 *   ... start --once                            # catch up to the tip, then exit
 */

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // environment only
}

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry");
const ONCE = args.has("--once") || DRY;
/** Robinhood keeps the original cursor id; every other chain gets its own. */
const cursorIdFor = (key: ChainKey) => (key === "robinhood" ? "swaps" : `swaps:${key}`);
/** Blocks re-scanned on every loop to absorb short reorgs (inserts are idempotent). */
const ROLLBACK_BLOCKS = 50n;
/** Stay this many blocks behind the tip. */
const CONFIRMATIONS = 1n;

function printSwaps(store: MemoryStore) {
  const pools = new Map(store.swaps.length ? [...store.pools.values()].map((p) => [p.token, p] as const) : []);
  console.log(`\n${store.swaps.length} swaps across ${store.pools.size} pools`);
  for (const p of store.pools.values()) {
    const rows = store.swaps.filter((s) => s.token === p.token);
    const last = rows[rows.length - 1];
    console.log(`\n${p.symbol} (${p.name}) pair ${p.quoteSymbol} · token is currency${p.tokenIsCurrency0 ? "0" : "1"} · ${rows.length} swaps · last price ${last ? e18ToDecimalString(last.priceQuoteE18, 12) : "-"} ${p.quoteSymbol}/token`);
    for (const s of rows.slice(0, 5)) line(s, pools.get(s.token)!);
    if (rows.length > 5) console.log("   …");
  }
}

function line(s: SwapRecord, p: PoolRecord) {
  console.log(
    `   ${s.timestamp.toISOString()} ${s.side.padEnd(4)} ${formatUnits(s.amountQuote, p.quoteDecimals).slice(0, 12).padStart(12)} ${p.quoteSymbol.padEnd(5)} ↔ ${formatUnits(s.amountToken, 18).slice(0, 16).padStart(16)} ${p.symbol} @ ${e18ToDecimalString(s.priceQuoteE18, 12)} by ${s.trader.slice(0, 10)}…${s.referrer ? " ref " + s.referrer.slice(0, 8) : ""}${s.comment ? ` "${s.comment}"` : ""}`,
  );
}

async function loop(key: ChainKey, store: Store, cfg: ScanConfig, progress: ScanProgress) {
  const client = logsClient(key);
  const pools = await ensurePools(client, store, await trackedTokens(store, key), key);
  if (pools.length === 0) {
    logger.info({ chain: key }, "no tracked tokens yet (no confirmed bot launches, INDEXER_DEV_TOKENS empty)");
    return;
  }
  const byPoolId = new Map<Hex, PoolRecord>(pools.map((p) => [p.poolId, p]));
  const tip = (await client.getBlockNumber()) - CONFIRMATIONS;
  // INDEXER_START_BLOCK / INDEXER_END_BLOCK are Robinhood block numbers.
  const endEnv = key === "robinhood" ? env().INDEXER_END_BLOCK : undefined;
  const head = endEnv !== undefined && BigInt(endEnv) < tip ? BigInt(endEnv) : tip;
  const earliest = pools.reduce((m, p) => (p.launchBlock < m ? p.launchBlock : m), pools[0]!.launchBlock);
  const startEnv = key === "robinhood" && env().INDEXER_START_BLOCK !== undefined ? BigInt(env().INDEXER_START_BLOCK!) : null;
  const cursorId = cursorIdFor(key);
  const cursor = await store.getCursor(cursorId);

  // Pools that launched before the cursor were added later: backfill them alone first.
  if (cursor !== null) {
    for (const p of pools) {
      if (p.launchBlock < cursor && (await store.getCursor(`pool:${p.token}`)) === null) {
        logger.info({ token: p.token, from: p.launchBlock.toString(), to: cursor.toString() }, "backfilling new pool");
        const only = new Map<Hex, PoolRecord>([[p.poolId, p]]);
        await scanAdaptive(client, cfg, only, p.launchBlock, cursor, async (swaps, upTo) => void (await store.commit(swaps, `pool:${p.token}`, upTo)), progress);
      }
    }
  }

  let from = cursor !== null ? cursor - ROLLBACK_BLOCKS : (startEnv ?? earliest);
  if (from < earliest) from = earliest;
  if (from > head) return;
  const before = progress.swaps;
  await scanAdaptive(client, cfg, byPoolId, from, head, async (swaps, upTo) => void (await store.commit(swaps, cursorId, upTo)), progress);
  logger.info({ chain: key, from: from.toString(), to: head.toString(), swaps: progress.swaps - before, ranges: progress.ranges, errors: progress.errors, range: progress.range.toString() }, "scan complete");
}

async function main() {
  const store: Store = DRY || !dbConfigured() ? new MemoryStore() : new PrismaStore();
  if (!DRY && !dbConfigured()) logger.warn("DATABASE_URL not set: running in memory, nothing will be persisted");
  const chains = INDEXED_CHAIN_KEYS.map((key) => {
    const cfg: ScanConfig = { ...DEFAULT_SCAN, poolManager: o1Chain(key).uniswapV4.poolManager, hook: activeHook(key) };
    const progress: ScanProgress = { range: cfg.rangeInit, ranges: 0, errors: 0, swaps: 0 };
    return { key, cfg, progress };
  });
  logger.info({ dry: DRY, once: ONCE, chains: chains.map((c) => ({ chain: c.key, poolManager: c.cfg.poolManager, hook: c.cfg.hook })) }, "indexer starting");

  for (;;) {
    for (const c of chains) {
      try {
        await loop(c.key, store, c.cfg, c.progress);
      } catch (err) {
        logger.error({ chain: c.key, err: err instanceof Error ? err.message : String(err) }, "loop failed");
        if (ONCE) throw err;
      }
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, env().INDEXER_POLL_MS));
  }
  if (store instanceof MemoryStore) printSwaps(store);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "indexer crashed");
  process.exit(1);
});
