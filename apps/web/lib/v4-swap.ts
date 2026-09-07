import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, stringToHex, zeroAddress, type Address, type Hex } from "viem";

/**
 * Uniswap v4 swaps through o1's launch pool, encoded for the Universal
 * Router: one V4_SWAP command carrying SWAP_EXACT_IN_SINGLE, SETTLE_ALL and
 * TAKE_ALL. Exact input only: o1's hook rejects exact output during the
 * anti-snipe window, and exact input is what a buy/sell box wants anyway.
 * Hook data carries o1bot's referrer address plus a 32-byte comment, which
 * is how the 0.2% referral share is attributed.
 *
 * Pure encoding, shared by the quote API (server) and the swap panel
 * (browser). Nothing here talks to a chain.
 */

export const CHAIN_ID = 4663;
export const SWAP_COMMENT = "o1bot.exchange";
export const ANTI_SNIPE_SECONDS = 20;

/** Universal Router command and v4 action ids (Uniswap universal-router v2). */
const COMMAND_V4_SWAP = "0x10" as const;
const ACTION_SWAP_EXACT_IN_SINGLE = "0x06";
const ACTION_SETTLE_ALL = "0x0c";
const ACTION_TAKE_ALL = "0x0f";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** o1 launch pools: token against its quote asset, LP fee 0 (the hook charges), o1's hook. */
export function launchPoolKey(token: Address, quote: Address, tickSpacing: number, hook: Address): PoolKey {
  const a = getAddress(token);
  const b = quote === zeroAddress ? zeroAddress : getAddress(quote);
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: 0, tickSpacing, hooks: getAddress(hook) };
}

/** `referrer ++ bytes32(comment)`; empty when there is no referrer. */
export function encodeHookData(referrer: Address | null, comment = SWAP_COMMENT): Hex {
  if (!referrer) return "0x";
  return concatHex([getAddress(referrer), stringToHex(comment.slice(0, 32), { size: 32 })]);
}

export type SwapEncoding = { to: Address; data: Hex; value: bigint };

export function encodeExactInputSwap(input: {
  router: Address;
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  hookData: Hex;
  deadline: bigint;
}): SwapEncoding {
  const { poolKey, zeroForOne } = input;
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const actions = concatHex([ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL] as Hex[]);
  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [{ poolKey, zeroForOne, amountIn: input.amountIn, amountOutMinimum: input.minAmountOut, hookData: input.hookData }],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, input.amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, input.minAmountOut]);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, take]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [COMMAND_V4_SWAP, [v4Input], input.deadline] });
  return { to: input.router, data, value: currencyIn === zeroAddress ? input.amountIn : 0n };
}

/** o1's anti-snipe fee: linear from the start total to the base fee over the window. */
export function antiSnipeFeeBps(now: number, launchTime: number, windowSeconds: number, startTotalBps: number, baseFeeBps: number): { active: boolean; secondsLeft: number; feeBps: number } {
  const elapsed = now - launchTime;
  if (elapsed >= windowSeconds || windowSeconds <= 0) return { active: false, secondsLeft: 0, feeBps: baseFeeBps };
  const left = Math.max(0, windowSeconds - elapsed);
  const feeBps = Math.round(baseFeeBps + ((startTotalBps - baseFeeBps) * left) / windowSeconds);
  return { active: true, secondsLeft: Math.ceil(left), feeBps };
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5000, Math.round(slippageBps))));
  const out = (amountOut * (10_000n - bps)) / 10_000n;
  return out > 0n ? out : 1n;
}
