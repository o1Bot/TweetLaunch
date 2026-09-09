import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { poolIdOf, poolKeyFor, stateViewAbi, v3FactoryAbi, v3PoolAbi, V3_FEE_TIERS, V4_FEE_TIERS } from "./v4";
import { e18ToNumber, priceQuotePerTokenE18, tokenIsCurrency0 } from "@o1bot/market";
import { findQuote, o1Chain, publicClient } from "@o1bot/shared";

/**
 * USD price of a paired asset, read from Robinhood Chain pools:
 *   ETH   → SwapX V3 WETH/USDG pool
 *   USDG  → 1
 *   stock → best SwapX V3 or hook-free V4 USDG/stock pool with liquidity
 * USDG is treated as one dollar. Cached for 60 seconds per asset.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: number | null }>();

const v3Slot0Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

function addresses() {
  const chain = o1Chain("robinhood");
  const weth = chain.swapX.wrappedNativeToken;
  const v3Factory = chain.swapX.factoryV3;
  const usdg = findQuote("robinhood", "USDG")?.address;
  if (typeof weth !== "string" || typeof v3Factory !== "string" || !usdg) throw new Error("config/o1.json is missing swapX or USDG entries");
  return { weth: getAddress(weth), v3Factory: getAddress(v3Factory), usdg, stateView: chain.uniswapV4.stateView };
}

/** USDG per one unit of `asset` (18 decimals assumed for stocks and WETH). */
async function usdgPerAsset(asset: Address, assetDecimals: number): Promise<number | null> {
  const client = publicClient("robinhood");
  const { v3Factory, usdg, stateView } = addresses();
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
      return e18ToNumber(priceQuotePerTokenE18(slot0[0], isC0, 6, assetDecimals));
    }
  }

  // Hook-free V4 pools.
  for (const [fee, spacing] of V4_FEE_TIERS) {
    const id = poolIdOf(poolKeyFor(asset, usdg, fee, spacing));
    try {
      const liquidity = await client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] });
      if (liquidity === 0n) continue;
      const slot0 = await client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] });
      return e18ToNumber(priceQuotePerTokenE18(slot0[0], isC0, 6, assetDecimals));
    } catch {
      // try the next tier
    }
  }
  return null;
}

export async function quoteUsd(quoteAddress: string, quoteDecimals: number): Promise<number | null> {
  const key = quoteAddress.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: number | null = null;
  try {
    const { weth, usdg } = addresses();
    const addr = getAddress(quoteAddress);
    if (addr === usdg) value = 1;
    else if (addr === zeroAddress) value = await usdgPerAsset(weth, 18);
    else value = await usdgPerAsset(addr, quoteDecimals);
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
