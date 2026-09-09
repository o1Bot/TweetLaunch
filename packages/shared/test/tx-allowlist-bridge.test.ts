import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { RELAY_DEPOSITORY } from "../src/bridge-chains";
import { buildBridgeAllowlist, checkTransaction } from "../src/tx-allowlist";

const WALLET: Address = getAddress("0x1111111111111111111111111111111111111111");
const SOMEONE: Address = getAddress("0x000000000000000000000000000000000000dEaD");
const REQUEST: Hex = `0x${"ab".repeat(32)}`;
const OTHER_REQUEST: Hex = `0x${"cd".repeat(32)}`;
const abi = parseAbi(["function depositNative(address to, bytes32 id)", "function transfer(address to, uint256 amount)"]);

const list = buildBridgeAllowlist({ chainId: 8453, depository: RELAY_DEPOSITORY, wallet: WALLET, depositId: REQUEST, amountWei: parseEther("0.1") });
const deposit = (to: Address = zeroAddress, id: Hex = REQUEST) => encodeFunctionData({ abi, functionName: "depositNative", args: [to, id] });

describe("bridge allow-list", () => {
  it("accepts the one deposit the quote described: pinned depository, zero depositor (msg.sender), this deposit id, this value", () => {
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(), value: parseEther("0.1") })).toMatchObject({ ok: true, kind: "relayDeposit" });
  });

  it("refuses a named depositor (even the wallet itself), another deposit id, another value, another chain or another contract", () => {
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(SOMEONE), value: parseEther("0.1") })).toMatchObject({ ok: false, reason: expect.stringContaining("depositor") });
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(WALLET), value: parseEther("0.1") })).toMatchObject({ ok: false, reason: expect.stringContaining("depositor") });
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(zeroAddress, OTHER_REQUEST), value: parseEther("0.1") })).toMatchObject({ ok: false, reason: expect.stringContaining("deposit id") });
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(), value: parseEther("0.2") })).toMatchObject({ ok: false, reason: expect.stringContaining("value") });
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: deposit(), value: 0n }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 4663, to: RELAY_DEPOSITORY, data: deposit(), value: parseEther("0.1") }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 8453, to: SOMEONE, data: deposit(), value: parseEther("0.1") }).ok).toBe(false);
  });

  it("opens nothing else on the origin chain", () => {
    const transfer = encodeFunctionData({ abi, functionName: "transfer", args: [SOMEONE, 1n] });
    expect(checkTransaction(list, { chainId: 8453, to: RELAY_DEPOSITORY, data: transfer, value: 0n }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 8453, to: SOMEONE, data: "0x", value: parseEther("0.1") }).ok).toBe(false);
    expect(list.entries).toHaveLength(1);
  });
});
