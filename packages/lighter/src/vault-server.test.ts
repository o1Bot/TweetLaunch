import { describe, expect, it } from "vitest";
import { openWithSecret, sealApiKey, sealWithSecret } from "./vault";

const SECRET = "11".repeat(32);
const OTHER = "22".repeat(32);
const KEY = `0x${"ab".repeat(40)}`;

describe("server vault", () => {
  it("round-trips a key under the secret, with a fresh IV each time", async () => {
    const a = await sealWithSecret(KEY, SECRET);
    const b = await sealWithSecret(KEY, SECRET);
    expect(a).not.toBe(b);
    expect(a.startsWith("s1.")).toBe(true);
    expect(await openWithSecret(a, SECRET)).toBe(KEY);
    expect(await openWithSecret(b, SECRET)).toBe(KEY);
  });

  it("refuses the wrong secret, a tampered blob and a secret of the wrong size", async () => {
    const blob = await sealWithSecret(KEY, SECRET);
    await expect(openWithSecret(blob, OTHER)).rejects.toThrow();
    const [tag, iv, ct] = blob.split(".");
    const flipped = `${tag}.${iv}.${ct!.slice(0, -2)}${ct!.slice(-2) === "AA" ? "BB" : "AA"}`;
    await expect(openWithSecret(flipped, SECRET)).rejects.toThrow();
    await expect(sealWithSecret(KEY, "abcd")).rejects.toThrow(/32 bytes/);
  });

  it("never opens a browser blob: those keys are derived from a wallet, not held by a server", async () => {
    const browserBlob = await sealApiKey(KEY, `0x${"cd".repeat(65)}`);
    await expect(openWithSecret(browserBlob, SECRET)).rejects.toThrow(/not a server vault blob/);
  });
});
