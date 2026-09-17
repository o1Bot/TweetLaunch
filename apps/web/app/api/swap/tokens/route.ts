import { getAddress, isAddress } from "viem";
import { isChainKey } from "@/lib/chains-web";
import { resolveCustomToken, swapCatalog, withBalances } from "@/lib/swap-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/swap/tokens?chain=robinhood[&wallet=0x…][&resolve=0x…]
 *
 * The tokens the swap page can offer on a chain, with the wallet's balances
 * when one is given. `resolve` returns one token that may not be listed,
 * read from the chain, for a pasted address.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainParam = url.searchParams.get("chain") ?? "robinhood";
  if (!isChainKey(chainParam)) return Response.json({ error: "unknown chain" }, { status: 400 });
  const walletParam = url.searchParams.get("wallet");
  const wallet = walletParam && isAddress(walletParam, { strict: false }) ? getAddress(walletParam.toLowerCase()) : null;
  const resolve = url.searchParams.get("resolve");
  try {
    if (resolve) {
      const token = await resolveCustomToken(chainParam, resolve);
      if (!token) return Response.json({ error: "not a token on this chain" }, { status: 404 });
      const [withBal] = wallet ? await withBalances(chainParam, [token], wallet) : [token];
      return Response.json({ chain: chainParam, token: withBal });
    }
    const tokens = await swapCatalog(chainParam);
    return Response.json({ chain: chainParam, tokens: wallet ? await withBalances(chainParam, tokens, wallet) : tokens });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not load the token list" }, { status: 502 });
  }
}
