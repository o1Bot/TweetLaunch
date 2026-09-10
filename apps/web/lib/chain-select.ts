import { cookies } from "next/headers";
import { CHAIN_COOKIE, DEFAULT_CHAIN, isChainKey, type ChainKey } from "./chains-web";

/**
 * Which chain the board shows: `?chain=` in the URL wins, then the cookie
 * the header switch sets, then Robinhood. Server components only.
 */
export async function selectedChain(searchParams?: { chain?: string | string[] }): Promise<ChainKey> {
  const q = Array.isArray(searchParams?.chain) ? searchParams?.chain[0] : searchParams?.chain;
  if (isChainKey(q)) return q;
  const fromCookie = (await cookies()).get(CHAIN_COOKIE)?.value;
  return isChainKey(fromCookie) ? fromCookie : DEFAULT_CHAIN;
}
