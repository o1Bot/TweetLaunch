import { describe, expect, it } from "vitest";
import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { COMMAND_V4_SWAP, decodeExactInputSwap, decodeHookData, encodeExactInputSwap, encodeHookData, EXACT_INPUT_ACTIONS, launchPoolKey, universalRouterAbi } from "../src/index";

const ROUTER: Address = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const HOOK: Address = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const REFERRER: Address = getAddress("0x2222222222222222222222222222222222222222");

const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);

describe("hook data", () => {
  it("is ABI-encoded (address, bytes32): 64 bytes with the address left-padded, as the hook decodes it", () => {
    const data = encodeHookData(REFERRER);
    expect(data.length).toBe(2 + 128);
    expect(data.slice(2, 26)).toBe("0".repeat(24));
    expect(data.slice(26, 66).toLowerCase()).toBe(REFERRER.slice(2).toLowerCase());
    expect(decodeHookData(data)).toEqual({ referrer: REFERRER, comment: "o1bot.exchange" });
    expect(encodeHookData(null)).toBe("0x");
    expect(decodeHookData("0x")).toEqual({ referrer: null, comment: "" });
  });

  it("refuses the packed 52-byte form and anything else", () => {
    const packed = concatHex([REFERRER, `0x${"00".repeat(32)}`]);
    expect(decodeHookData(packed)).toBeNull();
    expect(decodeHookData(REFERRER)).toBeNull();
    expect(decodeHookData(`0x${"ff".repeat(64)}`)).toBeNull();
  });
});

