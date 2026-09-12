// Verified ABIs vendored by scripts/vendor-abi.ts (two verification sources, or one plus a cross-chain check).
import type { ChainKey } from "@o1bot/shared";
import {
  arcFeeEscrowAbi,
  arcLaunchFactoryAbi,
  arcLaunchTokenDeployerAbi,
  baseFeeEscrowAbi,
  baseLaunchFactoryAbi,
  baseLaunchHookAbi,
  feeEscrowAbi,
  launchFactoryAbi,
  launchHookAbi,
  launchTokenDeployerAbi,
} from "../../../abis/index";

export { arcFeeEscrowAbi, arcLaunchFactoryAbi, arcLaunchTokenDeployerAbi, baseFeeEscrowAbi, baseLaunchFactoryAbi, baseLaunchHookAbi, feeEscrowAbi, launchFactoryAbi, launchHookAbi, launchTokenDeployerAbi };

export type LaunchFactoryAbi = typeof launchFactoryAbi;

/**
 * The launch factory ABI for a chain, typed as the Robinhood one. Base's
 * RWAB20 factory shares every function the executor calls with an identical
 * signature (vendor-abi.ts refuses to write it otherwise); it only lacks
 * `tokenDeployer` and `launchTokenBytecodeHash`, which the B20 path never
 * calls because Base predicts token addresses through the B20 precompile.
 * Arc's factory is the same `launchpad-v4-minimal` contract as Robinhood's
 * (ERC-20 token mode), vendored from arcexplorer.org and cross-checked the
 * same way.
 */
export function factoryAbiFor(key: ChainKey): LaunchFactoryAbi {
  if (key === "base") return baseLaunchFactoryAbi as unknown as LaunchFactoryAbi;
  if (key === "arc") return arcLaunchFactoryAbi as unknown as LaunchFactoryAbi;
  return launchFactoryAbi;
}
