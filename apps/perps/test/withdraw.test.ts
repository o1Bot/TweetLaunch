import { describe, expect, it, vi } from "vitest";
import { API_KEY_INDEX, TX_TYPE_L2_WITHDRAW, type LighterClient } from "@o1bot/lighter";

const { signWithdraw } = vi.hoisted(() => ({ signWithdraw: vi.fn() }));

// The wasm module is not loadable under vitest; everything else stays real.
vi.mock("@o1bot/lighter", async (importOriginal) => {
  const real = await importOriginal<typeof import("@o1bot/lighter")>();
  return {
    ...real,
    loadSigner: async () => ({ CreateClient: () => ({}), SignWithdraw: signWithdraw }),
    openApiKey: async () => "0xkey",
  };
});

import { vaultKey } from "../lib/register";
import { NoKeyError } from "../lib/submit";
import { submitWithdraw } from "../lib/withdraw";

function client(nonce: number) {
  const sent: Array<{ txType: number; txInfo: string }> = [];
  const c = {
    nextNonce: async () => ({ nonce }),
    sendTx: async (txType: number, txInfo: string) => {
      sent.push({ txType, txInfo });
      return {};
    },
  } as unknown as LighterClient;
  return { c, sent };
}

const store = (accountIndex: number) => ({ getItem: (k: string) => (k === vaultKey(accountIndex) ? "sealed" : null) });
const BUILT = { assetIndex: 3, routeType: 0, amount: 12_500_000, amountUsdc: "12.500000" };

describe("submitWithdraw", () => {
  it("passes the built withdrawal to the signer in the verified argument order and sends what it signed", async () => {
    signWithdraw.mockReturnValue({ txType: TX_TYPE_L2_WITHDRAW, txInfo: '{"x":1}', txHash: "0xabc" });
    const { c, sent } = client(7);
    const res = await submitWithdraw({ client: c, accountIndex: 50, built: BUILT, signMessage: async () => "0xsig", store: store(50) });
    // assetIndex, routeType, amount, skipNonce, nonce, apiKeyIndex, accountIndex — wasm/main.go c26ac340
    expect(signWithdraw).toHaveBeenCalledWith(3, 0, 12_500_000, 0, 7, API_KEY_INDEX, 50);
    expect(sent).toEqual([{ txType: 13, txInfo: '{"x":1}' }]);
    expect(res.txHash).toBe("0xabc");
  });

  it("refuses to send when the module signed something other than a withdraw", async () => {
    signWithdraw.mockReturnValue({ txType: 14, txInfo: "{}", txHash: "0x1" });
    const { c, sent } = client(1);
    await expect(
      submitWithdraw({ client: c, accountIndex: 50, built: BUILT, signMessage: async () => "0xsig", store: store(50) }),
    ).rejects.toThrow(/expected a withdraw/);
    expect(sent).toEqual([]);
  });

  it("asks for a key before asking the wallet for anything", async () => {
    const signMessage = vi.fn(async () => "0xsig");
    const { c } = client(1);
    await expect(
      submitWithdraw({ client: c, accountIndex: 51, built: BUILT, signMessage, store: store(50) }),
    ).rejects.toBeInstanceOf(NoKeyError);
    expect(signMessage).not.toHaveBeenCalled();
  });
});
