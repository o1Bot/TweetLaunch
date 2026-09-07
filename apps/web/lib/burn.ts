import { erc20Abi, getAddress, type Address } from "viem";
import { publicClient } from "@o1bot/shared";

/**
 * Burns on o1 launch tokens. The token has no burn() and refuses transfers
 * to the zero address, so "burned" means whatever sits at the conventional
 * dead address: those tokens can never move again. Read on chain when a
 * page renders; there is no event to index because a burn is an ordinary
 * transfer.
 */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

/** Burned amount (raw units) per token address, for one multicall. */
export async function readBurned(tokens: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (tokens.length === 0) return out;
  const addresses = tokens.map((t) => getAddress(t) as Address);
  try {
    const results = await publicClient("robinhood").multicall({
      allowFailure: true,
      contracts: addresses.map((address) => ({ address, abi: erc20Abi, functionName: "balanceOf", args: [BURN_ADDRESS] }) as const),
    });
    results.forEach((r, i) => out.set(addresses[i]!, r.status === "success" ? (r.result as bigint) : 0n));
  } catch {
    for (const a of addresses) out.set(a, 0n);
  }
  return out;
}
