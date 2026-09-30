import { describe, expect, it, vi } from "vitest";
import { BOT_API_KEY_INDEX, TX_TYPE_L2_CHANGE_PUB_KEY, buildRegisterMessage, type LinkStatus } from "@o1bot/lighter";

vi.mock("@o1bot/db", () => ({ db: () => { throw new Error("no database in this test"); } }));

const { registerPerpsKey } = await import("../src/perps-register");
type Deps = Parameters<typeof registerPerpsKey>[1];

const PUB = `0x${"ab".repeat(40)}`;
const WALLET = "0x830C9027454b5B8e6896240a0aae1b98C2c07dCa";
const ROW = { id: "p1", xUserId: "u1", walletAddress: WALLET, walletId: "w1", apiKeyIndex: BOT_API_KEY_INDEX, publicKey: null, sealedKey: null };
const LINKED: LinkStatus = { state: "linked", account: { index: 50, collateral: 100, availableBalance: 100, totalAssetValue: 100 } };

/** A signer that behaves like the wasm: the message it returns names exactly what it signed. */
function fakeSigner(over: { apiKeyIndexInMessage?: number; txType?: number } = {}) {
  return {
    GenerateAPIKey: () => ({ privateKey: "0xpriv", publicKey: PUB }),
    CreateClient: () => ({}),
    SignChangePubKey: (pubKeyHex: string, _skip: number, nonce: number, apiKeyIndex: number, accountIndex: number) => ({
      txType: over.txType ?? TX_TYPE_L2_CHANGE_PUB_KEY,
      txInfo: JSON.stringify({ AccountIndex: accountIndex, ApiKeyIndex: apiKeyIndex, PubKey: pubKeyHex, L1Sig: "" }),
      txHash: "0xhash",
      messageToSign: buildRegisterMessage({ pubKey: pubKeyHex, nonce: BigInt(nonce), accountIndex: BigInt(accountIndex), apiKeyIndex: over.apiKeyIndexInMessage ?? apiKeyIndex }),
    }),
  };
}

function deps(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const d: Deps = {
    lookup: async () => LINKED,
    slot: async () => null,
    nextNonce: async () => ({ nonce: 7 }),
    sendTx: vi.fn(async (txType: number, txInfo: string) => {
      calls.push("sendTx");
      return { txType, txInfo };
    }),
    signer: async () => fakeSigner(),
    seal: async (pk) => `s1.sealed(${pk})`,
    save: vi.fn(async () => {
      calls.push("save");
    }),
    signMessage: vi.fn(async () => {
      calls.push("signMessage");
      return "0xsig";
    }),
    dryRun: false,
    ...over,
  };
  return { d, calls };
}

describe("registerPerpsKey", () => {
  it("seals and stores the key, has the wallet sign the venue's message, then broadcasts — in that order", async () => {
    const { d, calls } = deps();
    const out = await registerPerpsKey(ROW, d);
    expect(out).toEqual({ ok: true, accountIndex: 50n, publicKey: PUB, txHash: "0xhash", already: false });
    expect(calls).toEqual(["save", "signMessage", "sendTx"]);
    expect(d.save).toHaveBeenCalledWith({ accountIndex: 50n, publicKey: PUB, sealedKey: "s1.sealed(0xpriv)" });
    const [txType, txInfo] = (d.sendTx as ReturnType<typeof vi.fn>).mock.calls[0] as [number, string];
    expect(txType).toBe(TX_TYPE_L2_CHANGE_PUB_KEY);
    expect(JSON.parse(txInfo)).toMatchObject({ AccountIndex: 50, ApiKeyIndex: BOT_API_KEY_INDEX, PubKey: PUB, L1Sig: "0xsig" });
    expect(d.signMessage).toHaveBeenCalledWith({ walletId: "w1", address: WALLET }, expect.stringContaining("Register Lighter Account"), { accountIndex: 50n, apiKeyIndex: BOT_API_KEY_INDEX, pubKey: PUB });
  });

  it("never writes over another client's key in the slot", async () => {
    const { d, calls } = deps({ slot: async () => ({ public_key: `0x${"cd".repeat(40)}` }) });
    const out = await registerPerpsKey(ROW, d);
    expect(out).toMatchObject({ ok: false, retry: false });
    expect((out as { error: string }).error).toMatch(/another client's key/);
    expect(calls).toEqual([]);
  });

  it("recognises its own key already in the slot from an attempt that lost the venue's answer", async () => {
    const { d, calls } = deps({ slot: async () => ({ public_key: PUB.toUpperCase() }) });
    const out = await registerPerpsKey({ ...ROW, publicKey: PUB, sealedKey: "s1.x" }, d);
    expect(out).toEqual({ ok: true, accountIndex: 50n, publicKey: PUB, txHash: null, already: true });
    expect(calls).toEqual([]);
  });

  it("refuses to ask the wallet for a signature over a message that names a different slot", async () => {
    const { d, calls } = deps({ signer: async () => fakeSigner({ apiKeyIndexInMessage: 0 }) });
    const out = await registerPerpsKey(ROW, d);
    expect(out).toMatchObject({ ok: false, retry: false });
    expect((out as { error: string }).error).toMatch(/different account, slot or key/);
    // The key was sealed (harmless: never registered), but nothing was signed or sent.
    expect(calls).toEqual(["save"]);
  });

  it("refuses to send when the signer produced something other than a registration", async () => {
    const { d, calls } = deps({ signer: async () => fakeSigner({ txType: 13 }) });
    const out = await registerPerpsKey(ROW, d);
    expect((out as { error: string }).error).toMatch(/expected a registration/);
    expect(calls).toEqual(["save"]);
  });

  it("does everything but broadcast in a dry run", async () => {
    const { d, calls } = deps({ dryRun: true });
    const out = await registerPerpsKey(ROW, d);
    expect(out).toEqual({ ok: true, accountIndex: 50n, publicKey: PUB, txHash: null, already: false });
    expect(calls).toEqual(["save", "signMessage"]);
  });

  it("tells a user without a Lighter account to deposit first, and retries only when the venue failed to answer", async () => {
    const none = await registerPerpsKey(ROW, deps({ lookup: async () => ({ state: "none" }) }).d);
    expect(none).toMatchObject({ ok: false, retry: false });
    expect((none as { error: string }).error).toMatch(/deposit once/);
    const down = await registerPerpsKey(ROW, deps({ lookup: async () => ({ state: "error", message: "503" }) }).d);
    expect(down).toMatchObject({ ok: false, retry: true });
  });
});
