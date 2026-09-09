import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, getAddress, hexToString, parseEther, zeroAddress, type Hex } from "viem";
import { antiSnipeFeeBps, applySlippage, encodeExactInputSwap, encodeHookData, launchPoolKey, universalRouterAbi } from "../lib/v4-swap";

const TOKEN = getAddress("0x49c43f482bcac7192a91a5a3da2940f35d861c01");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const HOOK = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const ROUTER = getAddress("0x8876789976dEcBfCbBbe364623C63652db8C0904");
const REFERRER = getAddress("0x1111111111111111111111111111111111111111");

describe("launchPoolKey", () => {
  it("puts native ETH first and keeps o1's hook with LP fee 0", () => {
    const key = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
    expect(key).toEqual({ currency0: zeroAddress, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK });
  });
  it("sorts ERC-20 pairs by address", () => {
    const key = launchPoolKey(TOKEN, USDG, 200, HOOK);
    expect(key.currency0).toBe(TOKEN);
    expect(key.currency1).toBe(USDG);
  });
});

describe("encodeHookData", () => {
  it("is abi.encode(referrer, bytes32 comment), the form o1's hook decodes", () => {
    const data = encodeHookData(REFERRER, "o1bot.exchange");
    expect(data.length).toBe(2 + 64 + 64);
    expect(data.slice(2, 26)).toBe("0".repeat(24));
    expect(data.slice(26, 66).toLowerCase()).toBe(REFERRER.slice(2).toLowerCase());
    expect(hexToString(`0x${data.slice(66)}` as Hex, { size: 32 })).toBe("o1bot.exchange");
  });
  it("is empty without a referrer", () => expect(encodeHookData(null)).toBe("0x"));
});

describe("encodeExactInputSwap", () => {
  it("produces one V4_SWAP command with swap, settle and take, and native value on ETH buys", () => {
    const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
    const amountIn = parseEther("0.1");
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: true, amountIn, minAmountOut: 123n, hookData: encodeHookData(REFERRER), deadline: 1_800_000_000n });
    expect(enc.to).toBe(ROUTER);
    expect(enc.value).toBe(amountIn);
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: enc.data });
    expect(decoded.functionName).toBe("execute");
    const [commands, inputs, deadline] = decoded.args;
    expect(commands).toBe("0x10");
    expect(deadline).toBe(1_800_000_000n);
    expect(inputs).toHaveLength(1);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);
    const [settleCurrency, settleAmount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    expect(settleCurrency).toBe(zeroAddress);
    expect(settleAmount).toBe(amountIn);
    const [takeCurrency, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    expect(takeCurrency).toBe(TOKEN);
    expect(takeMin).toBe(123n);
  });

  it("sends no value when the input is an ERC-20", () => {
    const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
    const enc = encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: false, amountIn: 5n, minAmountOut: 1n, hookData: "0x", deadline: 1n });
    expect(enc.value).toBe(0n);
  });
});

describe("anti-snipe fee", () => {
  it("falls linearly from 99% to 1% over the window", () => {
    expect(antiSnipeFeeBps(1000, 1000, 20, 9900, 100)).toEqual({ active: true, secondsLeft: 20, feeBps: 9900 });
    expect(antiSnipeFeeBps(1010, 1000, 20, 9900, 100)).toEqual({ active: true, secondsLeft: 10, feeBps: 5000 });
    expect(antiSnipeFeeBps(1020, 1000, 20, 9900, 100)).toEqual({ active: false, secondsLeft: 0, feeBps: 100 });
  });
});

describe("applySlippage", () => {
  it("keeps at least one unit", () => {
    expect(applySlippage(1000n, 300)).toBe(970n);
    expect(applySlippage(1n, 5000)).toBe(1n);
  });
});
