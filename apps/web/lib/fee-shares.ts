import { env, recipientSharePct } from "@o1bot/shared";

/**
 * How o1's creator fee is split under o1bot's fee splitter, in whole
 * percent, for the pages that explain it. Read from FEE_SPLITTER_PLATFORM_BPS,
 * the value the factories were deployed with; a launch's own share is stored
 * on its row and shown on the profile, so a later change to the default only
 * changes the copy for launches made after it.
 */
export function feeShares(): { creatorPct: number; platformPct: number } {
  const creatorPct = recipientSharePct(env().FEE_SPLITTER_PLATFORM_BPS);
  return { creatorPct, platformPct: 100 - creatorPct };
}
