import { randomBytes } from "node:crypto";
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  keccak256,
  numberToHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Token address prediction for the Robinhood `launchpad-v4-minimal` factory,
 * mirrored from the verified source (LaunchpadFactoryCore._prepareLaunch and
 * LaunchTokenDeployer._predictTokenAddress):
 *
 *   scopedSalt = keccak256(abi.encode(creator, creatorSalt))
 *   token      = CREATE2(deployer, scopedSalt, keccak256(creationCode ++ abi.encode(genesisParams)))
 *
 * The genesis params do not include the creator or the salt, so the bytecode
 * hash can be read once (`launchTokenBytecodeHash`) and the salt mined
 * locally. Validated against live launches in test/salt.test.ts.
 */

export function scopedSalt(creator: Address, creatorSalt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, creatorSalt]));
}

export function predictTokenAddress(deployer: Address, scoped: Hex, bytecodeHash: Hex): Address {
  return getContractAddress({ opcode: "CREATE2", from: deployer, salt: scoped, bytecodeHash });
}

/** True when the address' lowest byte equals `suffix` (o1 requires 0x01). */
export function hasSuffix(address: Address, suffix: number): boolean {
  return Number.parseInt(address.slice(-2), 16) === suffix;
}

export type MinedSalt = {
  creatorSalt: Hex;
  scopedSalt: Hex;
  token: Address;
  attempts: number;
};

export type MineInput = {
  creator: Address;
  deployer: Address;
  bytecodeHash: Hex;
  suffix: number;
  /** 32-byte seed; random when omitted. Same seed + inputs → same result. */
  seed?: Hex;
  maxAttempts?: number;
};

/**
 * Search creatorSalt = keccak256(seed ++ i) until the predicted token ends in
 * `suffix`. One byte of freedom → 256 attempts on average, microseconds each.
 */
/**
 * Base (`tokenMode: "b20"`): the factory mints through the B20 precompile and
 * predicts the address with `getB20Address(ASSET, factory, scopedSalt)`
 * (B20LaunchpadFactory._predictTokenAddress, verified on Base Blockscout).
 * The precompile's derivation is not public, so candidates are checked with
 * batched eth_calls through Multicall3 instead of locally. Same 0x01 suffix
 * rule (RWAB20LaunchpadFactory._validatePredictedToken).
 */
export const B20_VARIANT_ASSET = 0;
export const b20FactoryAbi = parseAbi(["function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)"]);

export type MineB20Input = {
  client: Pick<PublicClient, "multicall">;
  /** The B20 precompile (config/o1.json → chains.base.b20.factory). */
  b20Factory: Address;
  /** The o1 launch factory: the precompile's `sender` when it mints. */
  launchFactory: Address;
  creator: Address;
  suffix: number;
  seed?: Hex;
  maxAttempts?: number;
  /** Candidates per multicall; 256 covers the expected search in one round trip. */
  batchSize?: number;
};

export async function mineCreatorSaltB20(input: MineB20Input): Promise<MinedSalt> {
  const seed = input.seed ?? toHex(randomBytes(32));
  const max = input.maxAttempts ?? 4096;
  const batch = input.batchSize ?? 256;
  for (let start = 0; start < max; start += batch) {
    const n = Math.min(batch, max - start);
    const candidates = Array.from({ length: n }, (_, j) => {
      const creatorSalt = keccak256(concatHex([seed, numberToHex(start + j, { size: 32 })]));
      return { creatorSalt, scoped: scopedSalt(input.creator, creatorSalt) };
    });
    const tokens = (await input.client.multicall({
      allowFailure: false,
      contracts: candidates.map((c) => ({ address: input.b20Factory, abi: b20FactoryAbi, functionName: "getB20Address", args: [B20_VARIANT_ASSET, input.launchFactory, c.scoped] }) as const),
    })) as readonly Address[];
    for (const [j, raw] of tokens.entries()) {
      const token = getAddress(raw);
      if (hasSuffix(token, input.suffix)) {
        const c = candidates[j]!;
        return { creatorSalt: c.creatorSalt, scopedSalt: c.scoped, token, attempts: start + j + 1 };
      }
    }
  }
  throw new Error(`no salt with suffix 0x${input.suffix.toString(16).padStart(2, "0")} found in ${max} attempts`);
}

export function mineCreatorSalt(input: MineInput): MinedSalt {
  const seed = input.seed ?? toHex(randomBytes(32));
  const max = input.maxAttempts ?? 65_536;
  for (let i = 0; i < max; i++) {
    const creatorSalt = keccak256(concatHex([seed, numberToHex(i, { size: 32 })]));
    const scoped = scopedSalt(input.creator, creatorSalt);
    const token = predictTokenAddress(input.deployer, scoped, input.bytecodeHash);
    if (hasSuffix(token, input.suffix)) return { creatorSalt, scopedSalt: scoped, token, attempts: i + 1 };
  }
  throw new Error(`no salt with suffix 0x${input.suffix.toString(16).padStart(2, "0")} found in ${max} attempts`);
}
