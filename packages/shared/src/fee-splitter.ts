import { getAddress, type Address } from "viem";
import type { ChainKey } from "./chains";
import { env } from "./env";

/**
 * o1bot's FeeSplitterFactory on a chain (packages/contracts), or null where
 * none is deployed: launches there keep the creator's wallet as o1's fee
 * recipient, as before the splitter existed.
 */
export function feeSplitterFactory(key: ChainKey): Address | null {
  const e = env();
  const raw = key === "robinhood" ? e.FEE_SPLITTER_FACTORY_ROBINHOOD : key === "base" ? e.FEE_SPLITTER_FACTORY_BASE : e.FEE_SPLITTER_FACTORY_ARC;
  return raw ? getAddress(raw) : null;
}
