import { encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";

/**
 * Route data for the atomic dev buy (`createLaunchAndBuy`). The launch-buy
 * adapter is NOT source-verified on any explorer, so this layout was
 * reverse-engineered from live `createLaunchAndBuy` calldata and is checked
 * byte-for-byte against those transactions in test/route.test.ts:
 *
 *   abi.encode(Step[])  with
 *   Step = (uint8 kind, address tokenIn, address tokenOut, address pool,
 *           uint24 fee, int24 tickSpacing, address hooks, bytes hookData)
 *
 *   kind 1 = Uniswap V3 pool (SwapX): pool address set, hooks zero
 *   kind 2 = Uniswap V4 pool: pool zero; fee/tickSpacing/hooks form the key
 *
 * Funding is always native ETH. A V3 first hop takes WETH as tokenIn (the
 * adapter wraps); a V4 first hop takes the zero address (native currency).
 * The last hop is always the new launch pool (fee 0, o1 hook).
 */

export const ROUTE_KIND = { V3: 1, V4: 2 } as const;
export const MAX_ROUTE_DATA_BYTES = 4096;

export const ROUTE_STEPS_ABI = [
  {
    type: "tuple[]",
    name: "steps",
    components: [
      { name: "kind", type: "uint8" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "pool", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

export type RouteStep = {
  kind: 1 | 2;
  tokenIn: Address;
  tokenOut: Address;
  pool: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: Hex;
};

export function v3PoolStep(tokenIn: Address, tokenOut: Address, pool: Address, fee: number): RouteStep {
  return { kind: ROUTE_KIND.V3, tokenIn, tokenOut, pool, fee, tickSpacing: 0, hooks: zeroAddress, hookData: "0x" };
}

export function v4PoolStep(tokenIn: Address, tokenOut: Address, fee: number, tickSpacing: number, hooks: Address = zeroAddress): RouteStep {
  return { kind: ROUTE_KIND.V4, tokenIn, tokenOut, pool: zeroAddress, fee, tickSpacing, hooks, hookData: "0x" };
}

/** Final hop: paired asset → the token being launched, through o1's pool (LP fee 0, o1 hook). */
export function launchPoolStep(input: { quote: Address; token: Address; hook: Address; tickSpacing: number }): RouteStep {
  return v4PoolStep(input.quote, input.token, 0, input.tickSpacing, input.hook);
}

export function encodeRoute(steps: RouteStep[]): Hex {
  const data = encodeAbiParameters(ROUTE_STEPS_ABI, [steps]);
  const bytes = (data.length - 2) / 2;
  if (bytes > MAX_ROUTE_DATA_BYTES) throw new Error(`route data is ${bytes} bytes; o1 caps it at ${MAX_ROUTE_DATA_BYTES}`);
  return data;
}

/** Prefix hops (ETH → paired asset) followed by the launch-pool hop. */
export function buildLaunchRoute(prefix: RouteStep[], launch: RouteStep): Hex {
  return encodeRoute([...prefix, launch]);
}

/** Native ETH straight into the new launch pool (ETH-paired launches: no prefix). */
export function nativeToLaunchPoolRoute(input: { token: Address; hook: Address; tickSpacing: number }): Hex {
  return buildLaunchRoute([], launchPoolStep({ quote: zeroAddress, ...input }));
}
