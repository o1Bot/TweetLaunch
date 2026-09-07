import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import fixtures from "./fixtures/robinhood-launches.json" with { type: "json" };
import { hasSuffix, mineCreatorSalt, predictTokenAddress, scopedSalt } from "../src/salt";

// Robinhood Chain LaunchTokenDeployer (config/o1.json → contracts.launchTokenDeployer).
const DEPLOYER = "0xf86dfDb678D8E5d932100Ef479A59fa65a82a5Eb" as const;

describe("token address prediction", () => {
  for (const [label, f] of Object.entries(fixtures)) {
    it(`reproduces the on-chain token for ${label} (${f.txHash.slice(0, 10)}…)`, () => {
      const scoped = scopedSalt(f.from as Address, f.params.creatorSalt as Hex);
      expect(scoped).toBe(f.scopedSalt);
      const predicted = predictTokenAddress(DEPLOYER, scoped, f.bytecodeHash as Hex);
      expect(predicted).toBe(getAddress(f.token));
      expect(hasSuffix(predicted, 1)).toBe(true);
    });
  }

  it("mines a salt whose token ends in 01, deterministically from a seed", () => {
    const creator = fixtures.cashcat.from as Address;
    const seed = `0x${"11".repeat(32)}` as Hex;
    const a = mineCreatorSalt({ creator, deployer: DEPLOYER, bytecodeHash: fixtures.cashcat.bytecodeHash as Hex, suffix: 1, seed });
    const b = mineCreatorSalt({ creator, deployer: DEPLOYER, bytecodeHash: fixtures.cashcat.bytecodeHash as Hex, suffix: 1, seed });
    expect(a).toEqual(b);
    expect(a.token.toLowerCase().endsWith("01")).toBe(true);
    expect(a.attempts).toBeGreaterThan(0);
    expect(a.scopedSalt).toBe(scopedSalt(creator, a.creatorSalt));

    // The salt is scoped to the creator: another wallet gets another token.
    const other = mineCreatorSalt({ creator: fixtures.cgmBuy.from as Address, deployer: DEPLOYER, bytecodeHash: fixtures.cashcat.bytecodeHash as Hex, suffix: 1, seed });
    expect(other.token).not.toBe(a.token);
  });

  it("gives up after maxAttempts", () => {
    const base = { creator: fixtures.cashcat.from as Address, deployer: DEPLOYER, bytecodeHash: fixtures.cashcat.bytecodeHash as Hex, suffix: 1 };
    // Find a seed that needs more than one attempt, then cap just below it.
    let seedByte = 0x22;
    let mined = mineCreatorSalt({ ...base, seed: `0x${seedByte.toString(16).repeat(32)}` });
    while (mined.attempts < 2) {
      seedByte++;
      mined = mineCreatorSalt({ ...base, seed: `0x${seedByte.toString(16).repeat(32)}` });
    }
    const seed = `0x${seedByte.toString(16).repeat(32)}` as Hex;
    expect(() => mineCreatorSalt({ ...base, seed, maxAttempts: mined.attempts - 1 })).toThrow(/no salt/);
  });
});
