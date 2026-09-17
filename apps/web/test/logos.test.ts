import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import manifest from "../lib/logos.json";
import { logoFor } from "../lib/logos";

describe("asset logos the site serves itself", () => {
  it("answers a path for every symbol in the manifest, case-insensitively", () => {
    expect(logoFor("AAPL")).toBe("/logos/AAPL.png");
    expect(logoFor("aapl")).toBe("/logos/AAPL.png");
    expect(logoFor("ETH")).toBe("/logos/ETH.png");
    expect(logoFor("USDG")).toBe("/logos/USDG.png");
  });

  it("maps wrapped ether to the ether logo and nothing to unknown symbols", () => {
    expect(logoFor("WETH")).toBe("/logos/ETH.png");
    expect(logoFor("NOPE")).toBeNull();
    expect(logoFor(null)).toBeNull();
  });

  it("has a file for every manifest entry", () => {
    const dir = path.resolve(__dirname, "..", "public", "logos");
    for (const s of (manifest as { symbols: string[] }).symbols) expect(existsSync(path.join(dir, `${s}.png`)), s).toBe(true);
  });
});
