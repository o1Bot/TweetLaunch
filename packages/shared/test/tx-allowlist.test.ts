import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { buildAllowlist, checkTransaction, TX_SELECTORS } from "../src/tx-allowlist";

// Robinhood Chain (4663) active o1 suite, per config/o1.json.
const FACTORY = "0xcE9C48cFa068947f77738c81Be406B53338E5B0d" as const;
const ESCROW = "0xc5444b417a04a7E1B9C1E327c7D499803c14E5EF" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const SOMEONE = "0x000000000000000000000000000000000000dEaD" as const;

const list = buildAllowlist({ chainId: 4663, factory: FACTORY, feeEscrow: ESCROW, approvalTargets: [USDG] });

const abi = parseAbi([
  "function setCreatorFeeRecipient(address token, address recipient)",
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function claimFor(address recipient, address currency)",
]);

describe("checkTransaction", () => {
  it("accepts setCreatorFeeRecipient to the factory", () => {
    const data = encodeFunctionData({ abi, functionName: "setCreatorFeeRecipient", args: [SOMEONE, SOMEONE] });
    expect(checkTransaction(list, { chainId: 4663, to: FACTORY, data })).toMatchObject({
      ok: true,
      kind: "setCreatorFeeRecipient",
    });
  });

  it("accepts a fee claim to the escrow", () => {
    const data = encodeFunctionData({ abi, functionName: "claimFor", args: [SOMEONE, USDG] });
    expect(checkTransaction(list, { chainId: 4663, to: ESCROW, data })).toMatchObject({ ok: true, kind: "feeClaimFor" });
  });

  it("accepts an approval only to a listed quote token", () => {
    const data = encodeFunctionData({ abi, functionName: "approve", args: [FACTORY, 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: USDG, data }).ok).toBe(true);
    expect(checkTransaction(list, { chainId: 4663, to: SOMEONE, data }).ok).toBe(false);
  });

  it("decodes the approval and refuses any spender but the factory", () => {
    const data = encodeFunctionData({ abi, functionName: "approve", args: [SOMEONE, 2n ** 256n - 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: USDG, data })).toMatchObject({ ok: false, reason: expect.stringContaining("spender") });
    const custom = buildAllowlist({ chainId: 4663, factory: FACTORY, feeEscrow: ESCROW, approvalTargets: [USDG], approvalSpenders: [SOMEONE] });
    expect(checkTransaction(custom, { chainId: 4663, to: USDG, data }).ok).toBe(true);
    expect(checkTransaction(custom, { chainId: 4663, to: USDG, data: encodeFunctionData({ abi, functionName: "approve", args: [FACTORY, 1n] }) }).ok).toBe(false);
  });

  it("refuses calldata that carries an allowed selector but does not decode as that function", () => {
    const truncated = TX_SELECTORS.setCreatorFeeRecipient + "00".repeat(20);
    expect(checkTransaction(list, { chainId: 4663, to: FACTORY, data: truncated })).toMatchObject({ ok: false, reason: expect.stringContaining("decode") });
    expect(checkTransaction(list, { chainId: 4663, to: FACTORY, data: TX_SELECTORS.createLaunch }).ok).toBe(false);
  });

  it("rejects an allow-listed selector sent to the wrong contract", () => {
    const data = encodeFunctionData({ abi, functionName: "setCreatorFeeRecipient", args: [SOMEONE, SOMEONE] });
    expect(checkTransaction(list, { chainId: 4663, to: ESCROW, data }).ok).toBe(false);
  });

  it("rejects transfers, plain value sends, contract creation and other chains", () => {
    const transfer = encodeFunctionData({ abi, functionName: "transfer", args: [SOMEONE, 1n] });
    expect(checkTransaction(list, { chainId: 4663, to: USDG, data: transfer }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 4663, to: SOMEONE, data: "0x" }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 4663, to: null, data: TX_SELECTORS.createLaunch }).ok).toBe(false);
    expect(checkTransaction(list, { chainId: 8453, to: FACTORY, data: TX_SELECTORS.createLaunch }).ok).toBe(false);
    expect(checkTransaction(list, { to: FACTORY, data: TX_SELECTORS.createLaunch }).ok).toBe(false);
  });

  it("matches the address case-insensitively", () => {
    const data = encodeFunctionData({ abi, functionName: "setCreatorFeeRecipient", args: [SOMEONE, SOMEONE] });
    expect(checkTransaction(list, { chainId: 4663, to: FACTORY.toLowerCase(), data }).ok).toBe(true);
  });
});
