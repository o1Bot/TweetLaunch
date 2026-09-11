// Verified ABIs vendored by scripts/vendor-abi.ts (two verification sources, or one plus a cross-chain check).
import type { ChainKey } from "@o1bot/shared";
import { baseFeeEscrowAbi, baseLaunchFactoryAbi, baseLaunchHookAbi, feeEscrowAbi, launchFactoryAbi, launchHookAbi, launchTokenDeployerAbi } from "../../../abis/index";

export { baseFeeEscrowAbi, baseLaunchFactoryAbi, baseLaunchHookAbi, feeEscrowAbi, launchFactoryAbi, launchHookAbi, launchTokenDeployerAbi };

export type LaunchFactoryAbi = typeof launchFactoryAbi;

/**
 * The launch factory ABI for a chain, typed as the Robinhood one. Base's
 * RWAB20 factory shares every function the executor calls with an identical
 * signature (vendor-abi.ts refuses to write it otherwise); it only lacks
 * `tokenDeployer` and `launchTokenBytecodeHash`, which the B20 path never
 * calls because Base predicts token addresses through the B20 precompile.
 *
 * Arc runs the same `launchpad-v4-minimal` contracts as Robinhood (ERC-20
 * token mode, CREATE2 prediction, `01` suffix), but none of them is verified
 * on Arcscan and Sourcify does not index the chain, so there is no source to
 * vendor from: the Robinhood ABI is used as is. `pnpm abi:vendor --only arc`
 * writes bytecode-checked mirrors once an Arc RPC answers; until then the
 * live reads and the simulation in plan.ts are what catch a mismatch, and
 * they run before anything is signed.
 */
export function factoryAbiFor(key: ChainKey): LaunchFactoryAbi {
  return key === "base" ? (baseLaunchFactoryAbi as unknown as LaunchFactoryAbi) : launchFactoryAbi;
}
