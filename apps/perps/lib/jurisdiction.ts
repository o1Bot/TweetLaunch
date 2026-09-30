// The venue's restricted-country list, the eligibility check and the country
// names live in @o1bot/lighter (jurisdiction.ts): the web API holds people to
// the same list when they opt in to trading from a post. This file keeps the
// one piece that is Next-specific.
export { RESTRICTED_COUNTRIES, TERMS_FETCHED_AT, TERMS_URL, countryName, eligibility } from "@o1bot/lighter";
export type { Eligibility } from "@o1bot/lighter";

/**
 * Vercel sets `x-vercel-ip-country` on every request at the edge. Nothing sets
 * it locally, which is why "unknown" has to be a first-class state rather than
 * an error — `next dev` would otherwise be permanently blocked or permanently
 * open, and both teach the wrong thing.
 */
export function countryFromHeaders(headers: Headers): string | null {
  return headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? null;
}
