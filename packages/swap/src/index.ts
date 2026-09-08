import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToString,
  isAddress,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

/**
 * Uniswap v4 swaps through o1's launch pool, encoded for the Universal
 * Router: one V4_SWAP command carrying SWAP_EXACT_IN_SINGLE, SETTLE_ALL and
 * TAKE_ALL. Exact input only: o1's hook rejects exact output during the
 * anti-snipe window, and exact input is what a buy/sell box wants anyway.
 * Hook data carries o1bot's referrer address plus a 32-byte comment, which
 * is how the referral share is attributed. The hook ABI-decodes it as
 * `(address, bytes32)`, 64 bytes with the address left-padded; the packed
 * 52-byte form the docs' wording suggests makes the whole swap revert.
 *
 * Pure encoding and decoding, shared by the web app (quote API and swap
 * panel), the bot (trades from a post) and the signer allow-list, which
 * decodes every router call before it is signed. Nothing here talks to a
 * chain.
 */

export const CHAIN_ID = 4663;
export const SWAP_COMMENT = "o1bot.exchange";
export const ANTI_SNIPE_SECONDS = 20;

/** Universal Router command and v4 action ids (Uniswap universal-router v2). */
export const COMMAND_V4_SWAP = "0x10" as const;
const ACTION_SWAP_EXACT_IN_SINGLE = "0x06";
const ACTION_SETTLE_ALL = "0x0c";
const ACTION_TAKE_ALL = "0x0f";
/** The only action sequence the bot ever signs: swap, pay the input, collect the output to msg.sender. */
export const EXACT_INPUT_ACTIONS = concatHex([ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL] as Hex[]);

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

const SWAP_PARAMS = [
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
] as const;
const CURRENCY_AMOUNT = [{ type: "address" }, { type: "uint256" }] as const;
const V4_INPUT = [{ type: "bytes" }, { type: "bytes[]" }] as const;

/** o1 launch pools: token against its quote asset, LP fee 0 (the hook charges), o1's hook. */
export function launchPoolKey(token: Address, quote: Address, tickSpacing: number, hook: Address): PoolKey {
  const a = getAddress(token);
  const b = quote === zeroAddress ? zeroAddress : getAddress(quote);
  const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return { currency0, currency1, fee: 0, tickSpacing, hooks: getAddress(hook) };
}

const HOOK_DATA_PARAMS = [{ type: "address" }, { type: "bytes32" }] as const;

/** `abi.encode(referrer, bytes32(comment))`, as o1's hook decodes it; empty when there is no referrer. */
export function encodeHookData(referrer: Address | null, comment = SWAP_COMMENT): Hex {
  if (!referrer) return "0x";
  return encodeAbiParameters(HOOK_DATA_PARAMS, [getAddress(referrer), stringToHex(comment.slice(0, 32), { size: 32 })]);
}

/** Inverse of `encodeHookData`; null when the bytes are not exactly one ABI-encoded (address, bytes32). */
export function decodeHookData(hookData: Hex): { referrer: Address | null; comment: string } | null {
  if (hookData === "0x") return { referrer: null, comment: "" };
  if (hookData.length !== 2 + 128) return null;
  // The address word must be left-padded with zeros; viem would silently take the low 20 bytes otherwise.
  if (hookData.slice(2, 26) !== "0".repeat(24)) return null;
  try {
    const [referrer, comment] = decodeAbiParameters(HOOK_DATA_PARAMS, hookData);
    if (!isAddress(referrer)) return null;
    return { referrer: getAddress(referrer), comment: hexToString(comment, { size: 32 }) };
  } catch {
    return null;
  }
}

export type SwapEncoding = { to: Address; data: Hex; value: bigint };

export type ExactInputSwap = {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  hookData: Hex;
  deadline: bigint;
};

export function encodeExactInputSwap(input: ExactInputSwap & { router: Address }): SwapEncoding {
  const { poolKey, zeroForOne } = input;
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const swapParams = encodeAbiParameters(SWAP_PARAMS, [{ poolKey, zeroForOne, amountIn: input.amountIn, amountOutMinimum: input.minAmountOut, hookData: input.hookData }]);
  const settle = encodeAbiParameters(CURRENCY_AMOUNT, [currencyIn, input.amountIn]);
  const take = encodeAbiParameters(CURRENCY_AMOUNT, [currencyOut, input.minAmountOut]);
  const v4Input = encodeAbiParameters(V4_INPUT, [EXACT_INPUT_ACTIONS, [swapParams, settle, take]]);
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [COMMAND_V4_SWAP, [v4Input], input.deadline] });
  return { to: input.router, data, value: currencyIn === zeroAddress ? input.amountIn : 0n };
}

export type DecodedExactInputSwap = ExactInputSwap & {
  currencyIn: Address;
  currencyOut: Address;
  /** Native value the call must carry: amountIn when paying in ETH, else 0. */
  value: bigint;
};

/**
 * Decode Universal Router calldata and accept it only when it is exactly
 * what `encodeExactInputSwap` produces: one V4_SWAP command, the three
 * actions in order, settle and take naming the swap's own currencies and
 * amounts. TAKE_ALL pays msg.sender, so the output can only reach the
 * wallet that signs. Anything else (another command, a TAKE with a
 * recipient, extra inputs) returns null and must not be signed.
 */
export function decodeExactInputSwap(data: Hex): DecodedExactInputSwap | null {
  let commands: Hex;
  let inputs: readonly Hex[];
  let deadline: bigint;
  try {
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data });
    if (decoded.functionName !== "execute") return null;
    [commands, inputs, deadline] = decoded.args;
  } catch {
    return null;
  }
  if (commands.toLowerCase() !== COMMAND_V4_SWAP || inputs.length !== 1) return null;
  try {
    const [actions, params] = decodeAbiParameters(V4_INPUT, inputs[0]!);
    if (actions.toLowerCase() !== EXACT_INPUT_ACTIONS.toLowerCase() || params.length !== 3) return null;
    const [swap] = decodeAbiParameters(SWAP_PARAMS, params[0]!);
    const [settleCurrency, settleAmount] = decodeAbiParameters(CURRENCY_AMOUNT, params[1]!);
    const [takeCurrency, takeAmount] = decodeAbiParameters(CURRENCY_AMOUNT, params[2]!);
    const poolKey: PoolKey = {
      currency0: getAddress(swap.poolKey.currency0),
      currency1: getAddress(swap.poolKey.currency1),
      fee: swap.poolKey.fee,
      tickSpacing: swap.poolKey.tickSpacing,
      hooks: getAddress(swap.poolKey.hooks),
    };
    const currencyIn = swap.zeroForOne ? poolKey.currency0 : poolKey.currency1;
    const currencyOut = swap.zeroForOne ? poolKey.currency1 : poolKey.currency0;
    if (getAddress(settleCurrency) !== currencyIn || settleAmount !== swap.amountIn) return null;
    if (getAddress(takeCurrency) !== currencyOut || takeAmount !== swap.amountOutMinimum) return null;
    return {
      poolKey,
      zeroForOne: swap.zeroForOne,
      amountIn: swap.amountIn,
      minAmountOut: swap.amountOutMinimum,
      hookData: swap.hookData,
      deadline,
      currencyIn,
      currencyOut,
      value: currencyIn === zeroAddress ? swap.amountIn : 0n,
    };
  } catch {
    return null;
  }
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
