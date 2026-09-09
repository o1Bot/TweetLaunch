import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { encodeExactInputSwap, encodeHookData, launchPoolKey, permit2Abi } from "@o1bot/swap";
import { buildAllowlist, checkTransaction } from "../src/tx-allowlist";

const FACTORY: Address = getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d");
const ESCROW: Address = getAddress("0xc5444b417a04a7E1B9C1E327c7D499803c14E5EF");
const HOOK: Address = getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc");
const ROUTER: Address = getAddress("0x3333333333333333333333333333333333333333");
const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const REFERRER: Address = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN: Address = getAddress("0x0ab6bf0ffa6d5c5aaa8fc94a8fb2f4ea2f4f5c01");
const OTHER_TOKEN: Address = getAddress("0x9093f31188C0b5DaEA6c0270bf21FBbA24D80b01");
const SOMEONE: Address = getAddress("0x000000000000000000000000000000000000dEaD");

const list = buildAllowlist({
  chainId: 4663,
  factory: FACTORY,
  feeEscrow: ESCROW,
  trade: { router: ROUTER, permit2: PERMIT2, hook: HOOK, referrer: REFERRER, maxValueWei: 10n ** 17n, pools: [{ token: TOKEN, quote: zeroAddress, tickSpacing: 200 }] },
});
const poolKey = launchPoolKey(TOKEN, zeroAddress, 200, HOOK);
const erc20 = parseAbi(["function approve(address spender, uint256 amount)"]);

const buy = (over: Partial<Parameters<typeof encodeExactInputSwap>[0]> = {}) =>
  encodeExactInputSwap({ router: ROUTER, poolKey, zeroForOne: poolKey.currency0 === zeroAddress, amountIn: 10n ** 16n, minAmountOut: 1n, hookData: encodeHookData(REFERRER), deadline: 1n, ...over });

describe("trade allow-list", () => {
  it("accepts a buy that pays ETH into a known o1 pool with o1bot's referral", () => {
    const enc = buy();
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: enc.data, value: enc.value })).toMatchObject({ ok: true, kind: "routerExecute" });
  });

  it("accepts a sell with no value, and the two approvals it needs", () => {
    const enc = buy({ zeroForOne: poolKey.currency0 === TOKEN, amountIn: 5n });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: enc.data, value: 0n }).ok).toBe(true);
    const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: TOKEN, data: approve, value: 0n }).ok).toBe(true);
    const p2 = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [TOKEN, ROUTER, 2n ** 160n - 1n, 4_000_000_000] });
    expect(checkTransaction(list, { chainId: 4663, to: PERMIT2, data: p2, value: 0n })).toMatchObject({ ok: true, kind: "permit2Approve" });
  });

  it("refuses approvals to any other spender or token", () => {
    const toSomeone = encodeFunctionData({ abi: erc20, functionName: "approve", args: [SOMEONE, 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: TOKEN, data: toSomeone, value: 0n }).ok).toBe(false);
    const otherToken = encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: OTHER_TOKEN, data: otherToken, value: 0n }).ok).toBe(false);
    const p2Other = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [TOKEN, SOMEONE, 1n, 1] });
    expect(checkTransaction(list, { chainId: 4663, to: PERMIT2, data: p2Other, value: 0n }).ok).toBe(false);
    const p2OtherToken = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [OTHER_TOKEN, ROUTER, 1n, 1] });
    expect(checkTransaction(list, { chainId: 4663, to: PERMIT2, data: p2OtherToken, value: 0n }).ok).toBe(false);
  });

  it("refuses a swap on a pool the bot does not know, on another hook, or without the referral", () => {
    const otherPool = buy({ poolKey: launchPoolKey(OTHER_TOKEN, zeroAddress, 200, HOOK) });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: otherPool.data, value: otherPool.value })).toMatchObject({ ok: false, reason: expect.stringContaining("pool") });
    const otherHook = buy({ poolKey: { ...poolKey, hooks: SOMEONE } });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: otherHook.data, value: otherHook.value }).ok).toBe(false);
    const noRef = buy({ hookData: "0x" });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: noRef.data, value: noRef.value })).toMatchObject({ ok: false, reason: expect.stringContaining("referral") });
    const wrongRef = buy({ hookData: encodeHookData(SOMEONE) });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: wrongRef.data, value: wrongRef.value }).ok).toBe(false);
  });

  it("refuses a value that does not match the swap input, or one above the cap", () => {
    const enc = buy();
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: enc.data, value: enc.value + 1n }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: enc.data, value: 0n }).ok).toBe(false);
    const big = buy({ amountIn: 10n ** 17n + 1n });
    expect(checkTransaction(list, { chainId: 4663, to: ROUTER, data: big.data, value: big.value })).toMatchObject({ ok: false, reason: expect.stringContaining("cap") });
  });

  it("refuses native value on calls that never carry one", () => {
    const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: TOKEN, data: approve, value: 1n })).toMatchObject({ ok: false, reason: expect.stringContaining("value") });
  });

  it("opens approvals for the quote asset of a stock or USDG pool, and only for it", () => {
    const USDG: Address = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    const stock = buildAllowlist({
      chainId: 4663,
      factory: FACTORY,
      feeEscrow: ESCROW,
      trade: { router: ROUTER, permit2: PERMIT2, hook: HOOK, referrer: REFERRER, maxValueWei: 0n, pools: [{ token: OTHER_TOKEN, quote: USDG, tickSpacing: 200 }] },
    });
    const approve = encodeFunctionData({ abi: erc20, functionName: "approve", args: [PERMIT2, 1n] });
    expect(checkTransaction(stock, { chainId: 4663, to: USDG, data: approve, value: 0n }).ok).toBe(true);
    expect(checkTransaction(stock, { chainId: 4663, to: TOKEN, data: approve, value: 0n }).ok).toBe(false);
    const p2 = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [USDG, ROUTER, 1n, 1] });
    expect(checkTransaction(stock, { chainId: 4663, to: PERMIT2, data: p2, value: 0n }).ok).toBe(true);
    const key = launchPoolKey(OTHER_TOKEN, USDG, 200, HOOK);
    const swap = encodeExactInputSwap({ router: ROUTER, poolKey: key, zeroForOne: key.currency0 === USDG, amountIn: 5n, minAmountOut: 1n, hookData: encodeHookData(REFERRER), deadline: 1n });
    expect(swap.value).toBe(0n);
    expect(checkTransaction(stock, { chainId: 4663, to: ROUTER, data: swap.data, value: 0n }).ok).toBe(true);
  });

  it("does not open the router or Permit2 without a trade allowance", () => {
    const plain = buildAllowlist({ chainId: 4663, factory: FACTORY, feeEscrow: ESCROW });
    const enc = buy();
    expect(checkTransaction(plain, { chainId: 4663, to: ROUTER, data: enc.data, value: enc.value }).ok).toBe(false);
  });
});
