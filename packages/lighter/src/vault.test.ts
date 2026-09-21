import { describe, expect, it } from "vitest";
import { openApiKey, sealApiKey } from "./vault";

const SIG =
  "0x" + "ab".repeat(65); // 65-byte EVM signature shape
const OTHER_SIG = "0x" + "cd".repeat(65);
const PRIV = "0x1234deadbeef".padEnd(66, "0");

describe("vault", () => {
  it("roundtrip seal → open", async () => {
    const blob = await sealApiKey(PRIV, SIG);
    expect(await openApiKey(blob, SIG)).toBe(PRIV);
  });

  it("a different signature cannot open it", async () => {
    const blob = await sealApiKey(PRIV, SIG);
    await expect(openApiKey(blob, OTHER_SIG)).rejects.toThrow();
  });

  it("random iv — two seals produce different blobs", async () => {
    const a = await sealApiKey(PRIV, SIG);
    const b = await sealApiKey(PRIV, SIG);
    expect(a).not.toBe(b);
    expect(await openApiKey(a, SIG)).toBe(await openApiKey(b, SIG));
  });

  it("a corrupt blob is rejected", async () => {
    await expect(openApiKey("bukan-blob", SIG)).rejects.toThrow();
  });
});
