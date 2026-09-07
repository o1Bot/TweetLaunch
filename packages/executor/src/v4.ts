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

/** Fee tiers seen on Robinhood's hook-free external V4 pools (survey 2026-09-07). */
export const V4_FEE_TIERS: ReadonlyArray<readonly [fee: number, tickSpacing: number]> = [
  [100, 1],
  [500, 10],
  [1500, 15],
  [3000, 60],
  [10000, 200],
];

/** SwapX (Uniswap V3 fork) fee tiers. */
export const V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

export const stateViewAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

export const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);

export const v3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
