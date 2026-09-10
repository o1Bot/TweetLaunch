import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { B20_VARIANT_ASSET, mineCreatorSaltB20, scopedSalt } from "../src/salt";

const CREATOR = getAddress("0xdfdf62684aeffa62fbaa088dc073f2b7ef2d7a89");
const FACTORY = getAddress("0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC");
const B20 = getAddress("0xB20f000000000000000000000000000000000000");

/** A stand-in for the precompile: a deterministic address per (variant, sender, salt). */
function fakeB20Address(variant: number, sender: Address, salt: Hex): Address {
  const h = keccak256(`0x${variant.toString(16).padStart(2, "0")}${sender.slice(2)}${salt.slice(2)}`);
  return getAddress(`0x${h.slice(-40)}`);
}

function stubClient() {
  const calls: number[] = [];
  return {
    calls,
    multicall: async ({ contracts }: { contracts: readonly { args: readonly [number, Address, Hex] }[] }) => {
      calls.push(contracts.length);
      return contracts.map((c) => fakeB20Address(c.args[0], c.args[1], c.args[2]));
    },
  };
}

describe("mineCreatorSaltB20", () => {
  it("asks the precompile in batches and returns the first salt whose token ends in 01", async () => {
    const client = stubClient();
    const seed = `0x${"22".repeat(32)}` as Hex;
    const mined = await mineCreatorSaltB20({ client: client as never, b20Factory: B20, launchFactory: FACTORY, creator: CREATOR, suffix: 1, seed, batchSize: 64 });
    expect(mined.token.toLowerCase().endsWith("01")).toBe(true);
    expect(mined.scopedSalt).toBe(scopedSalt(CREATOR, mined.creatorSalt));
    expect(mined.token).toBe(fakeB20Address(B20_VARIANT_ASSET, FACTORY, mined.scopedSalt));
    // Every earlier candidate in the same seed sequence must not have qualified.
    expect(mined.attempts).toBeGreaterThan(0);
    expect(client.calls.every((n) => n <= 64)).toBe(true);
    expect(client.calls.length).toBe(Math.ceil(mined.attempts / 64));
  });

  it("is deterministic for a seed and gives up after maxAttempts", async () => {
    const seed = `0x${"33".repeat(32)}` as Hex;
    const a = await mineCreatorSaltB20({ client: stubClient() as never, b20Factory: B20, launchFactory: FACTORY, creator: CREATOR, suffix: 1, seed });
    const b = await mineCreatorSaltB20({ client: stubClient() as never, b20Factory: B20, launchFactory: FACTORY, creator: CREATOR, suffix: 1, seed });
    expect(a).toEqual(b);
    await expect(mineCreatorSaltB20({ client: stubClient() as never, b20Factory: B20, launchFactory: FACTORY, creator: CREATOR, suffix: 1, seed, maxAttempts: 1, batchSize: 1 })).rejects.toThrow(/no salt/);
  });
});
