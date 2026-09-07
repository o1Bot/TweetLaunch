import "dotenv/config";
import { formatEther } from "viem";
import {
  activeFactory,
  activeFeeEscrow,
  CHAIN_KEYS,
  chainDisplayName,
  cryptoQuotes,
  env,
  logger,
  o1Chain,
  o1Config,
  registryDrift,
  stockQuotes,
} from "@o1bot/shared";

/**
 * Bot entry point. Step 1 only proves the foundation: env parses, the o1
 * snapshot loads, and o1's live registry still points at the same factories.
 * Listener → parser → validator → queue → executor → replier land in later
 * steps and plug in here.
 */
async function main() {
  const e = env();
  const cfg = o1Config();
  logger.info({ dryRun: e.DRY_RUN, snapshotFetchedAt: cfg.fetchedAt }, "o1bot booting");

  for (const key of CHAIN_KEYS) {
    const chain = o1Chain(key);
    logger.info(
      {
        chain: chainDisplayName(key),
        chainId: chain.chainId,
        factory: activeFactory(key),
        feeEscrow: activeFeeEscrow(key),
        nativeLaunchFee: `${formatEther(BigInt(chain.snapshot.nativeLaunchFeeRaw))} ETH (snapshot)`,
        configVersionAtSnapshot: chain.snapshot.configVersion,
        cryptoPairs: cryptoQuotes(key).map((q) => q.symbol),
        stockPairs: stockQuotes(key).length,
      },
      "active o1 suite",
    );
  }

  const drift = await registryDrift();
  if (drift.length > 0) {
    logger.error({ drift }, "config/o1.json is stale: run `pnpm o1:sync` and re-verify ABIs before launching");
    process.exitCode = 1;
    return;
  }
  logger.info("o1 live registry matches the snapshot");
  logger.info("listener/executor are not implemented yet (steps 2-4); exiting");
}

main().catch((err) => {
  logger.error({ err }, "bot crashed");
  process.exit(1);
});
