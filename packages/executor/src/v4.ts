import { encodeAbiParameters, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";

/** Uniswap V4 pool identity helpers plus the read ABIs route discovery needs. */

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** Sorted pool key; native ETH is the zero address and therefore always currency0. */
export function poolKeyFor(a: Address, b: Address, fee: number, tickSpacing: number, hooks: Address = zeroAddress): PoolKey {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

/** PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * Hook-free V4 pools are permissionless, and on Robinhood Chain LPs have put
 * USDG/stock liquidity behind wildly different (fee, tickSpacing) pairs: a
 * StateView survey on 2026-09-07 (`scripts/survey-v4-tiers.ts`) found 30
 * distinct tiers, from 500/5 up to 100000/1000, with the 5% tier 50000/500
 * alone covering 137 of 194 stocks. A fixed list therefore misses pools, so
 * discovery probes this whole grid (one multicall per base asset) and lets
 * simulation rank whatever has liquidity.
 */
export const V4_FEES: readonly number[] = [100, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000];
export const V4_TICK_SPACINGS: readonly number[] = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 100, 200, 250, 300, 400, 500, 1000];
export const V4_FEE_TIERS: ReadonlyArray<readonly [fee: number, tickSpacing: number]> = V4_FEES.flatMap((fee) => V4_TICK_SPACINGS.map((tickSpacing) => [fee, tickSpacing] as const));

/** SwapX (Uniswap V3 fork) fee tiers. */
export const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

export const stateViewAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

export const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);

export const v3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
