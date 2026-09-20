import { createLighterClient } from "@o1bot/lighter";

// One client for the whole app. The base URL follows NEXT_PUBLIC_LIGHTER_API
// when it is set, so the Robinhood instance stays one variable away; the
// default is Lighter mainnet, which carries the RWA markets this product is for.
export const lighter = createLighterClient();

/**
 * Market lists change rarely and every page needs them, so let Next cache the
 * response rather than hitting the venue on each render. Prices inside the same
 * payload move constantly, which is why this is a minute and not an hour.
 */
export const MARKETS_REVALIDATE_SECONDS = 60;

export function revalidating(seconds: number): RequestInit {
  return { next: { revalidate: seconds } } as RequestInit;
}
