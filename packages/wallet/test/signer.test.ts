import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
import { buildAllowlist } from "@o1bot/shared";

const FACTORY = "0xcE9C48cFa068947f77738c81Be406B53338E5B0d" as const;
const ESCROW = "0xc5444b417a04a7E1B9C1E327c7D499803c14E5EF" as const;
const WALLET = "0x830C9027454b5B8e6896240a0aae1b98C2c07dCa" as const;
const SOMEONE = "0x000000000000000000000000000000000000dEaD" as const;

// What Privy's viem account really exposes today, plus something it might grow tomorrow.
const inner = {
  address: WALLET,
  publicKey: "0x04" as const,
  source: "custom",
  type: "local" as const,
  sign: vi.fn(async () => "0xraw"),
  signMessage: vi.fn(async () => "0xmsg"),
  signTypedData: vi.fn(async () => "0xtyped"),
  signAuthorization: vi.fn(async () => ({}) as never),
  signTransaction: vi.fn(async () => "0xsigned"),
  signSomethingNew: vi.fn(async () => "0xnew"),
};

vi.mock("@privy-io/server-auth/viem", () => ({ createViemAccount: async () => inner }));
vi.mock("../src/privy", () => ({ privy: () => ({}) }));

const { guardedAccount, TxNotAllowedError } = await import("../src/signer");

const abi = parseAbi(["function setCreatorFeeRecipient(address token, address recipient)", "function transfer(address to, uint256 amount)"]);
const allowlist = buildAllowlist({ chainId: 4663, factory: FACTORY, feeEscrow: ESCROW });

describe("guardedAccount", () => {
  const audit = vi.fn();
  beforeEach(() => {
    audit.mockClear();
    for (const fn of Object.values(inner)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  });

  it("exposes only the LocalAccount surface, never anything the inner account happens to have", async () => {
    const account = await guardedAccount({ walletId: "w", address: WALLET, allowlist, audit });
    expect(Object.keys(account).sort()).toEqual(["address", "publicKey", "sign", "signAuthorization", "signMessage", "signTransaction", "signTypedData", "source", "type"]);
    expect((account as Record<string, unknown>).signSomethingNew).toBeUndefined();
  });

  it("refuses raw hash, message, typed data and authorization signing without touching Privy", async () => {
    const account = await guardedAccount({ walletId: "w", address: WALLET, allowlist, audit });
    await expect(account.sign!({ hash: "0x00" })).rejects.toBeInstanceOf(TxNotAllowedError);
    await expect(account.signMessage({ message: "hi" })).rejects.toBeInstanceOf(TxNotAllowedError);
    await expect(account.signTypedData({ types: {}, primaryType: "EIP712Domain", message: {} } as never)).rejects.toBeInstanceOf(TxNotAllowedError);
    await expect(account.signAuthorization!({ address: SOMEONE, chainId: 4663, nonce: 0 })).rejects.toBeInstanceOf(TxNotAllowedError);
    expect(inner.sign).not.toHaveBeenCalled();
    expect(inner.signMessage).not.toHaveBeenCalled();
    expect(inner.signTypedData).not.toHaveBeenCalled();
    expect(inner.signAuthorization).not.toHaveBeenCalled();
  });

  it("signs an allow-listed transaction after recording it, and nothing else", async () => {
    const account = await guardedAccount({ walletId: "w", address: WALLET, allowlist, audit });
    const ok = encodeFunctionData({ abi, functionName: "setCreatorFeeRecipient", args: [SOMEONE, SOMEONE] });
    await expect(account.signTransaction({ chainId: 4663, to: FACTORY, data: ok, value: 0n })).resolves.toBe("0xsigned");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "setCreatorFeeRecipient", wallet: WALLET, to: FACTORY, chainId: 4663 }));
    expect(inner.signTransaction).toHaveBeenCalledTimes(1);

    const transfer = encodeFunctionData({ abi, functionName: "transfer", args: [SOMEONE, 1n] });
    await expect(account.signTransaction({ chainId: 4663, to: FACTORY, data: transfer })).rejects.toBeInstanceOf(TxNotAllowedError);
    await expect(account.signTransaction({ chainId: 4663, data: ok })).rejects.toThrow(/contract creation/);
    expect(inner.signTransaction).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
