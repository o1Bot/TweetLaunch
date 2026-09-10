import { erc20Abi, getAddress, isAddress, parseAbi, parseEventLogs, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { launchFactoryAbi } from "@o1bot/executor";
import { tokenIsCurrency0 } from "@o1bot/market";
import { type ChainKey, activeFactory, activeHook, activeSuite, chainByKey, env, findQuote, logger, o1Chain } from "@o1bot/shared";
import type { BotLaunch, PoolRecord, Store } from "./store";

/**
 * Which tokens the indexer follows. Exactly two sources:
 *   BOT  launches the bot confirmed on chain (rows in the Launch table)
 *   DEV  addresses in INDEXER_DEV_TOKENS, for local testing only
 * Nothing else is ever inserted into Pool, so the UI only shows o1bot launches.
 */

export type TrackedToken = { token: Address; source: "BOT" | "DEV"; launch: BotLaunch | null; launchTxHash: Hash | null };

/**
 * INDEXER_DEV_TOKENS entries are `0xtoken` or `0xtoken@0xlaunchTxHash`. With
 * the tx hash the launch is resolved from one receipt; without it the factory
 * logs are scanned backwards, which is slow on public RPCs.
 */
export function devTokensFromEnv(): Array<{ token: Address; launchTxHash: Hash | null }> {
  const raw = env().INDEXER_DEV_TOKENS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const [addr, tx] = entry.split("@");
      if (!addr || !isAddress(addr, { strict: false })) throw new Error(`INDEXER_DEV_TOKENS: not an address: ${entry}`);
      if (tx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error(`INDEXER_DEV_TOKENS: not a tx hash: ${entry}`);
      return { token: getAddress(addr.toLowerCase()), launchTxHash: (tx as Hash | undefined) ?? null };
    });
}

export async function trackedTokens(store: Store, key: ChainKey = "robinhood"): Promise<TrackedToken[]> {
  const chainId = chainByKey(key).id;
  const out = new Map<Address, TrackedToken>();
  for (const l of await store.botLaunches()) {
    if (l.chainId !== chainId) continue;
    out.set(getAddress(l.token), { token: getAddress(l.token), source: "BOT", launch: l, launchTxHash: l.launchTxHash });
  }
  // INDEXER_DEV_TOKENS are Robinhood addresses (local testing).
  if (key === "robinhood") for (const d of devTokensFromEnv()) if (!out.has(d.token)) out.set(d.token, { token: d.token, source: "DEV", launch: null, launchTxHash: d.launchTxHash });
  return [...out.values()];
}

const contractUriAbi = parseAbi(["function contractURI() view returns (string)"]);

type LaunchedArgs = { token: Address; poolId: `0x${string}`; originalCreator: Address; quoteToken: Address; launchSupply: bigint; tickSpacing: number };

async function launchedFromReceipt(client: PublicClient, factory: Address, txHash: Hash, token: Address) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const logs = parseEventLogs({ abi: launchFactoryAbi, eventName: "Launched", logs: receipt.logs });
  const log = logs.find((l) => getAddress(l.address) === factory && getAddress(l.args.token) === token);
  if (!log) throw new Error(`no Launched event for ${token} in ${txHash}`);
  return { args: log.args as LaunchedArgs, blockNumber: receipt.blockNumber, txHash };
}

/** DEV tokens have no launch tx on file: walk factory logs backwards until the Launched event turns up. */
async function launchedByScan(client: PublicClient, factory: Address, token: Address, firstBlock: bigint) {
  const head = await client.getBlockNumber();
  let range = 50_000n;
  let to = head;
  while (to >= firstBlock) {
    const from = to - range + 1n > firstBlock ? to - range + 1n : firstBlock;
    try {
      const logs = await client.getContractEvents({ address: factory, abi: launchFactoryAbi, eventName: "Launched", args: { token }, fromBlock: from, toBlock: to });
      if (logs.length > 0) {
        const log = logs[logs.length - 1]!;
        return { args: log.args as LaunchedArgs, blockNumber: log.blockNumber, txHash: log.transactionHash };
      }
      to = from - 1n;
      if (range < 200_000n) range = (range * 3n) / 2n;
    } catch (err) {
      if (range <= 1_000n) throw err;
      range /= 2n;
    }
  }
  throw new Error(`no Launched event found for ${token} since block ${firstBlock}`);
}