describe("encode / decode exact-input swap", () => {
  it("round-trips a buy paid in ETH", () => {
    const hookData = encodeHookData(REFERRER);
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: poolKey.currency0 === zeroAddress, amountIn: 10n ** 16n, minAmountOut: 5n, hookData, deadline: 1_800_000_000n });
    expect(enc.to).toBe(ROUTER);
    expect(enc.value).toBe(10n ** 16n);
    const dec = decodeExactInputSwap(enc.data);
    expect(dec).not.toBeNull();
    expect(dec!.poolKey).toEqual(poolKey);
    expect(dec!.amountIn).toBe(10n ** 16n);
    expect(dec!.minAmountOut).toBe(5n);
    expect(dec!.currencyIn).toBe(zeroAddress);
    expect(dec!.currencyOut).toBe(TOKEN);
    expect(dec!.value).toBe(10n ** 16n);
    expect(dec!.deadline).toBe(1_800_000_000n);
    expect(decodeHookData(dec!.hookData)).toEqual({ referrer: REFERRER, comment: "o1bot.exchange" });
  });

  it("round-trips a sell with no native value", () => {
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: poolKey.currency0 === TOKEN, amountIn: 123n, minAmountOut: 1n, hookData: "0x", deadline: 1n });
    expect(enc.value).toBe(0n);
    const dec = decodeExactInputSwap(enc.data);
    expect(dec?.currencyIn).toBe(TOKEN);
    expect(dec?.currencyOut).toBe(zeroAddress);
    expect(dec?.value).toBe(0n);
    expect(decodeHookData(dec!.hookData)).toEqual({ referrer: null, comment: "" });
  });

  it("refuses anything that is not exactly one V4 exact-input swap", () => {
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: true, amountIn: 1n, minAmountOut: 1n, hookData: "0x", deadline: 1n });
    const [, inputs, deadline] = (() => {
      const dec = decodeExactInputSwap(enc.data)!;
      return [dec, [enc.data], dec.deadline] as const;
    })();
    void inputs;
    // Two commands.
    const two = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [concatHex([COMMAND_V4_SWAP, COMMAND_V4_SWAP]), ["0x", "0x"], deadline] });
    expect(decodeExactInputSwap(two)).toBeNull();
    // A different command id (0x0b WRAP_ETH).
    const wrap = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: ["0x0b", [encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ROUTER, 1n])], deadline] });
    expect(decodeExactInputSwap(wrap)).toBeNull();
    // A v4 input whose actions include TAKE (0x12) with an explicit recipient instead of TAKE_ALL.
    const actions = concatHex(["0x06", "0x0c", "0x12"] as Hex[]);
    const swapParams = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              name: "poolKey",
              type: "tuple",
              components: [
                { name: "currency0", type: "address" },
                { name: "currency1", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "tickSpacing", type: "int24" },
                { name: "hooks", type: "address" },
              ],
            },
            { name: "zeroForOne", type: "bool" },
            { name: "amountIn", type: "uint128" },
            { name: "amountOutMinimum", type: "uint128" },
            { name: "hookData", type: "bytes" },
          ],
        },
      ],
      [{ poolKey, zeroForOne: true, amountIn: 1n, amountOutMinimum: 1n, hookData: "0x" }],
    );
    const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [poolKey.currency0, 1n]);
    const takeTo = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [poolKey.currency1, REFERRER, 1n]);
    const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settle, takeTo]]);
    const stolen = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [COMMAND_V4_SWAP, [v4Input], deadline] });
    expect(decodeExactInputSwap(stolen)).toBeNull();
    // Settle amount that does not match the swap input.
    const badSettle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [poolKey.currency0, 2n]);
    const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [poolKey.currency1, 1n]);
    const mismatch = encodeFunctionData({
      abi: universalRouterAbi,
      functionName: "execute",
      args: [COMMAND_V4_SWAP, [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [concatHex(["0x06", "0x0c", "0x0f"] as Hex[]), [swapParams, badSettle, take]])], deadline],
    });
    expect(decodeExactInputSwap(mismatch)).toBeNull();
    // Not router calldata at all.
    expect(decodeExactInputSwap("0xdeadbeef")).toBeNull();
  });

  it("encodes the Robinhood router's struct: minHopPriceX36 sits before hookData, so the hook receives the hook data", () => {
    const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
    const hookData = encodeHookData(REFERRER);
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: true, amountIn: 10n, minAmountOut: 1n, hookData, deadline: 1n });
    const [, inputs] = decodeFunctionData({ abi: universalRouterAbi, data: enc.data }).args;
    const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
    const words = params[0]!.slice(2).match(/.{64}/g)!;
    // Word 0 is the tuple offset; the struct starts at word 1: poolKey (5), zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData offset, length, data.
    expect(BigInt(`0x${words[9]}`)).toBe(0n); // minHopPriceX36
    expect(BigInt(`0x${words[10]}`)).toBe(BigInt(10 * 32)); // hookData offset, relative to the struct
    expect(BigInt(`0x${words[11]}`)).toBe(64n); // hookData length
    expect(`0x${words[12]}${words[13]}`).toBe(hookData);
    expect(decodeExactInputSwap(enc.data)?.hookData).toBe(hookData);
  });

  it("refuses the stock Uniswap struct and a non-zero price floor", () => {
    const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
    const hookData = encodeHookData(REFERRER);
    const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [zeroAddress, 10n]);
    const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [TOKEN, 1n]);
    const wrap = (swapParams: Hex) =>
      encodeFunctionData({
        abi: universalRouterAbi,
        functionName: "execute",
        args: [COMMAND_V4_SWAP, [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [EXACT_INPUT_ACTIONS, [swapParams, settle, take]])], 1n],
      });
    const poolKeyComponents = [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ] as const;
    // Stock layout, no minHopPriceX36: the deployed router would read empty hook data from it.
    const stock = encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: poolKeyComponents }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
      [{ poolKey, zeroForOne: true, amountIn: 10n, amountOutMinimum: 1n, hookData }],
    );
    expect(decodeExactInputSwap(wrap(stock))).toBeNull();
    // Deployed layout with a price floor set: not something the bot produces, so not something it signs.
    const floored = encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: poolKeyComponents }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
      [{ poolKey, zeroForOne: true, amountIn: 10n, amountOutMinimum: 1n, minHopPriceX36: 1n, hookData }],
    );
    expect(decodeExactInputSwap(wrap(floored))).toBeNull();
  });
});
