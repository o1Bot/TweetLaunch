import { randomBytes } from "node:crypto";
import {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  numberToHex,
  toHex,
  type Address,
  type Hex,
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