async function tokenMetadata(client: PublicClient, token: Address, known: BotLaunch | null) {
  const [name, symbol] = await Promise.all([
    known?.name ?? client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    known?.symbol ?? client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
  ]);
  let metadataUri = known?.metadataUri ?? null;
  if (!metadataUri) {
    try {
      metadataUri = await client.readContract({ address: token, abi: contractUriAbi, functionName: "contractURI" });
    } catch {
      metadataUri = null;
    }
  }
  let imageUri = known?.imageUri ?? null;
  if (!imageUri && metadataUri) imageUri = await imageFromMetadata(metadataUri);
  return { name, symbol, metadataUri, imageUri };
}

export function ipfsToHttp(uri: string): string {
  return uri.startsWith("ipfs://") ? `${env().IPFS_GATEWAY.replace(/\/$/, "")}/${uri.slice("ipfs://".length)}` : uri;
}

async function imageFromMetadata(uri: string): Promise<string | null> {
  try {
    const res = await fetch(ipfsToHttp(uri), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { image?: unknown };
    return typeof json.image === "string" ? json.image : null;
  } catch {
    return null;
  }
}

async function quoteInfo(client: PublicClient, quote: Address, key: ChainKey): Promise<{ symbol: string; decimals: number }> {
  if (quote === zeroAddress) return { symbol: "ETH", decimals: 18 };
  const known = findQuote(key, quote);
  if (known) return { symbol: known.symbol, decimals: known.decimals };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: quote, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/** Make sure every tracked token has a Pool row; returns the full current pool set. */
export async function ensurePools(client: PublicClient, store: Store, tracked: TrackedToken[], key: ChainKey = "robinhood"): Promise<PoolRecord[]> {
  const existing = new Map((await store.listPools(chainByKey(key).id)).map((p) => [p.token, p] as const));
  const factory = activeFactory(key);
  const hook = activeHook(key);
  const chain = o1Chain(key);
  const firstBlock = BigInt(activeSuite(key).firstBlock);

  for (const t of tracked) {
    if (existing.has(t.token)) continue;
    try {
      const launched = t.launchTxHash ? await launchedFromReceipt(client, factory, t.launchTxHash, t.token) : await launchedByScan(client, factory, t.token, firstBlock);
      const [meta, quote, block] = await Promise.all([tokenMetadata(client, t.token, t.launch), quoteInfo(client, getAddress(launched.args.quoteToken), key), client.getBlock({ blockNumber: launched.blockNumber })]);
      const pool: PoolRecord = {
        token: t.token,
        poolId: launched.args.poolId,
        chainId: chain.chainId,
        factory,
        hook,
        quoteAddress: getAddress(launched.args.quoteToken),
        quoteSymbol: quote.symbol,
        quoteDecimals: quote.decimals,
        tokenIsCurrency0: tokenIsCurrency0(t.token, getAddress(launched.args.quoteToken)),
        tickSpacing: launched.args.tickSpacing,
        creatorWallet: getAddress(launched.args.originalCreator),
        launchSupply: launched.args.launchSupply,
        launchBlock: launched.blockNumber,
        launchTxHash: launched.txHash,
        launchedAt: new Date(Number(block.timestamp) * 1000),
        name: meta.name,
        symbol: meta.symbol,
        imageUri: meta.imageUri,
        metadataUri: meta.metadataUri,
        source: t.source,
        launchId: t.launch?.launchId ?? null,
      };
      await store.upsertPool(pool);
      existing.set(t.token, pool);
      logger.info({ token: t.token, symbol: pool.symbol, pair: pool.quoteSymbol, poolId: pool.poolId, launchBlock: pool.launchBlock.toString(), source: t.source }, "tracking pool");
    } catch (err) {
      logger.error({ token: t.token, err: err instanceof Error ? err.message : String(err) }, "could not resolve launch; will retry");
    }
  }
  return [...existing.values()];
}
