import { getAddress, isAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { chainDisplayName, DEFAULT_CHAIN_KEY, findQuote, logger, nativeQuoteAddress, o1Chain, type ChainKey, type O1Quote } from "@o1bot/shared";
import { v3PoolStep, v4PoolStep, type RouteStep } from "./route";
import { poolIdOf, poolKeyFor, stateViewAbi, v3FactoryAbi, v3PoolAbi, V3_FEE_TIERS, V4_FEE_TIERS } from "./v4";

/**
 * Bounded route discovery for a native-funded dev buy into a non-ETH pair.
 *
 * Candidates (ETH → paired asset), each later completed with the launch-pool
 * hop and ranked by simulating the whole `createLaunchAndBuy`:
 *
 *   direct   V3 WETH/quote (SwapX, any fee tier with in-range liquidity)
 *   bridge   V3 WETH/USDG → V3 USDG/quote
 *   bridge   V3 WETH/USDG → V4 USDG/quote (hook-free, standard tiers)
 *
 * A V4 hop fed directly with native ETH is refused by the adapter with
 * UnsupportedRoute() (tested 2026-09-07 on NVDA, AAPL and USDG pools), so
 * native/quote V4 pools are not candidates; the adapter only takes native
 * into the launch pool itself. Survey of 2026-09-07: 106 of the 194 Robinhood
 * stock tokens have at least one liquid candidate; the rest have no on-chain
 * liquidity in these tiers and cannot be dev-bought through any router.
 */

export type RouteCandidate = { label: string; steps: RouteStep[]; liquidity: bigint };
export type DiscoveryOptions = { maxCandidates?: number; ttlMs?: number };

const DEFAULT_MAX = 6;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; candidates: RouteCandidate[] }>();

/** The dollar asset a two-hop route bridges through: USDG on Robinhood, USDC on Base and Arc. */
const BRIDGE_STABLE: Record<ChainKey, string> = { robinhood: "USDG", base: "USDC", arc: "USDC" };

function addressesFromConfig(key: ChainKey) {
  const chain = o1Chain(key);
  const weth = chain.swapX.wrappedNativeToken;
  const v3Factory = chain.swapX.factoryV3;
  if (typeof weth !== "string" || !isAddress(weth)) throw new Error(`config/o1.json: ${key} swapX.wrappedNativeToken missing`);
  if (typeof v3Factory !== "string" || !isAddress(v3Factory)) throw new Error(`config/o1.json: ${key} swapX.factoryV3 missing`);
  const stable = findQuote(key, BRIDGE_STABLE[key]);
  return { weth: getAddress(weth), v3Factory: getAddress(v3Factory), stateView: chain.uniswapV4.stateView, usdg: stable?.address ?? null, stableSymbol: BRIDGE_STABLE[key] };
}

type V3Pool = { fee: number; pool: Address; liquidity: bigint };
type V4Pool = { fee: number; tickSpacing: number; liquidity: bigint };

async function v3PoolsWithLiquidity(client: PublicClient, factory: Address, a: Address, b: Address): Promise<V3Pool[]> {
  const pools = await client.multicall({
    allowFailure: true,
    contracts: V3_FEE_TIERS.map((fee) => ({ address: factory, abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee] }) as const),
  });
  const found: Array<{ fee: number; pool: Address }> = [];
  pools.forEach((r, i) => {
    if (r.status === "success" && r.result !== zeroAddress) found.push({ fee: V3_FEE_TIERS[i] as number, pool: r.result });
  });
  if (found.length === 0) return [];
  const liquidity = await client.multicall({
    allowFailure: true,
    contracts: found.map((f) => ({ address: f.pool, abi: v3PoolAbi, functionName: "liquidity" }) as const),
  });
  return found
    .map((f, i) => ({ ...f, liquidity: liquidity[i]?.status === "success" ? (liquidity[i]!.result as bigint) : 0n }))
    .filter((p) => p.liquidity > 0n);
}

async function v4PoolsWithLiquidity(client: PublicClient, stateView: Address, a: Address, b: Address): Promise<V4Pool[]> {
  const liquidity = await client.multicall({
    allowFailure: true,
    contracts: V4_FEE_TIERS.map(([fee, tickSpacing]) => ({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolIdOf(poolKeyFor(a, b, fee, tickSpacing))] }) as const),
  });
  const out: V4Pool[] = [];
  liquidity.forEach((r, i) => {
    const tier = V4_FEE_TIERS[i]!;
    if (r.status === "success" && r.result > 0n) out.push({ fee: tier[0], tickSpacing: tier[1], liquidity: r.result });
  });
  return out;
}

const byLiquidityDesc = (x: { liquidity: bigint }, y: { liquidity: bigint }) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0);

/** Prefix routes (ETH → quote). Empty for ETH itself; empty list = no dev buy possible. */
export async function discoverPrefixRoutes(client: PublicClient, quote: O1Quote, opts: DiscoveryOptions = {}, key: ChainKey = DEFAULT_CHAIN_KEY): Promise<RouteCandidate[]> {
  // A pool quoted in the gas asset needs no prefix hop: native ETH, or on Arc the ERC-20 USDC the adapter
  // turns native USDC into by itself.
  if (quote.address === zeroAddress || quote.address === nativeQuoteAddress(key)) return [{ label: "native", steps: [], liquidity: 2n ** 128n }];
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cacheKey = `${key}:${quote.address}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttl) return cached.candidates;

  const { weth, v3Factory, stateView, usdg, stableSymbol } = addressesFromConfig(key);
  const sym = quote.symbol;
  const out: RouteCandidate[] = [];

  const v3Direct = await v3PoolsWithLiquidity(client, v3Factory, weth, quote.address);
  for (const p of v3Direct) out.push({ label: `v3 WETH/${sym} ${p.fee}`, steps: [v3PoolStep(weth, quote.address, p.pool, p.fee)], liquidity: p.liquidity });

  if (usdg && quote.address !== usdg) {
    const hop1 = (await v3PoolsWithLiquidity(client, v3Factory, weth, usdg)).sort(byLiquidityDesc)[0];
    if (hop1) {
      const first = v3PoolStep(weth, usdg, hop1.pool, hop1.fee);
      const [v3Bridge, v4Bridge] = await Promise.all([v3PoolsWithLiquidity(client, v3Factory, usdg, quote.address), v4PoolsWithLiquidity(client, stateView, usdg, quote.address)]);
      for (const p of v3Bridge) {
        out.push({ label: `v3 WETH/${stableSymbol} ${hop1.fee} → v3 ${stableSymbol}/${sym} ${p.fee}`, steps: [first, v3PoolStep(usdg, quote.address, p.pool, p.fee)], liquidity: p.liquidity });
      }
      for (const p of v4Bridge) {
        out.push({ label: `v3 WETH/${stableSymbol} ${hop1.fee} → v4 ${stableSymbol}/${sym} ${p.fee}`, steps: [first, v4PoolStep(usdg, quote.address, p.fee, p.tickSpacing)], liquidity: p.liquidity });
      }
    }
  }

  const candidates = out.sort(byLiquidityDesc).slice(0, opts.maxCandidates ?? DEFAULT_MAX);
  logger.debug({ chain: chainDisplayName(key), quote: sym, candidates: candidates.map((c) => c.label) }, "dev-buy route candidates");
  cache.set(cacheKey, { at: Date.now(), candidates });
  return candidates;
}

/** Test helper. */
export function clearRouteCache(): void {
  cache.clear();
}
