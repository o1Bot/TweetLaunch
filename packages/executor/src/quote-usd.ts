import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { poolIdOf, poolKeyFor, stateViewAbi, v3FactoryAbi, v3PoolAbi, V3_FEE_TIERS, V4_FEE_TIERS } from "./v4";
import { e18ToNumber, priceQuotePerTokenE18, tokenIsCurrency0 } from "@o1bot/market";
import { DEFAULT_CHAIN_KEY, findQuote, o1Chain, publicClient, type ChainKey } from "@o1bot/shared";

/**
 * USD price of a paired asset, read from that chain's pools:
 *   ETH    → V3 WETH/stable pool (SwapX on Robinhood, Uniswap V3 on Base)
 *   stable → 1 (USDG on Robinhood, USDC on Base)
 *   other  → best V3 or hook-free V4 stable/asset pool with liquidity
 * Cached for 60 seconds per chain and asset.
 */

const STABLE: Record<ChainKey, string> = { robinhood: "USDG", base: "USDC" };

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: number | null }>();

const v3Slot0Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

function addresses(key: ChainKey) {
  const chain = o1Chain(key);
  const weth = chain.swapX.wrappedNativeToken;
  const v3Factory = chain.swapX.factoryV3;
  const stable = findQuote(key, STABLE[key]);
  if (typeof weth !== "string" || typeof v3Factory !== "string" || !stable) throw new Error(`config/o1.json is missing swapX or ${STABLE[key]} entries for ${key}`);
  return { weth: getAddress(weth), v3Factory: getAddress(v3Factory), usdg: stable.address, stableDecimals: stable.decimals, stateView: chain.uniswapV4.stateView };
}

/** Dollars (the chain's stable) per one unit of `asset`. */
async function usdgPerAsset(asset: Address, assetDecimals: number, key: ChainKey): Promise<number | null> {
  const client = publicClient(key);
  const { v3Factory, usdg, stableDecimals, stateView } = addresses(key);
  const isC0 = tokenIsCurrency0(asset, usdg);

  // SwapX V3 pools first: pick the tier with the most in-range liquidity.
  const pools = await client.multicall({
    allowFailure: true,
    contracts: V3_FEE_TIERS.map((fee) => ({ address: v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [asset, usdg, fee] }) as const),
  });
  const candidates = pools.filter((p) => p.status === "success" && p.result !== zeroAddress).map((p) => p.result as Address);
  if (candidates.length > 0) {
    const liq = await client.multicall({ allowFailure: true, contracts: candidates.map((a) => ({ address: a, abi: v3PoolAbi, functionName: "liquidity" }) as const) });
    let bestPool: Address | null = null;
    let bestLiquidity = 0n;
    for (let i = 0; i < liq.length; i++) {
      const r = liq[i];
      if (r && r.status === "success" && r.result > bestLiquidity) {
        bestLiquidity = r.result;
        bestPool = candidates[i] as Address;
      }
    }
    if (bestPool) {
      const slot0 = await client.readContract({ address: bestPool, abi: v3Slot0Abi, functionName: "slot0" });
      return e18ToNumber(priceQuotePerTokenE18(slot0[0], isC0, stableDecimals, assetDecimals));
    }
  }

  // Hook-free V4 pools.
  for (const [fee, spacing] of V4_FEE_TIERS) {
    const id = poolIdOf(poolKeyFor(asset, usdg, fee, spacing));
    try {
      const liquidity = await client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] });
      if (liquidity === 0n) continue;
      const slot0 = await client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] });
      return e18ToNumber(priceQuotePerTokenE18(slot0[0], isC0, stableDecimals, assetDecimals));
    } catch {
      // try the next tier
    }
  }
  return null;
}

export async function quoteUsd(quoteAddress: string, quoteDecimals: number, chain: ChainKey = DEFAULT_CHAIN_KEY): Promise<number | null> {
  const key = `${chain}:${quoteAddress.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: number | null = null;
  try {
    const { weth, usdg } = addresses(chain);
    const addr = getAddress(quoteAddress);
    if (addr === usdg) value = 1;
    else if (addr === zeroAddress) value = await usdgPerAsset(weth, 18, chain);
    else value = await usdgPerAsset(addr, quoteDecimals, chain);
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
